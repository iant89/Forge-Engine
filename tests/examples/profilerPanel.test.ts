/**
 * @suite examples:profilerPanel
 * @group unit
 * @covers examples/src/diag/profilerPanel.ts
 * @desc Pins the demo's floating Profiler panel: it starts closed, the toolbar button and the panel's own collapse button / corner icon drive one shared state, repainting is throttled and only happens while the panel is open, and the shared debug-panel chrome gives it resize, edge-snap docking and persistence
 */

export const suite = {
  name: "examples:profilerPanel",
  group: "unit",
  covers: [
    "examples/src/diag/profilerPanel.ts",
  ],
  desc: "Pins the demo's floating Profiler panel: it starts closed, the toolbar button and the panel's own collapse button / corner icon drive one shared state, repainting is throttled and only happens while the panel is open, and the shared debug-panel chrome gives it resize, edge-snap docking and persistence",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { mountProfilerPanel, type ProfilerPanelOptions } from "../../examples/src/diag/profilerPanel.js";
import { saveLayout, type StorageLike } from "../../examples/src/diag/panelLayout.js";
import { FakeEl, env, type FakeEnv } from "../support/fakeDom.js";

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** The demo's wiring: a `<pre>` report body in the page, a Profiler button in the toolbar. */
function mountProfiler(e: FakeEnv, extra: Partial<ProfilerPanelOptions> = {}) {
  const body = new FakeEl("pre");
  const toolbar = new FakeEl("div");
  const button = new FakeEl("button");
  e.body.append(body, toolbar);
  toolbar.appendChild(button);
  let frame = 0;
  const p = mountProfilerPanel({
    body: body as unknown as HTMLElement,
    button: button as unknown as HTMLElement,
    report: () => `frame ${++frame}`,
    storage: null,
    doc: e.doc,
    win: e.win,
    now: e.now,
    ...extra,
  });
  return {
    p,
    body,
    button,
    paints: () => frame,
    // The panel's own chrome, as the fake elements the harness built.
    icon: p.ui.icon as unknown as FakeEl,
    ghost: p.ui.ghost as unknown as FakeEl,
    bar: p.ui.bar as unknown as FakeEl,
    grip: p.ui.grip as unknown as FakeEl,
    toggle: p.ui.toggleButton as unknown as FakeEl,
  };
}

group("profiler panel open/close state", () => {
  test("starts closed: nothing painted, toolbar button inactive, corner icon is the way back in", () => {
    const e = env();
    const m = mountProfiler(e);
    assert.equal(m.p.visible, false);
    assert.equal(m.p.ui.collapsed, true);
    assert.equal(m.body.textContent, "", "a closed profiler paints nothing");
    assert.equal(m.button.classes.has("active"), false);
    assert.equal(m.button.attrs["aria-pressed"], "false");
    assert.ok(m.icon.classes.has("fdp-icon-on"), "collapsed to the corner icon");
    assert.equal(m.body.style.pointerEvents, "none", "the report is pointer-transparent so camera drags reach the canvas");
  });

  test("the toolbar button opens the panel, paints the report and lights up", () => {
    const e = env();
    const m = mountProfiler(e);
    m.button.click();
    assert.equal(m.p.visible, true);
    assert.equal(m.p.ui.collapsed, false);
    assert.match(m.body.textContent, /^frame \d+$/, "painted on open, never the stale placeholder");
    assert.ok(m.button.classes.has("active"));
    assert.equal(m.button.attrs["aria-pressed"], "true");
    assert.ok(!m.icon.classes.has("fdp-icon-on"));
  });

  test("collapsing from the panel's own bar syncs the toolbar button; the corner icon re-opens it", () => {
    const e = env();
    const m = mountProfiler(e);
    m.button.click();
    (m.toggle).click();
    assert.equal(m.p.visible, false, "the panel's collapse button wins");
    assert.equal(m.button.classes.has("active"), false);
    assert.equal(m.button.attrs["aria-pressed"], "false");
    m.p.ui.icon.click();
    assert.equal(m.p.visible, true);
    assert.equal(m.button.attrs["aria-pressed"], "true", "and the toolbar button follows the icon");
  });

  test("setVisible drives the same state and is idempotent", () => {
    const e = env();
    const m = mountProfiler(e);
    m.p.setVisible(true);
    m.p.setVisible(true);
    assert.equal(m.paints(), 1, "a no-op open does not repaint");
    m.p.setVisible(false);
    m.p.setVisible(false);
    assert.equal(m.p.visible, false);
    assert.equal(m.button.attrs["aria-pressed"], "false");
  });

  test("a layout restored open is adopted: button synced, report painted, rect honoured", () => {
    const s = mem();
    saveLayout(s, "forge.panel.profiler", { collapsed: false, rect: { x: 20, y: 40, w: 300, h: 200 }, snap: null });
    const e = env();
    const m = mountProfiler(e, { storage: s });
    assert.equal(m.p.visible, true, "left open last session");
    assert.equal(m.button.attrs["aria-pressed"], "true");
    assert.match(m.body.textContent, /^frame \d+$/);
    assert.deepEqual(m.p.ui.rect, { x: 20, y: 40, w: 300, h: 200 });
  });
});

group("profiler panel repaint throttle", () => {
  test("tick repaints at most every repaintMs, and never while closed", () => {
    const e = env();
    const m = mountProfiler(e, { repaintMs: 250 });
    m.p.setVisible(true);
    assert.equal(m.paints(), 1, "painted on open");
    m.p.tick(0);
    m.p.tick(249);
    assert.equal(m.paints(), 1, "inside the interval");
    m.p.tick(250);
    assert.equal(m.paints(), 2, "the interval elapsed");
    m.p.tick(400);
    assert.equal(m.paints(), 2, "and restarts from the repaint, not from the open");
    m.p.tick(500);
    assert.equal(m.paints(), 3);
    m.p.setVisible(false);
    m.p.tick(100000);
    assert.equal(m.paints(), 3, "a closed profiler never repaints");
  });

  test("tick defaults to the panel clock when no timestamp is given", () => {
    const e = env();
    const m = mountProfiler(e, { repaintMs: 250 });
    m.p.setVisible(true);
    e.advance(300);
    m.p.tick();
    assert.equal(m.paints(), 2, "the frame loop's clock is the panel's clock");
  });
});

group("profiler panel chrome: resize, dock, dispose", () => {
  test("the corner grip resizes and a dwell near an edge docks the panel", () => {
    const e = env();
    const m = mountProfiler(e);
    m.p.setVisible(true);
    assert.deepEqual(m.p.ui.rect, { x: 10, y: 554, w: 360, h: 236 }, "defaults to the bottom of the safe area (10px margin)");

    // Shrink with the corner grip, down to the minimum size.
    const grip = m.grip;
    grip.fire("pointerdown", { clientX: 100, clientY: 300 });
    grip.fire("pointermove", { clientX: -60, clientY: 184 }); // -160 x, -116 y
    grip.fire("pointerup", { clientX: -60, clientY: 184 });
    assert.deepEqual(m.p.ui.rect, { x: 10, y: 554, w: 240, h: 120 }, "the grip resizes, clamped to the minimum");

    // Drag into the middle of the screen: no edge is near, so no dock ghost appears however long
    // the pointer is held there.
    const bar = m.bar;
    bar.fire("pointerdown", { clientX: 100, clientY: 300 });
    bar.fire("pointermove", { clientX: 150, clientY: 200 });
    e.advance(2100);
    assert.ok(!m.ghost.classes.has("fdp-ghost-on"), "no dock hint in the middle of the screen");

    // Back into the bottom-left corner and held: the ghost shows after the dwell, and releasing on
    // it docks the panel there and records the edges.
    bar.fire("pointermove", { clientX: 100, clientY: 392 });
    e.advance(2100);
    assert.ok(m.ghost.classes.has("fdp-ghost-on"), "held near the corner");
    bar.fire("pointerup", { clientX: 100, clientY: 392 });
    assert.deepEqual(m.p.layout(), { visible: true, collapsed: false, rect: { x: 10, y: 670, w: 240, h: 120 }, snap: { x: "left", y: "bottom" } });
  });

  test("dispose takes the panel, its ghost and its icon out of the page", () => {
    const e = env();
    const m = mountProfiler(e);
    m.p.setVisible(true);
    m.p.dispose();
    assert.equal(m.p.ui.root.parentNode, null);
    assert.equal(m.p.ui.icon.parentNode, null);
    assert.equal(m.p.ui.ghost.parentNode, null);
  });
});

finish();
