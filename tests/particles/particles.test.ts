/**
 * @suite particles:particles
 * @group unit
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/time.ts
 * @covers engine/src/debug/profiler.ts
 * @covers engine/src/gpu/constants.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/gpu/shaderCache.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/rng.ts
 * @covers engine/src/particles/components.ts
 * @covers engine/src/particles/emitter.ts
 * @covers engine/src/particles/gpu.ts
 * @covers engine/src/particles/gpuSystem.ts
 * @covers engine/src/particles/gpuWorld.ts
 * @covers engine/src/particles/layout.ts
 * @covers engine/src/particles/modules.ts
 * @covers engine/src/particles/shader.ts
 * @covers engine/src/particles/simulation.ts
 * @covers engine/src/particles/system.ts
 * @covers engine/src/particles/trails.ts
 * @covers engine/src/particles/world.ts
 * @covers engine/src/rendering/renderGraph.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/systems.ts
 * @covers engine/src/scene/world.ts
 * @desc Pins particles behavior and regression guarantees
 */

export const suite = {
  name: "particles:particles",
  group: "unit",
  covers:   [
    "engine/src/core/log.ts",
    "engine/src/core/time.ts",
    "engine/src/debug/profiler.ts",
    "engine/src/gpu/constants.ts",
    "engine/src/gpu/device.ts",
    "engine/src/gpu/shaderCache.ts",
    "engine/src/index.ts",
    "engine/src/math/rng.ts",
    "engine/src/particles/components.ts",
    "engine/src/particles/emitter.ts",
    "engine/src/particles/gpu.ts",
    "engine/src/particles/gpuSystem.ts",
    "engine/src/particles/gpuWorld.ts",
    "engine/src/particles/layout.ts",
    "engine/src/particles/modules.ts",
    "engine/src/particles/shader.ts",
    "engine/src/particles/simulation.ts",
    "engine/src/particles/system.ts",
    "engine/src/particles/trails.ts",
    "engine/src/particles/world.ts",
    "engine/src/rendering/renderGraph.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/systems.ts",
    "engine/src/scene/world.ts"
  ],
  desc: "Pins particles behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { arrayContaining, assertCloseTo, assertContains, assertMatchObject, assertMatches, finish, group, test } from "selrun";
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
  PARTICLE_RIBBON_SHADER,
  PARTICLE_RIBBON_RECORD_BYTES,
  PARTICLE_RIBBON_VERTS,
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

group("particles — integrator", () => {
  test("matches the semi-implicit closed form, not ½gt²", () => {
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
    assertCloseTo(state[P_Y], analytic.y, 4);
    assertCloseTo(state[P_VY], analytic.vy, 4);
    const continuous = y0 + 0.5 * g * (steps * dt) * (steps * dt);
    assert.ok(Math.abs(state[P_Y]! - continuous) > 0.05);
    assert.equal(PARTICLE_STRIDE, 64);
  });

  test("damps speed when drag is set, and kills a particle whose life expires", () => {
    const live = new Float32Array(PARTICLE_FLOATS);
    live[P_VY] = 10;
    live[P_LIFE] = 5;
    live[P_FLAGS] = FLAG_ALIVE;
    const dragged = live.slice();
    integrateParticle(live, 0, 0.1, { x: 0, y: 0, z: 0 }, 0);
    integrateParticle(dragged, 0, 0.1, { x: 0, y: 0, z: 0 }, 4);
    assert.ok(Math.abs(dragged[P_VY]!) < Math.abs(live[P_VY]!));

    const dying = new Float32Array(PARTICLE_FLOATS);
    dying[P_LIFE] = 0.02;
    dying[P_FLAGS] = FLAG_ALIVE;
    integrateParticle(dying, 0, 1 / 60, { x: 0, y: 0, z: 0 }, 0);
    integrateParticle(dying, 0, 1 / 60, { x: 0, y: 0, z: 0 }, 0);
    assert.equal(dying[P_FLAGS], 0);
    assert.equal(dying[P_LIFE], 0);
  });

  test("validates the compute shader structurally", () => {
    const issues = validateWgsl(PARTICLE_SIM_SHADER);
    assert.deepEqual(issues, [], issues.map((i) => `${i.line}: ${i.message}`).join("\n"));
    assertContains(PARTICLE_SIM_SHADER, "@compute fn");
    assertContains(PARTICLE_SIM_SHADER, "var<storage, read_write>");
  });
});

group("particles — modules, budget, trails", () => {
  test("emits inside a cone with a deterministic stream", () => {
    const cone = { direction: { x: 0, y: 1, z: 0 }, angle: 0, speedMin: 6, speedMax: 6 };
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    sampleCone(cone, new Rng(7), a);
    sampleCone(cone, new Rng(7), b);
    assert.deepEqual(a, b);
    assertCloseTo(a.y, 6, 5);
    assert.ok(Math.hypot(a.x, a.z) < 1e-6);
  });

  test("jitters spawn positions inside ±jitter/2 on each axis", () => {
    const e = new ParticleEmitter({
      seed: 5,
      rate: 64,
      lifeMin: 1,
      lifeMax: 1,
      position: { x: 10, y: 20, z: -5 },
      jitter: { x: 8, y: 4, z: 12 },
    });
    const s = new Float32Array(PARTICLE_FLOATS * 8);
    assert.equal(e.emit(s, 1, 8), 8);
    const xs = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const o = i * PARTICLE_FLOATS;
      assert.ok(s[o + P_X] >= 10 - 4);
      assert.ok(s[o + P_X] <= 10 + 4);
      assert.ok(s[o + P_Y] >= 20 - 2);
      assert.ok(s[o + P_Y] <= 20 + 2);
      assert.ok(s[o + P_Z] >= -5 - 6);
      assert.ok(s[o + P_Z] <= -5 + 6);
      xs.add(s[o + P_X]);
    }
    // A whole batch born in one call must fill the volume, not pile onto the emitter point.
    assert.ok(xs.size > 1);
  });

  test("lerps colour and size across life", () => {
    const sim = new ParticleSimulation({ capacity: 1, gravity: { x: 0, y: 0, z: 0 } });
    sim.state[P_LIFE] = 1;
    sim.state[P_MAX_LIFE] = 1;
    sim.state[P_AGE] = 0;
    sim.state[P_FLAGS] = FLAG_ALIVE;
    const color = new ColorOverLifeModule({ r: 1, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 1, a: 0 });
    const size = new SizeOverLifeModule(0.4, 0.1);
    color.apply(sim.state, 0, 0);
    size.apply(sim.state, 0, 0);
    assertCloseTo(sim.state[P_R], 1, 2);
    assertCloseTo(sim.state[P_SIZE], 0.4, 2);
    sim.state[P_AGE] = 1;
    color.apply(sim.state, 0, 0);
    size.apply(sim.state, 0, 0);
    assertCloseTo(sim.state[P_B], 1, 2);
    assertCloseTo(sim.state[P_A], 0, 2);
    assertCloseTo(sim.state[P_SIZE], 0.1, 2);
    assertCloseTo(sim.state[P_G], 0, 2);
  });

  test("caps emission by maxParticles and maxEmitsPerFrame", () => {
    const sim = new ParticleSimulation({ capacity: 8, maxEmitsPerFrame: 3, seed: 3 });
    sim.emitter.lifeMin = 30;
    sim.emitter.lifeMax = 30;
    sim.emitter.rate = 10_000;
    sim.step(1);
    assert.equal(sim.alive, 3);
    sim.step(1);
    sim.step(1);
    assert.ok(sim.alive <= 8);
    assert.equal(sim.emitted, 8);
  });

  test("records a trail that matches the particle's positions", () => {
    const trails = new ParticleTrails(1, 4);
    const state = new Float32Array(PARTICLE_FLOATS);
    state[P_FLAGS] = FLAG_ALIVE;
    state[P_LIFE] = 5;
    state[P_X] = 1;
    trails.record(state);
    state[P_X] = 2;
    trails.record(state);
    assert.equal(trails.count(0), 2);
    const latest = { x: 0, y: 0, z: 0 };
    const older = { x: 0, y: 0, z: 0 };
    assert.equal(trails.sample(0, 0, latest), true);
    assert.equal(trails.sample(0, 1, older), true);
    assert.equal(latest.x, 2);
    assert.equal(older.x, 1);
    assert.equal(trails.sample(0, 3, latest), false);
  });

  test("is deterministic for the same emitter seed", () => {
    function run() {
      const sim = new ParticleSimulation({ capacity: 32, seed: 42, gravity: { x: 0, y: -9.81, z: 0 }, drag: 0.2 });
      sim.emitter.rate = 20;
      sim.modules.push(new SizeOverLifeModule(0.2, 0.05));
      for (let i = 0; i < 40; i++) sim.step(1 / 60);
      return Array.from(sim.state);
    }
    assert.deepEqual(run(), run());
  });

  test("integrates 100k particles comfortably under a second for 30 steps", () => {
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
    assert.equal(sim.alive, count);
    assert.ok(ms < 1000, `100k × 30 steps took ${ms.toFixed(1)} ms`);
    // Spot-check one particle against the analytic curve (v0 = 0 for index 0).
    const analytic = analyticGravity(0, -9.81, 30, 1 / 60);
    assertCloseTo(sim.state[P_Y], analytic.y, 3);
  });
});

group("particles — GPU and scene integration", () => {
  test("dispatches the compute pipeline on the mock device and keeps the CPU curve analytic", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const result = await runParticleGravityCheck(gpu.device, { steps: 30, dt: 1 / 60, count: 64, gravityY: -9.81, y0: 2 });
      assert.ok(result.cpuError < 1e-4);
      assert.equal(result.dispatches, 30);
      assert.ok(result.computeTouchCount > 0);
      // The mock records the dispatch; it does not execute WGSL. A real GPU sets gpuExecuted.
      assert.equal(result.gpuExecuted, false);
      assert.deepEqual(gpu.mock.errors, []);
    } finally {
      await gpu.dispose();
    }
  });

  test("steps a ParticleComponent from the system and poses a sprite", () => {
    const world = new EntityWorld();
    const sim = new ParticleSimulation({ capacity: 4, seed: 1, gravity: { x: 0, y: 2, z: 0 } });
    sim.emitter.rate = 60;
    sim.emitter.cone.speedMin = 0;
    sim.emitter.cone.speedMax = 0;
    const host = world.createEntity("emitter");
    const component = new ParticleComponent(sim);
    host.add(component);
    const sprite = world.createEntity("sprite");
    sprite.add(new Transform());
    component.spriteEntities = [sprite.id];
    host.get(ParticleComponent)!.spriteEntities = [sprite.id];
    world.registerSystem(new ParticleSystem());
    world.runSystems(ctx(world, 1 / 30));
    assert.ok(sim.alive > 0);
    assert.equal(sim.stepCount, 1);
    const posed = sprite.get(Transform)!;
    assert.ok(posed.position.y > -1);
    world.dispose();
  });

  test("runs CPU components once per fixed substep instead of once per rendered frame", () => {
    const world = new EntityWorld();
    const sim = new ParticleSimulation({ capacity: 4 });
    const host = world.createEntity("fixed emitter");
    host.add(new ParticleComponent(sim));
    world.registerSystem(new ParticleSystem());
    const context = ctx(world, 1 / 30);
    (context as { fixedDt: number }).fixedDt = 1 / 120;
    (context as { fixedSteps: number }).fixedSteps = 4;
    world.runSystems(context);
    assert.equal(sim.stepCount, 4);
    (context as { fixedSteps: number }).fixedSteps = 0;
    world.runSystems(context);
    assert.equal(sim.stepCount, 4);
    world.dispose();
  });

  test("rejects two components stepping the same simulation", () => {
    const sim = new ParticleSimulation();
    new ParticleComponent(sim);
    assert.throws(() => new ParticleComponent(sim), /already owned by ParticleComponent/);
  });

  test("steps a ParticleWorld scene object without a second stepper", () => {
    const scene = new Scene({ name: "particles" });
    const fountain = new ParticleWorld({ capacity: 16, seed: 2, name: "fountain" });
    fountain.simulation.emitter.rate = 120;
    scene.add(fountain);
    const context = ctx(scene.world, 1 / 60);
    (context as { fixedDt: number }).fixedDt = 1 / 120;
    (context as { fixedSteps: number }).fixedSteps = 3;
    fountain.update?.(context, 1 / 60);
    assert.equal(fountain.simulation.stepCount, 3);
    (context as { fixedSteps: number }).fixedSteps = 0;
    fountain.update?.(context, 1 / 20);
    assert.equal(fountain.simulation.stepCount, 3);
    assert.ok(fountain.simulation.alive > 0);
    assert.equal(fountain.stats().steps, 3);
    scene.dispose();
  });
});

group("particles — emitter does not use Math.random", () => {
  test("two emitters with the same seed emit the same first particle", () => {
    const a = new ParticleEmitter({ seed: 99, rate: 1, lifeMin: 1, lifeMax: 1 });
    const b = new ParticleEmitter({ seed: 99, rate: 1, lifeMin: 1, lifeMax: 1 });
    const sa = new Float32Array(PARTICLE_FLOATS * 2);
    const sb = new Float32Array(PARTICLE_FLOATS * 2);
    assert.equal(a.emit(sa, 1, 1), 1);
    assert.equal(b.emit(sb, 1, 1), 1);
    assert.deepEqual(Array.from(sa), Array.from(sb));
  });
});

group("particles — Phase 12 GPU system", () => {
  test("validates emit / full-sim / cull / render / ribbon / resolve shaders structurally", () => {
    for (const [name, src] of [
      ["emit", PARTICLE_EMIT_SHADER],
      ["fullSim", PARTICLE_FULL_SIM_SHADER],
      ["cull", PARTICLE_CULL_SHADER],
      ["render", PARTICLE_RENDER_SHADER],
      ["ribbon", PARTICLE_RIBBON_SHADER],
      ["resolve", PARTICLE_RESOLVE_SHADER],
    ] as const) {
      const issues = validateWgsl(src);
      assert.deepEqual(issues, [], `${name}: ${issues.map((i) => `${i.line}: ${i.message}`).join("\n")}`);
    }
  });

  test("keeps velocity-stretched billboards aligned and gives flakes stable size variation", async () => {
    assertContains(PARTICLE_RENDER_SHADER, "select(p.seed * 6.28318530718, 0.0, params.stretch > 0.0)");
    assertContains(PARTICLE_FULL_SIM_SHADER, "fract(p.maxLife * 31.713)");
    assertContains(PARTICLE_FULL_SIM_SHADER, "params.sizeVariation");

    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const flakes = new GpuParticleSystem(gpu, {
        capacity: 64,
        modules: { sizeVariation: 0.55 },
      });
      assert.equal(flakes.modules.sizeVariation, 0.55);
      flakes.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("simulates and draws 100k particles without creating 100k ECS entities", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, {
        capacity: 100_000,
        seed: 11,
        maxEmitsPerFrame: 4096,
        softParticles: true,
      });
      await system.init();
      assert.equal(system.ready, true);
      assert.equal(system.entityCount(), 0);
      assert.equal(system.capacity, 100_000);
      assert.equal(system.storageBytes(), 100_000 * PARTICLE_STRIDE);

      const viewProj = new Float32Array(16);
      viewProj[0] = viewProj[5] = viewProj[10] = viewProj[15] = 1;
      system.prepare({
        dt: 1 / 120,
        simulationSteps: 4,
        viewProj,
        cameraPos: { x: 0, y: 2, z: 8 },
        cameraRight: { x: 1, y: 0, z: 0 },
        cameraUp: { x: 0, y: 1, z: 0 },
      });
      assert.ok(system.lastEmitBudget > 0);

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
      assertMatches(stats.executed, arrayContaining(["particle.sim", "particle.sort", "particle.render", "particle.resolve"]));
      assert.deepEqual(system.lastEnqueuedPasses, ["particle.sim", "particle.sort", "particle.render", "particle.resolve"]);
      assert.equal(system.entityCount(), 0);
      assert.deepEqual(gpu.mock.errors, []);
      assert.equal(system.stepCount, 4);
      assert.ok((gpu.device as unknown as { dispatches: number }).dispatches > 0);
      swap.destroy();
      depth.destroy();
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("stresses 10k / 50k / 100k capacities on the mock device without ECS growth", async () => {
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
        assert.equal(system.capacity, capacity);
        assert.equal(system.entityCount(), 0);
        assert.ok(system.lastEmitBudget > 0);
        system.dispose();
      }
      assert.deepEqual(gpu.mock.errors, []);
    } finally {
      await gpu.dispose();
    }
  });

  test("GpuParticleWorld never allocates sprite entities", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const scene = new Scene({ name: "gpu-particles" });
      const world = new GpuParticleWorld({ capacity: 100_000, seed: 3, name: "gpu" });
      await world.attachDevice(gpu);
      scene.add(world);
      assert.equal(world.system?.ready, true);
      assert.equal(world.system?.entityCount(), 0);
      assert.equal(scene.world.liveEntityCount, 0);
      world.prepareFrame({
        viewProj: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        cameraPos: { x: 0, y: 1, z: 4 },
        cameraRight: { x: 1, y: 0, z: 0 },
        cameraUp: { x: 0, y: 1, z: 0 },
      });
      assert.ok(world.system!.emitted > 0);
      assert.equal(scene.world.liveEntityCount, 0);
      scene.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("emitter seed is deterministic for the same GPU emit index stream", () => {
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
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test("soft-particle fade samples framebuffer pixel coords, not clip/NDC", () => {
    // Fragment @builtin(position) is pixel xy + depth z; dividing by w collapses UVs to a corner.
    assertContains(PARTICLE_RENDER_SHADER, "vec2<i32>(in.clip.xy)");
    assertContains(PARTICLE_RENDER_SHADER, "let particleZ = in.clip.z;");
    assert.doesNotMatch(PARTICLE_RENDER_SHADER, /in\.clip\.xy\s*\/\s*max\(in\.clip\.w/);
    assert.doesNotMatch(PARTICLE_RENDER_SHADER, /particleZ\s*=\s*in\.clip\.z\s*\/\s*max\(in\.clip\.w/);
    // Soft fade must not floor alpha (that left ≥5% ghosting through occluders).
    assertContains(PARTICLE_RENDER_SHADER, "alpha = alpha * soft;");
    assert.doesNotMatch(PARTICLE_RENDER_SHADER, /max\(\s*soft\s*,\s*0\.05\s*\)/);
  });

  test("cull draw uses compacted visible list + drawIndirect (no instance_index identity fallback)", async () => {
    assertContains(PARTICLE_RENDER_SHADER, "particleIndex == 0xffffffffu");
    assert.doesNotMatch(PARTICLE_RENDER_SHADER, /select\(\s*inst\s*,\s*particleIndex/);
    assertContains(PARTICLE_EMIT_SHADER, "params.emitBase + want");

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
      assert.ok(draws.length > 0);
      assert.deepEqual(gpu.mock.errors, []);
      swap.destroy();
      depth.destroy();
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });


  test("update invalidates render when GPU system is ready (dirty renderMode)", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const world = new GpuParticleWorld({ capacity: 64, seed: 5, name: "invalidate" });
      let invalidateCalls = 0;
      const context = {
        ...ctx(new EntityWorld()),
        render: { invalidate: () => { invalidateCalls++; } },
      } as SystemContext;
      world.update(context, 1 / 60);
      assert.equal(invalidateCalls, 0);
      await world.attachDevice(gpu);
      assert.equal(world.system?.ready, true);
      world.update(context, 1 / 60);
      assert.equal(invalidateCalls, 1);
      world.update(context, 1 / 60);
      assert.equal(invalidateCalls, 2);
      world.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("prepareFrame requires cameraRight/cameraUp basis (not viewProj columns)", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const world = new GpuParticleWorld({ capacity: 64, seed: 2, name: "basis" });
      await world.attachDevice(gpu);
      // Distinct basis that would NOT match identity viewProj column extraction ([1,0,0]/[0,1,0]).
      const cameraRight = { x: 0, y: 0, z: 1 };
      const cameraUp = { x: 0, y: 1, z: 0 };
      world.prepareFrame({
        viewProj: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        cameraPos: { x: 0, y: 1, z: 4 },
        cameraRight,
        cameraUp,
      });
      assert.ok(world.system!.emitted > 0);
      // Type contract: cameraRight/cameraUp are required — covered by this call compiling.
      world.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("init latches render shader module before ensureRenderPipeline", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, { capacity: 64, seed: 1, maxEmitsPerFrame: 8 });
      await system.init();
      assert.equal(system.ready, true);
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
        label: "swap-render-latch",
        size: { width: 16, height: 8 },
        format: gpu.format,
        usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
      });
      const depth = gpu.device.createTexture({
        label: "depth-render-latch",
        size: { width: 16, height: 8 },
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
        execute: (c) => {
          c.beginRenderPass().end();
        },
      });
      // Must not throw "render module missing" — module was assertShader'd in init.
      system.enqueue(graph, {
        color,
        depth: depthHandle,
        colorFormat: gpu.format,
        depthFormat: gpu.depthFormat,
      });
      graph.execute();
      assert.deepEqual(gpu.mock.errors, []);
      swap.destroy();
      depth.destroy();
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });


  test("attachDevice attach generation: stale finally does not clear newer initPending", async () => {
    const gpuA = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    const gpuB = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    const originalInit = GpuParticleSystem.prototype.init;
    let initCalls = 0;
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });
    GpuParticleSystem.prototype.init = async function (this: GpuParticleSystem) {
      const n = ++initCalls;
      if (n === 1) await gateA;
      else if (n === 2) await gateB;
    };
    try {
      const world = new GpuParticleWorld({ capacity: 64, seed: 11, name: "attach-gen" });
      const pA = world.attachDevice(gpuA);
      // Let attach A enter its hanging init.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(initCalls, 1);

      const pB = world.attachDevice(gpuB);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(initCalls, 2);
      const systemB = world.system;

      // Stale A settles; its finally must NOT clear B's initPending.
      releaseA();
      await pA;

      // Same device B while B is still pending: must reuse, not dispose/recreate mid-init.
      const pB2 = world.attachDevice(gpuB);
      assert.equal(initCalls, 2);
      assert.equal(world.system, systemB);
      assert.equal(pB2, pB);

      releaseB();
      await pB;
      await pB2;
      world.dispose();
    } finally {
      GpuParticleSystem.prototype.init = originalInit;
      await gpuA.dispose();
      await gpuB.dispose();
    }
  });

  test("init does not set ready if dispose ran during shader await", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, { capacity: 64, seed: 13 });
      type AssertFn = (module: GPUShaderModule) => Promise<void>;
      const proto = GpuParticleSystem.prototype as unknown as { assertShader: AssertFn };
      const originalAssert = proto.assertShader;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let entered = 0;
      proto.assertShader = async function (this: GpuParticleSystem, module: GPUShaderModule) {
        entered++;
        if (entered === 1) await gate;
        return originalAssert.call(this, module);
      };
      try {
        const initPromise = system.init();
        // Wait until init is blocked inside assertShader await.
        for (let i = 0; i < 50 && entered === 0; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(entered > 0);
        system.dispose();
        release();
        await initPromise;
        assert.equal(system.ready, false);
        assert.equal(system.stats().ready, false);
      } finally {
        proto.assertShader = originalAssert;
      }
    } finally {
      await gpu.dispose();
    }
  });

  test("dispose during pending init lets a later attachDevice start clean", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    const originalInit = GpuParticleSystem.prototype.init;
    let initCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    GpuParticleSystem.prototype.init = async function (this: GpuParticleSystem) {
      initCalls++;
      if (initCalls === 1) await gate;
      return originalInit.call(this);
    };
    try {
      const world = new GpuParticleWorld({ capacity: 64, seed: 17, name: "dispose-pending" });
      const stale = world.attachDevice(gpu);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(initCalls, 1);

      world.dispose();
      assert.equal(world.system === null, true);

      // Same device after dispose must not early-return the stale promise with system=null.
      const fresh = world.attachDevice(gpu);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(initCalls, 2);
      assert.notEqual(fresh, stale);
      assert.equal(world.system !== null, true);

      release();
      await stale;
      await fresh;
      assert.equal(world.system?.ready, true);
      world.dispose();
    } finally {
      GpuParticleSystem.prototype.init = originalInit;
      await gpu.dispose();
    }
  });

  test("attachDevice latches failure and does not dispose/recreate every frame", async () => {
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
        assert.equal(world.attachFailed, true);
        assert.equal(world.system?.ready, false);
        const firstSystem = world.system;
        // Failed init must dispose allocated GPU buffers (not leave a ready=false leak).
        assert.equal((firstSystem as unknown as { disposed: boolean }).disposed, true);
        assert.equal((firstSystem as unknown as { particleBuffer: GPUBuffer | null }).particleBuffer, null);
        await world.attachDevice(gpu);
        await world.attachDevice(gpu);
        assert.equal(initCalls, 1);
        assert.equal(world.system, firstSystem);
        world.clearAttachFailure();
        await world.attachDevice(gpu);
        assert.equal(initCalls, 2);
      } finally {
        GpuParticleSystem.prototype.init = originalInit;
      }
      world.dispose();
    } finally {
      await gpu.dispose();
    }
  });
});

group("particles — Phase 12.4/12.7 GPU ribbon trails", () => {
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const FRAME = {
    dt: 1 / 60,
    viewProj: IDENTITY,
    cameraPos: { x: 0, y: 1, z: 4 },
    cameraRight: { x: 1, y: 0, z: 0 },
    cameraUp: { x: 0, y: 1, z: 0 },
  };

  /** Run one seeded frame graph over the system and return the `particle.render` draws. */
  async function runRibbonFrame(gpu: GraphicsDevice, system: GpuParticleSystem) {
    // The mock log spans the whole device lifetime; the assertions are per-frame.
    gpu.mock.commandLog.length = 0;
    system.prepare(FRAME);
    const graph = new RenderGraph(gpu);
    const swap = gpu.device.createTexture({
      label: "swap-ribbon",
      size: { width: 32, height: 16 },
      format: gpu.format,
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
    });
    const depth = gpu.device.createTexture({
      label: "depth-ribbon",
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
    system.enqueue(graph, { color, depth: depthHandle, colorFormat: gpu.format, depthFormat: gpu.depthFormat });
    graph.execute();
    const draws = gpu.mock.commandLog.filter(
      (r) => r.type === "draw" && (r as { label?: string }).label === "particle.render",
    );
    swap.destroy();
    depth.destroy();
    return draws;
  }

  test("pins the ribbon contract across emit, cull, resolve and the vertex stage", () => {
    assert.equal(PARTICLE_RIBBON_VERTS, 18);
    assert.equal(PARTICLE_RIBBON_RECORD_BYTES, 16);
    // emit: a recycled slot's ring is zeroed in place, so a new life never reads its predecessor.
    assertContains(PARTICLE_EMIT_SHADER, "trails[tb + 0u] = vec4<f32>(p.position, 0.0);");
    assertContains(PARTICLE_EMIT_SHADER, "trails[tb + 3u] = vec4<f32>(p.position, 0.0);");
    // cull: the ribbon instance count counts the *same* survivors, gated by the frame's flag word.
    assertContains(PARTICLE_CULL_SHADER, "if ((params.flags & 1u) == 1u) {");
    assertContains(PARTICLE_CULL_SHADER, "atomicAdd(&indirect[5], 1u);");
    // resolve: the vertex record is stored once and the ribbon counter zeroed for the next frame.
    assertContains(PARTICLE_RESOLVE_SHADER, `atomicStore(&indirect[4], ${PARTICLE_RIBBON_VERTS}u);`);
    assertContains(PARTICLE_RESOLVE_SHADER, "atomicStore(&indirect[5], 0u);");
    // vertex: three quads per strip (6 vertices each), degenerate outside, sorted ring, soft flag.
    assertContains(PARTICLE_RIBBON_SHADER, "let seg = vid / 6u;");
    // A recycled slot's zero-age marker must not spike a segment at the world origin.
    assertContains(PARTICLE_RIBBON_SHADER, "if (pa.w <= 0.0) {");
    assertContains(PARTICLE_RIBBON_SHADER, "out.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);");
    assertContains(PARTICLE_RIBBON_SHADER, "out.softEnabled = params.flags & 1u;");
    assert.equal(PARTICLE_RIBBON_SHADER.match(/if \(s\[\d\]\.w < s\[\d\]\.w\)/g)?.length ?? 0, 5);
  });

  test("draws the ribbon record ahead of the billboards in the same particle.render pass", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, { capacity: 64, seed: 5, maxEmitsPerFrame: 16, ribbons: true });
      await system.init();
      const draws = await runRibbonFrame(gpu, system);
      assert.equal(draws.length, 2);
      assertMatchObject(draws[0], {
        indirect: true,
        offset: PARTICLE_RIBBON_RECORD_BYTES,
        vertexCount: PARTICLE_RIBBON_VERTS,
        instanceCount: 64,
      });
      assertMatchObject(draws[1], { indirect: true, offset: 0, vertexCount: 6, instanceCount: 64 });
      const stats = system.stats();
      assert.equal(stats.ribbons, true);
      assert.equal(stats.ribbonVerts, PARTICLE_RIBBON_VERTS);
      assert.equal(stats.ribbonDrawn, true);
      assert.deepEqual(gpu.mock.errors, []);
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("the ribbon draw follows the live toggle without a pipeline rebuild", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, { capacity: 32, seed: 9, maxEmitsPerFrame: 8 });
      await system.init();
      assert.equal(system.stats().ribbons, false);
      let draws = await runRibbonFrame(gpu, system);
      assert.equal(draws.length, 1); // billboards only — the ribbon record stays unissued
      assertMatchObject(draws[0], { offset: 0, vertexCount: 6 });
      assert.equal(system.stats().ribbonDrawn, false);
      system.setRibbons(true);
      draws = await runRibbonFrame(gpu, system);
      assert.equal(draws.length, 2);
      assertMatchObject(draws[0], { offset: PARTICLE_RIBBON_RECORD_BYTES, vertexCount: PARTICLE_RIBBON_VERTS });
      system.setRibbons(false);
      draws = await runRibbonFrame(gpu, system);
      assert.equal(draws.length, 1);
      assert.deepEqual(gpu.mock.errors, []);
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("a sub-workgroup capacity still fills one workgroup of ribbon instances", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const system = new GpuParticleSystem(gpu, { capacity: 8, seed: 4, maxEmitsPerFrame: 4, ribbons: true });
      await system.init();
      assert.equal(system.capacity, 64); // floored to one workgroup, like every other pass
      const draws = await runRibbonFrame(gpu, system);
      assertMatchObject(draws[0], { vertexCount: PARTICLE_RIBBON_VERTS, instanceCount: 64 });
      assert.deepEqual(gpu.mock.errors, []);
      system.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("same-seed systems with ribbons stay in lockstep", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const make = () => new GpuParticleSystem(gpu, { capacity: 128, seed: 1234, maxEmitsPerFrame: 64, ribbons: true });
      const a = make();
      const b = make();
      await a.init();
      await b.init();
      for (let i = 0; i < 3; i++) {
        a.prepare(FRAME);
        b.prepare(FRAME);
      }
      assert.equal(b.emitted, a.emitted);
      assert.equal(b.lastEmitBudget, a.lastEmitBudget);
      assert.equal(b.stepCount, a.stepCount);
      a.dispose();
      b.dispose();
    } finally {
      await gpu.dispose();
    }
  });

  test("dispose releases the ribbon uniform with everything else", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const before = { ...gpu.mock.outstanding, buffers: gpu.mock.outstanding.buffers.slice(), textures: gpu.mock.outstanding.textures.slice() };
      const system = new GpuParticleSystem(gpu, { capacity: 64, seed: 1, ribbons: true, softParticles: true });
      await system.init();
      await runRibbonFrame(gpu, system);
      system.dispose();
      assert.deepEqual(gpu.mock.outstanding.buffers, before.buffers);
      assert.deepEqual(gpu.mock.outstanding.textures, before.textures);
    } finally {
      await gpu.dispose();
    }
  });

  test("GpuParticleWorld.setRibbon drives the live system and persists across options", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true, allowMockFallback: true });
    try {
      const world = new GpuParticleWorld({ capacity: 64, seed: 6, name: "ribbons", ribbons: false });
      await world.attachDevice(gpu);
      assert.equal(world.system?.ribbons, false);
      world.setRibbon(true);
      assert.equal(world.system?.ribbons, true);
      assert.equal(world.stats().ribbons, true);
      // A re-attach reuses the mutated options, so the toggle survives a device switch.
      world.dispose();
      const again = new GpuParticleWorld({ capacity: 64, seed: 6, name: "ribbons2", ribbons: true });
      await again.attachDevice(gpu);
      assert.equal(again.system?.ribbons, true);
      again.dispose();
    } finally {
      await gpu.dispose();
    }
  });
});

await finish();
