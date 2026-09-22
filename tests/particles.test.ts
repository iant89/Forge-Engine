import { describe, expect, it } from "vitest";
import {
  Clock,
  ColorOverLifeModule,
  EntityWorld,
  FLAG_ALIVE,
  GraphicsDevice,
  Logger,
  P_A,
  P_AGE,
  P_B,
  P_FLAGS,
  P_G,
  P_LIFE,
  P_MAX_LIFE,
  P_R,
  P_SIZE,
  P_VY,
  P_X,
  P_Y,
  PARTICLE_FLOATS,
  PARTICLE_SIM_SHADER,
  PARTICLE_STRIDE,
  ParticleComponent,
  ParticleEmitter,
  ParticleSimulation,
  ParticleSystem,
  ParticleTrails,
  ParticleWorld,
  Profiler,
  Rng,
  Scene,
  SizeOverLifeModule,
  SystemScratch,
  Transform,
  analyticGravity,
  integrateParticle,
  runParticleGravityCheck,
  sampleCone,
  validateWgsl,
  type SystemContext,
} from "@forge/engine";

function ctx(world: EntityWorld, dt = 1 / 60): SystemContext {
  return {
    world,
    clock: new Clock(),
    dt,
    fixedDt: dt,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    frame: 1,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

describe("particles — integrator", () => {
  it("matches the semi-implicit closed form, not ½gt²", () => {
    const state = new Float32Array(PARTICLE_FLOATS);
    const y0 = 3;
    const g = -9.81;
    const dt = 1 / 60;
    const steps = 120;
    state[P_Y] = y0;
    state[P_LIFE] = 10;
    state[P_MAX_LIFE] = 10;
    state[P_FLAGS] = FLAG_ALIVE;
    for (let i = 0; i < steps; i++) integrateParticle(state, 0, dt, { x: 0, y: g, z: 0 }, 0);
    const analytic = analyticGravity(y0, g, steps, dt);
    expect(state[P_Y]).toBeCloseTo(analytic.y, 4);
    expect(state[P_VY]).toBeCloseTo(analytic.vy, 4);
    const continuous = y0 + 0.5 * g * (steps * dt) * (steps * dt);
    expect(Math.abs(state[P_Y]! - continuous)).toBeGreaterThan(0.05);
    expect(PARTICLE_STRIDE).toBe(64);
  });

  it("damps speed when drag is set, and kills a particle whose life expires", () => {
    const live = new Float32Array(PARTICLE_FLOATS);
    live[P_VY] = 10;
    live[P_LIFE] = 5;
    live[P_FLAGS] = FLAG_ALIVE;
    const dragged = live.slice();
    integrateParticle(live, 0, 0.1, { x: 0, y: 0, z: 0 }, 0);
    integrateParticle(dragged, 0, 0.1, { x: 0, y: 0, z: 0 }, 4);
    expect(Math.abs(dragged[P_VY]!)).toBeLessThan(Math.abs(live[P_VY]!));

    const dying = new Float32Array(PARTICLE_FLOATS);
    dying[P_LIFE] = 0.02;
    dying[P_FLAGS] = FLAG_ALIVE;
    integrateParticle(dying, 0, 1 / 60, { x: 0, y: 0, z: 0 }, 0);
    integrateParticle(dying, 0, 1 / 60, { x: 0, y: 0, z: 0 }, 0);
    expect(dying[P_FLAGS]).toBe(0);
    expect(dying[P_LIFE]).toBe(0);
  });

  it("validates the compute shader structurally", () => {
    const issues = validateWgsl(PARTICLE_SIM_SHADER);
    expect(issues, issues.map((i) => `${i.line}: ${i.message}`).join("\n")).toEqual([]);
    expect(PARTICLE_SIM_SHADER).toContain("@compute fn");
    expect(PARTICLE_SIM_SHADER).toContain("var<storage, read_write>");
  });
});

describe("particles — modules, budget, trails", () => {
  it("emits inside a cone with a deterministic stream", () => {
    const cone = { direction: { x: 0, y: 1, z: 0 }, angle: 0, speedMin: 6, speedMax: 6 };
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    sampleCone(cone, new Rng(7), a);
    sampleCone(cone, new Rng(7), b);
    expect(a).toEqual(b);
    expect(a.y).toBeCloseTo(6, 5);
    expect(Math.hypot(a.x, a.z)).toBeLessThan(1e-6);
  });

  it("lerps colour and size across life", () => {
    const sim = new ParticleSimulation({ capacity: 1, gravity: { x: 0, y: 0, z: 0 } });
    sim.state[P_LIFE] = 1;
    sim.state[P_MAX_LIFE] = 1;
    sim.state[P_AGE] = 0;
    sim.state[P_FLAGS] = FLAG_ALIVE;
    const color = new ColorOverLifeModule({ r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 1, a: 0 });
    const size = new SizeOverLifeModule(0.4, 0.1);
    color.apply(sim.state, 0, 0);
    size.apply(sim.state, 0, 0);
    expect(sim.state[P_R]).toBeCloseTo(1);
    expect(sim.state[P_SIZE]).toBeCloseTo(0.4);
    sim.state[P_AGE] = 1;
    color.apply(sim.state, 0, 0);
    size.apply(sim.state, 0, 0);
    expect(sim.state[P_B]).toBeCloseTo(1);
    expect(sim.state[P_A]).toBeCloseTo(0);
    expect(sim.state[P_SIZE]).toBeCloseTo(0.1);
    expect(sim.state[P_G]).toBeCloseTo(0);
  });

  it("caps emission by maxParticles and maxEmitsPerFrame", () => {
    const sim = new ParticleSimulation({ capacity: 8, maxEmitsPerFrame: 3, seed: 3 });
    sim.emitter.lifeMin = 30;
    sim.emitter.lifeMax = 30;
    sim.emitter.rate = 10_000;
    sim.step(1);
    expect(sim.alive).toBe(3);
    sim.step(1);
    sim.step(1);
    expect(sim.alive).toBeLessThanOrEqual(8);
    expect(sim.emitted).toBe(8);
  });

  it("records a trail that matches the particle's positions", () => {
    const trails = new ParticleTrails(1, 4);
    const state = new Float32Array(PARTICLE_FLOATS);
    state[P_FLAGS] = FLAG_ALIVE;
    state[P_LIFE] = 5;
    state[P_X] = 1;
    trails.record(state);
    state[P_X] = 2;
    trails.record(state);
    expect(trails.count(0)).toBe(2);
    const latest = { x: 0, y: 0, z: 0 };
    const older = { x: 0, y: 0, z: 0 };
    expect(trails.sample(0, 0, latest)).toBe(true);
    expect(trails.sample(0, 1, older)).toBe(true);
    expect(latest.x).toBe(2);
    expect(older.x).toBe(1);
    expect(trails.sample(0, 3, latest)).toBe(false);
  });

  it("is deterministic for the same emitter seed", () => {
    function run() {
      const sim = new ParticleSimulation({ capacity: 32, seed: 42, gravity: { x: 0, y: -9.81, z: 0 }, drag: 0.2 });
      sim.emitter.rate = 20;
      sim.modules.push(new SizeOverLifeModule(0.2, 0.05));
      for (let i = 0; i < 40; i++) sim.step(1 / 60);
      return Array.from(sim.state);
    }
    expect(run()).toEqual(run());
  });

  it("integrates 100k particles comfortably under a second for 30 steps", () => {
    const count = 100_000;
    const sim = new ParticleSimulation({ capacity: count, gravity: { x: 0, y: -9.81, z: 0 }, drag: 0 });
    for (let i = 0; i < count; i++) {
      const o = i * PARTICLE_FLOATS;
      sim.state[o + P_LIFE] = 8;
      sim.state[o + P_MAX_LIFE] = 8;
      sim.state[o + P_FLAGS] = FLAG_ALIVE;
      sim.state[o + P_VY] = (i % 17) * 0.01;
    }
    const t0 = performance.now();
    for (let s = 0; s < 30; s++) sim.integrateAll(1 / 60);
    const ms = performance.now() - t0;
    expect(sim.alive).toBe(count);
    expect(ms, `100k × 30 steps took ${ms.toFixed(1)} ms`).toBeLessThan(1000);
    // Spot-check one particle against the analytic curve (v0 = 0 for index 0).
    const analytic = analyticGravity(0, -9.81, 30, 1 / 60);
    expect(sim.state[P_Y]).toBeCloseTo(analytic.y, 3);
  });
});

describe("particles — GPU and scene integration", () => {
  it("dispatches the compute pipeline on the mock device and keeps the CPU curve analytic", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const result = await runParticleGravityCheck(gpu.device, { steps: 30, dt: 1 / 60, count: 64, gravityY: -9.81, y0: 2 });
      expect(result.cpuError).toBeLessThan(1e-4);
      expect(result.dispatches).toBe(30);
      expect(result.computeTouchCount).toBeGreaterThan(0);
      // The mock records the dispatch; it does not execute WGSL. A real GPU sets gpuExecuted.
      expect(result.gpuExecuted).toBe(false);
      expect(gpu.mock.errors).toEqual([]);
    } finally {
      await gpu.dispose();
    }
  });

  it("steps a ParticleComponent from the system and poses a sprite", () => {
    const world = new EntityWorld();
    const sim = new ParticleSimulation({ capacity: 4, seed: 1, gravity: { x: 0, y: 2, z: 0 } });
    sim.emitter.rate = 60;
    sim.emitter.cone.speedMin = 0;
    sim.emitter.cone.speedMax = 0;
    const component = new ParticleComponent(sim);
    const host = world.createEntity("emitter");
    host.add(new ParticleComponent(sim));
    const sprite = world.createEntity("sprite");
    sprite.add(new Transform());
    component.spriteEntities = [sprite.id];
    host.get(ParticleComponent)!.spriteEntities = [sprite.id];
    world.registerSystem(new ParticleSystem());
    world.runSystems(ctx(world, 1 / 30));
    expect(sim.alive).toBeGreaterThan(0);
    expect(sim.stepCount).toBe(1);
    const posed = sprite.get(Transform)!;
    expect(posed.position.y).toBeGreaterThan(-1);
    world.dispose();
  });

  it("steps a ParticleWorld scene object without a second stepper", () => {
    const scene = new Scene({ name: "particles" });
    const fountain = new ParticleWorld({ capacity: 16, seed: 2, name: "fountain" });
    fountain.simulation.emitter.rate = 30;
    scene.add(fountain);
    const context = ctx(scene.world, 1 / 60);
    fountain.update?.(context, 1 / 60);
    fountain.update?.(context, 1 / 60);
    expect(fountain.simulation.stepCount).toBe(2);
    expect(fountain.simulation.alive).toBeGreaterThan(0);
    expect(fountain.stats().steps).toBe(2);
    scene.dispose();
  });
});

describe("particles — emitter does not use Math.random", () => {
  it("two emitters with the same seed emit the same first particle", () => {
    const a = new ParticleEmitter({ seed: 99, rate: 1, lifeMin: 1, lifeMax: 1 });
    const b = new ParticleEmitter({ seed: 99, rate: 1, lifeMin: 1, lifeMax: 1 });
    const sa = new Float32Array(PARTICLE_FLOATS * 2);
    const sb = new Float32Array(PARTICLE_FLOATS * 2);
    expect(a.emit(sa, 1, 1)).toBe(1);
    expect(b.emit(sb, 1, 1)).toBe(1);
    expect(Array.from(sa)).toEqual(Array.from(sb));
  });
});
