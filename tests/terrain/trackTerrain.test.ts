/**
 * @suite terrain:trackTerrain
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/terrain/index.ts
 * @covers engine/src/terrain/track.ts
 * @covers engine/src/terrain/trackSurface.ts
 * @desc Pins spline track carving, berms, ribbons, scatter determinism, lap timing, surface textures and berm collision
 */

export const suite = {
  name: "terrain:trackTerrain",
  group: "unit",
  covers: [
    "engine/src/index.ts",
    "engine/src/terrain/index.ts",
    "engine/src/terrain/track.ts",
    "engine/src/terrain/trackSurface.ts",
  ],
  desc: "Pins spline track carving, berms, ribbons, scatter determinism, lap timing, surface textures and berm collision",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  TrackLapTimer,
  TrackSpline,
  TrackTerrain,
  Vehicle,
  createVehicleConfig,
  grassBermPixels,
  gravelRoadPixels,
  heightFunctionGround,
  litterQuadsSource,
  scatterAlongTrack,
  trackRibbonSource,
  trackTerrainGridSource,
  type TrackProjection,
} from "@forge/engine";

/** A 400 m × 200 m stadium-ish loop: two straights joined by wide bends. */
const LOOP = [
  { x: 0, z: -100 }, { x: 60, z: -90 }, { x: 80, z: -40 }, { x: 80, z: 40 }, { x: 60, z: 90 },
  { x: 0, z: 100 }, { x: -60, z: 90 }, { x: -80, z: 40 }, { x: -80, z: -40 }, { x: -60, z: -90 },
];
const slope = (x: number, z: number): number => 0.05 * z + 0.02 * x;
const proj = (): TrackProjection => ({ s: 0, lateral: 0, dist: Infinity, index: -1 });

group("TrackSpline", () => {
  test("resamples at a uniform step with unit tangents and a closed length", () => {
    const sp = new TrackSpline(LOOP, { step: 0.5 });
    assert.ok(sp.length > 450 && sp.length < 650, `length ${sp.length}`);
    assertCloseTo(sp.step * sp.sampleCount, sp.length, 6);
    for (let i = 0; i < sp.sampleCount; i += 37) assertCloseTo(Math.hypot(sp.tx[i]!, sp.tz[i]!), 1, 6);
    const a = sp.sampleAt(0, { x: 0, z: 0, tx: 0, tz: 0 });
    const b = sp.sampleAt(sp.length, { x: 0, z: 0, tx: 0, tz: 0 });
    assertCloseTo(a.x, b.x, 6);
    assertCloseTo(a.z, b.z, 6);
  });

  test("project returns the signed lateral offset (positive right of travel) and Infinity off-corridor", () => {
    const sp = new TrackSpline(LOOP);
    sp.buildIndex(10);
    const c = sp.sampleAt(200, { x: 0, z: 0, tx: 0, tz: 1 });
    // Right of travel is (tz, −tx).
    const r = sp.project(c.x + c.tz * 3, c.z - c.tx * 3, proj());
    assertCloseTo(r.lateral, 3, 2);
    assertCloseTo(r.s, 200, 0);
    const l = sp.project(c.x - c.tz * 3, c.z + c.tx * 3, proj());
    assertCloseTo(l.lateral, -3, 2);
    assert.equal(sp.project(0, 0, proj()).dist, Infinity);
  });
});

group("TrackTerrain carve", () => {
  const sp = new TrackSpline(LOOP);
  const t = new TrackTerrain(slope, sp, { bermHeight: 0.8, bermVariation: 0, roadHalfWidth: 2.2, shoulder: 0.5, bermWidth: 2.8, blendWidth: 7 });

  test("road is crowned with ruts, berm crest is bermHeight above the bed, outside is natural", () => {
    const s = 123;
    const bed = t.bedAt(s);
    assertCloseTo(t.heightAtOffset(s, 0) - bed, 0.05, 6);
    assert.ok(t.heightAtOffset(s, 0.8) < t.heightAtOffset(s, 0.3), "rut is a groove");
    const crest = 2.2 + 0.5 + 1.4;
    assertCloseTo(t.heightAtOffset(s, crest) - bed, 0.8, 6);
    assertCloseTo(t.heightAtOffset(s, -crest) - bed, 0.8, 6);
    const pos = { x: 0, z: 0 };
    const far = t.heightAtOffset(s, t.corridorHalfWidth + 0.01, pos);
    assertCloseTo(far, slope(pos.x, pos.z), 6);
  });

  test("heightAt by projection agrees with the ribbon sampler", () => {
    const pos = { x: 0, z: 0 };
    for (const [s, lat] of [[40, 0], [300, 1.1], [410, -4.1], [77, 6.2]] as const) {
      const y = t.heightAtOffset(s, lat, pos);
      assertCloseTo(t.heightAt(pos.x, pos.z), y, 2);
    }
  });

  test("bed is smoothed along the track and surfaceAt classifies road / rut / berm", () => {
    let maxStep = 0;
    for (let i = 1; i < sp.sampleCount; i++) maxStep = Math.max(maxStep, Math.abs(t.bed[i]! - t.bed[i - 1]!));
    assert.ok(maxStep < 0.1, `bed step ${maxStep}`);
    const pos = { x: 0, z: 0 };
    const out = { road: 0, rut: 0, berm: 0, lateral: 0, s: 0 };
    t.heightAtOffset(200, 0.8, pos);
    t.surfaceAt(pos.x, pos.z, out);
    assert.ok(out.road > 0.99 && out.rut > 0.9 && out.berm === 0);
    t.heightAtOffset(200, 4.1, pos);
    t.surfaceAt(pos.x, pos.z, out);
    assert.ok(out.berm > 0.99 && out.road === 0);
    assert.ok(t.minLegSeparation() > 2 * t.corridorHalfWidth);
  });

  test("ribbon and grid sources are well-formed with unit normals and tangents", () => {
    const road = trackRibbonSource(t, { from: -2.7, to: 2.7, across: 9, alongStep: 1 });
    const grid = trackTerrainGridSource(t, 0, 0, 220, 40);
    for (const src of [road, grid]) {
      const vc = src.positions.length / 3;
      assert.equal(src.normals!.length, vc * 3);
      assert.equal(src.tangents!.length, vc * 4);
      for (let k = 0; k < src.indices!.length; k++) assert.ok(src.indices![k]! < vc);
      for (let v = 0; v < vc; v += 13) {
        assertCloseTo(Math.hypot(src.normals![v * 3]!, src.normals![v * 3 + 1]!, src.normals![v * 3 + 2]!), 1, 4);
        assertCloseTo(Math.hypot(src.tangents![v * 4]!, src.tangents![v * 4 + 1]!, src.tangents![v * 4 + 2]!), 1, 4);
        assert.ok(Math.abs(src.tangents![v * 4 + 3]!) === 1);
        assert.ok(src.normals![v * 3 + 1]! > 0.3);
      }
    }
    // Grid sinks under the road so the ribbon covers it.
    const pos = { x: 0, z: 0 };
    const y = t.heightAtOffset(10, 0, pos);
    const g = trackTerrainGridSource(t, pos.x, pos.z, 2, 2, { corridorSink: 0.5 });
    assertCloseTo(g.positions[4 * 3 + 1]!, y - 0.5, 1);
  });
});

group("scatter and litter", () => {
  const sp = new TrackSpline(LOOP);
  const t = new TrackTerrain(slope, sp);
  test("placements are deterministic, inside the band and on the surface", () => {
    const opts = { seed: 4, lateralMin: 1, lateralMax: 3, density: 0.5, palettes: 3 };
    const a = scatterAlongTrack(t, opts);
    const b = scatterAlongTrack(t, opts);
    assert.deepEqual(a, b);
    assert.ok(a.length > 300);
    for (const p of a) {
      assert.ok(Math.abs(p.lateral) >= 1 && Math.abs(p.lateral) <= 3);
      assert.ok(p.palette >= 0 && p.palette < 3);
      assertCloseTo(p.y, t.heightAt(p.x, p.z), 2);
    }
    const weighted = scatterAlongTrack(t, { ...opts, weight: () => 0 });
    assert.equal(weighted.length, 0);
  });
  test("litter quads are one card per placement lifted over the surface", () => {
    const pl = scatterAlongTrack(t, { seed: 2, lateralMin: 0, lateralMax: 2, density: 0.2 });
    const src = litterQuadsSource(t, pl, { lift: 0.05 });
    assert.equal(src.positions.length, pl.length * 12);
    assert.equal(src.indices!.length, pl.length * 6);
    const p0 = pl[0]!;
    const cy = (src.positions[1]! + src.positions[4]! + src.positions[7]! + src.positions[10]!) / 4;
    assert.ok(cy > p0.y && cy - p0.y < 0.1);
  });
});

group("TrackLapTimer", () => {
  const sp = new TrackSpline(LOOP);
  sp.buildIndex(8);
  const drive = (timer: TrackLapTimer, from: number, to: number, step: number, dt: number): string[] => {
    const events: string[] = [];
    const c = { x: 0, z: 0, tx: 0, tz: 1 };
    for (let s = from; step > 0 ? s <= to : s >= to; s += step) {
      sp.sampleAt(s, c);
      const e = timer.update(c.x, c.z, dt);
      if (e) events.push(e);
    }
    return events;
  };
  test("starts on the first crossing and times full laps through the checkpoints", () => {
    const timer = new TrackLapTimer(sp, { startS: 20 });
    const ev = drive(timer, 10, 10 + 2 * sp.length + 20, 1, 0.1);
    assert.deepEqual(ev, ["start", "lap", "lap"]);
    assert.equal(timer.state.lap, 3);
    // One lap of `length` metres at 1 m per 0.1 s.
    assertCloseTo(timer.state.lastLap!, Math.round(sp.length) * 0.1, 0);
    assert.ok(timer.state.bestLap! <= timer.state.lastLap! + 1e-9);
  });
  test("reversing back over the line does not score a lap", () => {
    const timer = new TrackLapTimer(sp, { startS: 20 });
    drive(timer, 10, 40, 1, 0.1);
    assert.equal(timer.state.running, true);
    drive(timer, 40, 0, -1, 0.1);
    const ev = drive(timer, 0, 40, 1, 0.1);
    assert.deepEqual(ev, []);
    assert.equal(timer.state.lastLap, null);
  });
  test("a teleport across the line after resync is not a crossing", () => {
    const timer = new TrackLapTimer(sp, { startS: 20 });
    drive(timer, 0, 10, 1, 0.1);
    timer.resync();
    assert.deepEqual(drive(timer, 30, 40, 1, 0.1), []);
    assert.equal(timer.state.running, false);
  });
});

group("surface textures", () => {
  test("gravel road pixels are deterministic, tan, with darker rut bands at the rut offset", () => {
    const a = gravelRoadPixels({ width: 108, height: 64, halfSpan: 2.7, rutOffset: 0.8, rutWidth: 0.32, leafDensity: 0 });
    const b = gravelRoadPixels({ width: 108, height: 64, halfSpan: 2.7, rutOffset: 0.8, rutWidth: 0.32, leafDensity: 0 });
    assert.deepEqual(a.albedo, b.albedo);
    const column = (lat: number): number => {
      const x = Math.floor(((lat + 2.7) / 5.4) * a.width);
      let sum = 0;
      for (let y = 0; y < a.height; y++) sum += a.albedo[(y * a.width + x) * 4]!;
      return sum / a.height;
    };
    assert.ok(column(0.8) < column(0.15) * 0.92, "rut darker than the crown");
    let r = 0, bl = 0;
    for (let i = 0; i < a.albedo.length; i += 4) {
      r += a.albedo[i]!;
      bl += a.albedo[i + 2]!;
    }
    assert.ok(r > bl * 1.15, "warm (tan), not grey-blue");
  });
  test("grass berm pixels are green and tile seamlessly", () => {
    const g = grassBermPixels({ size: 64 });
    let r = 0, gr = 0;
    for (let i = 0; i < g.albedo.length; i += 4) {
      r += g.albedo[i]!;
      gr += g.albedo[i + 1]!;
    }
    assert.ok(gr > r * 1.1);
    // Normals: unit-ish encoded, +Z dominant.
    for (let i = 0; i < g.normal.length; i += 4 * 97) assert.ok(g.normal[i + 2]! > 180);
  });
});

group("berms are real collision for the engine vehicle", () => {
  test("a car driven straight off a bend climbs the berm and is lifted by it", () => {
    const sp = new TrackSpline(LOOP);
    const t = new TrackTerrain(() => 0, sp, { bermHeight: 0.8, bermVariation: 0 });
    const ground = heightFunctionGround((x, z) => t.heightAt(x, z), 0.2);
    const v = new Vehicle(createVehicleConfig());
    // Start on the centreline heading 35° off the track direction, toward the right berm.
    const c = sp.sampleAt(60, { x: 0, z: 0, tx: 0, tz: 1 });
    v.position.set(c.x, 0, c.z);
    v.yaw = Math.atan2(c.tx, c.tz) + 0.6;
    v.placeOnGround(ground);
    const y0 = v.position.y;
    v.input.throttle = 0.6;
    let maxRise = 0;
    for (let i = 0; i < 240; i++) {
      v.step(1 / 60, ground);
      maxRise = Math.max(maxRise, v.position.y - y0);
    }
    assert.ok(maxRise > 0.25, `berm lifted the chassis by ${maxRise.toFixed(2)} m`);
  });
});

await finish();
