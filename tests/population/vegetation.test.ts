/**
 * @suite population:vegetation
 * @group unit
 * @covers engine/src/population/tree.ts
 * @covers engine/src/population/grass.ts
 * @covers engine/src/population/vegetation.ts
 * @covers engine/src/terrain/trackWeather.ts
 * @covers engine/src/environment/moistureField.ts
 * @desc Pins procedural trees (hierarchy, LOD, determinism, leaf alpha) and bushes, grass patches (density LOD), the vegetation field's LOD/visibility/sway, and track weather grip + moisture overlay
 */

export const suite = {
  name: "population:vegetation",
  group: "unit",
  covers: [
    "engine/src/population/tree.ts",
    "engine/src/population/grass.ts",
    "engine/src/population/vegetation.ts",
    "engine/src/terrain/trackWeather.ts",
    "engine/src/environment/moistureField.ts",
  ],
  desc: "Pins procedural trees (hierarchy, LOD, determinism, leaf alpha) and bushes, grass patches (density LOD), the vegetation field's LOD/visibility/sway, and track weather grip + moisture overlay",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  GroundMoistureField,
  Quat,
  Renderable,
  Scene,
  TRACK_GROUND_CONDITIONS,
  TrackSpline,
  TrackTerrain,
  TrackWeatherGround,
  Transform,
  VegetationField,
  barkPixels,
  createMeltEnvironment,
  generateBush,
  generateTree,
  grassBladePixels,
  grassPatchSource,
  leafCardPixels,
  triangleCount,
  type Geometry,
  type Material,
  type TreeSpecies,
} from "@forge/engine";

const MAPLE: TreeSpecies = { name: "maple", height: [10, 14], shape: "round" };

group("procedural trees", () => {
  test("hi and lo trees: same seed same tree, lo is much cheaper, sizes plausible", () => {
    const a = generateTree(MAPLE, 42, "hi");
    const b = generateTree(MAPLE, 42, "hi");
    assert.deepEqual(Array.from(a.wood.positions.slice(0, 30)), Array.from(b.wood.positions.slice(0, 30)));
    assert.equal(a.leaves.positions.length, b.leaves.positions.length);
    const lo = generateTree(MAPLE, 42, "lo");
    const hiTris = triangleCount(a.wood) + triangleCount(a.leaves);
    const loTris = triangleCount(lo.wood) + triangleCount(lo.leaves);
    assert.ok(loTris < hiTris * 0.4, `lo ${loTris} vs hi ${hiTris}`);
    assert.ok(a.height > 9 && a.height < 18, `height ${a.height}`);
    assert.ok(a.crownRadius > 1.5 && a.crownRadius < 9, `crown ${a.crownRadius}`);
    // Same skeleton: the lo trunk base ring sits where the hi one does.
    assert.ok(Math.abs(lo.wood.positions[1]! - a.wood.positions[1]!) < 1e-6);
    // Different seed → a different tree.
    const c = generateTree(MAPLE, 43, "hi");
    assert.notEqual(c.leaves.positions[0], a.leaves.positions[0]);
  });

  test("branch hierarchy: more levels → more wood; leaves sit in the crown, not on the bole", () => {
    const one = generateTree({ ...MAPLE, levels: 1 }, 7, "hi");
    const three = generateTree({ ...MAPLE, levels: 3 }, 7, "hi");
    assert.ok(triangleCount(three.wood) > triangleCount(one.wood) * 3);
    const t = generateTree({ ...MAPLE, clearBole: 0.4 }, 9, "hi");
    let minY = Infinity;
    for (let k = 1; k < t.leaves.positions.length; k += 3) minY = Math.min(minY, t.leaves.positions[k]!);
    assert.ok(minY > 2, `lowest leaf at ${minY.toFixed(2)} m`);
    for (const v of t.leaves.normals!) assert.ok(Number.isFinite(v));
  });

  test("leaf and bark textures: alpha silhouette, white-balanced for tinting", () => {
    for (const shape of ["maple", "oval", "birch"] as const) {
      const px = leafCardPixels(64, shape, 1);
      let opaque = 0;
      for (let k = 3; k < px.length; k += 4) if (px[k]! > 0) opaque++;
      const frac = opaque / (64 * 64);
      assert.ok(frac > 0.12 && frac < 0.8, `${shape} coverage ${frac.toFixed(2)}`);
    }
    const bark = barkPixels(32, "birch");
    assert.ok(bark[0]! > 40);
  });

  test("bushes: several stems from one root crown, deterministic, lo cheaper, shrub-sized", () => {
    const spec = { name: "shrub", height: [1.2, 2.4] as [number, number], stems: 5, spread: 0.5 };
    const a = generateBush(spec, 7, "hi");
    const b = generateBush(spec, 7, "hi");
    assert.deepEqual(Array.from(a.leaves.positions.slice(0, 30)), Array.from(b.leaves.positions.slice(0, 30)));
    const one = generateBush({ ...spec, stems: 1 }, 7, "hi");
    assert.ok(triangleCount(a.wood) > triangleCount(one.wood) * 3, "five stems carry several times one stem's wood");
    const lo = generateBush(spec, 7, "lo");
    assert.ok(triangleCount(lo.wood) + triangleCount(lo.leaves) < triangleCount(a.wood) + triangleCount(a.leaves));
    assert.ok(a.height > 1 && a.height < 3.2, `height ${a.height}`);
    assert.ok(a.crownRadius > 0.3 && a.crownRadius < 3, `crown ${a.crownRadius}`);
    // Every stem starts at the root crown, sunk like a tree trunk (0.3 m, so slopes never float it).
    let minY = Infinity;
    for (let k = 1; k < a.wood.positions.length; k += 3) minY = Math.min(minY, a.wood.positions[k]!);
    assert.ok(minY > -0.32 && minY < 0, `wood min y ${minY}`);
    // Tangents travel with the rotated stems (normal-mapped cards stay lit).
    assert.equal(a.leaves.tangents!.length / 4, a.leaves.positions.length / 3);
  });
});

group("procedural grass", () => {
  test("patch: blades rooted below ground, lo keeps a third of the blades", () => {
    const hi = grassPatchSource({ blades: 60, seed: 3, sink: 0.05 }, "hi");
    const lo = grassPatchSource({ blades: 60, seed: 3, sink: 0.05 }, "lo");
    assert.equal(triangleCount(hi), 60 * 5);
    assert.equal(triangleCount(lo), 20);
    let minY = Infinity, maxY = -Infinity;
    for (let k = 1; k < hi.positions.length; k += 3) {
      minY = Math.min(minY, hi.positions[k]!);
      maxY = Math.max(maxY, hi.positions[k]!);
    }
    assert.ok(Math.abs(minY + 0.05) < 1e-6);
    assert.ok(maxY > 0.2 && maxY < 0.6);
    const px = grassBladePixels(4, 16);
    assert.ok(px[0]! > px[(15 * 4) * 4]!, "tip lighter than root");
  });
});

group("vegetation field", () => {
  const geo = (n: string): Geometry => ({ label: n }) as unknown as Geometry;
  const mat = (): Material & { cover: number[] } => {
    const m = { cover: [] as number[], setSnowCover(a: number, _l: number, w: number) { m.cover = [a, w]; } };
    return m as unknown as Material & { cover: number[] };
  };

  test("LOD and visibility by viewer distance; sway leans downwind; weather reaches materials", () => {
    const scene = new Scene();
    const viewer = { x: 0, y: 0, z: 0 };
    const leafMat = mat();
    const hi = geo("hi"), lo = geo("lo");
    const field = new VegetationField({
      models: [{ parts: [{ hi, lo, material: leafMat }], lodDistance: 10, maxDistance: 50, sway: { maxBend: 0.5, halfBendWind: 5 }, swayDistance: 20 }],
      viewer: () => viewer,
      wind: () => ({ x: 8, z: 0 }),
    });
    field.add(0, 5, 0, 0);
    field.add(0, 30, 0, 0);
    field.add(0, 80, 0, 0);
    scene.add(field);
    field.update({} as never, 0.016);
    const renderables = (): number[] => {
      const st = scene.world.store(Renderable);
      const out: number[] = [];
      for (let i = 0; i < st.count; i++) out.push(scene.world.idForSlot(st.slotAt(i)) as unknown as number);
      return out;
    };
    const ids = renderables() as never[];
    assert.equal(ids.length, 3);
    assert.equal(field.stats_.hi, 1);
    assert.equal(field.stats_.lo, 1);
    assert.equal(field.stats_.hidden, 1);
    // The near plant leans downwind (+x): its local up rotates toward +x.
    const near = ids.find((id) => scene.world.getComponent(id, Transform)!.position.x === 5)!;
    const q = scene.world.getComponent(near, Transform)!.rotation as Quat;
    const up = q.rotateVector({ x: 0, y: 1, z: 0 } as never, { x: 0, y: 0, z: 0 } as never) as unknown as { x: number; y: number };
    assert.ok(up.x > 0.05, `lean ${up.x}`);
    const far = ids.find((id) => scene.world.getComponent(id, Transform)!.position.x === 80)!;
    assert.equal(scene.world.getComponent(far, Renderable)!.visible, false);
    const mid = ids.find((id) => scene.world.getComponent(id, Transform)!.position.x === 30)!;
    assert.equal(scene.world.getComponent(mid, Renderable)!.geometry, lo);
    field.setSurface(0.6, 0.8);
    assert.deepEqual(leafMat.cover, [0.8, 0.6]);
    // Viewer walks over: LOD follows.
    viewer.x = 30;
    field.refresh();
    assert.equal(scene.world.getComponent(mid, Renderable)!.geometry, hi);
    scene.removeObject(field);
    assert.equal(renderables().length, 0);
  });

  test("shadow casting is its own ring: a caster stops casting before it stops being drawn", () => {
    const scene = new Scene();
    const viewer = { x: 0, y: 0, z: 0 };
    const leafMat = mat();
    const hi = geo("hi"), lo = geo("lo");
    // Two parts, both casters, and a shadow ring inside the draw distance (a forest's cost is its
    // shadow pass: thousands of casters that are too far away for their shadows to be readable).
    const ringed = {
      parts: [{ hi, lo, material: leafMat, castShadow: true }, { hi: lo, lo, material: leafMat, castShadow: true }],
      lodDistance: 10,
      maxDistance: 50,
      shadowDistance: 20,
      swayDistance: 30,
    };
    const unringed = { parts: [{ hi, lo, material: leafMat, castShadow: true }], lodDistance: 10, maxDistance: 50, swayDistance: 30 };
    const field = new VegetationField({ models: [ringed, unringed], viewer: () => viewer, wind: () => ({ x: 0, z: 0 }) });
    field.add(0, 5, 0, 0); // inside the ring: drawn and casting
    field.add(0, 30, 0, 0); // drawn, past the ring: no longer a caster
    field.add(0, 90, 0, 0); // past the draw distance: hidden
    field.add(1, 30, 0, 4); // no ring: casts wherever it is drawn
    scene.add(field);
    field.update({} as never, 0.016);
    const partsAt = (x: number, z: number): Renderable[] => {
      const st = scene.world.store(Renderable);
      const out: Renderable[] = [];
      for (let i = 0; i < st.count; i++) {
        const id = scene.world.idForSlot(st.slotAt(i)) as unknown as number;
        const t = scene.world.getComponent(id, Transform)!;
        if (t.position.x === x && t.position.z === z) out.push(scene.world.getComponent(id, Renderable)!);
      }
      return out;
    };
    assert.equal(partsAt(5, 0).length, 2, "both parts of the near plant exist");
    assert.ok(partsAt(5, 0).every((r) => r.visible && r.castShadow), "inside the ring, every caster casts");
    assert.ok(partsAt(30, 0).every((r) => r.visible && !r.castShadow), "outside the ring it is drawn but not a caster");
    assert.ok(partsAt(90, 0).every((r) => !r.visible), "past the draw distance it is hidden");
    assert.ok(partsAt(30, 4).every((r) => r.visible && r.castShadow), "a model with no ring keeps casting");
    assert.equal(field.stats_.casting, 2, "casting counts instances, not parts");

    // The ring follows the viewer: what was near is now far, and vice versa.
    viewer.x = 30;
    field.refresh();
    assert.ok(partsAt(30, 0).every((r) => r.castShadow), "the ring moved with the viewer");
    assert.ok(partsAt(5, 0).every((r) => r.visible && !r.castShadow), "and the plant left behind stopped casting");
    assert.ok(partsAt(90, 0).every((r) => !r.visible), "still hidden");
    assert.equal(field.stats_.casting, 2);
    scene.removeObject(field);
  });
});

group("track weather ground", () => {
  const points = [
    { x: 0, z: 0 }, { x: 60, z: 10 }, { x: 80, z: 70 }, { x: 20, z: 90 }, { x: -20, z: 50 },
  ];
  const sp = new TrackSpline(points, { closed: true, step: 0.5 });
  const track = new TrackTerrain((x, z) => 0.02 * x + 0.01 * z, sp, { roadHalfWidth: 2.2, shoulder: 0.45, bermWidth: 2.6, bermHeight: 0.8 });
  const at = (s: number, lateral: number): [number, number] => {
    const c = sp.sampleAt(s, { x: 0, z: 0, tx: 0, tz: 1 });
    return [c.x + c.tz * lateral, c.z - c.tx * lateral];
  };

  test("soils follow the cross-section; grip: dry road 1, grass berm lower, wet grass much lower", () => {
    const g = new TrackWeatherGround(track, { resolution: 64 });
    assert.equal(g.soilAt(...at(40, 0)), "gravel");
    assert.equal(g.soilAt(...at(40, 4)), "grass");
    assert.equal(g.soilAt(...at(40, 25)), "dirt");
    g.applyCondition(TRACK_GROUND_CONDITIONS.dry);
    g.surface = { ...TRACK_GROUND_CONDITIONS.dry.surface };
    const roadDry = g.gripAt(...at(40, 0));
    const grassDry = g.gripAt(...at(40, 4));
    assert.ok(roadDry > 0.95, `dry road ${roadDry}`);
    assert.ok(grassDry < roadDry && grassDry > 0.75, `dry grass ${grassDry}`);
    g.applyCondition(TRACK_GROUND_CONDITIONS.wet, 0);
    g.surface = { ...TRACK_GROUND_CONDITIONS.wet.surface };
    const roadWet = g.gripAt(...at(40, 0));
    const grassWet = g.gripAt(...at(40, 4));
    assert.ok(roadWet < roadDry * 0.85, `wet road ${roadWet}`);
    assert.ok(grassWet < roadWet * 0.8, `wet grass ${grassWet} vs wet road ${roadWet}`);
    g.applyCondition(TRACK_GROUND_CONDITIONS.snow);
    g.surface = { ...TRACK_GROUND_CONDITIONS.snow.surface };
    assert.ok(g.gripAt(...at(40, 0)) < 0.45);
    g.applyCondition(TRACK_GROUND_CONDITIONS.muddy);
    g.surface = { ...TRACK_GROUND_CONDITIONS.muddy.surface };
    const roadMud = g.gripAt(...at(40, 0));
    assert.ok(roadMud < roadDry * 0.7, `mud road ${roadMud}`);
    assert.ok(g.gripAt(...at(40, 4)) < roadMud, "muddy berm worse than muddy road");
  });

  test("overlay maps: dry ground transparent, mud covers but never fully (road detail reads through)", () => {
    const f = new GroundMoistureField({ originX: 0, originZ: 0, size: 10, resolution: 4 });
    const albedo = new Uint8Array(64), mr = new Uint8Array(64);
    f.setUniform({ moisture: 0, water: 0, snow: 0 });
    f.writeOverlayMaps(albedo, mr, 0.8);
    for (let k = 3; k < 64; k += 4) assert.equal(albedo[k], 0);
    f.setUniform({ moisture: 1 });
    f.writeOverlayMaps(albedo, mr, 0.8);
    for (let k = 3; k < 64; k += 4) assert.ok(albedo[k]! > 120 && albedo[k]! <= 204, `alpha ${albedo[k]}`);
    f.setUniform({ moisture: 0, snow: 0.1 });
    f.writeOverlayMaps(albedo, mr, 0.8);
    assert.ok(albedo[0]! > 200, "snow is white");
  });

  test("rain soaks the field over time and update() reports when to re-upload", () => {
    const g = new TrackWeatherGround(track, { resolution: 48, timeScale: 120, interval: 0.5 });
    const env = createMeltEnvironment({ airTemperatureC: 10, precipitation: 1, humidity: 1, cloudCover: 1 });
    assert.equal(g.update(0.2, env), false);
    let steps = 0;
    for (let i = 0; i < 40; i++) if (g.update(0.25, env)) steps++;
    assert.equal(steps, 20);
    let wet = 0;
    for (const m of g.field.moisture) wet += m;
    assert.ok(wet / g.field.moisture.length > 0.05, `mean moisture ${wet / g.field.moisture.length}`);
  });
});

await finish();
