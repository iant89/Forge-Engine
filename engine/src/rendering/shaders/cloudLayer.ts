/**
 * The cloud deck's WGSL (Phase 8b, layered in Phase 17.3), evaluated inside the sky shader's
 * fragment stage and sampled by every surface shader for the deck's shadow.
 *
 * Requires the including module to declare `perFrame: PerFrameUniforms`, `sky: SkyUniforms` and
 * `cloud: CloudUniforms` globals (the surface shaders bind the same block as `BINDINGS.cloud`).
 * The coverage remap, the stacking, the sun-path march and the LOD fade are the GPU twin of
 * `environment/clouds.ts` (`cloudDensityAt` / `cloudDeckColumnAt` / `cloudDeckShadowTau` /
 * `cloudDeckRadiance` / `cloudOctaveWeight`): same formulas, but the noise basis differs on purpose —
 * the CPU samples Perlin fbm from `math/noise.ts` while the GPU marches a float32 value-noise fbm
 * (4 octaves, like the CPU). Bit equality was never on the table across that gap; the CPU side is
 * pinned against its own statistics (monotone coverage, clear/overcast endpoints, the march against
 * a dense reference) and the GPU side is pinned by presence + direction in the browser gate
 * (overcast noon is brighter than clear noon, the deck occludes the stars, the ground under the
 * deck darkens when the shadow is switched on).
 *
 * Three things are worth knowing before editing any of this:
 *
 *  - **The stack is authoritative in the uniform.** `cloud.layers[i] = (driftX, driftZ, centre,
 *    weight)` is computed on the CPU (`cloudLayerCentre` / `cloudLayerWeight` / `cloudLayerDrift`),
 *    so the shader never re-derives a height, a weight or an advection it could disagree about with
 *    the CPU twin or with the shadow march below.
 *  - **Derivatives are taken before anything else, in the entry point.** `dpdx`/`dpdy` are only
 *    legal in uniform control flow, and Tint counts a branch on non-uniform data (or an early
 *    return behind one) as the end of it, so the two helpers below keep their derivative above
 *    every guard and their callers call them as the entry point's first statement — the deck
 *    itself is evaluated inside per-pixel branches and takes the footprint as an argument.
 *  - **Octaves fade against that footprint.** An octave whose wavelength is below the sampling
 *    footprint is dropped (Nyquist), which is what stops a grazing ray from resolving a different
 *    octave per pixel per frame — the Phase 17.3 temporal-stability fix — and makes the far deck
 *    *cheaper* as well as steadier.
 */

export const WGSL_CLOUD = /* wgsl */ `
fn cloudHash(p: vec2<f32>, seed: f32) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7)) + seed * 17.13;
  return fract(sin(h) * 43758.5453123);
}

fn cloudNoise(p: vec2<f32>, seed: f32) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = cloudHash(i, seed);
  let b = cloudHash(i + vec2<f32>(1.0, 0.0), seed);
  let c = cloudHash(i + vec2<f32>(0.0, 1.0), seed);
  let d = cloudHash(i + vec2<f32>(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The octave fade window, in noise units: CLOUD_DETAIL_FADE_NEAR..FAR (environment/clouds.ts).
const CLOUD_DETAIL_FADE_NEAR: f32 = 1.0;
const CLOUD_DETAIL_FADE_FAR: f32 = 3.0;

// fbm in noise units with a per-octave LOD fade. \`footprint\` is the world metres one pixel covers,
// already multiplied by the layer's scale; 0 disables the fade. An octave whose wavelength falls
// below the footprint fades out over the next two (Nyquist), and a fully faded octave stops the
// loop — the far deck holds fewer octaves and costs less, and the horizon stops shimmering.
fn cloudFbm(p: vec2<f32>, seed: f32, footprint: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var q = p;
  var wavelength = 1.0;
  // max(footprint, 1e-6) keeps the smoothstep edges ordered (strict compilers reject low >= high),
  // and a footprint of zero then fades nothing — every octave is resolvable.
  let fp = max(footprint, 1e-6);
  for (var i = 0; i < 4; i++) {
    let fade = smoothstep(fp, fp * CLOUD_DETAIL_FADE_FAR, wavelength);
    if (fade > 0.001) {
      sum += cloudNoise(q, seed) * amp * fade;
      // The normaliser counts the octave at its *unfaded* amplitude, exactly like the CPU
      // (cloudFieldLod): a fade has to shrink an octave's share of the sum, and fading the
      // divisor too would cancel the fade out and leave the alias in place.
      norm += amp;
    } else if (footprint > 0.0) {
      // Nothing further up the series can be resolvable either — stop marching octaves.
      break;
    }
    amp *= 0.5;
    wavelength *= 1.0 / 2.03;
    q = q * 2.03 + vec2<f32>(11.3, -7.7);
  }
  return select(0.0, sum / norm, norm > 0.0);
}

// Sub-layer i's sampling scale: \`cloud.scale * cloud.layerScale^i\` (cloudLayerScale).
fn cloudLayerScaleOf(index: i32) -> f32 {
  return cloud.scale * pow(cloud.layerScale, f32(index));
}

// Sub-layer i's record: (driftX, driftZ, centre height above sea level, column weight).
fn cloudLayerAt(index: i32) -> vec4<f32> {
  let i = clamp(index, 0i, i32(cloud.layerCount) - 1);
  return cloud.layers[u32(i)];
}

// Sub-layer extent and the layer a height falls in — the same arithmetic cloudLayerThickness and
// cloudLayerIndexAt do on the CPU.
fn cloudLayerThickness() -> f32 {
  return max(cloud.thickness, 0.0) / max(cloud.layerCount, 1.0);
}

fn cloudLayerIndexAt(height: f32) -> i32 {
  let base = cloud.height - cloud.thickness * 0.5;
  let index = i32(floor((height - base) / max(cloudLayerThickness(), 1e-3)));
  return clamp(index, 0i, i32(cloud.layerCount) - 1);
}

// fe-33 local clearing (cloudHoleApply): clear inside holeRadius, an overcast ring of holeWall
// outside it, blended by holeStrength (0 = the deck exactly as before).
fn cloudHoleApply(d: f32, xz: vec2<f32>) -> f32 {
  let strength = clamp(cloud.holeStrength, 0.0, 1.0);
  let r = max(cloud.holeRadius, 0.0);
  if (strength <= 0.0 || r <= 0.0) {
    return d;
  }
  let w = max(cloud.holeWall, 1e-3);
  let dist = length(xz - cloud.holeCenter);
  let open = smoothstep(r * 0.75, r, dist);
  let ring = smoothstep(r, r + 0.25 * w, dist) * (1.0 - smoothstep(r + 0.6 * w, r + w, dist));
  let carved = max(d, clamp(cloud.density, 0.0, 1.0) * ring) * open;
  return mix(d, carved, strength);
}

// Sub-layer index: the coverage remap on the shader's own value-noise fbm (cloudLayerDensityAt).
fn cloudLayerDensityAt(xz: vec2<f32>, index: i32, footprint: f32) -> f32 {
  return cloudHoleApply(cloudLayerDensityRaw(xz, index, footprint), xz);
}

fn cloudLayerDensityRaw(xz: vec2<f32>, index: i32, footprint: f32) -> f32 {
  let coverage = cloud.coverage;
  if (coverage <= 0.001) {
    return 0.0;
  }
  let layer = cloudLayerAt(index);
  let scale = cloudLayerScaleOf(index);
  let f = cloudFbm((xz + layer.xy) * scale, cloud.seed + f32(index), footprint * scale);
  let density = clamp(cloud.density, 0.0, 1.0);
  if (coverage >= 1.0) {
    return density;
  }
  let edge0 = 1.0 - coverage - 0.15;
  let edge1 = 1.0 - coverage + 0.25;
  return smoothstep(edge0, edge1, f) * density;
}

// The deck's column density: the weighted mean over the stack (cloudDeckColumnAt).
fn cloudDeckColumnAt(xz: vec2<f32>, footprint: f32) -> f32 {
  var column = 0.0;
  let count = i32(cloud.layerCount);
  for (var i = 0; i < count; i++) {
    column += cloudLayerAt(i).w * cloudLayerDensityAt(xz, i, footprint);
  }
  return clamp(column, 0.0, 1.0);
}

// Optical depth of the deck along the sun ray above \`height\`, in the units the shading curve
// wants ("density × path / sub-layer thickness", secant-clamped): cloudDeckShadowTau. Samples land
// in whichever sub-layer holds their height, and the count follows the path length — the top layer
// is barely shadowed by anything, so it takes a single sample while the bottom layer, which looks
// up through the whole stack, takes the full count. One fbm per sample.
fn cloudDeckShadowTau(xz: vec2<f32>, height: f32, sunDir: vec3<f32>, footprint: f32) -> f32 {
  let thickness = cloudLayerThickness();
  let bottom = cloud.height - cloud.thickness * 0.5;
  let top = cloud.height + cloud.thickness * 0.5;
  if (sunDir.y <= 0.02 || cloud.coverage <= 0.001 || cloud.density <= 0.0) {
    return 0.0;
  }
  let start = max(height, bottom);
  let span = top - start;
  if (span <= 0.0) {
    return 0.0;
  }
  let secant = min(1.0 / max(sunDir.y, 1e-3), 8.0);
  let maxSteps = max(round(cloud.shadowSteps), 1.0);
  let count = max(round(maxSteps * span / max(thickness, 1e-3)), 1.0);
  let dh = span / count;
  var tau = 0.0;
  for (var s = 0; s < i32(count); s++) {
    let y = start + (f32(s) + 0.5) * dh;
    let along = (y - height) * secant;
    let layer = cloudLayerIndexAt(y);
    let d = cloudLayerDensityAt(xz + sunDir.xz * along, layer, footprint);
    tau += d * cloudLayerAt(layer).w * dh;
  }
  return (secant * tau) / max(thickness, 1e-3);
}

// World metres one pixel covers at the deck's mid-plane — the footprint the deck samples with.
// Called from uniform control flow only (it takes derivatives); cloudFootprintAt is the CPU twin
// and tests/tools use it with an analytic pixel angle. The derivative comes *before* the guards on
// purpose: Tint rejects a derivative reached past a branch on non-uniform data ("dpdy must only be
// called from uniform control flow"), so the plane hit is evaluated unconditionally with a clamped
// divisor and the guards below throw it away.
fn cloudDeckFootprint(dir: vec3<f32>) -> f32 {
  let dh = cloud.height - max(sky.observerHeight, 0.0);
  let t = dh / max(abs(dir.y), 1e-4);
  let p = perFrame.cameraPosRender.xz + dir.xz * t;
  let footprint = max(length(dpdx(p)), length(dpdy(p)));
  if (dh <= 0.0 || dir.y <= 0.01) {
    return 0.0;
  }
  return footprint;
}

// World metres one pixel covers *here* — what a shadowed surface's footprint is (so the deck's
// shadow fades its octaves with the ground's own sampling rate, not the deck's).
fn cloudSurfaceFootprint(worldPos: vec3<f32>) -> f32 {
  return max(length(dpdx(worldPos.xz)), length(dpdy(worldPos.xz)));
}

// What fraction of the sun reaches a scene point through the deck (1 = unshadowed / no deck):
// cloudDeckTransmittance. \`footprint\` and its derivative are the caller's, see above.
fn cloudSunVisibility(worldPos: vec3<f32>, footprint: f32) -> f32 {
  if (cloud.surfaceShadows <= 0.5 || cloud.shadowStrength <= 0.0 || cloud.coverage <= 0.001 || cloud.enabled <= 0.5) {
    return 1.0;
  }
  let sunDir = normalize(sky.sunDirection);
  if (sunDir.y <= 0.02) {
    return 1.0;
  }
  let tau = cloudDeckShadowTau(worldPos.xz, worldPos.y, sunDir, footprint);
  return exp(-2.5 * clamp(cloud.shadowStrength, 0.0, 4.0) * tau);
}

// The shaded deck along dir: rgb is the composite radiance (linear), a the opacity. Sub-layers are
// composited front to back — the view ray meets the lowest sheet first — each shaded by the sun
// path above it through the stack (better shadowing inside the cloud) and by the ambient.
fn cloudDeck(dir: vec3<f32>, sunDir: vec3<f32>, footprint: f32) -> vec4<f32> {
  let coverage = cloud.coverage;
  if (coverage <= 0.001 || dir.y <= 0.005) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let cosT = max(dot(dir, sunDir), 0.0);
  let silver = 1.0 + cloud.silverLining * pow(cosT, 6.0);
  let midDistance = max((cloud.height - max(sky.observerHeight, 0.0)) / dir.y, 1e-3);
  var radiance = vec3<f32>(0.0);
  var transmittance = 1.0;
  let count = i32(cloud.layerCount);
  for (var i = 0; i < count; i++) {
    let layer = cloudLayerAt(i);
    let dh = layer.z - max(sky.observerHeight, 0.0);
    if (dh <= 0.0) {
      continue;
    }
    let t = dh / dir.y;
    let xz = perFrame.cameraPosRender.xz + dir.xz * t;
    // The sheet's own footprint: the ray is t metres out, so a pixel covers t/midDistance times
    // the ground it covers at the deck's centre height.
    let layerFootprint = footprint * (t / midDistance);
    let column = layer.w * cloudLayerDensityAt(xz, i, layerFootprint);
    if (column <= 1e-4) {
      continue;
    }
    let sunPath = cloudDeckShadowTau(xz, layer.z, sunDir, layerFootprint);
    let transmitted = 0.25 + 0.75 * exp(-2.5 * (column + sunPath));
    let alpha = (1.0 - exp(-3.0 * column)) * smoothstep(0.005, 0.08, dir.y);
    radiance += transmittance * alpha * cloud.cloudAlbedo * (cloud.sunTint * transmitted + cloud.ambientTint) * silver;
    transmittance *= 1.0 - alpha;
    if (transmittance <= 0.002) {
      break;
    }
  }
  return vec4<f32>(radiance, clamp(1.0 - transmittance, 0.0, 1.0));
}
`;
