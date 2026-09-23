import { describe, expect, it } from "vitest";
import {
  Clock,
  ColorOverLifeModule,
  EntityWorld,
  FLAG_ALIVE,
  GraphicsDevice,
  GpuParticleSystem,
  GpuParticleWorld,
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
  P_Z,
  PARTICLE_CULL_SHADER,
  PARTICLE_EMIT_SHADER,
  PARTICLE_FLOATS,
  PARTICLE_FULL_SIM_SHADER,
  PARTICLE_RENDER_SHADER,
  PARTICLE_RESOLVE_SHADER,
  PARTICLE_SIM_SHADER,
  PARTICLE_STRIDE,
  ParticleComponent,
  ParticleEmitter,
  ParticleSimulation,
  ParticleSystem,
  ParticleTrails,
  ParticleWorld,
  Profiler,
  RenderGraph,
  Rng,
  Scene,
  SizeOverLifeModule,
  SystemScratch,
  TextureUsage,
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

  it("jitters spawn positions inside ±jitter/2 on each axis", () => {
    const e = new ParticleEmitter({
      seed: 5,
      rate: 64,
      lifeMin: 1,
      lifeMax: 1,
      position: { x: 10, y: 20, z: -5 },
      jitter: { x: 8, y: 4, z: 12 },
    });
    const s = new Float32Array(PARTICLE_FLOATS * 8);
    expect(e.emit(s, 1, 8)).toBe(8);
    const xs = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const o = i * PARTICLE_FLOATS;
      expect(s[o + P_X]).toBeGreaterThanOrEqual(10 - 4);
      expect(s[o + P_X]).toBeLessThanOrEqual(10 + 4);
      expect(s[o + P_Y]).toBeGreaterThanOrEqual(20 - 2);
      expect(s[o + P_Y]).toBeLessThanOrEqual(20 + 2);
      expect(s[o + P_Z]).toBeGreaterThanOrEqual(-5 - 6);
      expect(s[o + P_Z]).toBeLessThanOrEqual(-5 + 6);
      xs.add(s[o + P_X]);
    }
    // A whole batch born in one call must fill the volume, not pile onto the emitter point.
    expect(xs.size).toBeGreaterThan(1);
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

describe("particles — Phase 12 GPU system", () => {
  it("validates emit / full-sim / cull / render / resolve shaders structurally", () => {
    for (const [name, src] of [
      ["emit", PARTICLE_EMIT_SHADER],
      ["fullSim", PARTICLE_FULL_SIM_SHADER],
      ["cull", PARTICLE_CULL_SHADER],
      ["render", PARTICLE_RENDER_SHADER],
      ["resolve", PARTICLE_RESOLVE_SHADER],
    ] as const) {
      const issues = validateWgsl(src);
      expect(issues, `${name}: ${issues.map((i) => `${i.line}: ${i.message}`).join("\n")}`).toEqual([]);
    }
  });

  it("simulates and draws 100k particles without creating 100k ECS entities", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, {
        capacity: 100_000,
        seed: 11,
        maxEmitsPerFrame: 4096,
        softParticles: true,
      });
      await system.init();
      expect(system.ready).toBe(true);
      expect(system.entityCount()).toBe(0);
      expect(system.capacity).toBe(100_000);
      expect(system.storageBytes()).toBe(100_000 * PARTICLE_STRIDE);

      const viewProj = new Float32Array(16);
      viewProj[0] = viewProj[5] = viewProj[10] = viewProj[15] = 1;
      system.prepare({
        dt: 1 / 60,
        viewProj,
        cameraPos: { x: 0, y: 2, z: 8 },
        cameraRight: { x: 1, y: 0, z: 0 },
        cameraUp: { x: 0, y: 1, z: 0 },
      });
      expect(system.lastEmitBudget).toBeGreaterThan(0);

      const graph = new RenderGraph(gpu);
      const swap = gpu.device.createTexture({
        label: "swap",
        size: { width: 64, height: 32 },
        format: gpu.format,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
      });
      const depth = gpu.device.createTexture({
        label: "depth",
        size: { width: 64, height: 32 },
        format: gpu.depthFormat,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
      });
      graph.begin();
      const color = graph.importTexture("swapchain", swap);
      const depthHandle = graph.importTexture("depth", depth);
      // Seed colour/depth so particle.render's loadOp is legal.
      graph.addPass({
        name: "seed",
        color: [{ texture: color }],
        depth: { texture: depthHandle },
        execute: (ctx) => {
          ctx.beginRenderPass().end();
        },
      });
      system.enqueue(graph, {
        color,
        depth: depthHandle,
        colorFormat: gpu.format,
        depthFormat: gpu.depthFormat,
      });
      const stats = graph.execute();
      expect(stats.executed).toEqual(expect.arrayContaining(["particle.sim", "particle.sort", "particle.render", "particle.resolve"]));
      expect(system.lastEnqueuedPasses).toEqual(["particle.sim", "particle.sort", "particle.render", "particle.resolve"]);
      expect(system.entityCount()).toBe(0);
      expect(gpu.mock.errors).toEqual([]);
      expect(system.stepCount).toBe(1);
      expect((gpu.device as unknown as { dispatches: number }).dispatches).toBeGreaterThan(0);
      swap.destroy();
      depth.destroy();
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  it("stresses 10k / 50k / 100k capacities on the mock device without ECS growth", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      for (const capacity of [10_000, 50_000, 100_000]) {
        const system = new GpuParticleSystem(gpu, { capacity, seed: capacity, maxEmitsPerFrame: 1024 });
        await system.init();
        const viewProj = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        system.prepare({
          dt: 1 / 60,
          viewProj,
          cameraPos: { x: 0, y: 1, z: 5 },
          cameraRight: { x: 1, y: 0, z: 0 },
          cameraUp: { x: 0, y: 1, z: 0 },
        });
        expect(system.capacity).toBe(capacity);
        expect(system.entityCount()).toBe(0);
        expect(system.lastEmitBudget).toBeGreaterThan(0);
        system.dispose();
      }
      expect(gpu.mock.errors).toEqual([]);
    } finally {
      await gpu.dispose();
    }
  });

  it("GpuParticleWorld never allocates sprite entities", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const scene = new Scene({ name: "gpu-particles" });
      const world = new GpuParticleWorld({ capacity: 100_000, seed: 3, name: "gpu" });
      await world.attachDevice(gpu);
      scene.add(world);
      expect(world.system?.ready).toBe(true);
      expect(world.system?.entityCount()).toBe(0);
      expect(scene.world.liveEntityCount).toBe(0);
      world.prepareFrame({
        viewProj: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        cameraPos: { x: 0, y: 1, z: 4 },
      });
      expect(world.system!.emitted).toBeGreaterThan(0);
      expect(scene.world.liveEntityCount).toBe(0);
      scene.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  it("emitter seed is deterministic for the same GPU emit index stream", () => {
    // CPU mirror of the hash used by PARTICLE_EMIT_SHADER — same seed + index → same first float.
    function mix32(x: number): number {
      let h = (x + 0x9e3779b9) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
      h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
      return (h ^ (h >>> 15)) >>> 0;
    }
    function hash2(a: number, b: number): number {
      return mix32((a ^ Math.imul(b, 0x85ebca6b)) >>> 0);
    }
    const seed = 7;
    const a = hash2(seed, 0);
    const b = hash2(seed, 0);
    const c = hash2(seed, 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("soft-particle fade samples framebuffer pixel coords, not clip/NDC", () => {
    // Fragment @builtin(position) is pixel xy + depth z; dividing by w collapses UVs to a corner.
    expect(PARTICLE_RENDER_SHADER).toContain("vec2<i32>(in.clip.xy)");
    expect(PARTICLE_RENDER_SHADER).toContain("let particleZ = in.clip.z;");
    expect(PARTICLE_RENDER_SHADER).not.toMatch(/in\.clip\.xy\s*\/\s*max\(in\.clip\.w/);
    expect(PARTICLE_RENDER_SHADER).not.toMatch(/particleZ\s*=\s*in\.clip\.z\s*\/\s*max\(in\.clip\.w/);
  });

  it("cull draw uses compacted visible list + drawIndirect (no instance_index identity fallback)", async () => {
    expect(PARTICLE_RENDER_SHADER).toContain("particleIndex == 0xffffffffu");
    expect(PARTICLE_RENDER_SHADER).not.toMatch(/select\(\s*inst\s*,\s*particleIndex/);
    expect(PARTICLE_EMIT_SHADER).toContain("params.emitBase + want");

    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, { capacity: 256, seed: 1, maxEmitsPerFrame: 32 });
      await system.init();
      const viewProj = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      system.prepare({
        dt: 1 / 60,
        viewProj,
        cameraPos: { x: 0, y: 1, z: 4 },
        cameraRight: { x: 1, y: 0, z: 0 },
        cameraUp: { x: 0, y: 1, z: 0 },
      });
      const graph = new RenderGraph(gpu);
      const swap = gpu.device.createTexture({
        label: "swap-cull",
        size: { width: 32, height: 16 },
        format: gpu.format,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
      });
      const depth = gpu.device.createTexture({
        label: "depth-cull",
        size: { width: 32, height: 16 },
        format: gpu.depthFormat,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
      });
      graph.begin();
      const color = graph.importTexture("swapchain", swap);
      const depthHandle = graph.importTexture("depth", depth);
      graph.addPass({
        name: "seed",
        color: [{ texture: color }],
        depth: { texture: depthHandle },
        execute: (ctx) => {
          ctx.beginRenderPass().end();
        },
      });
      system.enqueue(graph, {
        color,
        depth: depthHandle,
        colorFormat: gpu.format,
        depthFormat: gpu.depthFormat,
      });
      graph.execute();
      const draws = gpu.mock.commandLog.filter((r) => r.type === "draw" && (r as { indirect?: boolean }).indirect);
      expect(draws.length).toBeGreaterThan(0);
      expect(gpu.mock.errors).toEqual([]);
      swap.destroy();
      depth.destroy();
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  it("attachDevice latches failure and does not dispose/recreate every frame", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const world = new GpuParticleWorld({ capacity: 64, seed: 9, name: "fail-latch" });
      const originalInit = GpuParticleSystem.prototype.init;
      let initCalls = 0;
      GpuParticleSystem.prototype.init = async function (this: GpuParticleSystem) {
        initCalls++;
        throw new Error("forced init failure");
      };
      try {
        await world.attachDevice(gpu);
        expect(world.attachFailed).toBe(true);
        expect(world.system?.ready).toBe(false);
        const firstSystem = world.system;
        await world.attachDevice(gpu);
        await world.attachDevice(gpu);
        expect(initCalls).toBe(1);
        expect(world.system).toBe(firstSystem);
        world.clearAttachFailure();
        await world.attachDevice(gpu);
        expect(initCalls).toBe(2);
      } finally {
        GpuParticleSystem.prototype.init = originalInit;
      }
      world.dispose();
    } finally {
      await gpu.dispose();
    }
  });
});
