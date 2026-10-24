/**
 * The analytic sky (Phase 8a), drawn by the `forge.sky` pass as one fullscreen triangle on the far
 * plane after the opaque geometry, with the scene depth explicitly loaded and `less-equal` testing
 * so only pixels the geometry left untouched are shaded (no overdraw behind terrain). The pass
 * never writes depth; the explicit load/store (instead of a read-only attach) is the portable
 * spelling — see the WebKit note in `renderer.ts`'s `buildFrame`.
 *
 * The fragment stage is the GPU twin of `environment/atmosphere.ts`: the same single-scattering
 * integral (Rayleigh + Mie + ozone, midpoint rule on cubically spaced view segments, a light ray per
 * sample), the same constants (delivered through `SkyUniforms`, never retyped), the same lit-ground
 * term below the horizon, and the same multiple-scattering term (Phase 17.1) read out of the table
 * the compute passes in `shaders/multiScattering.ts` build. On top of that it adds what only a per-pixel pass can: the limb-darkened
 * sun disc, an atmosphere-attenuated anti-solar moon, a star field that fades with daylight, and
 * procedural cloud deck (`WGSL_CLOUD`, lit by the same sun/ambient the CPU derives). The scene fog
 * (`WGSL_FOG`) is applied to the planet ground in every mode and to the sky in height mode, so the
 * horizon meets the fogged geometry in front of it (see docs/ENVIRONMENT.md §3).
 *
 * View rays come from `invViewProj`: the vertex stage unprojects each corner at the near and far
 * planes and the fragment stage normalises `far - near`, which is exact for both perspective and
 * orthographic cameras because both points are affine in NDC.
 *
 * Output follows the forward shader's contract: scene-referred linear radiance on the HDR path
 * (`perFrame.flags` bit 1 set), otherwise exposure + tone map + sRGB in-shader.
 */

import { PerFrameUniforms, SkyUniforms, CloudUniforms } from "../uniforms.js";
import { WGSL_ATMOSPHERE_FUNCTIONS, WGSL_COLOR, WGSL_FOG } from "./common.js";
import { WGSL_CLOUD } from "./cloudLayer.js";
import { WGSL_ATMOSPHERE_COMMON, wgslMultiScatteringSampler } from "./multiScattering.js";

/** Group/binding map of the sky pass (its own bind-group layout; see `PipelineFactory`). */
export const SKY_BINDINGS = {
  perFrame: { group: 0, binding: 0 },
  sky: { group: 0, binding: 1 },
  cloud: { group: 0, binding: 2 },
  /** The multiple-scattering table `shaders/multiScattering.ts` builds (`MS_BINDINGS.lut`). */
  multiScattering: { group: 0, binding: 3 },
} as const;

export const SKY_SHADER = /* wgsl */ `
${PerFrameUniforms.toWgsl("uniform")}

${SkyUniforms.toWgsl("uniform")}

${CloudUniforms.toWgsl("uniform")}

@group(0) @binding(0) var<uniform> perFrame: PerFrameUniforms;
@group(0) @binding(1) var<uniform> sky: SkyUniforms;
@group(0) @binding(2) var<uniform> cloud: CloudUniforms;

${WGSL_COLOR}
${WGSL_FOG}
${WGSL_CLOUD}

const PI: f32 = 3.141592653589793;
// Path length the height fog is integrated over for sky pixels (long enough to converge).
const SKY_FOG_DISTANCE: f32 = 100000.0;

struct SkyOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) nearPoint: vec3<f32>,
  @location(1) farPoint: vec3<f32>,
}

// Brightest radiance the sky hands the rgba16float HDR target (its finite max is 65504).
const SKY_RADIANCE_MAX: f32 = 60000.0;

// fe-17: a term that is not finite contributes nothing. WebKit compiles WGSL to Metal with fast math,
// where whether a NaN/inf appears (and survives clamp/max) depends on how the optimiser happened to
// schedule this exact source — the device bisect saw the shipped sky black while every trivially
// edited variant drew. Gating each accumulated term keeps one bad sample from blackening the pixel.
fn skyFinite3(v: vec3<f32>) -> vec3<f32> {
  return select(vec3<f32>(0.0), v, msFinite(v.x) && msFinite(v.y) && msFinite(v.z));
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> SkyOut {
  let x = f32(index & 1u) * 4.0 - 1.0;
  let y = f32(index >> 1u) * 4.0 - 1.0;
  var out: SkyOut;
  // z = 1 (the far plane): with less-equal against the scene depth only untouched pixels pass.
  out.pos = vec4<f32>(x, y, 1.0, 1.0);
  let near = perFrame.invViewProj * vec4<f32>(x, y, 0.0, 1.0);
  let far = perFrame.invViewProj * vec4<f32>(x, y, 1.0, 1.0);
  out.nearPoint = near.xyz / near.w;
  out.farPoint = far.xyz / far.w;
  return out;
}

${WGSL_ATMOSPHERE_FUNCTIONS}
${WGSL_ATMOSPHERE_COMMON}
${wgslMultiScatteringSampler(SKY_BINDINGS.multiScattering.binding)}

fn hash13(p: vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
  var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

// A sparse star field: one candidate star per cell of a 3D grid the view ray pierces on the unit
// sphere; ~1 in 5 cells holds a star, brightness and a slow twinkle from the same hash.
fn stars(dir: vec3<f32>) -> f32 {
  let scale = 48.0;
  let p = dir * scale;
  let cell = floor(p);
  var total = 0.0;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let c = cell + vec3<f32>(f32(dx), f32(dy), f32(dz));
        let r = hash33(c);
        if (r.x > 0.2) {
          continue;
        }
        let centre = c + 0.5 + (r.yzx - 0.5) * 0.8;
        let dist = length(p - normalize(centre) * scale);
        let radius = 0.045 + r.z * 0.05;
        let core = 1.0 - smoothstep(0.0, radius, dist);
        let twinkle = 0.75 + 0.25 * sin(perFrame.time.x * (2.0 + r.y * 6.0) + r.z * 40.0);
        total += core * (0.25 + r.z * r.z * 2.5) * twinkle;
      }
    }
  }
  return total;
}

@fragment
fn fragmentMain(in: SkyOut) -> @location(0) vec4<f32> {
  let dir = normalize(in.farPoint - in.nearPoint);
  let sunDir = normalize(sky.sunDirection);
  // The cloud deck's sampling footprint. Derivatives are only legal in uniform control flow, and
  // the deck itself is evaluated inside the ground/sky branches below, so the footprint is taken
  // here where every pixel of the fullscreen triangle passes through.
  let deckFootprint = cloudDeckFootprint(dir);
  let R = sky.planetRadius;
  let origin = vec3<f32>(0.0, R + max(sky.observerHeight, 0.0), 0.0);
  // Keep the narrow, optically longest horizon band converged at every quality profile. The light
  // sample count is also used for the sun, moon and ground terms below the main atmosphere integral.
  let horizonBand = abs(dir.y) < 0.035;
  let lightSamples = select(sky.lightSamples, max(sky.lightSamples, 32i), horizonBand);

  var radiance = vec3<f32>(0.0);
  var viewOd = vec3<f32>(0.0);
  var msSum = vec3<f32>(0.0);
  var hitsGround = false;
  var tGroundOut = 0.0;
  let tTop = raySphereExit(origin, dir, R + sky.atmosphereHeight);
  if (tTop > 0.0) {
    let tGround = raySphereEntry(origin, dir, R);
    hitsGround = tGround > 0.0;
    tGroundOut = max(tGround, 0.0);
    let tMax = select(tTop, tGround, hitsGround);
    // An observer above the atmosphere (a planet seen from orbit) starts integrating where the ray
    // enters the shell; below the top of the air this is 0 and nothing changes.
    let tEnter = select(0.0, max(raySphereEntry(origin, dir, R + sky.atmosphereHeight), 0.0), sky.observerHeight > sky.atmosphereHeight);
    let pathLength = max(tMax - tEnter, 0.0);
    let cosTheta = dot(dir, sunDir);
    let phaseR = rayleighPhase(cosTheta);
    let phaseM = miePhase(cosTheta, sky.mieAnisotropy);
    let viewSamples = select(sky.viewSamples, max(sky.viewSamples, 64i), horizonBand);
    let invN = 1.0 / f32(viewSamples);
    var odR = 0.0;
    var odM = 0.0;
    var odO = 0.0;
    var sumR = vec3<f32>(0.0);
    var sumM = vec3<f32>(0.0);
    var tPrev = tEnter;
    for (var i = 0; i < viewSamples; i++) {
      // Cubic spacing (segment i spans tEnter + pathLength·[(i/N)³, ((i+1)/N)³]): dense where the air
      // is, near the camera (or where the ray enters the shell). Matches environment/atmosphere.ts
      // sample for sample.
      let u = f32(i + 1) * invN;
      let tNext = tEnter + pathLength * u * u * u;
      let ds = tNext - tPrev;
      let p = origin + dir * (0.5 * (tPrev + tNext));
      tPrev = tNext;
      let h = length(p) - R;
      let dR = exp(-h / sky.rayleighScaleHeight) * ds;
      let dM = exp(-h / sky.mieScaleHeight) * ds;
      let dO = ozoneDensity(h) * ds;
      odR += dR;
      odM += dM;
      odO += dO;
      let blocked = raySphereEntry(p, sunDir, R) > 0.0; // the sun is below this sample's horizon
      var lightOd = vec3<f32>(0.0);
      if (!blocked) {
        lightOd = opticalDepthToSpace(p, sunDir, lightSamples);
      }
      let od = sky.rayleighScattering * odR + sky.mieExtinction * odM + sky.ozoneAbsorption * odO;
      if (!blocked) {
        let attenuation = exp(-(od + lightOd));
        sumR += skyFinite3(attenuation * dR);
        sumM += skyFinite3(attenuation * dM);
      }
      if (sky.multiScattering != 0) {
        // Multiple scattering (Phase 17.1) reaches this sample from the whole lit sky, so it lands
        // even where the sun itself is below the local horizon — that is the twilight glow. The
        // table already carries the sun's transmittance to the scattering points, so only this
        // ray's transmittance and the local scattering coefficients remain.
        msSum += skyFinite3(exp(-od) * (sky.rayleighScattering * dR + sky.mieScattering * dM) * msSourceAt(h, p, sunDir));
      }
    }
    viewOd = sky.rayleighScattering * odR + sky.mieExtinction * odM + sky.ozoneAbsorption * odO;
    radiance = skyFinite3(sky.sunIntensity * (sky.rayleighScattering * sumR * phaseR + sky.mieScattering * sumM * phaseM + msSum));
    if (hitsGround) {
      let g = origin + dir * tGround;
      let n = normalize(g);
      let nDotL = max(dot(n, sunDir), 0.0);
      if (nDotL > 0.0) {
        let lightT = exp(-opticalDepthToSpace(g, sunDir, lightSamples));
        radiance += skyFinite3(exp(-viewOd) * (sky.groundAlbedo / PI) * sky.sunIntensity * lightT * nDotL);
      }
    }
  }

  if (!hitsGround) {
    // Sun disc: limb-darkened, seen through the whole atmosphere, blooming freely on the HDR path.
    let cosSun = dot(dir, sunDir);
    if (cosSun > 0.999 && raySphereEntry(origin, sunDir, R) < 0.0) {
      // asin of the cross product keeps precision near the disc centre where acos(cos) does not.
      let angle = asin(clamp(length(cross(dir, sunDir)), 0.0, 1.0));
      let radius = max(sky.sunAngularRadius, 1e-5);
      if (angle < radius + 0.001) {
        let r = clamp(angle / radius, 0.0, 1.0);
        let limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - r * r)));
        let edge = 1.0 - smoothstep(radius - 0.001, radius + 0.001, angle);
        let transmittance = exp(-opticalDepthToSpace(origin, sunDir, lightSamples));
        radiance += skyFinite3(transmittance * sky.sunIntensity * sky.sunDiscIntensity * limb * edge);
      }
    }
    // A procedural full moon follows the anti-solar direction. It uses the same atmospheric
    // transmittance and planet occlusion as the sun; phases/orbital inclination remain future data.
    let moonDir = -sunDir;
    if (moonDir.y > -0.01 && raySphereEntry(origin, moonDir, R) < 0.0) {
      let moonAngle = asin(clamp(length(cross(dir, moonDir)), 0.0, 1.0));
      let moonRadius = 0.0045;
      if (moonAngle < moonRadius + 0.001) {
        let moonEdge = 1.0 - smoothstep(moonRadius - 0.001, moonRadius + 0.001, moonAngle);
        let moonT = exp(-opticalDepthToSpace(origin, moonDir, lightSamples));
        radiance += skyFinite3(moonT * vec3<f32>(0.82, 0.88, 1.0) * (sky.sunIntensity * 0.004 * moonEdge));
      }
    }
    if (sky.starBrightness > 0.0 && dir.y > -0.05) {
      // Stars fade with the scattered light so they never show through a daytime sky.
      let daylight = clamp(luminance(radiance) * 40.0, 0.0, 1.0);
      let horizonFade = smoothstep(-0.05, 0.12, dir.y);
      radiance += skyFinite3(vec3<f32>(0.9, 0.95, 1.0) * (stars(dir) * 0.03 * sky.starBrightness * (1.0 - daylight) * horizonFade));
    }
  }

  if (!hitsGround) {
    // The cloud deck (Phase 8b, layered in Phase 17.3): a stack of noise-textured sheets above the
    // observer, occluding the sky (and the disc and stars behind it) with its own opacity, each
    // sheet shaded by the deck above it. Fog applies after, so a fogged horizon veils the deck's
    // base exactly like any distant geometry.
    let deck = cloudDeck(dir, sunDir, deckFootprint);
    let deckA = select(0.0, clamp(deck.a, 0.0, 1.0), msFinite(deck.a));
    radiance = mix(radiance, skyFinite3(deck.rgb), deckA);
  }

  // Scene fog. The planet ground is geometry at a known distance and is fogged in every mode, so
  // it meets the (fogged) scene geometry in front of it. The sky itself is fogged only by height
  // fog, whose path integral through an exponential layer is finite for upward rays: the horizon
  // fills with fog while the zenith stays clear. Linear/exp² fog leave the sky alone (their
  // integral over an infinite path would erase it); match their colour to the horizon instead.
  let cameraY = perFrame.cameraPosRender.y;
  if (hitsGround) {
    radiance = mix(perFrame.fogColor, radiance, fogTransmittance(tGroundOut, cameraY, cameraY - sky.observerHeight));
  } else if (perFrame.fogParams.x > 2.5) {
    radiance = mix(perFrame.fogColor, radiance, fogTransmittance(SKY_FOG_DISTANCE, cameraY, cameraY + SKY_FOG_DISTANCE * dir.y));
  }

  // fe-17: never hand the HDR target a NaN, an inf or a negative. rgba16float overflows to inf above
  // 65504 and a single non-finite sky pixel reaches every bloom mip and the tonemap, which shows as a
  // black sky on iOS Safari. Exponent-bit test, not x != x (WebKit's Metal fast math).
  let radianceOk = msFinite(radiance.x) && msFinite(radiance.y) && msFinite(radiance.z);
  radiance = select(vec3<f32>(0.0), clamp(radiance, vec3<f32>(0.0), vec3<f32>(SKY_RADIANCE_MAX)), radianceOk);
  if ((perFrame.flags & 2u) != 0u) {
    return vec4<f32>(radiance, 1.0);
  }
  var color = radiance * perFrame.exposure;
  color = tonemap(color, perFrame.toneMapping);
  color = linearToSrgb(color);
  return vec4<f32>(color, 1.0);
}
`;
