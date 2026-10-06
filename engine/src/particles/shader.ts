/**
 * GPU particle shaders (Phase 12).
 *
 * `PARTICLE_SIM_SHADER` stays the tight gravity/drag/life integrator used by
 * {@link runParticleGravityCheck} — it must remain lockstep with {@link integrateParticle}.
 *
 * The Phase 12 path uses emit + full sim + cull + billboard/soft render shaders (plus the ribbon
 * vertex stage, {@link PARTICLE_RIBBON_SHADER}, which triangulates the trail ring in place).
 * Vertex pulling draws from the storage buffer via `drawIndirect` over the compacted visible list;
 * there are no per-particle ECS entities.
 */

/** Workgroup size shared by every particle compute pass. */
export const PARTICLE_WORKGROUP = 64;

/**
 * Vertices the ribbon vertex stage consumes per instance: 3 segments (4 trail samples) × 2
 * triangles of 6 verts. The indirect record's vertex-count word and the mock's seed both use this
 * constant so the draw and the shader can never disagree about the count.
 */
export const PARTICLE_RIBBON_VERTS = 18;

/** Byte offset of the ribbon indirect record — word 4 of the 8-word (32 B) indirect buffer. */
export const PARTICLE_RIBBON_RECORD_BYTES = 16;

/**
 * Compute integrator. Must stay in lockstep with {@link integrateParticle}: same semi-implicit
 * Euler, same drag form, same life/flag rule. The CPU fallback is not a different model.
 */
export const PARTICLE_SIM_SHADER = /* wgsl */ `
struct Particle {
  position: vec3<f32>,
  life: f32,
  velocity: vec3<f32>,
  maxLife: f32,
  color: vec4<f32>,
  size: f32,
  seed: f32,
  age: f32,
  flags: f32,
}

struct SimParams {
  dt: f32,
  gravityX: f32,
  gravityY: f32,
  gravityZ: f32,
  drag: f32,
  count: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@workgroup_size(64) @compute fn csMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  var p = particles[i];
  if (p.flags < 0.5 || p.life <= 0.0) {
    return;
  }
  p.velocity = p.velocity + vec3<f32>(params.gravityX, params.gravityY, params.gravityZ) * params.dt;
  let damp = max(0.0, 1.0 - params.drag * params.dt);
  p.velocity = p.velocity * damp;
  p.position = p.position + p.velocity * params.dt;
  p.life = p.life - params.dt;
  p.age = p.age + params.dt;
  if (p.life <= 0.0) {
    p.life = 0.0;
    p.flags = 0.0;
  }
  particles[i] = p;
}
`;

/** Shared Particle + hash helpers for emit/full-sim/cull/render. */
const PARTICLE_COMMON_WGSL = /* wgsl */ `
struct Particle {
  position: vec3<f32>,
  life: f32,
  velocity: vec3<f32>,
  maxLife: f32,
  color: vec4<f32>,
  size: f32,
  seed: f32,
  age: f32,
  flags: f32,
}

fn mix32(x: u32) -> u32 {
  var h = x + 0x9e3779b9u;
  h = (h ^ (h >> 16u)) * 0x21f0aaadu;
  h = (h ^ (h >> 15u)) * 0x735a2d97u;
  return h ^ (h >> 15u);
}

fn hash2(a: u32, b: u32) -> u32 {
  return mix32(a ^ (b * 0x85ebca6bu));
}

fn hashToFloat(h: u32) -> f32 {
  return f32(h) * (1.0 / 4294967296.0);
}

fn valueNoise3(p: vec3<f32>, seed: u32) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hashToFloat(hash2(hash2(u32(i.x), u32(i.y)), u32(i.z) ^ seed));
  let n100 = hashToFloat(hash2(hash2(u32(i.x) + 1u, u32(i.y)), u32(i.z) ^ seed));
  let n010 = hashToFloat(hash2(hash2(u32(i.x), u32(i.y) + 1u), u32(i.z) ^ seed));
  let n110 = hashToFloat(hash2(hash2(u32(i.x) + 1u, u32(i.y) + 1u), u32(i.z) ^ seed));
  let n001 = hashToFloat(hash2(hash2(u32(i.x), u32(i.y)), (u32(i.z) + 1u) ^ seed));
  let n101 = hashToFloat(hash2(hash2(u32(i.x) + 1u, u32(i.y)), (u32(i.z) + 1u) ^ seed));
  let n011 = hashToFloat(hash2(hash2(u32(i.x), u32(i.y) + 1u), (u32(i.z) + 1u) ^ seed));
  let n111 = hashToFloat(hash2(hash2(u32(i.x) + 1u, u32(i.y) + 1u), (u32(i.z) + 1u) ^ seed));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  let y0 = mix(x00, x10, u.y);
  let y1 = mix(x01, x11, u.y);
  return mix(y0, y1, u.z) * 2.0 - 1.0;
}
`;

/**
 * GPU emission. Ring-buffer write: invocation `i` writes slot `(writeHead + i) % capacity`.
 * Spawn parameters are hashed from `(seed, emitBase + i)` (monotonic) so a seed is deterministic across ring wraps.
 * The four trail samples of the slot are reset to (spawn position, age 0): a reused slot must never
 * show the *previous* occupant's trail, and the ribbon vertex stage treats `age <= 0` samples as
 * "no history yet" — so zeroing is what keeps a freshly spawned particle ribbon-free instead of
 * streaking from wherever it died last life.
 */
export const PARTICLE_EMIT_SHADER = /* wgsl */ `
${PARTICLE_COMMON_WGSL}

struct EmitParams {
  position: vec3<f32>,
  size: f32,
  coneDir: vec3<f32>,
  coneAngle: f32,
  color: vec4<f32>,
  jitter: vec3<f32>,
  lifeMin: f32,
  speedMin: f32,
  speedMax: f32,
  lifeMax: f32,
  seed: u32,
  writeHead: u32,
  emitBudget: u32,
  capacity: u32,
  emitBase: u32,
}

@group(0) @binding(0) var<uniform> params: EmitParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> trails: array<vec4<f32>>;

fn sampleCone(dir: vec3<f32>, angle: f32, h0: u32, h1: u32, h2: u32, speedMin: f32, speedMax: f32) -> vec3<f32> {
  var axis = dir;
  let len = length(axis);
  if (len > 1e-6) {
    axis = axis / len;
  } else {
    axis = vec3<f32>(0.0, 1.0, 0.0);
  }
  var tangent = cross(axis, vec3<f32>(0.0, 1.0, 0.0));
  if (dot(tangent, tangent) < 1e-6) {
    tangent = cross(axis, vec3<f32>(1.0, 0.0, 0.0));
  }
  tangent = normalize(tangent);
  let bitangent = cross(axis, tangent);
  let u = hashToFloat(h0);
  let v = hashToFloat(h1);
  let theta = angle * sqrt(u);
  let phi = v * 6.28318530718;
  let st = sin(theta);
  let ct = cos(theta);
  let speed = mix(speedMin, speedMax, hashToFloat(h2));
  return (axis * ct + tangent * (st * cos(phi)) + bitangent * (st * sin(phi))) * speed;
}

@workgroup_size(64) @compute fn csEmit(@builtin(global_invocation_id) id: vec3<u32>) {
  let want = id.x;
  if (want >= params.emitBudget) {
    return;
  }
  let slot = (params.writeHead + want) % params.capacity;
  // Monotonic emit base keeps the hash stream unique across ring wraps.
  let emitIndex = params.emitBase + want;
  let h0 = hash2(params.seed, emitIndex * 6u + 1u);
  let h1 = hash2(params.seed, emitIndex * 6u + 2u);
  let h2 = hash2(params.seed, emitIndex * 6u + 3u);
  let h3 = hash2(params.seed, emitIndex * 6u + 4u);
  let h4 = hash2(params.seed, emitIndex * 6u + 5u);
  let h5 = hash2(params.seed, emitIndex * 6u + 6u);
  let life = mix(params.lifeMin, params.lifeMax, hashToFloat(h0));
  let vel = sampleCone(params.coneDir, params.coneAngle, h1, h2, h3, params.speedMin, params.speedMax);
  var p: Particle;
  p.position = params.position + (vec3<f32>(hashToFloat(h4), hashToFloat(h5), hashToFloat(hash2(h4, h5))) - vec3<f32>(0.5)) * params.jitter;
  p.life = life;
  p.velocity = vel;
  p.maxLife = life;
  p.color = params.color;
  p.size = params.size;
  p.seed = hashToFloat(hash2(params.seed, emitIndex));
  p.age = 0.0;
  p.flags = 1.0;
  particles[slot] = p;
  // Reset the trail ring of the reused slot (see the module comment): age 0 means "no history",
  // which is what the ribbon vertex stage keys its degenerate-segment test on.
  let tb = slot * 4u;
  trails[tb + 0u] = vec4<f32>(p.position, 0.0);
  trails[tb + 1u] = vec4<f32>(p.position, 0.0);
  trails[tb + 2u] = vec4<f32>(p.position, 0.0);
  trails[tb + 3u] = vec4<f32>(p.position, 0.0);
}
`;

/**
 * Full GPU integrator: gravity, drag, turbulence/noise, attractor, velocity boost,
 * colour/size/rotation over life, and a 4-sample trail history ring per particle.
 */
export const PARTICLE_FULL_SIM_SHADER = /* wgsl */ `
${PARTICLE_COMMON_WGSL}

struct FullSimParams {
  dt: f32,
  drag: f32,
  time: f32,
  count: u32,
  gravity: vec3<f32>,
  turbulence: f32,
  attractorPos: vec3<f32>,
  attractorStrength: f32,
  colorFrom: vec4<f32>,
  colorTo: vec4<f32>,
  sizeStart: f32,
  sizeEnd: f32,
  noiseScale: f32,
  rotationSpeed: f32,
  velocityBoost: vec3<f32>,
  seed: u32,
}

@group(0) @binding(0) var<uniform> params: FullSimParams;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> trails: array<vec4<f32>>;

@workgroup_size(64) @compute fn csSim(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  var p = particles[i];
  if (p.flags < 0.5 || p.life <= 0.0) {
    return;
  }
  p.velocity = p.velocity + params.velocityBoost * params.dt;
  p.velocity = p.velocity + params.gravity * params.dt;
  let toA = params.attractorPos - p.position;
  let distSq = max(dot(toA, toA), 0.25);
  p.velocity = p.velocity + toA * (params.attractorStrength * params.dt / distSq);
  if (params.turbulence > 0.0) {
    let np = p.position * params.noiseScale + vec3<f32>(params.time);
    let nx = valueNoise3(np, params.seed);
    let ny = valueNoise3(np + vec3<f32>(19.1, 0.0, 0.0), params.seed);
    let nz = valueNoise3(np + vec3<f32>(0.0, 37.3, 0.0), params.seed);
    p.velocity = p.velocity + vec3<f32>(nx, ny, nz) * params.turbulence * params.dt;
  }
  let damp = max(0.0, 1.0 - params.drag * params.dt);
  p.velocity = p.velocity * damp;
  p.position = p.position + p.velocity * params.dt;
  p.life = p.life - params.dt;
  p.age = p.age + params.dt;
  let t = select(1.0, clamp(p.age / max(p.maxLife, 1e-6), 0.0, 1.0), p.maxLife > 1e-6);
  p.color = mix(params.colorFrom, params.colorTo, t);
  p.size = mix(params.sizeStart, params.sizeEnd, t);
  p.seed = fract(p.seed + params.rotationSpeed * params.dt * (0.1 + t));
  if (p.life <= 0.0) {
    p.life = 0.0;
    p.flags = 0.0;
  } else {
    let base = i * 4u;
    let slot = u32(p.age * 30.0) % 4u;
    trails[base + slot] = vec4<f32>(p.position, p.age);
  }
  particles[i] = p;
}
`;

/** Frustum + distance cull → compact index list + indirect instanceCount. HiZ deferred. */
export const PARTICLE_CULL_SHADER = /* wgsl */ `
${PARTICLE_COMMON_WGSL}

struct CullParams {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  count: u32,
  cullDistance: f32,
  flags: u32,
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> params: CullParams;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> visible: array<u32>;
@group(0) @binding(3) var<storage, read_write> indirect: array<atomic<u32>>;

@workgroup_size(64) @compute fn csCull(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) {
    return;
  }
  let p = particles[i];
  if (p.flags < 0.5 || p.life <= 0.0 || p.size <= 0.0) {
    return;
  }
  let toCam = p.position - params.cameraPos;
  if (dot(toCam, toCam) > params.cullDistance * params.cullDistance) {
    return;
  }
  let clip = params.viewProj * vec4<f32>(p.position, 1.0);
  if (clip.w <= 0.0) {
    return;
  }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 1.2 || abs(ndc.y) > 1.2 || ndc.z < 0.0 || ndc.z > 1.0) {
    return;
  }
  let slot = atomicAdd(&indirect[1], 1u);
  visible[slot] = i;
  // The ribbon draw consumes the *same* compacted list, so it counts survivors through the same
  // test in the same invocation. Flag off ⇒ record word 5 never grows ⇒ zero-instance draw.
  if ((params.flags & 1u) == 1u) {
    atomicAdd(&indirect[5], 1u);
  }
}
`;

/**
 * Billboard / stretched-billboard / soft-particle render. Mesh particles remain deferred; the
 * ribbon path lives in {@link PARTICLE_RIBBON_SHADER}. Soft fade uses textureLoad on the
 * scene depth buffer when the soft flag is set.
 */
export const PARTICLE_RENDER_SHADER = /* wgsl */ `
${PARTICLE_COMMON_WGSL}

struct RenderParams {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  softScale: f32,
  cameraRight: vec3<f32>,
  stretch: f32,
  cameraUp: vec3<f32>,
  flags: u32,
  colorMul: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: RenderParams;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var depthTex: texture_depth_2d;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) @interpolate(flat) softEnabled: u32,
}

fn cornerOffset(vert: u32) -> vec2<f32> {
  switch (vert) {
    case 0u: { return vec2<f32>(-1.0, -1.0); }
    case 1u: { return vec2<f32>( 1.0, -1.0); }
    case 2u: { return vec2<f32>( 1.0,  1.0); }
    case 3u: { return vec2<f32>(-1.0, -1.0); }
    case 4u: { return vec2<f32>( 1.0,  1.0); }
    default: { return vec2<f32>(-1.0,  1.0); }
  }
}

@vertex fn vsMain(@builtin(vertex_index) vid: u32, @builtin(instance_index) inst: u32) -> VSOut {
  var out: VSOut;
  let particleIndex = visible[inst];
  out.softEnabled = params.flags & 1u;
  // 0xFFFFFFFF = compacted-list sentinel (culled / unused). Never fall back to instance_index.
  if (particleIndex == 0xffffffffu) {
    out.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    out.color = vec4<f32>(0.0);
    out.uv = vec2<f32>(0.0);
    return out;
  }
  let p = particles[particleIndex];
  if (p.flags < 0.5 || p.life <= 0.0) {
    out.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    out.color = vec4<f32>(0.0);
    out.uv = vec2<f32>(0.0);
    return out;
  }
  let corner = cornerOffset(vid % 6u);
  let angle = p.seed * 6.28318530718;
  let ca = cos(angle);
  let sa = sin(angle);
  let local = vec2<f32>(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca) * max(p.size, 1e-4);
  var right = params.cameraRight;
  var up = params.cameraUp;
  if (params.stretch > 0.0) {
    let speed = length(p.velocity);
    if (speed > 1e-4) {
      let dir = p.velocity / speed;
      right = cross(dir, params.cameraUp);
      if (dot(right, right) < 1e-6) {
        right = params.cameraRight;
      } else {
        right = normalize(right);
      }
      up = dir * (1.0 + params.stretch * min(speed, 40.0) * 0.05);
    }
  }
  let world = p.position + right * local.x + up * local.y;
  out.clip = params.viewProj * vec4<f32>(world, 1.0);
  out.color = p.color * params.colorMul;
  out.uv = corner * 0.5 + vec2<f32>(0.5);
  return out;
}

@fragment fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  let r = length(in.uv - vec2<f32>(0.5));
  if (r > 0.5) {
    discard;
  }
  // Radial falloff of the billboard: opaque inside r = 0.35, fading to 0 at the 0.5 discard rim.
  // WGSL requires smoothstep's low edge < high edge (strict compilers reject the module
  // otherwise), so the reversed GLSL idiom smoothstep(0.5, 0.35, r) must be written this way.
  let edge = 1.0 - smoothstep(0.35, 0.5, r);
  var alpha = in.color.a * edge;
  if (in.softEnabled != 0u && params.softScale > 0.0) {
    // @builtin(position) in the fragment stage is framebuffer pixel coords (z = depth, w = 1/clip_w).
    let dims = vec2<i32>(textureDimensions(depthTex));
    let px = clamp(vec2<i32>(in.clip.xy), vec2<i32>(0), dims - vec2<i32>(1));
    let sceneDepth = textureLoad(depthTex, px, 0);
    let particleZ = in.clip.z;
    let soft = saturate((sceneDepth - particleZ) * params.softScale * f32(dims.y));
    alpha = alpha * soft;
  }
  if (alpha < 0.004) {
    discard;
  }
  return vec4<f32>(in.color.rgb, alpha);
}
`;

/**
 * Reset both indirect records for the next frame: words 0-3 are the billboard draw
 * (6 verts × compacted instances), words 4-7 the ribbon draw (3 segments × 6 verts = 18 verts ×
 * the same compacted instances). The instance counters are the only per-frame state; the
 * vertex-count words are constants the CPU seeds at init as a backstop.
 */
export const PARTICLE_RESOLVE_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> indirect: array<atomic<u32>>;

@workgroup_size(1) @compute fn csResolve(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x != 0u) {
    return;
  }
  atomicStore(&indirect[0], 6u);
  atomicStore(&indirect[1], 0u);
  atomicStore(&indirect[2], 0u);
  atomicStore(&indirect[3], 0u);
  atomicStore(&indirect[4], 18u);
  atomicStore(&indirect[5], 0u);
  atomicStore(&indirect[6], 0u);
  atomicStore(&indirect[7], 0u);
}
`;

/**
 * Ribbon mesh draw (12.4 / 12.7). One instance per *visible* particle, 18 vertices per instance:
 * 3 segments × 2 triangles, generated entirely in the vertex stage from the 4-sample trail ring
 * the full-sim writes and the emitter resets. No mesh buffer, no CPU geometry — the ribbon is
 * "trail history, triangulated at clip time".
 *
 * The four samples are sorted newest-first by age (the ring writes u32(age*30) % 4, so storage
 * order is not temporal order; sorting makes it so and keeps the logic a pure function of the
 * buffer bytes). Segment `seg` connects sample `seg+1` (older) to sample `seg` (newer): zero-length
 * or pre-first-write segments (`age <= 0`) collapse to the degenerate clip sentinel, so a young
 * particle simply has no ribbon yet. Each strip is camera-facing (right = normalize(cross(dir,
 * viewDir)), with the camera's right axis as the parallel-ray fallback), its width tapers from
 * `tailWidth` to 1 across the strip in units of the particle's current size, and its alpha ramps
 * with `fade²` so the tail dies out. Soft particles keep the same scene-depth fade as billboards.
 */
export const PARTICLE_RIBBON_SHADER = /* wgsl */ `
${PARTICLE_COMMON_WGSL}

struct RibbonParams {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  softScale: f32,
  cameraRight: vec3<f32>,
  sizeScale: f32,
  tailWidth: f32,
  flags: u32,
  pad0: f32,
  pad1: f32,
  colorMul: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: RibbonParams;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var<storage, read> trails: array<vec4<f32>>;
@group(0) @binding(4) var depthTex: texture_depth_2d;

struct RibbonVSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) @interpolate(flat) softEnabled: u32,
}

fn degenerateRibbon() -> RibbonVSOut {
  var out: RibbonVSOut;
  out.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  out.color = vec4<f32>(0.0);
  out.softEnabled = 0u;
  return out;
}

@vertex fn vsRibbon(@builtin(vertex_index) vid: u32, @builtin(instance_index) inst: u32) -> RibbonVSOut {
  let particleIndex = visible[inst];
  if (particleIndex == 0xffffffffu) {
    return degenerateRibbon();
  }
  let p = particles[particleIndex];
  if (p.flags < 0.5 || p.life <= 0.0) {
    return degenerateRibbon();
  }
  // Load the ring and sort it newest-first by age. Five fixed comparators on four elements — a
  // static sorting network, so the result is a pure function of the buffer bytes and every frame
  // with the same bytes agrees. The full-sim stores samples at u32(age*30) % 4, so storage
  // order is not temporal order and must not be assumed.
  var s: array<vec4<f32>, 4u>;
  s[0] = trails[particleIndex * 4u + 0u];
  s[1] = trails[particleIndex * 4u + 1u];
  s[2] = trails[particleIndex * 4u + 2u];
  s[3] = trails[particleIndex * 4u + 3u];
  if (s[0].w < s[1].w) { let t = s[0]; s[0] = s[1]; s[1] = t; }
  if (s[2].w < s[3].w) { let t = s[2]; s[2] = s[3]; s[3] = t; }
  if (s[1].w < s[2].w) { let t = s[1]; s[1] = s[2]; s[2] = t; }
  if (s[0].w < s[1].w) { let t = s[0]; s[0] = s[1]; s[1] = t; }
  if (s[1].w < s[2].w) { let t = s[1]; s[1] = s[2]; s[2] = t; }
  if (s[0].w <= 0.0) {
    return degenerateRibbon(); // no written sample yet (spawn frame) — a ribbon needs history
  }
  let seg = vid / 6u;
  if (seg > 2u) {
    return degenerateRibbon(); // over-eager vertex count guard
  }
  let k = vid % 6u;
  // a = the older endpoint of this segment, b = the newer one; the strip tapers/fades toward a.
  let pa = s[seg + 1u];
  let pb = s[seg];
  // A zero age here is the emit pass's "slot freshly recycled" marker, not a written sample —
  // drawing to it would spike a triangle at the world origin. Young particles simply lose the
  // affected segment until their history fills in (bucket 0 is written at age ~1/30).
  if (pa.w <= 0.0) {
    return degenerateRibbon();
  }
  let dir = pb.xyz - pa.xyz;
  let dirLen = length(dir);
  if (dirLen < 1e-5) {
    return degenerateRibbon(); // same-bucket or duplicated samples ⇒ zero-area triangle anyway
  }
  var endSel: u32;
  var side: f32;
  switch (k) {
    case 0u: { endSel = 0u; side = -1.0; break; }
    case 1u: { endSel = 1u; side = 1.0; break; }
    case 2u: { endSel = 0u; side = 1.0; break; }
    case 3u: { endSel = 0u; side = -1.0; break; }
    case 4u: { endSel = 1u; side = -1.0; break; }
    default: { endSel = 1u; side = 1.0; break; }
  }
  let end = select(pa, pb, endSel == 1u);
  let mid = (pa.xyz + pb.xyz) * 0.5;
  let toCam = params.cameraPos - mid;
  // Camera-facing: the strip's width axis is perpendicular to both the segment and the view ray.
  // Degenerate (segment pointing straight at the camera) falls back to a perpendicular of the
  // view axis, then to the camera's right as the last resort, so the ribbon never flips wildly.
  var rightV = cross(dir, toCam);
  if (dot(rightV, rightV) < 1e-8) {
    rightV = cross(dir, vec3<f32>(0.0, 0.0, -1.0));
  }
  if (dot(rightV, rightV) < 1e-8) {
    rightV = params.cameraRight;
  }
  let right = normalize(rightV);
  let span = max(s[0].w - s[3].w, 1e-4);
  let fadeA = saturate((pa.w - s[3].w) / span);
  let fadeB = saturate((pb.w - s[3].w) / span);
  let fade = select(fadeA, fadeB, endSel == 1u);
  let halfWidth = max(p.size, 0.0) * params.sizeScale * 0.5 * mix(params.tailWidth, 1.0, fade);
  let world = end.xyz + right * (side * halfWidth);
  var out: RibbonVSOut;
  out.clip = params.viewProj * vec4<f32>(world, 1.0);
  out.color = vec4<f32>(p.color.rgb * params.colorMul.rgb, p.color.a * params.colorMul.a * fade * fade);
  out.softEnabled = params.flags & 1u;
  return out;
}

@fragment fn fsRibbon(in: RibbonVSOut) -> @location(0) vec4<f32> {
  var alpha = in.color.a;
  if (in.softEnabled != 0u && params.softScale > 0.0) {
    // @builtin(position) in the fragment stage is framebuffer pixel coords (z = depth, w = 1/clip_w),
    // the same reading the billboard pass uses for its soft fade.
    let dims = vec2<i32>(textureDimensions(depthTex));
    let px = clamp(vec2<i32>(in.clip.xy), vec2<i32>(0), dims - vec2<i32>(1));
    let sceneDepth = textureLoad(depthTex, px, 0);
    let ribbonZ = in.clip.z;
    let soft = saturate((sceneDepth - ribbonZ) * params.softScale * f32(dims.y));
    alpha = alpha * soft;
  }
  if (alpha < 0.004) {
    discard;
  }
  return vec4<f32>(in.color.rgb, alpha);
}
`;
