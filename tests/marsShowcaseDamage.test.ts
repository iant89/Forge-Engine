/**
 * Rover impacts on the Mars Showcase do not fracture interactive rocks. The rover model is
 * mocked with procedural boxes at known model-space positions (the real 10 MB GLB never loads,
 * so no network or image decoder is needed): a hard ram may dent the rover, but the target rock
 * and its population identity stay intact, with no fracture debris or saved broken-rock ID.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Clock,
  GraphicsDevice,
  Logger,
  PopulationWorld,
  Profiler,
  Renderable,
  SystemScratch,
  TerrainWorld,
  type TaskScheduler,
  VehicleComponent,
  heightFunctionGround,
  type Engine,
  type Entity,
  type SystemContext,
} from "@forge/engine";
import { buildMarsShowcaseScene } from "../examples/src/scenes/marsShowcaseScene.js";
import type { LoadedGlb } from "../examples/src/assets/glb.js";
import { shouldSplitRockDuringDrilling } from "../examples/src/scenes/roverTools.js";

vi.mock("../examples/src/assets/glb.js", () => ({
  loadGlb: async (
    device: unknown,
    _url: string,
    onProgress?: (progress: { phase: string; receivedBytes: number; totalBytes: number | null }) => void,
  ): Promise<LoadedGlb> => {
    const engine = await import("@forge/engine");
    const geometries: { dispose(): void }[] = [];
    const material = engine.Material.unlit({ label: "mock-rover", color: 0xb06030 });
    const box = (name: string, size: number, at: [number, number, number]) => {
      const src = engine.boxGeometrySource({ width: size, height: size, depth: size });
      for (let i = 0; i < src.positions.length; i += 3) {
        src.positions[i]! += at[0];
        src.positions[i + 1]! += at[1];
        src.positions[i + 2]! += at[2];
      }
      const geometry = engine.Geometry.create(device as GraphicsDevice, src);
      geometries.push(geometry);
      return { name, geometry, material };
    };
    onProgress?.({ phase: "done", receivedBytes: 1, totalBytes: 1 });
    return {
      // Body parts at known model-space spots: the crush offsets must move the nose (front
      // zone) while the tail and deck stay put.
      body: [
        box("nose", 0.5, [0, 0, 1.5]),
        box("tail", 0.5, [0, 0, -1.5]),
        box("deck", 0.6, [0, 0.3, 0]),
        box("panel_L", 0.4, [-1.3, 0, 0]),
        box("panel_R", 0.4, [1.3, 0, 0]),
      ],
      wheels: ["wheel_FL", "wheel_FR", "wheel_ML", "wheel_MR", "wheel_RL", "wheel_RR"].map(
        (name, i) => ({
          name,
          hub: [i % 2 === 0 ? -1.1 : 1.1, 0, 1.1 - Math.floor(i / 2) * 1.1] as [number, number, number],
          parts: [box(`${name}-tire`, 0.4, [0, 0, 0])],
        }),
      ),
      mast: null,
      arm: {
        joints: [
          { name: "arm", joint: "azimuth", offset: [0.45149457, 0.91479832, 1.17553592], axis: [0, 1, 0], parts: [] },
          { name: "arm_shoulder", joint: "shoulder", offset: [-0.16599844, -0.09205257, -0.07775922], axis: [0, 0, -1], parts: [] },
          { name: "arm_elbow", joint: "elbow", offset: [-0.78691312, 0.22860408, -0.0218314], axis: [0, 0, -1], parts: [] },
          { name: "arm_wrist", joint: "wrist", offset: [0.75290355, 0.02422731, -0.01918676], axis: [0, 0, -1], parts: [] },
          { name: "arm_turret", joint: "turret", offset: [0.1757079, 0.15246472, -0.06037109], axis: [0, 1, 0], parts: [] },
        ],
      },
      dispose(): void {
        for (const g of geometries) g.dispose();
        material.dispose();
      },
    };
  },
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

async function fixture() {
  const windowStub = new EventTarget();
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", { getElementById: () => null });
  const fetchStub = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchStub);
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const engine = { gpu, tasks: undefined as unknown as TaskScheduler } as Engine;
  const handle = buildMarsShowcaseScene(engine);
  const scene = handle.scene;
  scene.attachToEngine(engine);
  const terrain = scene.object<TerrainWorld>("TerrainWorld")!;
  const population = scene.object<PopulationWorld>("population")!;
  const component = scene.world.getComponent(scene.world.findByName("rover-chassis")[0]!, VehicleComponent)!;
  const context = {
    world: scene.world,
    clock: new Clock(),
    dt: 1 / 60,
    fixedDt: 1 / 60,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    frame: 0,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  } satisfies SystemContext;
  cleanups.push(async () => {
    handle.dispose?.();
    await gpu.dispose();
    expect(gpu.mock.outstanding.buffers).toEqual([]);
    expect(gpu.mock.outstanding.textures).toEqual([]);
  });
  const tick = (): void => {
    context.frame++;
    context.elapsed += context.dt;
    handle.update(context.dt);
    scene.update(context, context.dt);
  };
  const key = (type: "keydown" | "keyup", code: string): void => {
    windowStub.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
  };
  return { handle, scene, terrain, population, component, context, tick, key };
}

describe("Mars Showcase — rock-safe impacts and turret tools", () => {
  it("keeps the rock intact after a hard ram, with no fracture entities or saved break ID", async () => {
    const { handle, scene, terrain, population, component, tick, key } = await fixture();
    const rover = component.vehicle;
    const ground = heightFunctionGround((x: number, z: number) => terrain.getHeightAt(x, z));
    for (let i = 0; i < 120; i++) tick();
    const spawnYaw = rover.yaw;
    // Await the mocked model: it resolves without network or timers, so a microtask pump
    // between ticks is enough (a bare sync loop would never let the promise settle).
    for (let i = 0; i < 60 && !handle.marsState().modelLoaded; i++) {
      tick();
      await Promise.resolve();
    }
    expect(handle.marsState().modelLoaded, "mocked rover model attaches").toBe(true);

    const byName = (name: string): Entity => {
      const id = scene.world.findByName(name)[0];
      expect(id, `entity ${name}`).toBeDefined();
      return scene.world.facade(id!)!;
    };
    const withPrefix = (prefix: string): Entity[] => {
      const out: Entity[] = [];
      for (const id of scene.world.liveEntityIds()) {
        if (!scene.world.name(id).startsWith(prefix)) continue;
        const entity = scene.world.facade(id);
        if (entity) out.push(entity);
      }
      return out;
    };

    // Pristine: no damage anywhere, parts at base, no damage line, stock ride height.
    const pristine = handle.marsState();
    expect([pristine.damageZoneFront, pristine.damageZoneRear, pristine.damageZoneLeft, pristine.damageZoneRight]).toEqual([0, 0, 0, 0]);
    expect(pristine.damageWheels).toEqual([0, 0, 0, 0, 0, 0]);
    expect(pristine.detachedWheels).toEqual([]);
    const nose = byName("rover-body-nose");
    expect(nose.transform.position.z).toBeCloseTo(0, 8);
    const noseRot = nose.transform.rotation;
    expect([noseRot.x, noseRot.y, noseRot.z]).toEqual([0, 0, 0]);
    expect(noseRot.w).toBeCloseTo(1, 8);
    expect(handle.overlay?.() ?? "").not.toContain("damage");
    expect(rover.config.suspensionRest).toBeCloseTo(0.32, 8);

    // Ram targets: mirror the scene's round/flat classification (type 2 flattens Y by 0.38;
    // flat collision radii use raw scales × 0.4/1.2) and take big rocks that shatter at speed.
    interface Target { chunkKey: string; typeId: number; index: number; x: number; z: number; radius: number }
    const collisionRadius = (typeId: number, scales: ArrayLike<number>, p: number): number | null => {
      const base = typeId === 2 ? 2.4 : 0.8;
      const rawSx = scales[p]! * base;
      const rawSy = scales[p + 1]! * base * (typeId === 2 ? 0.62 : 1);
      const rawSz = scales[p + 2]! * base;
      const minDim = Math.min(rawSx, rawSy, rawSz);
      const sy = minDim;
      const sx = rawSx === minDim ? rawSy : rawSx;
      const sz = rawSz === minDim ? rawSy : rawSz;
      if (sy < 0.7 * Math.max(sx, sz)) {
        return Math.max(scales[p]!, scales[p + 2]!) * (typeId === 2 ? 1.2 : 0.4);
      }
      return Math.max(0.12, ((sx + sy + sz) / 3) * 0.55);
    };
    const RAM_GAP = 6;
    const laneClear = (t: Target): boolean => {
      const sx = t.x + 0.35;
      const sz = t.z - RAM_GAP;
      for (const [chunkKey] of terrain.chunks) {
        for (const typeId of [1, 2, 3]) {
          const block = population.chunkPopulation(chunkKey, typeId);
          if (!block) continue;
          for (let i = 0; i < block.count; i++) {
            const p = i * 3;
            if (block.scales[p] === 0 && block.scales[p + 1] === 0) continue;
            if (chunkKey === t.chunkKey && typeId === t.typeId && i === t.index) continue;
            const rx = block.positions[p]!;
            const rz = block.positions[p + 2]!;
            const dx = t.x - sx;
            const dz = t.z - sz;
            const u = Math.min(1, Math.max(0, ((rx - sx) * dx + (rz - sz) * dz) / (dx * dx + dz * dz)));
            // 3.2 m covers the 1.6 m contact reach plus the biggest candidate radii, so a
            // rejected lane can never hide a rock the bumper still reaches.
            if (Math.hypot(rx - (sx + u * dx), rz - (sz + u * dz)) < 3.2) return false;
          }
        }
      }
      return true;
    };
    const candidates: Target[] = [];
    for (const [chunkKey] of terrain.chunks) {
      for (const typeId of [1, 2, 3]) {
        const block = population.chunkPopulation(chunkKey, typeId);
        if (!block) continue;
        for (let i = 0; i < block.count; i++) {
          const p = i * 3;
          if (block.scales[p] === 0 && block.scales[p + 1] === 0) continue;
          const radius = collisionRadius(typeId, block.scales, p);
          if (radius === null || radius < 0.5) continue;
          const x = block.positions[p]!;
          const z = block.positions[p + 2]!;
          if (Math.hypot(x - rover.position.x, z - rover.position.z) > 55) continue;
          candidates.push({ chunkKey, typeId, index: i, x, z, radius });
        }
      }
    }
    // Largest first to guarantee a blocking contact on the front-left corner. Lanes are verified
    // at ram time (teleporting can stream in chunks the spawn scan never saw), and neighboring
    // rocks are excluded so this proves the crush threshold itself is unreachable by the rover.
    candidates.sort((a, b) => b.radius - a.radius);
    expect(candidates.length, "a deep bench of big ram targets near spawn").toBeGreaterThanOrEqual(10);

    /** Drive W into the target; returns the contact speed, or null when the lane is blocked. */
    const ram = (t: Target): number | null => {
      // The target's chunk may have streamed out while ramming elsewhere; wait for it back.
      for (let i = 0; i < 300 && !population.chunkPopulation(t.chunkKey, t.typeId); i++) tick();
      const fresh = population.chunkPopulation(t.chunkKey, t.typeId)!;
      expect(fresh, `chunk ${t.chunkKey} streams back`).toBeTruthy();
      const tx = fresh.positions[t.index * 3]!;
      const tz = fresh.positions[t.index * 3 + 2]!;
      // Teleport beside the lane: the rock lands on the front-LEFT wheel every ram.
      const sx = tx + 0.35;
      const sz = tz - RAM_GAP;
      rover.yaw = spawnYaw;
      rover.yawRate = 0;
      rover.position.set(sx, terrain.getHeightAt(sx, sz) + 1.0, sz);
      rover.placeOnGround(ground);
      key("keydown", "KeyS");
      for (let i = 0; i < 30; i++) tick();
      key("keyup", "KeyS");
      if (!laneClear({ ...t, x: tx, z: tz })) return null;
      const before = handle.marsState().brokenInteractiveRocks;
      key("keydown", "KeyW");
      let contactSpeed = 0;
      for (let i = 0; i < 400; i++) {
        tick();
        contactSpeed = Math.max(contactSpeed, rover.speed);
      }
      key("keyup", "KeyW");
      // Stop at the contact; the target may be pushed, but its fracture state must not change.
      rover.setVelocity(0, 0, 0);
      rover.yawRate = 0;
      key("keydown", "KeyS");
      for (let i = 0; i < 20; i++) tick();
      key("keyup", "KeyS");
      const after = handle.marsState();
      expect(after.brokenInteractiveRocks, "rover impact cannot fracture a rock").toBe(before);
      const snapshot = JSON.parse(handle.saveInteractiveTerrain()) as { brokenRockIds: string[] };
      expect(snapshot.brokenRockIds).not.toContain(`${t.chunkKey}:${t.typeId === 2 ? "boulders" : t.typeId === 3 ? "rocks-b" : "rocks"}:${t.index}`);
      expect(withPrefix("rock-chunk-")).toHaveLength(0);
      expect(withPrefix("rock-pebble-")).toHaveLength(0);
      return contactSpeed;
    };
    const expectAttachedLook = (): void => {
      expect(rover.wheels[0]!.disabled).toBe(false);
      const parts = withPrefix("rover-wheel_FL-part");
      expect(parts.length).toBeGreaterThanOrEqual(1);
      for (const part of parts) expect(part.get(Renderable)?.visible).toBe(true);
      expect(withPrefix("detached-")).toHaveLength(0);
    };

    // A head-on ram may crumple the rover, but never chips the rock. The saved broken-ID set,
    // live fragment entities, and population identity all stay intact after a peak-speed impact.
    let impactSpeed: number | null = null;
    let nextCandidate = 0;
    while (impactSpeed === null && nextCandidate < candidates.length) impactSpeed = ram(candidates[nextCandidate++]!);
    expect(impactSpeed, "a clean lane for a hard rock impact").not.toBeNull();
    const afterRam = handle.marsState();
    expect(afterRam.brokenInteractiveRocks).toBe(0);
    expect(afterRam.detachedWheels).toEqual([]);
    expect(handle.saveInteractiveTerrain()).not.toContain('"brokenRockIds":["');
    expect(withPrefix("rock-chunk-")).toHaveLength(0);
    expect(withPrefix("rock-pebble-")).toHaveLength(0);
    expect(rover.wheels[0]!.disabled).toBe(false);
    for (const part of withPrefix("rover-wheel_FL-part")) expect(part.get(Renderable)?.visible).toBe(true);
    expect(withPrefix("detached-")).toHaveLength(0);
    expectAttachedLook();
    // If this heavy target blocks rather than rolling away, the independent vehicle-damage path
    // still reports localized contact without granting the rover enough crush force to split it.
    if (afterRam.damageZoneFront > 0) {
      expect(afterRam.damageZoneFront).toBeGreaterThan(afterRam.damageZoneRear);
      expect(afterRam.damageZoneRear).toBeLessThan(0.05);
    }
  });

  it("unfolds, auto-aligns and drills a reachable small rock; dust, a hole and rubble remain visible", async () => {
    const { handle, scene, terrain, population, component, context, tick } = await fixture();
    const rover = component.vehicle;
    const sceneOnlyTick = (): void => {
      context.frame++;
      context.elapsed += context.dt;
      scene.update(context, context.dt);
    };
    for (let i = 0; i < 12 && !handle.marsState().modelLoaded; i++) await Promise.resolve();
    expect(handle.marsState().modelLoaded).toBe(true);
    // Populate the spawn tiles without calling handle.update: the synthetic target is installed
    // before the interaction layer promotes any instance to a proxy.
    for (let i = 0; i < 180; i++) sceneOnlyTick();

    let target: { chunkKey: string; block: NonNullable<ReturnType<PopulationWorld["chunkPopulation"]>>; index: number } | null = null;
    for (const [chunkKey] of terrain.chunks) {
      const block = population.chunkPopulation(chunkKey, 1);
      if (!block) continue;
      for (let index = 0; index < block.count; index++) {
        const p = index * 3;
        if (block.scales[p] === 0 || block.scales[p + 1] === 0) continue;
        const id = `${chunkKey}:rocks:${index}`;
        if (shouldSplitRockDuringDrilling({ id, radius: 0.3, isFlat: false, thickness: 0.6 }, 0)) continue;
        target = { chunkKey, block, index };
        break;
      }
      if (target) break;
    }
    expect(target, "a nearby round instance suitable for the deterministic non-split drill pass").not.toBeNull();

    const targetX = rover.position.x;
    const targetZ = rover.position.z + 2.384;
    for (const [chunkKey] of terrain.chunks) {
      for (const typeId of [1, 2, 3]) {
        const block = population.chunkPopulation(chunkKey, typeId);
        if (!block) continue;
        let changed = false;
        for (let index = 0; index < block.count; index++) {
          if (block === target!.block && typeId === 1 && index === target!.index) continue;
          const p = index * 3;
          if (Math.hypot(block.positions[p]! - rover.position.x, block.positions[p + 2]! - rover.position.z) >= 10) continue;
          block.scales[p] = 0;
          block.scales[p + 1] = 0;
          block.scales[p + 2] = 0;
          changed = true;
        }
        if (changed) block.markModified();
      }
    }
    const p = target!.index * 3;
    const rockScale = 0.68; // 0.8 m procedural geometry × scale × 0.55 proxy factor ≈ 0.30 m radius.
    target!.block.scales[p] = rockScale;
    target!.block.scales[p + 1] = rockScale;
    target!.block.scales[p + 2] = rockScale;
    target!.block.positions[p] = targetX;
    target!.block.positions[p + 2] = targetZ;
    target!.block.rotations[target!.index] = 0;
    target!.block.snapY(target!.index, terrain.getHeightAt(targetX, targetZ) + rockScale * 0.4);
    target!.block.markModified();
    const targetId = `${target!.chunkKey}:rocks:${target!.index}`;

    handle.setArm(true);
    for (let i = 0; i < 480 && (!handle.marsState().armUnfolded || handle.marsState().toolPrompt === null); i++) tick();
    const ready = handle.marsState();
    expect(ready.armUnfolded, "the mock GLB supplies all five real arm pivots").toBe(true);
    expect(ready.toolPrompt, "an arm-reachable rock exposes the tool prompt").not.toBeNull();
    expect(ready.toolTargetId).toBe(targetId);
    expect(handle.useTool("drill")).toBe(true);
    expect(handle.marsState().toolAction).toBe("drill");

    let sawWorking = false;
    for (let i = 0; i < 900; i++) {
      tick();
      const state = handle.marsState();
      if (state.toolPhase === "working") sawWorking = true;
      if (state.drilledRocks === 1 && state.toolPhase === "idle") break;
    }
    const drilled = handle.marsState();
    expect(sawWorking, "the arm completes its approach/alignment phase before drilling").toBe(true);
    expect(drilled.toolPhase).toBe("idle");
    expect(drilled.drilledRocks).toBe(1);
    expect(drilled.drillSplits).toBe(0);
    expect(drilled.toolLastResult).toContain("CORE DRILLED");
    expect(drilled.toolMarks).toBeGreaterThanOrEqual(2);
    expect(drilled.toolRubble).toBeGreaterThanOrEqual(5);
    expect(drilled.toolDust).toBeGreaterThan(0);
    const marks: Entity[] = [];
    for (const id of scene.world.liveEntityIds()) {
      if (!scene.world.name(id).startsWith("rover-tool-hole-")) continue;
      const entity = scene.world.facade(id);
      if (entity) marks.push(entity);
    }
    expect(marks.length).toBe(1);
    expect(marks[0]!.get(Renderable)?.visible).toBe(true);

    // The two optional turret modes share the same proximity/servo path: abrasion leaves another
    // physical trace, while the simulated PIXL pass reports a deterministic material reading.
    expect(handle.useTool("abrade")).toBe(true);
    for (let i = 0; i < 900 && (handle.marsState().abradedRocks === 0 || handle.marsState().toolPhase !== "idle"); i++) tick();
    expect(handle.marsState().abradedRocks).toBe(1);
    expect(handle.marsState().toolLastResult).toContain("SURFACE ABRADED");
    expect(handle.useTool("analyze")).toBe(true);
    for (let i = 0; i < 900 && (handle.marsState().analyzedRocks === 0 || handle.marsState().toolPhase !== "idle"); i++) tick();
    expect(handle.marsState().analyzedRocks).toBe(1);
    expect(handle.marsState().toolLastResult).toContain("PIXL SAMPLE");
  });
});
