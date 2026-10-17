/**
 * @suite scene:sceneSave
 * @group integration
 * @covers engine/src/scene/serialization.ts
 * @covers engine/src/scene/scene.ts
 * @covers engine/src/scene/components.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/environment/dayNight.ts
 * @covers engine/src/environment/weather.ts
 * @covers engine/src/terrain/world.ts
 * @covers engine/src/scripting/component.ts
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/index.ts
 * @desc Phase 19.1/19.2: versioned scene saves — entities, components, hierarchy and transforms round-trip by registered name and file key, asset references resolve, nothing is lost silently, scene objects carry their state, and version-1 files migrate
 */

export const suite = {
  name: "scene:sceneSave",
  group: "integration",
  covers: [
    "engine/src/scene/serialization.ts",
    "engine/src/scene/scene.ts",
    "engine/src/scene/components.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/environment/dayNight.ts",
    "engine/src/environment/weather.ts",
    "engine/src/terrain/world.ts",
    "engine/src/scripting/component.ts",
    "engine/src/scripting/runtime.ts",
    "engine/src/index.ts",
  ],
  desc: "Phase 19.1/19.2: versioned scene saves — entities, components, hierarchy and transforms round-trip by registered name and file key, asset references resolve, nothing is lost silently, scene objects carry their state, and version-1 files migrate",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Camera,
  Clock,
  Component,
  DayNightCycle,
  Light,
  LogLevel,
  Logger,
  Profiler,
  Quat,
  Renderable,
  Script,
  ScriptComponent,
  ScriptRuntime,
  SCENE_SAVE_FORMAT,
  SCENE_SAVE_VERSION,
  Scene,
  SystemScratch,
  TerrainWorld,
  Vec3,
  WeatherSystem,
  loadScene,
  migrateSceneSave,
  migrateSceneSaveV1,
  registerComponent,
  registerSceneSaveMigration,
  saveScene,
  terrainOptionsFromState,
  type Entity,
  type SystemContext,
} from "@forge/engine";

/** A component whose constructor throws: the loader must skip it, not abort. */
class Fragile extends Component {
  level = 1;
  constructor() {
    super();
    if (Fragile.armed) throw new Error("Fragile: refuses to load");
  }
  static armed = false;
}
registerComponent(Fragile as never, { name: "SaveTestFragile" });

/** Never registered: the saver has no stable name for it. */
class Unregistered extends Component {
  value = 3;
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const geometryA = { label: "rock-mesh" };
const materialA = { label: "rock-mat" };

function buildScene(): { scene: Scene; root: Entity; arm: Entity; hand: Entity } {
  const scene = new Scene({ name: "save-test" });
  scene.settings.exposure = 1.7;
  // Child created before its parent, a duplicate name and an unnamed entity: parents go by key.
  const hand = scene.createTransformedEntity("part", new Vec3(0, 0.5, 0));
  const root = scene.createTransformedEntity("root", new Vec3(10, 2, -4));
  const arm = scene.createTransformedEntity("part", new Vec3(0, 1, 0));
  arm.parent = root;
  hand.parent = arm;
  const q = new Quat().setEulerComponents(0.3, 1.1, -0.2);
  root.transform.rotation = q;
  root.transform.scale = new Vec3(2, 3, 4);
  // A system writing storage directly (as physics does): the save must see the stored pose.
  scene.world.transforms.setPosition(scene.world.transformSlot(arm.id), 7, 8, 9);
  const light = new Light();
  light.kind = "spot";
  light.intensity = 12.5;
  light.color.set(1, 0.5, 0.25);
  light.castShadow = false;
  root.add(light);
  const cam = new Camera();
  cam.fovY = 0.9;
  cam.far = 4321;
  cam.enabled = false;
  scene.createEntity("").add(cam);
  const r = new Renderable();
  r.geometry = geometryA as never;
  r.material = materialA as never;
  r.tint = 0xff00ff00;
  r.castShadow = false;
  hand.add(r);
  return { scene, root, arm, hand };
}

const assets = {
  assetId: (v: object) => (v === geometryA ? { kind: "geometry", id: "rock" } : v === materialA ? { kind: "material", id: "rock" } : undefined),
  resolveAsset: (kind: string, id: string) => (kind === "geometry" && id === "rock" ? geometryA : kind === "material" && id === "rock" ? materialA : undefined),
};

group("scene saves round-trip (19.1)", () => {
  test("entities, hierarchy, transforms and components survive a JSON round trip, and a re-save is identical", () => {
    const { scene } = buildScene();
    const { save, report } = saveScene(scene, assets);
    assert.equal(save.format, SCENE_SAVE_FORMAT);
    assert.equal(save.version, SCENE_SAVE_VERSION);
    assert.equal(report.entities, 4);
    assert.deepEqual(report.dropped, []);
    const types = save.entities.flatMap((e) => e.components.map((c) => c.type)).sort();
    assert.deepEqual(types, ["Camera", "Light", "Renderable", "Transform", "Transform", "Transform"], "registered names, not constructor names");

    const copy = new Scene({ name: "blank" });
    const loaded = copy.applySerialized(json(save), { resolveAsset: assets.resolveAsset });
    assert.equal(loaded.from, SCENE_SAVE_VERSION);
    assert.deepEqual(loaded.skipped, []);
    assert.deepEqual(loaded.unresolvedAssets, []);
    assert.equal(copy.name, "save-test");
    assert.equal(copy.settings.exposure, 1.7);

    const resave = saveScene(copy, assets).save;
    assert.deepEqual(json(resave), json(save), "save → load → save is the identity");
  });

  test("parents resolve by key (child before parent, duplicate names), and the stored pose wins over the mirror", () => {
    const { scene } = buildScene();
    const copy = new Scene();
    copy.applySerialized(json(scene.serialize(assets)), { resolveAsset: assets.resolveAsset });
    const parts = copy.world.findByName("part").map((id) => copy.world.facade(id)!);
    const root = copy.world.facade(copy.world.findByName("root")[0]!)!;
    const arm = parts.find((p) => p.parent?.id === root.id)!;
    const hand = parts.find((p) => p.parent?.id === arm.id)!;
    assert.ok(arm && hand, "both duplicate-named entities keep their own parent");
    assert.deepEqual([...arm.transform.position.toArray()], [7, 8, 9], "the pose written to storage, not the stale mirror");
    const r = root.transform.rotation;
    const q = new Quat().setEulerComponents(0.3, 1.1, -0.2);
    for (const [a, b] of [[r.x, q.x], [r.y, q.y], [r.z, q.z], [r.w, q.w]] as const) assert.ok(Math.abs(a - b) < 1e-6, "rotation round-trips");
    assert.deepEqual([...root.transform.scale.toArray()], [2, 3, 4]);
    const light = root.get(Light)!;
    assert.equal(light.kind, "spot");
    assert.equal(light.intensity, 12.5);
    assert.deepEqual([light.color.x, light.color.y, light.color.z], [1, 0.5, 0.25]);
    assert.equal(light.castShadow, false);
    const cam = copy.world.store(Camera).valueAt(0);
    assert.equal(cam.enabled, false, "a disabled component stays disabled");
    assert.equal(cam.far, 4321);
    const rend = hand.get(Renderable)!;
    assert.equal(rend.geometry as unknown, geometryA, "asset references resolve to the loader's objects");
    assert.equal(rend.material as unknown, materialA);
    assert.equal(rend.tint, 0xff00ff00);
  });

  test("nothing is lost silently: object fields without an asset id are reported, once per type and field", () => {
    const { scene } = buildScene();
    scene.createTransformedEntity("second", new Vec3()).add(Object.assign(new Renderable(), { geometry: geometryA }));
    const { report } = saveScene(scene);
    assert.deepEqual(report.dropped.map((d) => `${d.type}.${d.field}`).sort(), ["Renderable.geometry", "Renderable.material"]);
    assert.throws(() => scene.createEntity("x").add(new Unregistered()), /not registered/, "an unregistered component never reaches a save");
  });

  test("loading reports what it cannot use and still loads the rest", () => {
    const { scene, hand } = buildScene();
    hand.add(new Fragile());
    const save = json(scene.serialize(assets));
    save.entities[0]!.components.push({ type: "NoSuchComponent", data: { x: 1 } });
    Fragile.armed = true;
    try {
      const copy = new Scene();
      const report = loadScene(copy, save); // no resolveAsset
      assert.deepEqual(report.skipped.map((s) => `${s.type}: ${s.reason}`).sort(), ["NoSuchComponent: type is not registered in this build", "SaveTestFragile: Fragile: refuses to load"]);
      assert.deepEqual(report.unresolvedAssets, [{ kind: "geometry", id: "rock" }, { kind: "material", id: "rock" }]);
      assert.equal(report.entities, 4);
      assert.equal(copy.world.store(Light).count, 1, "the rest of the scene loaded");
    } finally {
      Fragile.armed = false;
    }
  });
});

group("scene objects carry their state (environment, terrain settings)", () => {
  test("day/night and weather state round-trip onto the objects of the same name", () => {
    const scene = new Scene();
    const cycle = new DayNightCycle({ latitude: -33.9, longitude: 18.4, timeOfDay: 6.25, dayOfYear: 300, year: 2031, timeScale: 120 });
    const weather = new WeatherSystem({ seed: 77, initial: "storm", target: "clear" });
    scene.add(cycle);
    scene.add(weather);
    cycle.advance(90);
    weather.surface.wetness = 0.4;
    weather.surface.snow = 0.1;
    weather.driveVehicles = false;
    const save = json(scene.serialize());

    const copy = new Scene();
    const cycle2 = new DayNightCycle();
    const weather2 = new WeatherSystem({ seed: 77 });
    copy.add(cycle2);
    copy.add(weather2);
    const report = copy.applySerialized(save);
    assert.deepEqual(report.objects.applied.sort(), ["dayNight", "weather"]);
    assert.deepEqual(report.objects.warnings, []);
    for (const k of ["latitude", "longitude", "timeOfDay", "dayOfYear", "year", "timeScale", "simulatedSeconds"] as const) assert.equal(cycle2[k], cycle[k], k);
    assert.deepEqual({ ...weather2.state }, { ...weather.state });
    assert.deepEqual({ ...weather2.target }, { ...weather.target });
    assert.deepEqual({ ...weather2.surface }, { ...weather.surface });
    assert.equal(weather2.driveVehicles, false);
    assert.deepEqual(json(copy.serialize()).objects, save.objects, "and re-save identically");
  });

  test("missing objects, mismatched types and construction-time differences are reported", () => {
    const scene = new Scene();
    scene.add(new DayNightCycle({ name: "sky" }));
    scene.add(new WeatherSystem({ name: "weather", seed: 5 }));
    const save = json(scene.serialize());
    const copy = new Scene();
    copy.add(new WeatherSystem({ name: "sky" })); // same name, wrong type
    copy.add(new WeatherSystem({ name: "weather", seed: 6 }));
    const report = copy.applySerialized(save);
    assert.deepEqual(report.objects.mismatched, [{ name: "sky", saved: "DayNightCycle", actual: "WeatherSystem" }]);
    assert.deepEqual(report.objects.warnings, ["weather: seed 5 differs from this system's 6 (set at construction)"]);
    const lonely = new Scene();
    assert.deepEqual(lonely.applySerialized(save).objects.missing.sort(), ["sky", "weather"]);
  });

  test("terrain settings: a save names the generator, and terrainOptionsFromState rebuilds a world that matches it", () => {
    const terrain = new TerrainWorld({ seed: 4242, chunkSize: 64, chunkResolution: 17, viewDistance: 300, maxLOD: 3, horizonSkirt: false, syncGeneration: true });
    const state = json(terrain.saveState());
    assert.equal(state["seed"], 4242);
    assert.ok(state["pipeline"] && typeof state["pipeline"] === "object", "the default pipeline is describable");
    const rebuilt = new TerrainWorld({ ...terrainOptionsFromState(state), horizonSkirt: false, syncGeneration: true });
    assert.deepEqual(rebuilt.loadState(state), []);
    assert.equal(rebuilt.pipelineHash, terrain.pipelineHash, "same generator, same hash");
    const other = new TerrainWorld({ seed: 1, chunkSize: 64, chunkResolution: 17, horizonSkirt: false, syncGeneration: true });
    const warnings = other.loadState(state);
    assert.ok(warnings.some((w) => w.startsWith("seed 4242 differs")), warnings.join("; "));
    terrain.dispose?.();
    rebuilt.dispose?.();
    other.dispose?.();
  });
});

group("scripts in a save", () => {
  class Guard extends Script {
    hp = 10;
    readonly home = new Vec3();
    target: object | null = null;
    seenAtCreate = -1;
    override onCreate(): void {
      this.seenAtCreate = this.hp;
    }
  }

  test("a script's data fields and enabled flag come back before onCreate; object fields are reported", () => {
    const scene = new Scene();
    const runtime = ScriptRuntime.install(scene.world);
    runtime.define("Guard", Guard);
    const g = new Guard();
    g.hp = 3;
    g.home.set(4, 5, 6);
    g.target = { any: "object" };
    g.enabled = false;
    scene.createEntity("guard").add(new ScriptComponent(g));
    const { save, report } = saveScene(scene);
    assert.deepEqual(report.dropped.map((d) => `${d.type}.${d.field}`), ["Script:Guard.target"]);

    const copy = new Scene();
    const rt2 = ScriptRuntime.install(copy.world);
    rt2.define("Guard", Guard);
    const loaded = copy.applySerialized(json(save));
    assert.deepEqual(loaded.skipped, []);
    const restored = copy.world.store(ScriptComponent).valueAt(0).scripts[0] as Guard;
    assert.ok(restored instanceof Guard && restored !== g);
    assert.equal(restored.hp, 3);
    assert.deepEqual([...restored.home.toArray()], [4, 5, 6]);
    assert.equal(restored.target, null, "a dropped field keeps the constructor's value");
    assert.equal(restored.enabled, false);
    restored.enabled = true;
    runtime.dispose();
    rt2.dispose();
    copy.dispose();
  });

  test("onCreate sees the restored data, and a script the loading runtime does not define is a script error", () => {
    const scene = new Scene();
    const runtime = ScriptRuntime.install(scene.world);
    runtime.define("Guard", Guard);
    const g = new Guard();
    g.hp = 42;
    scene.createEntity("guard").add(new ScriptComponent(g));
    const save = json(scene.serialize());
    const copy = new Scene();
    const rt2 = ScriptRuntime.install(copy.world);
    rt2.define("Guard", Guard);
    copy.applySerialized(save);
    const c: SystemContext = {
      world: copy.world,
      clock: new Clock(),
      dt: 1 / 60,
      fixedDt: 1 / 60,
      fixedSteps: 1,
      alpha: 0,
      elapsed: 1 / 60,
      frame: 1,
      logger: new Logger({ level: LogLevel.Silent }),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    };
    copy.update(c, c.dt);
    const restored = copy.world.store(ScriptComponent).valueAt(0).scripts[0] as Guard;
    assert.equal(restored.seenAtCreate, 42);

    const bare = new Scene();
    const rt3 = ScriptRuntime.install(bare.world);
    bare.applySerialized(save);
    assert.equal(rt3.errors.length, 1);
    assert.match(rt3.errors[0]!.message, /unknown script "Guard"/);
    for (const r of [runtime, rt2, rt3]) r.dispose();
  });
});

group("versioned save format (19.2)", () => {
  test("a version-1 file (parents by name) migrates and loads", () => {
    const v1 = {
      version: 1,
      name: "old",
      settings: { exposure: 0.8 },
      objects: [{ name: "dayNight", type: "DayNightCycle" }],
      entities: [
        { name: "child", id: 9, parent: "base", components: [{ type: "Transform", data: { position: [1, 2, 3] } }] },
        { name: "base", id: 4, components: [{ type: "Transform", data: { position: [5, 0, 0] } }, { type: "Light", data: { intensity: 3 } }] },
      ],
    };
    const { save, from } = migrateSceneSave(json(v1));
    assert.equal(from, 1);
    assert.equal(save.version, 2);
    assert.equal(save.format, SCENE_SAVE_FORMAT);
    assert.deepEqual(save.entities.map((e) => [e.key, e.name, e.parent]), [[0, "child", 1], [1, "base", undefined]]);
    const scene = new Scene();
    const report = scene.applySerialized(json(v1));
    assert.equal(report.from, 1);
    assert.deepEqual(report.skipped, []);
    const child = scene.world.facade(scene.world.findByName("child")[0]!)!;
    assert.equal(child.parent?.name, "base");
    assert.deepEqual([...child.transform.position.toArray()], [1, 2, 3]);
    assert.equal(scene.settings.exposure, 0.8);
  });

  test("refuses what it cannot read, with the reason", () => {
    assert.throws(() => migrateSceneSave(null), /expected a JSON object/);
    assert.throws(() => migrateSceneSave({ entities: [] }), /missing or invalid version/);
    assert.throws(() => migrateSceneSave({ format: SCENE_SAVE_FORMAT, version: SCENE_SAVE_VERSION + 1, entities: [] }), /written by a newer build/);
    assert.throws(() => migrateSceneSave({ version: 2, entities: [] }), /format is not "forge.scene"/);
    assert.throws(() => registerSceneSaveMigration(SCENE_SAVE_VERSION, (d) => d), /has no successor/);
  });

  test("a registered migration replaces the step and its output version is checked", () => {
    registerSceneSaveMigration(1, (d) => d);
    try {
      assert.throws(() => migrateSceneSave({ version: 1, entities: [] }), /migration from version 1 produced version 1/);
    } finally {
      registerSceneSaveMigration(1, migrateSceneSaveV1);
    }
    assert.equal(migrateSceneSave({ version: 1, entities: [] }).save.version, 2, "the shipped step is back");
  });
});

await finish();
