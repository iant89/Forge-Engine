/**
 * The multiple-scattering passes (Phase 17.1): the GPU twin of `environment/multiScattering.ts`.
 *
 * Two compute entry points in one module, in the order the renderer records them:
 *
 *  - `csTransmittance` fills `transmittanceTable`: the optical depth to the top of the atmosphere
 *    from every `(height, μ_sun)`, the table the field pass looks its light rays up in. It depends
 *    only on the atmosphere — not on the observer or the sun's azimuth — and it stores τ rather than
 *    transmittance, because τ is the quantity that interpolates linearly across a horizon that
 *    `exp(-τ)` crosses by orders of magnitude.
 *  - `csField` fills `multiScatteringLut`: `J_ms / sunIntensity` per channel at every
 *    `(height, μ_sun)` texel — the multiple-scattering source the sky pass adds to its integral.
 *
 * The field is deliberately a storage texture rather than a fixed-size storage array. WebKit's
 * fragment compiler mis-reads the latter shape (the Phase 17.1 black-sky failure), while a
 * `rgba32float` texture has one explicit texel per `(sun, height)` coordinate and is read with
 * `textureLoad` in every fragment stage. The transmittance helper table remains a compute-only
 * storage array: it never crosses into a fragment module.
 *
 * Both entry points walk exactly the equations `environment/multiScattering.ts` walks on the CPU
 * (Fibonacci sphere directions, midpoint path segments, the same warped axes), against the same
 * `SkyUniforms` the sky pass binds, so the drawn horizon and the fog colour derived from the CPU
 * table agree. `WGSL_ATMOSPHERE_COMMON` is the shared text: the sky fragment shader includes the
 * same phase/ozone/sphere functions and the same LUT reader from here, and the acceptance tests
 * read the LUT back off the device and compare it with the CPU build.
 */

import { ESTIMATE_MIE_ANISOTROPY } from "../../environment/atmosphere.js";
import { MULTI_SCATTERING_GPU, MS_LUT_FLOATS_PER_TEXEL, multiScatteringTexels } from "../../environment/multiScattering.js";
import { SkyUniforms } from "../uniforms.js";
import { WGSL_ATMOSPHERE_FUNCTIONS } from "./common.js";

/** Group/binding map of both compute passes and of the sky pass's LUT read. */
export const MS_BINDINGS = {
  sky: { group: 0, binding: 0 },
  transmittance: { group: 0, binding: 1 },
  lut: { group: 0, binding: 2 },
} as const;

/** Entry point names, in the order the renderer dispatches them. */
export const MS_ENTRY = {
  transmittance: "csTransmittance",
  field: "csField",
} as const;

/** Workgroup size of both passes (a multiple of 32 keeps every backend happy). */
export const MS_WORKGROUP = 64;

const GPU = MULTI_SCATTERING_GPU;
export const MS_LUT_TEXELS = multiScatteringTexels(GPU);
export const MS_TABLE_TEXELS = GPU.transmittanceHeights * GPU.transmittanceZeniths;
/** The format is intentionally unfilterable: fragment stages use `textureLoad`, not a sampler. */
export const MS_LUT_TEXTURE_FORMAT: GPUTextureFormat = "rgba32float";

/**
 * WGSL shared by the multiple-scattering compute passes and the sky fragment shader: the LUT axes,
 * the bilinear sampler, and the atmosphere helpers both shaders march with. Callers must declare the
 * `sky` uniform and (for {@link WGSL_MS_LUT_BINDING}) the LUT binding before including this text.
 */
export const WGSL_ATMOSPHERE_COMMON = /* wgsl */ `
const MS_LUT_HEIGHT: i32 = ${GPU.heightSamples};
const MS_LUT_SUN: i32 = ${GPU.sunSamples};
const MS_TABLE_HEIGHT: i32 = ${GPU.transmittanceHeights};
const MS_TABLE_SUN: i32 = ${GPU.transmittanceZeniths};
const MS_DIRECTIONS: i32 = ${GPU.directions};
const MS_STEPS: i32 = ${GPU.steps};
const MS_LIGHT_SAMPLES: i32 = ${GPU.lightSamples};
const MS_MAX_SERIES_RATIO: f32 = ${GPU.maxSeriesRatio.toFixed(4)};
const MS_GOLDEN_ANGLE: f32 = 2.399963229728653;
// tau of a blocked sun ray: exp(-MS_BLOCKED_TAU) is 0 in f32, and interpolating against a lit
// neighbour keeps it there.
const MS_BLOCKED_TAU: f32 = 1.0e30;
// Widest Mie lobe the field's 16-direction isotropic average evaluates (see
// environment/atmosphere.ts ESTIMATE_MIE_ANISOTROPY) — a forward-peaked lobe (Mars dust) cannot be
// integrated by that many directions.
const MS_ESTIMATE_G: f32 = ${ESTIMATE_MIE_ANISOTROPY.toFixed(2)};

// Largest J_ms / sunIntensity any texel may carry. The physical tables peak near 0.04 (Earth and Mars
// at GPU resolution, turbidity 2); 4.0 leaves two orders of magnitude for scaled atmospheres while a
// garbage texel can no longer overflow the rgba16float HDR target (fe-17).
const MS_SOURCE_MAX: f32 = 4.0;

// A finite, non-negative, bounded multiple-scattering term. The finiteness test reads the exponent
// bits instead of comparing x != x: WebKit compiles WGSL to Metal with fast math, under which a
// NaN/inf comparison (and clamp/max of a NaN) may be folded away. One bad texel otherwise turns the
// sky NaN, and on the HDR path bloom + tonemap spread that to a black sky (fe-17, iOS Safari).
fn msFinite(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;
}
fn msSanitize(v: vec3<f32>) -> vec3<f32> {
  let ok = msFinite(v.x) && msFinite(v.y) && msFinite(v.z);
  return select(vec3<f32>(0.0), clamp(v, vec3<f32>(0.0), vec3<f32>(MS_SOURCE_MAX)), ok);
}

// Row coordinate of a height: sqrt(h / atmosphereHeight), dense near the ground.
fn msHeightParam(h: f32) -> f32 {
  if (h <= 0.0) {
    return 0.0;
  }
  let t = h / sky.atmosphereHeight;
  return select(sqrt(t), 1.0, t >= 1.0);
}

// Column coordinate of a sun elevation cosine: uniform in mu, so twilight is resolved evenly.
fn msSunParam(muSun: f32) -> f32 {
  if (muSun <= -1.0) {
    return 0.0;
  }
  if (muSun >= 1.0) {
    return 1.0;
  }
  // Dense around mu = 0: the table changes by orders of magnitude across the terminator, which a
  // uniform axis spends less than one column on. Mirrors multiScatteringSunParam on the CPU.
  return 0.5 + 0.5 * sign(muSun) * sqrt(abs(muSun));
}

// Inverse of msSunParam: the mu at a texel's column coordinate (the axis the two tables build on).
fn msSunFromParam(param: f32) -> f32 {
  let u = 2.0 * param - 1.0;
  return sign(u) * u * u;
}
`;

/**
 * The LUT declaration (read-only) plus its texel reader, for shaders that read the table. The sky
 * and forward fragment stages bind the same `rgba32float` texture at different group/binding slots,
 * so the binding index is a parameter — one texture declaration, two bind-group layouts. `textureLoad`
 * keeps the format unfilterable and avoids the fixed-size storage-array path WebKit mis-reads.
 */
export function wgslMultiScatteringSampler(binding: number): string {
  return /* wgsl */ `
@group(0) @binding(${binding}) var multiScatteringLut: texture_2d<f32>;

// J_ms / sunIntensity at a height and a position, bilinearly interpolated on the table axes.
fn msSourceAt(h: f32, p: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32> {
  let len = max(length(p), 1.0);
  let muSun = dot(p / len, sunDir);
  let x = msHeightParam(h) * f32(MS_LUT_HEIGHT - 1);
  let y = msSunParam(muSun) * f32(MS_LUT_SUN - 1);
  let x0 = clamp(i32(floor(x)), 0, MS_LUT_HEIGHT - 2);
  let y0 = clamp(i32(floor(y)), 0, MS_LUT_SUN - 2);
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let row0 = x0;
  let row1 = row0 + 1;
  let a = msSanitize(textureLoad(multiScatteringLut, vec2<i32>(y0, row0), 0).rgb);
  let b = msSanitize(textureLoad(multiScatteringLut, vec2<i32>(y0 + 1, row0), 0).rgb);
  let c = msSanitize(textureLoad(multiScatteringLut, vec2<i32>(y0, row1), 0).rgb);
  let d = msSanitize(textureLoad(multiScatteringLut, vec2<i32>(y0 + 1, row1), 0).rgb);
  // Weights clamped too: a NaN height/sun coordinate must not extrapolate past the table.
  let wx = clamp(fx, 0.0, 1.0);
  let wy = clamp(fy, 0.0, 1.0);
  return msSanitize(mix(mix(a, b, wy), mix(c, d, wy), wx));
}
`;
}

/**
 * The compute module: `csTransmittance` then `csField`. Both read the sky block the renderer writes
 * once per frame, so a rebuild costs one uniform write and two dispatches.
 */
export const MULTI_SCATTERING_SHADER = /* wgsl */ `
${SkyUniforms.toWgsl("uniform")}

@group(0) @binding(${MS_BINDINGS.sky.binding}) var<uniform> sky: SkyUniforms;
@group(0) @binding(${MS_BINDINGS.transmittance.binding}) var<storage, read_write> transmittanceTable: array<vec4<f32>, ${MS_TABLE_TEXELS}>;
@group(0) @binding(${MS_BINDINGS.lut.binding}) var multiScatteringLut: texture_storage_2d<rgba32float, write>;

${WGSL_ATMOSPHERE_COMMON}

const PI: f32 = 3.141592653589793;

${WGSL_ATMOSPHERE_FUNCTIONS}

// Optical depth (per channel) to the top of the atmosphere from a table height, cubically spaced —
// the same march the CPU field uses. Uniform segments are hopeless for the grazing rays the
// twilight columns are made of: at mu ~ 0 the path is ~1000 km long and twelve uniform samples
// start 40 km up where there is no air left. A ray that meets the planet is MS_BLOCKED_TAU.
fn msOpticalDepthToSpace(h: f32, dir: vec3<f32>) -> vec3<f32> {
  let origin = vec3<f32>(0.0, sky.planetRadius + h, 0.0);
  if (raySphereEntry(origin, dir, sky.planetRadius) > 0.0) {
    return vec3<f32>(MS_BLOCKED_TAU);
  }
  let tTop = raySphereExit(origin, dir, sky.planetRadius + sky.atmosphereHeight);
  if (tTop <= 0.0) {
    return vec3<f32>(0.0);
  }
  var dR = 0.0;
  var dM = 0.0;
  var dO = 0.0;
  var tPrev = 0.0;
  for (var i = 0; i < MS_LIGHT_SAMPLES; i++) {
    let u = f32(i + 1) / f32(MS_LIGHT_SAMPLES);
    let tNext = tTop * u * u * u;
    let ds = tNext - tPrev;
    let q = origin + dir * (0.5 * (tPrev + tNext));
    tPrev = tNext;
    let sampleH = length(q) - sky.planetRadius;
    dR += exp(-sampleH / sky.rayleighScaleHeight) * ds;
    dM += exp(-sampleH / sky.mieScaleHeight) * ds;
    dO += ozoneDensity(sampleH) * ds;
  }
  return sky.rayleighScattering * dR + sky.mieExtinction * dM + sky.ozoneAbsorption * dO;
}

// The tau-to-space table, built first: 768 rays. tau, not transmittance: near each row's horizon
// tau changes by orders of magnitude within one column and interpolating tau (smooth, nearly
// linear in mu) is right where interpolating exp(-tau) invents light.
@workgroup_size(${MS_WORKGROUP}) @compute fn ${MS_ENTRY.transmittance}(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = i32(gid.x);
  if (index >= MS_TABLE_HEIGHT * MS_TABLE_SUN) {
    return;
  }
  let hi = index / MS_TABLE_SUN;
  let si = index - hi * MS_TABLE_SUN;
  let h = (f32(hi) / f32(MS_TABLE_HEIGHT - 1)) * (f32(hi) / f32(MS_TABLE_HEIGHT - 1)) * sky.atmosphereHeight;
  let mu = msSunFromParam(f32(si) / f32(MS_TABLE_SUN - 1));
  let dir = vec3<f32>(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  transmittanceTable[index] = vec4<f32>(msOpticalDepthToSpace(h, dir), 0.0);
}

// Bilinear tau-to-space at (height, mu), clamped at the table edges, exponentiated back.
fn tableTransmittance(h: f32, muSun: f32) -> vec3<f32> {
  let x = msHeightParam(max(h, 0.0)) * f32(MS_TABLE_HEIGHT - 1);
  let y = msSunParam(muSun) * f32(MS_TABLE_SUN - 1);
  let x0 = clamp(i32(floor(x)), 0, MS_TABLE_HEIGHT - 2);
  let y0 = clamp(i32(floor(y)), 0, MS_TABLE_SUN - 2);
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let row0 = x0 * MS_TABLE_SUN;
  let row1 = row0 + MS_TABLE_SUN;
  let a = transmittanceTable[row0 + y0].rgb;
  let b = transmittanceTable[row0 + y0 + 1].rgb;
  let c = transmittanceTable[row1 + y0].rgb;
  let d = transmittanceTable[row1 + y0 + 1].rgb;
  return exp(-mix(mix(a, b, fy), mix(c, d, fy), fx));
}

// The multi-scattering field: one texel = one (height, sun cosine) pair.
@workgroup_size(${MS_WORKGROUP}) @compute fn ${MS_ENTRY.field}(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = i32(gid.x);
  if (index >= MS_LUT_HEIGHT * MS_LUT_SUN) {
    return;
  }
  let hi = index / MS_LUT_SUN;
  let si = index - hi * MS_LUT_SUN;
  let hParam = f32(hi) / f32(MS_LUT_HEIGHT - 1);
  let h = hParam * hParam * sky.atmosphereHeight;
  let muSun = msSunFromParam(f32(si) / f32(MS_LUT_SUN - 1));
  let r = sky.planetRadius + h;
  let sunDir = vec3<f32>(sqrt(max(0.0, 1.0 - muSun * muSun)), muSun, 0.0);

  var accR = vec3<f32>(0.0);
  var accM = vec3<f32>(0.0);
  var accRho = vec3<f32>(0.0);
  // Fibonacci sphere: the same deterministic directions environment/multiScattering.ts averages.
  for (var d = 0; d < MS_DIRECTIONS; d++) {
    let cosT = 1.0 - 2.0 * (f32(d) + 0.5) / f32(MS_DIRECTIONS);
    let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
    let phi = f32(d) * MS_GOLDEN_ANGLE;
    let dir = vec3<f32>(sinT * cos(phi), cosT, sinT * sin(phi));
    let origin = vec3<f32>(0.0, r, 0.0);
    let cosScatter = dot(dir, sunDir);
    let phaseR = rayleighPhase(cosScatter);
    let phaseM = miePhase(cosScatter, clamp(sky.mieAnisotropy, -MS_ESTIMATE_G, MS_ESTIMATE_G));
    let b = r * dir.y;
    let tExit = -b + sqrt(max(0.0, b * b - (r * r - (sky.planetRadius + sky.atmosphereHeight) * (sky.planetRadius + sky.atmosphereHeight))));
    let groundDisc = b * b - (r * r - sky.planetRadius * sky.planetRadius);
    let tGround = select(-1.0, -b - sqrt(groundDisc), dir.y < 0.0 && groundDisc >= 0.0);
    let tMax = select(tExit, tGround, tGround >= 0.0 && tGround < tExit);
    if (tMax <= 0.0) {
      continue;
    }
    var viewOd = vec3<f32>(0.0);
    var tPrev = 0.0;
    for (var i = 0; i < MS_STEPS; i++) {
      // Cubic spacing: the same discretisation environment/atmosphere.ts and the sky shader use.
      let u = f32(i + 1) / f32(MS_STEPS);
      let tNext = tMax * u * u * u;
      let ds = tNext - tPrev;
      let t = 0.5 * (tPrev + tNext);
      tPrev = tNext;
      let p = origin + dir * t;
      let len = max(length(p), 1.0);
      let sampleH = len - sky.planetRadius;
      let dR = exp(-sampleH / sky.rayleighScaleHeight) * ds;
      let dM = exp(-sampleH / sky.mieScaleHeight) * ds;
      let dO = ozoneDensity(sampleH) * ds;
      viewOd += sky.rayleighScattering * dR + sky.mieExtinction * dM + sky.ozoneAbsorption * dO;
      let viewT = exp(-viewOd);
      let sunT = tableTransmittance(sampleH, dot(p / len, sunDir));
      accR += phaseR * viewT * sunT * dR;
      accM += phaseM * viewT * sunT * dM;
      accRho += viewT * (sky.rayleighScattering * dR + sky.mieScattering * dM);
    }
  }
  let inv = 1.0 / f32(MS_DIRECTIONS);
  let aR = accR * inv;
  let aM = accM * inv;
  let rho = clamp(accRho * inv, vec3<f32>(0.0), vec3<f32>(MS_MAX_SERIES_RATIO));
  let source = (sky.rayleighScattering * aR + sky.mieScattering * aM) / (vec3<f32>(1.0) - rho);
  let meanRho = (rho.r + rho.g + rho.b) / 3.0;
  let safeRho = select(0.0, clamp(meanRho, 0.0, 1.0), msFinite(meanRho));
  textureStore(multiScatteringLut, vec2<i32>(si, hi), vec4<f32>(msSanitize(source), safeRho));
}
`;

/** Bytes one LUT texel occupies in the storage buffer (a vec4 of f32). */
export const MS_LUT_TEXEL_BYTES = MS_LUT_FLOATS_PER_TEXEL * 4;
