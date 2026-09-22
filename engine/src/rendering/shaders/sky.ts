/**
 * The analytic sky (Phase 8a), drawn by the `forge.sky` pass as one fullscreen triangle on the far
 * plane after the opaque geometry, with the scene depth bound read-only and `less-equal` testing so
 * only pixels the geometry left untouched are shaded (no overdraw behind terrain).
 *
 * The fragment stage is the GPU twin of `environment/atmosphere.ts`: the same single-scattering
 * integral (Rayleigh + Mie + ozone, midpoint rule on cubically spaced view segments, a light ray per
 * sample), the same constants (delivered through `SkyUniforms`, never retyped), the same lit-ground
 * term below the horizon. On top of that it adds what only a per-pixel pass can: the limb-darkened
 * sun disc, a hashed star field that fades in as the scattered light goes away, and (Phase 8b) one
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
import { WGSL_COLOR, WGSL_FOG } from "./common.js";
import { WGSL_CLOUD } from "./cloudLayer.js";

/** Group/binding map of the sky pass (its own bind-group layout; see `PipelineFactory`). */
export const SKY_BINDINGS = {
  perFrame: { group: 0, binding: 0 },
  sky: { group: 0, binding: 1 },
  cloud: { group: 0, binding: 2 },
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

// Ray/sphere against a sphere at the origin: exit distance, or -1 when it misses / is behind.
fn raySphereExit(o: vec3<f32>, d: vec3<f32>, radius: f32) -> f32 {
  let b = dot(o, d);
  let c = dot(o, o) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return -1.0;
  }
  let t = -b + sqrt(disc);
  return select(t, -1.0, t < 0.0);
}

// Nearest positive intersection, or -1.
fn raySphereEntry(o: vec3<f32>, d: vec3<f32>, radius: f32) -> f32 {
  let b = dot(o, d);
  let c = dot(o, o) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return -1.0;
  }
  let s = sqrt(disc);
  let t0 = -b - s;
  if (t0 > 0.0) {
    return t0;
  }
  let t1 = -b + s;
  return select(t1, -1.0, t1 <= 0.0);
}

fn ozoneDensity(h: f32) -> f32 {
  if (sky.ozoneWidth <= 0.0) {
    return 0.0;
  }
  return max(0.0, 1.0 - abs(h - sky.ozoneCenter) / sky.ozoneWidth);
}

fn rayleighPhase(cosTheta: f32) -> f32 {
  return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

fn miePhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (3.0 * (1.0 - g2)) / (8.0 * PI * (2.0 + g2)) * ((1.0 + cosTheta * cosTheta) / (denom * sqrt(denom)));
}

// Optical depth (per channel) from p toward the top of the atmosphere along unit direction d.
fn opticalDepthToSpace(p: vec3<f32>, d: vec3<f32>, samples: i32) -> vec3<f32> {
  let tTop = raySphereExit(p, d, sky.planetRadius + sky.atmosphereHeight);
  if (tTop <= 0.0) {
    return vec3<f32>(0.0);
  }
  let ds = tTop / f32(samples);
  var dR = 0.0;
  var dM = 0.0;
  var dO = 0.0;
  for (var i = 0; i < samples; i++) {
    let q = p + d * ((f32(i) + 0.5) * ds);
    let h = length(q) - sky.planetRadius;
    dR += exp(-h / sky.rayleighScaleHeight) * ds;
    dM += exp(-h / sky.mieScaleHeight) * ds;
    dO += ozoneDensity(h) * ds;
  }
  return sky.rayleighScattering * dR + sky.mieExtinction * dM + sky.ozoneAbsorption * dO;
}

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
  let R = sky.planetRadius;
  let origin = vec3<f32>(0.0, R + max(sky.observerHeight, 0.0), 0.0);

  var radiance = vec3<f32>(0.0);
  var viewOd = vec3<f32>(0.0);
  var hitsGround = false;
  var tGroundOut = 0.0;
  let tTop = raySphereExit(origin, dir, R + sky.atmosphereHeight);
  if (tTop > 0.0) {
    let tGround = raySphereEntry(origin, dir, R);
    hitsGround = tGround > 0.0;
    tGroundOut = max(tGround, 0.0);
    let tMax = select(tTop, tGround, hitsGround);
    let cosTheta = dot(dir, sunDir);
    let phaseR = rayleighPhase(cosTheta);
    let phaseM = miePhase(cosTheta, sky.mieAnisotropy);
    let invN = 1.0 / f32(sky.viewSamples);
    var odR = 0.0;
    var odM = 0.0;
    var odO = 0.0;
    var sumR = vec3<f32>(0.0);
    var sumM = vec3<f32>(0.0);
    var tPrev = 0.0;
    for (var i = 0; i < sky.viewSamples; i++) {
      // Cubic spacing (segment i spans tMax·[(i/N)³, ((i+1)/N)³]): dense where the air is, near the
      // camera. Matches environment/atmosphere.ts sample for sample.
      let u = f32(i + 1) * invN;
      let tNext = tMax * u * u * u;
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
      if (raySphereEntry(p, sunDir, R) > 0.0) {
        continue; // the sun is below this sample's horizon
      }
      let lightOd = opticalDepthToSpace(p, sunDir, sky.lightSamples);
      let od = sky.rayleighScattering * odR + sky.mieExtinction * odM + sky.ozoneAbsorption * odO;
      let attenuation = exp(-(od + lightOd));
      sumR += attenuation * dR;
      sumM += attenuation * dM;
    }
    viewOd = sky.rayleighScattering * odR + sky.mieExtinction * odM + sky.ozoneAbsorption * odO;
    radiance = sky.sunIntensity * (sky.rayleighScattering * sumR * phaseR + sky.mieScattering * sumM * phaseM);
    if (hitsGround) {
      let g = origin + dir * tGround;
      let n = normalize(g);
      let nDotL = max(dot(n, sunDir), 0.0);
      if (nDotL > 0.0) {
        let lightT = exp(-opticalDepthToSpace(g, sunDir, sky.lightSamples));
        radiance += exp(-viewOd) * (sky.groundAlbedo / PI) * sky.sunIntensity * lightT * nDotL;
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
        let transmittance = exp(-opticalDepthToSpace(origin, sunDir, sky.lightSamples));
        radiance += transmittance * sky.sunIntensity * sky.sunDiscIntensity * limb * edge;
      }
    }
    if (sky.starBrightness > 0.0 && dir.y > -0.05) {
      // Stars fade with the scattered light so they never show through a daytime sky.
      let daylight = clamp(luminance(radiance) * 40.0, 0.0, 1.0);
      let horizonFade = smoothstep(-0.05, 0.12, dir.y);
      radiance += vec3<f32>(0.9, 0.95, 1.0) * (stars(dir) * 0.03 * sky.starBrightness * (1.0 - daylight) * horizonFade);
    }
  }

  if (!hitsGround) {
    // The cloud deck (Phase 8b): one noise-textured plane above the observer, occluding the sky
    // (and the disc and stars behind it) with its own opacity. Fog applies after, so a fogged
    // horizon veils the deck's base exactly like any distant geometry.
    let deck = cloudDeck(dir, sunDir);
    radiance = mix(radiance, deck.rgb, deck.a);
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

  if ((perFrame.flags & 2u) != 0u) {
    return vec4<f32>(radiance, 1.0);
  }
  var color = radiance * perFrame.exposure;
  color = tonemap(color, perFrame.toneMapping);
  color = linearToSrgb(color);
  return vec4<f32>(color, 1.0);
}
`;
