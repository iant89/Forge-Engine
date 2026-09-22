/**
 * The cloud deck's WGSL (Phase 8b), evaluated inside the sky shader's fragment stage.
 *
 * Requires the including module to declare `perFrame: PerFrameUniforms`, `sky: SkyUniforms` and
 * `cloud: CloudUniforms` globals. The coverage remap and the shading are the GPU twin of
 * `environment/clouds.ts` (`cloudDensityAt` / `cloudRadiance` / `cloudAlpha`): same formulas, but
 * the noise basis differs on purpose — the CPU samples Perlin fbm from `math/noise.ts` while the
 * GPU marches a float32 value-noise fbm (4 octaves, like the CPU). Bit equality was never on the
 * table across that gap; the CPU side is pinned against its own statistics (monotonic coverage,
 * clear/overcast endpoints) and the GPU side is pinned by presence + direction in the browser
 * gate (overcast noon is brighter than clear noon, the deck occludes the stars).
 */

export const WGSL_CLOUD = /* wgsl */ `
fn cloudHash(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7)) + cloud.seed * 17.13;
  return fract(sin(h) * 43758.5453123);
}

fn cloudNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = cloudHash(i);
  let b = cloudHash(i + vec2<f32>(1.0, 0.0));
  let c = cloudHash(i + vec2<f32>(0.0, 1.0));
  let d = cloudHash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn cloudFbm(p: vec2<f32>) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var q = p;
  for (var i = 0; i < 4; i++) {
    sum += cloudNoise(q) * amp;
    norm += amp;
    amp *= 0.5;
    q = q * 2.03 + vec2<f32>(11.3, -7.7);
  }
  return sum / norm;
}

// The shaded deck along dir: rgb is the cloud radiance (linear), a is the opacity. The plane
// intersection is in render-local metres (the camera's XZ plus the ray's XZ times the height
// over the elevation), advected by the mean wind over the frame clock.
fn cloudDeck(dir: vec3<f32>, sunDir: vec3<f32>) -> vec4<f32> {
  let coverage = cloud.coverage;
  if (coverage <= 0.001 || dir.y <= 0.005) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let dh = cloud.height - sky.observerHeight;
  if (dh <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let t = dh / dir.y;
  let xz = perFrame.cameraPosRender.xz + dir.xz * t + cloud.wind * perFrame.time.x;
  let f = cloudFbm(xz * cloud.scale);
  let edge0 = 1.0 - coverage - 0.15;
  let edge1 = 1.0 - coverage + 0.25;
  let d = smoothstep(edge0, edge1, f) * cloud.density;
  if (d <= 0.001) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let alpha = (1.0 - exp(-3.0 * d)) * smoothstep(0.005, 0.08, dir.y);
  let cosT = max(dot(dir, sunDir), 0.0);
  let transmitted = 0.25 + 0.75 * exp(-2.5 * d);
  let silver = 1.0 + cloud.silverLining * pow(cosT, 6.0);
  let lit = cloud.sunTint * transmitted + cloud.ambientTint;
  return vec4<f32>(cloud.cloudAlbedo * lit * silver, alpha);
}
`;
