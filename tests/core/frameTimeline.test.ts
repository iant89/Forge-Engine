/**
 * @suite core:frameTimeline
 * @group unit
 * @covers engine/src/debug/frameTimeline.ts
 * @desc Phase 21.1 frame timeline: self-time attribution with inherited categories, bounded history, the band and lane layout, hit testing and the text readout
 */

export const suite = {
  name: "core:frameTimeline",
  group: "unit",
  covers: [
    "engine/src/debug/frameTimeline.ts",
  ],
  desc: "Phase 21.1 frame timeline: self-time attribution with inherited categories, bounded history, the band and lane layout, hit testing and the text readout",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  TIMELINE_CATEGORIES,
  formatTimelineFrame,
  frameTimeline,
  hitTestTimeline,
  layoutTimeline,
  type FrameRecord,
} from "@forge/engine";

const rec = (index: number, cpuMs: number, slices: FrameRecord["slices"], gpuMs = 0): FrameRecord => ({
  index,
  totalMs: cpuMs,
  cpuMs,
  gpuMs,
  scriptMs: 0,
  physicsMs: 0,
  renderMs: 0,
  drawCalls: 1,
  triangles: 1,
  slices,
});

/**
 * One frame in the shape the engine produces: `streaming:assets` first, `Frame` around the scene
 * update with two categorised systems (one of them opening an unprefixed nested scope), then
 * `Render` as a sibling. 12.5 ms of work plus a 0.9 ms gap the scopes never see.
 */
const FRAME = rec(7, 12.5, [
  // Slices arrive in *end* order, the order the profiler appends them.
  { name: "terrain:TerrainSystem", startMs: 0.3, durationMs: 3 },
  { name: "upload", startMs: 0.4, durationMs: 2 },
  { name: "physics:PhysicsSystem", startMs: 3.5, durationMs: 2 },
  { name: "Frame", startMs: 0.2, durationMs: 8 },
  { name: "Render", startMs: 8.4, durationMs: 3.5 },
  { name: "streaming:assets", startMs: 0.05, durationMs: 0.1 },
], 9.25);

group("attribution", () => {
  test("charges each slice its self time so nested scopes are counted once", () => {
    const frame = frameTimeline([FRAME]).frames[0]!;
    const byName = new Map(frame.slices.map((s) => [s.name, s]));
    assert.equal(byName.get("terrain:TerrainSystem")!.selfMs.toFixed(2), "1.00", "the system keeps what its children did not use");
    assert.equal(byName.get("upload")!.selfMs.toFixed(2), "2.00");
    // `Frame` wraps the two systems, so its self time is the scene update's own overhead.
    assert.equal(byName.get("Frame")!.selfMs.toFixed(2), "3.00");
    assert.equal(byName.get("Frame")!.depth, 0);
    assert.equal(byName.get("Render")!.depth, 0);
    assert.equal(byName.get("streaming:assets")!.depth, 0);
  });

  test("an unprefixed nested scope inherits its ancestor's category instead of guessing", () => {
    const frame = frameTimeline([FRAME]).frames[0]!;
    const upload = frame.slices.find((s) => s.name === "upload")!;
    assert.equal(upload.category, "terrain", "`upload` inside terrain:TerrainSystem is terrain work");
    assert.equal(upload.label, "upload");
    assert.equal(frame.slices.find((s) => s.name === "terrain:TerrainSystem")!.label, "TerrainSystem");
  });

  test("an unprefixed container is other, and an unprefixed leaf falls back to the name", () => {
    const frame = frameTimeline([FRAME]).frames[0]!;
    assert.equal(frame.slices.find((s) => s.name === "Frame")!.category, "other", "Frame's self time is overhead, not simulation");
    assert.equal(frame.slices.find((s) => s.name === "Render")!.category, "rendering");
  });

  test("the categories partition the frame exactly: the gap lands in other", () => {
    const frame = frameTimeline([FRAME]).frames[0]!;
    const sum = TIMELINE_CATEGORIES.reduce((a, c) => a + frame.categories[c], 0);
    assert.equal(sum.toFixed(4), "12.5000", "every millisecond of the frame is counted exactly once");
    assert.equal(frame.categories.terrain.toFixed(2), "3.00");
    assert.equal(frame.categories.physics.toFixed(2), "2.00");
    assert.equal(frame.categories.rendering.toFixed(2), "3.50");
    assert.equal(frame.categories.streaming.toFixed(2), "0.10");
    assert.equal(frame.otherMs.toFixed(2), "0.90", "the 0.9 ms between the scopes is visible, not absorbed");
    assert.equal(frame.categories.other.toFixed(2), "3.90", "overhead plus the gap");
    assert.equal(frame.gpuMs, 9.25);
    assert.equal(frame.lanes, 3);
    assert.equal(frame.spanMs.toFixed(2), "11.90");
  });

  test("a frame with no scopes at all is one column of other — the graph survives `detailed: false`", () => {
    const frame = frameTimeline([rec(1, 8, [])]).frames[0]!;
    assert.equal(frame.categories.other.toFixed(2), "8.00");
    assert.equal(frame.slices.length, 0);
    assert.equal(frame.lanes, 0);
  });

  test("a scope that straddles the frame boundary cannot make a category negative", () => {
    const frame = frameTimeline([rec(2, 4, [{ name: "physics:step", startMs: -6, durationMs: 9 }])]).frames[0]!;
    assert.equal(frame.categories.physics.toFixed(2), "9.00");
    assert.equal(frame.categories.other, 0, "the remainder is floored at zero, not taken from another category");
  });
});

group("history window", () => {
  test("keeps the newest maxFrames frames, oldest first", () => {
    const records = Array.from({ length: 12 }, (_, i) => rec(i, 1 + i / 10, []));
    const model = frameTimeline(records, { maxFrames: 5 });
    assert.deepEqual(model.frames.map((f) => f.index), [7, 8, 9, 10, 11]);
    assert.equal(model.peakMs.toFixed(2), "2.10");
  });

  test("the scale ceiling never clips a spike and never sits below the budget", () => {
    const flat = frameTimeline([rec(1, 4, []), rec(2, 4, [])]);
    assert.equal(flat.scaleMs.toFixed(3), (1000 / 60 * 1.25).toFixed(3), "a fast session still shows the budget line");
    const spike = frameTimeline([rec(1, 4, []), rec(2, 120, [])]);
    assert.equal(spike.scaleMs, 120, "a 120 ms frame is drawn, not cut off");
    assert.equal(spike.peakMs, 120);
  });

  test("an empty history is a valid model, not a crash", () => {
    const model = frameTimeline([]);
    assert.deepEqual(model.frames, []);
    assert.equal(model.peakMs, 0);
  });
});

group("layout", () => {
  const model = frameTimeline([FRAME]);
  const layout = layoutTimeline(model, { width: 360, height: 120, selected: 0 });

  test("stacks the band bottom-up in category order, grounded on the baseline", () => {
    const column = layout.columns[0]!;
    assert.equal(column.index, 7);
    assert.equal(column.w, 359, "a one-pixel gap keeps neighbouring columns readable");
    const stack = column.segments.map((s) => s.category);
    assert.deepEqual(stack, ["physics", "terrain", "streaming", "rendering", "other"]);
    const bottom = column.segments[0]!;
    const top = column.segments[column.segments.length - 1]!;
    assert.equal((bottom.y + bottom.h).toFixed(4), layout.band.h.toFixed(4), "the first category sits on the baseline");
    assert.equal(top.category, "other", "the unattributed remainder is on top");
    const total = column.segments.reduce((a, s) => a + s.h, 0);
    assert.equal(total.toFixed(3), ((12.5 / model.scaleMs) * layout.band.h).toFixed(3), "the stack is the frame's CPU time");
  });

  test("draws the budget line where the model's scale puts it", () => {
    // 16.67 ms of a 20.83 ms ceiling fills 80% of the band, so the line is 20% down from the top.
    assert.equal(layout.budgetY.toFixed(2), (layout.band.h * 0.2).toFixed(2));
    assert.equal(layout.scaleMs.toFixed(2), "20.83");
  });

  test("marks GPU time as a tick, never as a stacked segment", () => {
    const column = layout.columns[0]!;
    assert.equal(column.gpuY?.toFixed(2), (layout.band.h - (9.25 / model.scaleMs) * layout.band.h).toFixed(2));
    assert.ok(column.gpuY! < layout.band.h, "inside the band");
    assert.equal(frameTimeline([rec(1, 5, [])]).frames[0]!.gpuMs, 0);
    assert.equal(layoutTimeline(frameTimeline([rec(1, 5, [])]), { width: 40, height: 40 }).columns[0]!.gpuY, null);
  });

  test("the lane chart spreads the selected frame's scopes by start time and depth", () => {
    const lanes = layout.lanes!;
    const byName = new Map(lanes.slices.map((s) => [s.slice.name, s]));
    assert.equal(layout.selected, 0);
    assert.equal(byName.get("Frame")!.y, 0);
    assert.equal(byName.get("terrain:TerrainSystem")!.y, layout.lanes!.laneHeight);
    assert.equal(byName.get("upload")!.y, layout.lanes!.laneHeight * 2, "nested one lane deeper");
    assert.ok(byName.get("Render")!.x > byName.get("terrain:TerrainSystem")!.x, "Render starts later in the frame");
    assert.ok(byName.get("physics:PhysicsSystem")!.x > byName.get("terrain:TerrainSystem")!.x);
    assert.equal(byName.get("Frame")!.w.toFixed(1), ((8 / 12.5) * 360).toFixed(1), "width is duration over the frame axis");
  });

  test("a narrow strip shows fewer columns than it has frames, and a deep one no more than it fits", () => {
    const many = frameTimeline(Array.from({ length: 40 }, (_, i) => rec(i, 5, [])), { maxFrames: 40 });
    const narrow = layoutTimeline(many, { width: 100, height: 40, minColumnWidth: 4 });
    assert.equal(narrow.columns.length, 25, "100 px at a 4 px minimum is 25 columns");
    assert.equal(narrow.columns[0]!.index, 15, "the newest 25 of 40");
    const wide = layoutTimeline(many, { width: 400, height: 40 });
    assert.equal(wide.columns.length, 40);
  });

  test("bandRatio 1 is a band with no lane chart, and zero width or height is an empty layout", () => {
    const bandOnly = layoutTimeline(model, { width: 100, height: 40, bandRatio: 1 });
    assert.equal(bandOnly.lanes, null);
    assert.equal(bandOnly.selected, null);
    assert.equal(bandOnly.band.h, 40);
    const nothing = layoutTimeline(model, { width: 0, height: 0 });
    assert.deepEqual(nothing.columns, []);
    assert.equal(nothing.lanes, null);
  });

  test("a frame whose stack overflows the band is compressed, not clipped", () => {
    // A 30 ms scope straddling a 4 ms frame: the scopes account for more than the ceiling allows.
    const odd = frameTimeline([rec(1, 4, [{ name: "physics:step", startMs: -2, durationMs: 30 }])]);
    const laid = layoutTimeline(odd, { width: 40, height: 40 });
    const column = laid.columns[0]!;
    const total = column.segments.reduce((a, s) => a + s.h, 0);
    assert.ok(total <= laid.band.h + 1e-6, "the stack fits the band");
    assert.equal(column.clipped, true, "and says it was compressed");
  });
});

group("hit testing", () => {
  const model = frameTimeline([rec(1, 5, []), rec(2, 5, []), rec(3, 5, []), rec(4, 5, [])]);
  const layout = layoutTimeline(model, { width: 400, height: 100, selected: 1 });

  test("the band selects a column by x alone", () => {
    assert.equal(hitTestTimeline(model, layout, 10, 5)?.column, 0);
    assert.equal(hitTestTimeline(model, layout, 350, 5)?.column, 3);
    assert.equal(hitTestTimeline(model, layout, 10, 55)?.column, 0, "anywhere in the band's height");
  });

  test("the lane chart selects the slice under the point, and the frame when the point is outside one", () => {
    const withSlices = frameTimeline([FRAME]);
    const laid = layoutTimeline(withSlices, { width: 360, height: 120, selected: 0 });
    const lanes = laid.lanes!;
    const physics = lanes.slices.find((s) => s.slice.name === "physics:PhysicsSystem")!;
    const hit = hitTestTimeline(withSlices, laid, physics.x + 1, lanes.y + physics.y + 1)!;
    assert.equal(hit.slice?.name, "physics:PhysicsSystem");
    assert.equal(hit.column, 0);
    const blank = hitTestTimeline(withSlices, laid, 359, lanes.y + lanes.h - 1)!;
    assert.equal(blank.slice, undefined, "past the last scope there is no slice");
    assert.equal(blank.column, 0);
  });

  test("a point outside the strip hits nothing", () => {
    assert.equal(hitTestTimeline(model, layout, -5, 5), null);
    assert.equal(hitTestTimeline(model, layout, 10, 500), null);
  });
});

group("readout", () => {
  test("names the frame, the budget verdict and every category with time in it", () => {
    const frame = frameTimeline([FRAME]).frames[0]!;
    const text = formatTimelineFrame(frame);
    assert.match(text, /^#7 {2}cpu 12\.50ms {2}gpu 9\.25ms {2}within the 16\.7ms budget\n/);
    assert.match(text, /terrain 3\.00/);
    assert.match(text, /other 3\.90/);
    assert.ok(!text.includes("particles"), "categories with no time are left out");
  });

  test("a frame over budget says so, and a bare frame still reads", () => {
    assert.match(formatTimelineFrame(frameTimeline([rec(9, 33, [])]).frames[0]!), /over the 16\.7ms budget/);
    assert.match(formatTimelineFrame(frameTimeline([rec(9, 33, [])]).frames[0]!), /^#9 {2}cpu 33\.00ms/);
  });
});

finish();
