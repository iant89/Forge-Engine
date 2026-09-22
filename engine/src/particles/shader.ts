/**
 * Compute integrator. Must stay in lockstep with {@link integrateParticle}: same semi-implicit
 * Euler, same drag form, same life/flag rule. The CPU fallback is not a different model.
 *
 * `@compute` is written immediately before `fn` so `validateWgsl` (which requires `@compute fn`)
 * and the mock entry-point scan both accept it. `workgroup_size` is a sibling attribute.
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

export const PARTICLE_WORKGROUP = 64;
