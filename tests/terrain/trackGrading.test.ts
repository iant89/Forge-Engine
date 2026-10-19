/**
 * @suite terrain:trackGrading
 * @group unit
 * @covers engine/src/index.ts
 * @covers engine/src/terrain/index.ts
 * @covers engine/src/terrain/pipelineSpec.ts
 * @covers engine/src/terrain/trackGrading.ts
 * @desc Pins the track-grading pipeline stage: level core, blend, seamless chunks and LODs, spec round trip, bed design and TerrainWorld queries
 */

export const suite = {
  name: "terrain:trackGrading",
  group: "unit",
  covers: [
    "engine/src/index.ts",
    "engine/src/terrain/index.ts",
    "engine/src/terrain/pipelineSpec.ts",
    "engine/src/terrain/trackGrading.ts",
  ],
  desc: "Pins the track-grading pipeline stage: level core, blend, seamless chunks and LODs, spec round trip, bed design and TerrainWorld queries",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  GeneratorPipeline,
  HeightGenerator,
  RealisticHeightGenerator,
  TerrainWorld,
  TrackGradingGenerator,
  UsageError,
  createPipelineFromSpec,
  createWorldCell,
  describePipeline,
  designBedProfile,
  hashPipelineSpec,
  isDescribableStage,
  type GradedCorridor,
  type WorldCell,
} from "@forge/engine";

/** A bumpy but smooth natural surface so "unchanged" and "levelled" are unmistakable. */
const bumpy = (x: number, z: number): number => 20 + 3 * Math.sin(x * 0.3) * Math.cos(z * 0.25);

function bumpyCell(cx = 0, cz = 0, size = 64, res = 17): WorldCell {
  const cell = createWorldCell(cx, cz, size, res, 1);
  const step = size / (res - 1);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) cell.heights[j * res + i] = bumpy(cx * size + i * step, cz * size + j * step);
  return cell;
}

/** A straight north–south road at x = 32 whose bed climbs from 4 m (z = 0) to 12 m (z = 64). */
const ROAD: GradedCorridor = { points: [32, 0, 32, 64], bed: [4, 12], halfWidth: 4, blendWidth: 8 };

group("TrackGradingGenerator — grading a cell", () => {
  test("the level core is the bed, interpolated along the corridor", () => {
    const cell = bumpyCell();
    new TrackGradingGenerator({ corridors: [ROAD] }).process(cell);
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    let core = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = i * step;
        const z = j * step;
        if (Math.abs(x - 32) <= 4) {
          assertCloseTo(cell.heights[j * res + i]!, 4 + (12 - 4) * (z / 64), 4, `core (${x}, ${z})`);
          core++;
        }
      }
    }
    assert.ok(core >= 3 * res, `the core covers a band of vertices (${core})`);
  });

  test("ground beyond the corridor's reach is untouched and the blend lies between bed and natural", () => {
    const cell = bumpyCell();
    new TrackGradingGenerator({ corridors: [ROAD] }).process(cell);
    const res = cell.resolution;
    const step = cell.size / (res - 1);
    let blended = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = i * step;
        const z = j * step;
        const d = Math.abs(x - 32);
        const graded = cell.heights[j * res + i]!;
        const natural = bumpy(x, z);
        if (d >= 12) {
          assertCloseTo(graded, natural, 4, `untouched (${x}, ${z})`);
        } else if (d > 4) {
          const bed = 4 + 8 * (z / 64);
          const lo = Math.min(bed, natural) - 1e-3;
          const hi = Math.max(bed, natural) + 1e-3;
          assert.ok(graded >= lo && graded <= hi, `blend (${x}, ${z}) ${graded} within [${lo}, ${hi}]`);
          blended++;
        }
      }
    }
    assert.ok(blended > 20);
  });

  test("a corridor that misses the cell leaves it alone", () => {
    const cell = bumpyCell(0, 0);
    const before = Float32Array.from(cell.heights);
    new TrackGradingGenerator({ corridors: [{ points: [400, 400, 400, 500], bed: [1, 1], halfWidth: 5, blendWidth: 5 }] }).process(cell);
    assert.deepEqual(Array.from(cell.heights), Array.from(before));
  });

  test("corridors apply in order: a road eases into the pad it leaves", () => {
    const pad: GradedCorridor = { points: [20, 32, 44, 32], bed: [10, 10], halfWidth: 9, blendWidth: 6 };
    const road: GradedCorridor = { points: [32, 20, 32, 64], bed: [14, 14], halfWidth: 3, blendWidth: 6 };
    const cell = bumpyCell();
    new TrackGradingGenerator({ corridors: [pad, road] }).process(cell);
    const res = cell.resolution;
    const at = (x: number, z: number): number => cell.heights[(z / 4) * res + x / 4]!;
    assertCloseTo(at(32, 40), 14, 4, "road core wins where it runs");
    assertCloseTo(at(20, 32), 10, 4, "pad core beyond the road's reach");
    assertCloseTo(at(44, 32), 10, 4, "pad core beyond the road's reach");
    // Inside the road's blend the road eases into the pad, not into the natural ground.
    const eased = at(28, 32);
    assert.ok(eased > 10 && eased < 14, `eased ${eased}`);
  });
});

group("TrackGradingGenerator — chunks and LODs", () => {
  const stage = new TrackGradingGenerator({
    corridors: [{ points: [250, -30, 256, 60, 262, 150], bed: [5, 6, 5.5], halfWidth: 4.2, blendWidth: 11 }],
  });
  const height = new RealisticHeightGenerator({ continentalAmplitude: 80, mountainAmplitude: 160, hillAmplitude: 35, detailAmplitude: 5, warpAmount: 60 });
  const build = (cx: number, cz: number, res: number): WorldCell => {
    const cell = createWorldCell(cx, cz, 128, res, 7421);
    height.process(cell);
    stage.process(cell);
    return cell;
  };

  test("two chunks agree exactly on their shared border (a road along a chunk edge never cracks)", () => {
    for (const cz of [-1, 0]) {
      const left = build(1, cz, 33);
      const right = build(2, cz, 33);
      for (let j = 0; j < 33; j++) assert.equal(left.heights[j * 33 + 32], right.heights[j * 33], `x border row ${j}`);
    }
    const south = build(2, 0, 33);
    const north = build(2, 1, 33);
    for (let i = 0; i < 33; i++) assert.equal(south.heights[32 * 33 + i], north.heights[i], `z border column ${i}`);
  });

  test("every LOD resolution samples the same graded surface", () => {
    const fine = build(2, 0, 33);
    const coarse = build(2, 0, 9);
    for (let j = 0; j < 9; j++) {
      for (let i = 0; i < 9; i++) assertCloseTo(coarse.heights[j * 9 + i]!, fine.heights[j * 4 * 33 + i * 4]!, 4, `vertex ${i},${j}`);
    }
  });
});

group("TrackGradingGenerator — describable pipeline stage", () => {
  const stage = new TrackGradingGenerator({ corridors: [ROAD, { points: [10, 10, 30, 10], bed: [7, 7], halfWidth: 6, blendWidth: 5 }] });
  const pipeline = (): GeneratorPipeline => new GeneratorPipeline().addStage(new HeightGenerator({ amplitude: 12 })).addStage(stage);

  test("is describable, hashes its configuration and rebuilds identically from a cloned spec", () => {
    assert.equal(isDescribableStage(stage), true);
    const spec = structuredClone(describePipeline(pipeline()));
    assert.equal(spec.stages[1]!.kind, "track-grading");
    assert.deepEqual(Object.keys(spec.stages[1]!.options), ["identity"]);
    const rebuilt = createPipelineFromSpec(spec);
    assert.deepEqual(describePipeline(rebuilt), spec);
    assert.equal(hashPipelineSpec(describePipeline(rebuilt)), hashPipelineSpec(spec));
    const a = createWorldCell(0, 0, 64, 17, 3);
    const b = createWorldCell(0, 0, 64, 17, 3);
    pipeline().execute(a);
    rebuilt.execute(b);
    assert.deepEqual(Array.from(b.heights), Array.from(a.heights));
  });

  test("a different bed is a different pipeline (cache key) and corridors are rounded to a millimetre", () => {
    const other = new TrackGradingGenerator({ corridors: [{ ...ROAD, bed: [4, 12.002] }] });
    assert.notEqual(
      hashPipelineSpec(describePipeline(new GeneratorPipeline().addStage(other))),
      hashPipelineSpec(describePipeline(new GeneratorPipeline().addStage(new TrackGradingGenerator({ corridors: [ROAD] })))),
    );
    const rounded = new TrackGradingGenerator({ corridors: [{ points: [1.00049, 2, 3, 4], bed: [5.00051, 6], halfWidth: 3.0004, blendWidth: 2 }] });
    assert.deepEqual(rounded.corridors[0]!.points, [1, 2, 3, 4]);
    assert.deepEqual(rounded.corridors[0]!.bed, [5.001, 6]);
    assert.equal(rounded.corridors[0]!.halfWidth, 3);
  });

  test("fromIdentity rejects malformed, unsupported and non-canonical configuration", () => {
    assert.equal(TrackGradingGenerator.fromIdentity(stage.identity).identity, stage.identity);
    assert.throws(() => TrackGradingGenerator.fromIdentity("{"), UsageError);
    assert.throws(() => TrackGradingGenerator.fromIdentity(JSON.stringify({ version: 2, corridors: [] })), UsageError);
    assert.throws(() => TrackGradingGenerator.fromIdentity(JSON.stringify({ version: 1, corridors: [{ points: [0, 0, 1, 1], bed: [1], halfWidth: 1, blendWidth: 1 }] })), UsageError);
    assert.throws(() => TrackGradingGenerator.fromIdentity(JSON.stringify({ version: 1, corridors: [{ points: [0, 0, 1, 1], bed: [1, 1], halfWidth: "1", blendWidth: 1 }] })), UsageError);
    assert.throws(() => TrackGradingGenerator.fromIdentity(JSON.stringify(JSON.parse(stage.identity), null, 1)), UsageError, "extra whitespace is not canonical");
  });

  test("the constructor validates every corridor", () => {
    const bad = (c: Partial<GradedCorridor>): void => {
      assert.throws(() => new TrackGradingGenerator({ corridors: [{ ...ROAD, ...c }] }), UsageError);
    };
    bad({ points: [1, 2] });
    bad({ points: [1, 2, 3] });
    bad({ bed: [1] });
    bad({ bed: [1, Number.NaN] });
    bad({ points: [0, 0, Number.POSITIVE_INFINITY, 1] });
    bad({ halfWidth: -1 });
    bad({ blendWidth: 0 });
    assert.throws(() => new TrackGradingGenerator({ corridors: null as never }), UsageError);
  });
});

group("designBedProfile", () => {
  const range = (n: number, f: (i: number) => number): number[] => Array.from({ length: n }, (_, i) => f(i));
  const maxGrade = (bed: ArrayLike<number>, step: number): number => {
    let worst = 0;
    for (let i = 1; i < bed.length; i++) worst = Math.max(worst, Math.abs(bed[i]! - bed[i - 1]!) / step);
    return worst;
  };

  test("leaves a constant profile and the interior of a gentle ramp alone", () => {
    const flat = designBedProfile(range(40, () => 7), 2);
    for (const v of flat) assertCloseTo(v, 7, 9);
    const ramp = range(80, (i) => 3 + 0.05 * 2 * i); // 5 % grade, step 2 m
    const bed = designBedProfile(ramp, 2, { smoothing: 20, maxGrade: 0.12 });
    for (let i = 20; i < 60; i++) assertCloseTo(bed[i]!, ramp[i]!, 9, `sample ${i}`);
  });

  test("cuts a spike and fills a pit, and never exceeds the grade limit", () => {
    const natural = range(100, (i) => 5 + (i === 50 ? 12 : 0) - (i === 20 ? 9 : 0));
    const bed = designBedProfile(natural, 2, { smoothing: 30, maxGrade: 0.1 });
    assert.ok(bed[50]! < 5 + 3, `the spike is cut (${bed[50]})`);
    assert.ok(bed[20]! > 5 - 3, `the pit is filled (${bed[20]})`);
    assert.ok(maxGrade(bed, 2) <= 0.1 + 1e-9, `grade ${maxGrade(bed, 2)}`);
  });

  test("a cliff becomes a graded ramp that still joins the two levels", () => {
    // 10 m at a 12 % limit needs ≈ 83 m of run — well inside the 120 m either side of the step.
    const natural = range(120, (i) => (i < 60 ? 0 : 10));
    const bed = designBedProfile(natural, 2, { smoothing: 6, maxGrade: 0.12 });
    assert.ok(maxGrade(bed, 2) <= 0.12 + 1e-9);
    assert.ok(bed[0]! < 0.5 && bed[119]! > 9.5, `ends ${bed[0]} / ${bed[119]}`);
    for (let i = 1; i < bed.length; i++) assert.ok(bed[i]! >= bed[i - 1]! - 1e-9, "monotone across a monotone step");
  });

  test("a cliff the limit cannot absorb still obeys the limit (the ramp just runs off the ends)", () => {
    const natural = range(120, (i) => (i < 60 ? 0 : 20));
    const bed = designBedProfile(natural, 2, { smoothing: 6, maxGrade: 0.12 });
    assert.ok(maxGrade(bed, 2) <= 0.12 + 1e-9);
    assert.ok(bed[0]! < bed[119]! - 8, "still rises across the step");
  });

  test("is deterministic and rejects unusable input", () => {
    const natural = range(60, (i) => Math.sin(i * 0.4) * 4);
    assert.deepEqual(Array.from(designBedProfile(natural, 2)), Array.from(designBedProfile(natural, 2)));
    assert.throws(() => designBedProfile([1], 2), UsageError);
    assert.throws(() => designBedProfile([1, 2], 0), UsageError);
    assert.throws(() => designBedProfile([1, 2], Number.NaN), UsageError);
    assert.throws(() => designBedProfile([1, 2, 3], 1, { maxGrade: 0 }), UsageError);
  });
});

group("TrackGradingGenerator — TerrainWorld queries", () => {
  test("height queries on a streamed world see the graded road, and the natural ground elsewhere", () => {
    const corridor: GradedCorridor = { points: [32, -40, 32, 140], bed: [3, 3], halfWidth: 5, blendWidth: 9 };
    const natural = new GeneratorPipeline().addStage(new HeightGenerator({ amplitude: 18 }));
    const graded = new GeneratorPipeline().addStage(new HeightGenerator({ amplitude: 18 })).addStage(new TrackGradingGenerator({ corridors: [corridor] }));
    const options = { seed: 5, chunkSize: 64, chunkResolution: 17, viewDistance: 100, horizonSkirt: false } as const;
    const worldNatural = new TerrainWorld({ ...options, pipeline: natural });
    const worldGraded = new TerrainWorld({ ...options, pipeline: graded });
    for (const z of [4, 33, 70, 101]) {
      assertCloseTo(worldGraded.getHeightAt(32, z), 3, 3, `road centre z=${z}`);
      // The query is bicubic (Catmull-Rom over the 4 m grid), so beside the centre it can lean a few
      // centimetres toward the blend — which is why roads keep their level core wider than the surface.
      assert.ok(Math.abs(worldGraded.getHeightAt(34, z) - 3) < 0.1, `road core z=${z}`);
      assertCloseTo(worldGraded.getHeightAt(32 + 40, z), worldNatural.getHeightAt(32 + 40, z), 4, `far off the road z=${z}`);
    }
    // The road is level across (no cross-slope) where the natural ground is not.
    const across = worldGraded.getHeightAt(29, 50) - worldGraded.getHeightAt(35, 50);
    assert.ok(Math.abs(across) < 0.05, `cross level ${across}`);
    const naturalAcross = worldNatural.getHeightAt(29, 50) - worldNatural.getHeightAt(35, 50);
    assert.ok(Math.abs(naturalAcross) > Math.abs(across), "the natural ground leans across the same line");
  });
});

await finish();
