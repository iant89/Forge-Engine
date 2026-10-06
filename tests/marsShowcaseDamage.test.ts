/**
 * Area-dependent visible vehicle damage on the Mars Showcase assembly. The rover model is
 * mocked with procedural boxes at known model-space positions (the real 10 MB GLB never loads,
 * so no network or image decoder is needed): full-speed rams must crush the rammed nose, bend
 * then tear off the struck wheel, drop it as a prop, and report everything through marsState
 * and the overlay — while the far side and tail stay pristine.
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
      arm: null,
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
  return { handle, scene, terrain, population, component, tick, key };
}

describe("Mars Showcase — area-dependent vehicle damage", () => {
  it("rams crush the struck nose, bend then tear off the hit wheel, and report it all", async () => {
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
    // Smallest first so the wheel bends before it breaks. Lanes are verified at ram time
    // (teleporting 50 m streams in chunks the spawn scan never saw); blocked lanes are
    // skipped so every ram is exactly one rock on the front-left wheel.
    candidates.sort((a, b) => a.radius - b.radius);
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
        contactSpeed = rover.speed;
        if (handle.marsState().brokenInteractiveRocks > before) break;
      }
      key("keyup", "KeyW");
      // Stop dead at the impact: braking through would overrun into rocks past the target
      // (ram speeds reach 6+ m/s downhill), and the next ram teleports away regardless.
      rover.setVelocity(0, 0, 0);
      rover.yawRate = 0;
      key("keydown", "KeyS");
      for (let i = 0; i < 20; i++) tick();
      key("keyup", "KeyS");
      expect(handle.marsState().brokenInteractiveRocks - before, "a clean lane breaks exactly its rock").toBe(1);
      return contactSpeed;
    };
    const logState = (tag: string, v: number): void => {
      const s = handle.marsState();
      console.log(
        `${tag} (${v.toFixed(2)} m/s): zones F${s.damageZoneFront.toFixed(2)} R${s.damageZoneRear.toFixed(2)} ` +
        `L${s.damageZoneLeft.toFixed(2)} R${s.damageZoneRight.toFixed(2)} wheels ${s.damageWheels.map((w: number) => w.toFixed(2)).join(",")}`,
      );
    };
    const expectAttachedLook = (): void => {
      expect(rover.wheels[0]!.disabled).toBe(false);
      const parts = withPrefix("rover-wheel_FL-part");
      expect(parts.length).toBeGreaterThanOrEqual(1);
      for (const part of parts) expect(part.get(Renderable)?.visible).toBe(true);
      expect(withPrefix("detached-")).toHaveLength(0);
    };

    // Ram 1: the nose crushes in, the front-left wheel bends, the overlay reports. One ram
    // can never detach (max single hit 0.65 < 1), so FL is guaranteed still attached here.
    let v1: number | null = null;
    let nextCandidate = 0;
    while (v1 === null && nextCandidate < candidates.length) v1 = ram(candidates[nextCandidate++]!);
    expect(v1, "a first ram with a clear lane").not.toBeNull();
    logState("after ram 1", v1!);
    const s1 = handle.marsState();
    expect(s1.damageZoneFront).toBeGreaterThan(0.08);
    expect(s1.damageZoneFront).toBeGreaterThan(
      2 * (s1.damageZoneRear + s1.damageZoneLeft + s1.damageZoneRight),
    );
    expect(s1.damageWheels[0]).toBeGreaterThan(0.15);
    expect(s1.detachedWheels).toEqual([]);
    expect(rover.wheels[0]!.bend).toBeGreaterThan(0);
    expect(nose.transform.position.z).toBeLessThan(byName("rover-body-tail").transform.position.z - 0.01);
    expect(byName("rover-body-deck").transform.position.z).toBeCloseTo(0, 8);
    expect(handle.overlay?.() ?? "").toContain("damage");
    expectAttachedLook();

    // Keep ramming (skipping blocked lanes) until FL tears off: meshes hidden, wreckage
    // dropped, rover drives on five wheels.
    while (handle.marsState().detachedWheels.length === 0 && nextCandidate < candidates.length) {
      const v = ram(candidates[nextCandidate++]!);
      if (v !== null) {
        logState("after ram", v);
        if (handle.marsState().detachedWheels.length === 0) expectAttachedLook();
      }
    }
    const s3 = handle.marsState();
    expect(s3.detachedWheels).toEqual([0]);
    expect(rover.wheels[0]!.disabled).toBe(true);
    expect(rover.wheels[0]!.driven).toBe(false);
    for (const part of withPrefix("rover-wheel_FL-part")) {
      expect(part.get(Renderable)?.visible).toBe(false);
    }
    expect(withPrefix("detached-").length).toBeGreaterThanOrEqual(1);
    expect(s3.contactWheels).toBeLessThanOrEqual(5);
    // Area-dependent: the far side and tail are essentially untouched.
    expect(s3.damageWheels[1]).toBeLessThan(0.05);
    for (const i of [2, 3, 4, 5]) expect(s3.damageWheels[i]).toBeLessThan(0.05);
    expect(s3.damageZoneFront).toBeGreaterThan(0.5);
    expect(s3.damageZoneRear).toBeLessThan(0.05);
    expect(s3.damageZoneRight).toBeLessThan(0.05);
    expect(handle.overlay?.() ?? "").toContain("✕");
  });
});
