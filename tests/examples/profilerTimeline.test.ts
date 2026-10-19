/**
 * @suite examples:profilerTimeline
 * @group unit
 * @covers examples/src/diag/profilerTimeline.ts
 * @covers examples/src/diag/profilerPanel.ts
 * @desc Pins the demo's profiler timeline strip: it paints the frame history into a canvas through a four-method surface, hover selects the frame under the pointer, a tap pins and releases it, a pinned frame keeps its identity as the ring turns, painting is throttled and costs nothing before the strip has a size, and the floating panel hosts the strip above the text report
 */

export const suite = {
  name: "examples:profilerTimeline",
  group: "unit",
  covers: [
    "examples/src/diag/profilerTimeline.ts",
    "examples/src/diag/profilerPanel.ts",
  ],
  desc: "Pins the demo's profiler timeline strip: it paints the frame history into a canvas through a four-method surface, hover selects the frame under the pointer, a tap pins and releases it, a pinned frame keeps its identity as the ring turns, painting is throttled and costs nothing before the strip has a size, and the floating panel hosts the strip above the text report",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { TIMELINE_COLORS, drawTimeline, mountProfilerTimeline, type ProfilerTimeline, type TimelineSurface } from "../../examples/src/diag/profilerTimeline.js";
import { mountProfilerPanel } from "../../examples/src/diag/profilerPanel.js";
import { frameTimeline, type FrameRecord } from "@forge/engine";
import { FakeEl, env, type FakeEnv } from "../support/fakeDom.js";

/** Every call the strip makes on a 2D context, recorded: the strip is pinned by its rectangles. */
class FakeSurface implements TimelineSurface {
  fillStyle = "";
  font = "";
  textBaseline = "";
  rects: { x: number; y: number; w: number; h: number; style: string }[] = [];
  texts: { text: string; x: number; y: number; style: string }[] = [];
  transforms: number[][] = [];
  clearRect(): void {}
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h, style: this.fillStyle });
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, style: this.fillStyle });
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 5.4 };
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transforms.push([a, b, c, d, e, f]);
  }
}

const rec = (index: number, cpuMs: number, slices: FrameRecord["slices"] = [], gpuMs = 0): FrameRecord => ({
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

/** Six frames with a recognisable shape: a steady 8 ms frame and a 40 ms spike at the end. */
function history(count = 6): FrameRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const spike = i === count - 1;
    const cpu = spike ? 40 : 8 + i * 0.1;
    return rec(100 + i, cpu, [
      { name: "Frame", startMs: 0, durationMs: cpu * 0.7 },
      { name: "terrain:TerrainSystem", startMs: 0.1, durationMs: cpu * 0.4 },
      { name: "physics:PhysicsSystem", startMs: cpu * 0.45, durationMs: cpu * 0.2 },
      { name: "Render", startMs: cpu * 0.7, durationMs: cpu * 0.25 },
    ], spike ? 38 : 6);
  });
}

interface Rig {
  timeline: ProfilerTimeline;
  surface: FakeSurface;
  canvas: FakeEl;
  env: FakeEnv;
  records: FrameRecord[];
}

function mount(e: FakeEnv, records: FrameRecord[] = history(), width = 360, height = 96): Rig {
  const surface = new FakeSurface();
  const canvas = new FakeEl("canvas");
  e.body.appendChild(canvas);
  const timeline = mountProfilerTimeline({
    frames: () => records,
    canvas: canvas as unknown as HTMLCanvasElement,
    createContext: () => surface,
    doc: e.doc,
    win: e.win,
    now: e.now,
  });
  if (width > 0) timeline.resize(width, height);
  return { timeline, surface, canvas, env: e, records };
}

group("painting", () => {
  test("draws one column per frame, the budget line and the selected frame's lanes", () => {
    const rig = mount(env());
    const state = rig.timeline.state();
    assert.equal(state.frames, 6);
    assert.equal(state.columns, 6);
    assert.equal(state.painted, 1);
    assert.equal(state.peakMs, 40);
    assert.equal(state.cssWidth, 360);
    assert.equal(state.cssHeight, 96);

    // The backdrop covers the whole strip, then the budget line spans the band at one pixel.
    const full = rig.surface.rects.filter((r) => r.w === 360 && r.h === 96);
    assert.equal(full.length, 1, "one backdrop fill");
    const budget = rig.surface.rects.filter((r) => r.w === 360 && r.h === 1 && r.style === "rgb(248 113 113 / 0.8)");
    assert.equal(budget.length, 1, "one budget line, spanning the band alone");

    // Six columns × (terrain, physics, rendering, other) segments, in the category colours.
    const colours = new Set(Object.values(TIMELINE_COLORS));
    const segments = rig.surface.rects.filter((r) => colours.has(r.style) && r.h > 1);
    assert.ok(segments.length >= 18, `every column stacks its categories (${segments.length} segments)`);
    assert.ok(segments.some((r) => r.style === TIMELINE_COLORS.terrain));
    assert.ok(segments.some((r) => r.style === TIMELINE_COLORS.physics));
    assert.ok(segments.some((r) => r.style === TIMELINE_COLORS.other));

    // The lane chart draws the newest frame's scopes and labels the wide ones.
    assert.ok(rig.surface.texts.some((t) => t.text === "TerrainSystem"), "a label for a slice with room");
    assert.match(rig.timeline.state().readout, /^#105 {2}cpu 40\.00ms {2}gpu 38\.00ms {2}over the 16\.7ms budget/, "the newest frame is selected by default");
  });

  test("the spike is drawn at the ceiling: the strip scales to the worst frame, not the budget", () => {
    const rig = mount(env());
    const model = frameTimeline(rig.records);
    assert.equal(model.scaleMs, 40, "the 40 ms frame is the ceiling");
    const band = 56; // 96 px × the default 0.58 band ratio
    const colours = Object.values(TIMELINE_COLORS);
    // Column segments live inside the band; the lane chart's slices are drawn below it.
    // `>= -0.001`: a stack that exactly fills the band lands on y = -1e-15, not on 0.
    const columns = rig.surface.rects.filter((r) => colours.includes(r.style) && r.y >= -0.001 && r.y + r.h <= band + 0.001);
    assert.ok(columns.length > 0);
    const tallest = band - Math.min(...columns.map((r) => r.y));
    assert.ok(Math.abs(tallest - band) < 0.5, `the worst frame fills the band (${tallest.toFixed(1)} of ${band})`);
    assert.ok(rig.surface.rects.some((r) => colours.includes(r.style) && r.y > band), "and its scopes are drawn in the lane chart below");
  });

  test("draws in CSS pixels on a device-pixel backing store", () => {
    const e = env();
    (e.win as unknown as { devicePixelRatio?: number }).devicePixelRatio = 3;
    const rig = mount(e, history(), 200, 80);
    const canvas = rig.canvas as unknown as { width: number; height: number };
    assert.equal(canvas.width, 400, "200 CSS px at dpr 3, capped at 2");
    assert.equal(rig.timeline.state().dpr, 2);
    const last = rig.surface.transforms[rig.surface.transforms.length - 1]!;
    assert.deepEqual(last, [2, 0, 0, 2, 0, 0], "the whole strip is drawn once, scaled by the dpr");
  });

  test("costs nothing before it has a size, and nothing at all with no history", () => {
    const e = env();
    const unsized = mount(e, history(), 0, 0);
    assert.equal(unsized.timeline.state().painted, 0, "no size, no paint");
    unsized.timeline.tick(1000);
    assert.equal(unsized.timeline.state().painted, 0);

    const empty = mount(env(), []);
    assert.equal(empty.timeline.state().frames, 0);
    assert.equal(empty.timeline.state().selected, null);
    assert.equal(empty.timeline.state().readout, "");
    assert.equal(empty.surface.rects.filter((r) => Object.values(TIMELINE_COLORS).includes(r.style)).length, 0, "no columns");
    assert.equal(empty.surface.rects.length, 2, "backdrop and budget line only: the strip is drawn, just empty");
    assert.deepEqual(empty.surface.texts.map((t) => t.text), ["16.7ms"], "the budget line is still labelled; a peak of nothing is not");
  });

  test("repaints on a throttle, not on every tick", () => {
    const rig = mount(env());
    assert.equal(rig.timeline.state().painted, 1);
    rig.timeline.tick(50);
    assert.equal(rig.timeline.state().painted, 1, "50 ms after the last paint is too soon");
    rig.timeline.tick(200);
    assert.equal(rig.timeline.state().painted, 2, "150 ms later it repaints");
  });

  test("leaves a narrow slice unlabelled and truncates one that is merely cramped", () => {
    const surface = new FakeSurface();
    const model = frameTimeline([
      rec(1, 10, [
        { name: "terrain:AnExtremelyLongSystemName", startMs: 0, durationMs: 1 },
        { name: "physics:Mid", startMs: 2, durationMs: 4 },
      ]),
    ]);
    drawTimeline(surface, model, { width: 360, height: 96, selected: 0 });
    const labels = surface.texts.map((t) => t.text);
    assert.ok(labels.some((t) => t.endsWith("…")), `the long label is truncated (${labels.join(", ")})`);
    assert.ok(labels.every((t) => t !== "AnExtremelyLongSystemName"), "and never overflows its rectangle");
  });
});

group("selection", () => {
  test("hovering a column selects that frame, and the readout follows the pointer", () => {
    const rig = mount(env());
    // Six columns across 360 px: 60 px each, so x=150 is the third frame.
    rig.canvas.fire("pointermove", { clientX: 150, clientY: 20 });
    const state = rig.timeline.state();
    assert.equal(state.hoverFrame, 102);
    assert.equal(state.selected, 2);
    assert.equal(state.pinned, false);
    assert.match(state.readout, /^#102 {2}cpu 8\.20ms/);
    assert.equal(rig.timeline.state().painted, 2, "the hover repainted the strip");
  });

  test("a hover that stays inside one column does not repaint", () => {
    const rig = mount(env());
    rig.canvas.fire("pointermove", { clientX: 150, clientY: 20 });
    const painted = rig.timeline.state().painted;
    rig.canvas.fire("pointermove", { clientX: 155, clientY: 30 });
    assert.equal(rig.timeline.state().painted, painted, "same frame, no work");
  });

  test("leaving the strip returns it to the newest frame", () => {
    const rig = mount(env());
    rig.canvas.fire("pointermove", { clientX: 150, clientY: 20 });
    assert.equal(rig.timeline.state().selected, 2);
    rig.canvas.fire("pointerleave", {});
    assert.equal(rig.timeline.state().hoverFrame, null);
    assert.equal(rig.timeline.state().selected, 5, "back to the newest");
  });

  test("a tap pins the frame, hover stops moving it, and a second tap releases it", () => {
    const rig = mount(env());
    rig.canvas.fire("pointerdown", { clientX: 150, clientY: 20 });
    assert.equal(rig.timeline.state().pinned, true);
    assert.equal(rig.timeline.state().selected, 2);
    rig.canvas.fire("pointermove", { clientX: 330, clientY: 20 });
    assert.equal(rig.timeline.state().selected, 2, "pinned: the strip is frozen where the user put it");
    rig.canvas.fire("pointerdown", { clientX: 150, clientY: 20 });
    assert.equal(rig.timeline.state().pinned, false);
    assert.equal(rig.timeline.state().selected, 5, "released: it follows the newest frame again");
  });

  test("tapping a different column while pinned moves the pin", () => {
    const rig = mount(env());
    rig.canvas.fire("pointerdown", { clientX: 150, clientY: 20 });
    rig.canvas.fire("pointerdown", { clientX: 330, clientY: 20 });
    assert.equal(rig.timeline.state().pinned, true);
    assert.equal(rig.timeline.state().selected, 5);
  });

  test("a pinned frame keeps its identity as the ring turns, and unpins when it scrolls out", () => {
    const records = history();
    const rig = mount(env(), records);
    rig.canvas.fire("pointerdown", { clientX: 30, clientY: 20 });
    assert.equal(rig.timeline.state().selected, 0);
    const pinned = rig.timeline.state().selectedFrame;
    assert.equal(pinned, 100);

    // Two new frames: the pinned one slides from position 0 to position 0 of a window that no
    // longer starts at 100, and the strip must still be showing frame 100.
    records.push(rec(106, 9, []), rec(107, 9, []));
    rig.timeline.paint();
    assert.equal(rig.timeline.state().selectedFrame, pinned, "still frame 100");
    assert.equal(rig.timeline.state().selected, 0, "at its new position in the window");

    // Now push it out of a five-frame window entirely: the pin cannot be honoured.
    const ring = mount(env(), history(5));
    ring.timeline.pin(100);
    assert.equal(ring.timeline.state().selected, 0);
    for (let i = 0; i < 6; i++) ring.records.push(rec(200 + i, 9, []));
    ring.records.splice(0, ring.records.length - 5);
    ring.timeline.paint();
    assert.equal(ring.timeline.state().pinned, false, "the pin is dropped rather than silently moved");
    assert.equal(ring.timeline.state().selected, 4, "and the strip follows the newest frame again");
  });

  test("a pointer outside the strip selects nothing", () => {
    const rig = mount(env());
    rig.canvas.fire("pointermove", { clientX: -20, clientY: 20 });
    assert.equal(rig.timeline.state().hoverFrame, null);
    rig.canvas.fire("pointerdown", { clientX: 400, clientY: 20 });
    assert.equal(rig.timeline.state().pinned, false, "a tap past the right edge does not pin the last column");
  });
});

group("in the floating panel", () => {
  test("the panel puts the strip and a readout above the report, and paints them on open", () => {
    const e = env();
    const surface = new FakeSurface();
    const body = new FakeEl("pre");
    const button = new FakeEl("button");
    e.body.append(body, button);
    let frame = 0;
    const panel = mountProfilerPanel({
      body: body as unknown as HTMLElement,
      button: button as unknown as HTMLElement,
      report: () => `frame ${++frame}`,
      storage: null,
      // The fake DOM has no layout, so the strip is told its size the way a host with a fixed
      // strip would be; in the page it measures its own element.
      timeline: { frames: () => history(), createContext: () => surface, width: 360, height: 96 },
      doc: e.doc,
      win: e.win,
      now: e.now,
    });
    assert.equal(panel.timelineState()!.painted, 0, "nothing is painted while the panel is closed");
    assert.equal(surface.rects.length, 0);

    button.click();
    const state = panel.timelineState()!;
    assert.equal(state.painted, 1, "opening the panel paints the strip");
    assert.equal(state.frames, 6);
    assert.match(state.readout, /^#105/);

    // The body the panel was given is the report; the strip and its readout are siblings above it.
    const wrapper = body.parentNode!;
    assert.ok(wrapper.classes.has("fdp-body"), "the wrapper became the panel's body");
    // The wrapper is only in the document because the panel asked it to stand where the report
    // stood: detach it and the whole panel (and the demo's #profiler-panel id) disappears.
    assert.ok(panel.ui.root.parentNode, "the panel's root is attached to the document");
    assert.ok(
      (e.body as unknown as { children: unknown[] }).children.includes(panel.ui.root),
      "the panel is a child of the body, not an orphan",
    );
    assert.deepEqual(wrapper.children.map((c) => c.tag), ["canvas", "div", "pre"]);
    assert.match(wrapper.children[1]!.textContent, /^#105 {2}cpu 40\.00ms/, "the readout is a real element, so it is selectable");
    assert.match(body.textContent, /^frame \d+$/, "and the report is still painted underneath");

    // Repainting the panel repaints the strip with it (one throttle, 4 Hz, for both).
    panel.tick(1000);
    assert.equal(panel.timelineState()!.painted, 2);

    assert.ok(
      wrapper.children[0]!.style.cssText.includes("pointer-events:auto"),
      "the strip takes pointer input back from the panel's pointer-transparent body",
    );
    panel.dispose();
  });

  test("a panel with no timeline is the text-only panel it always was", () => {
    const e = env();
    const body = new FakeEl("pre");
    e.body.appendChild(body);
    let frame = 0;
    const panel = mountProfilerPanel({
      body: body as unknown as HTMLElement,
      report: () => `frame ${++frame}`,
      storage: null,
      doc: e.doc,
      win: e.win,
      now: e.now,
    });
    assert.equal(panel.timelineState(), null);
    panel.setVisible(true);
    assert.match(body.textContent, /^frame \d+$/);
    assert.ok(
      !body.parentNode!.children.some((c) => c.tag === "canvas"),
      "the report is the panel's body, unwrapped: no strip was added",
    );
    panel.dispose();
  });
});

group("lifecycle", () => {
  test("a disposed strip stops painting and stops listening", () => {
    const rig = mount(env());
    rig.timeline.dispose();
    const painted = rig.timeline.state().painted;
    rig.timeline.paint();
    rig.timeline.tick(5000);
    rig.canvas.fire("pointermove", { clientX: 150, clientY: 20 });
    assert.equal(rig.timeline.state().painted, painted, "nothing is drawn after dispose");
    assert.equal(rig.timeline.state().hoverFrame, null, "and the pointer no longer selects");
  });
});

finish();
