/**
 * @suite examples:debugPanel
 * @group unit
 * @covers examples/src/diag/debugPanel.ts
 * @covers examples/src/diag/panelLayout.ts
 * @desc Pins the floating debug panels: drag/resize clamping, off-screen recovery and reset, layout persistence, edge-snap dwell timer + ghost + snap on release, rotation re-clamp, collapsed corner icon placement, and copy with the clipboard fallback
 */

export const suite = {
  name: "examples:debugPanel",
  group: "unit",
  covers: [
    "examples/src/diag/debugPanel.ts",
    "examples/src/diag/panelLayout.ts",
  ],
  desc: "Pins the floating debug panels: drag/resize clamping, off-screen recovery and reset, layout persistence, edge-snap dwell timer + ghost + snap on release, rotation re-clamp, collapsed corner icon placement, and copy with the clipboard fallback",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { ICONS, copyResultLabel, mountDebugPanel, type DebugPanelOptions } from "../../examples/src/diag/debugPanel.js";
import {
  SnapTracker, bounds, clampRect, cornerIcon, readInsets, withMargin, dragRect, isOffscreen, loadLayout, nearEdges, placeIcon, resizeRect, resolveRect, saveLayout, snapRect,
  type StorageLike,
} from "../../examples/src/diag/panelLayout.js";
import { FakeEl, env } from "../support/fakeDom.js";

const VP = { w: 400, h: 800 };
const MIN = { w: 100, h: 60 };

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

group("panelLayout geometry", () => {
  test("clampRect keeps the rect on-screen and within min/viewport size", () => {
    assert.deepEqual(clampRect({ x: -50, y: 900, w: 50, h: 2000 }, VP, MIN), { x: 0, y: 0, w: 100, h: 800 });
    assert.deepEqual(clampRect({ x: 350, y: 10, w: 200, h: 100 }, VP, MIN), { x: 200, y: 10, w: 200, h: 100 });
  });
  test("dragRect clamps at every edge", () => {
    const r = { x: 10, y: 10, w: 200, h: 100 };
    assert.deepEqual(dragRect(r, -500, -500, VP, MIN), { x: 0, y: 0, w: 200, h: 100 });
    assert.deepEqual(dragRect(r, 999, 999, VP, MIN), { x: 200, y: 700, w: 200, h: 100 });
  });
  test("resizeRect br grows to the viewport edge and not below min", () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    assert.deepEqual(resizeRect(r, 999, 999, "br", VP, MIN), { x: 100, y: 100, w: 300, h: 700 });
    assert.deepEqual(resizeRect(r, -999, -999, "br", VP, MIN), { x: 100, y: 100, w: 100, h: 60 });
  });
  test("resizeRect tr keeps the bottom edge fixed and stops at the top", () => {
    const r = { x: 0, y: 100, w: 200, h: 100 };
    assert.deepEqual(resizeRect(r, 0, -50, "tr", VP, MIN), { x: 0, y: 50, w: 200, h: 150 });
    assert.deepEqual(resizeRect(r, 0, -999, "tr", VP, MIN), { x: 0, y: 0, w: 200, h: 200 });
    assert.deepEqual(resizeRect(r, 0, 999, "tr", VP, MIN), { x: 0, y: 140, w: 200, h: 60 });
  });
  test("isOffscreen / resolveRect: off-screen or invalid layouts reset to the default, near ones clamp", () => {
    assert.equal(isOffscreen({ x: 1200, y: 10, w: 300, h: 200 }, VP), true, "saved on a wider screen");
    assert.equal(isOffscreen({ x: 380, y: 10, w: 300, h: 200 }, VP), true, "only 20px visible");
    assert.equal(isOffscreen({ x: 300, y: 10, w: 300, h: 200 }, VP), false);
    assert.equal(isOffscreen({ x: NaN, y: 0, w: 1, h: 1 }, VP), true);
    const def = { x: 10, y: 10, w: 200, h: 100 };
    assert.deepEqual(resolveRect({ x: 1200, y: 0, w: 300, h: 200 }, def, VP, MIN), { rect: def, reset: true });
    assert.deepEqual(resolveRect({ x: 300, y: 10, w: 300, h: 200 }, def, VP, MIN), { rect: { x: 100, y: 10, w: 300, h: 200 }, reset: false });
    assert.deepEqual(resolveRect(null, def, VP, MIN), { rect: def, reset: false });
  });
  test("placeIcon slides past obstacles and stops at the edge", () => {
    const icon = { x: 346, y: 746, w: 44, h: 44 };
    assert.deepEqual(placeIcon(icon, [{ x: 200, y: 600, w: 200, h: 200 }], "up"), { x: 346, y: 548, w: 44, h: 44 });
    assert.deepEqual(placeIcon({ x: 346, y: 10, w: 44, h: 44 }, [{ x: 340, y: 10, w: 50, h: 44 }], "left"), { x: 288, y: 10, w: 44, h: 44 });
    assert.deepEqual(placeIcon(icon, [{ x: 300, y: 700, w: 100, h: 100 }, { x: 300, y: 600, w: 100, h: 92 }], "up").y, 548, "chains");
    assert.equal(placeIcon(icon, [{ x: 0, y: 0, w: 400, h: 800 }], "up").y, 0, "clamped at the top");
  });
});

group("safe-area insets", () => {
  // iPhone portrait: notch 47 top, home indicator 34 bottom; + 10px margin.
  const SAFE = { w: 390, h: 844, inset: withMargin({ l: 0, t: 47, r: 0, b: 34 }, 10) };
  test("readInsets parses probe padding (px, junk → 0)", () => {
    assert.deepEqual(readInsets({ paddingLeft: "0px", paddingTop: "47px", paddingRight: "", paddingBottom: "34.5px" }), { l: 0, t: 47, r: 0, b: 34.5 });
    assert.deepEqual(readInsets(null), { l: 0, t: 0, r: 0, b: 0 });
    assert.deepEqual(bounds(SAFE), { l: 10, t: 57, r: 380, b: 800, w: 370, h: 743 });
  });
  test("clamp, drag and resize stay inside the safe area + margin", () => {
    assert.deepEqual(clampRect({ x: -50, y: -50, w: 200, h: 100 }, SAFE, MIN), { x: 10, y: 57, w: 200, h: 100 });
    assert.deepEqual(clampRect({ x: 999, y: 999, w: 999, h: 100 }, SAFE, MIN), { x: 10, y: 700, w: 370, h: 100 });
    assert.deepEqual(dragRect({ x: 10, y: 100, w: 200, h: 100 }, 0, 9999, SAFE, MIN).y, 700);
    assert.deepEqual(resizeRect({ x: 10, y: 100, w: 200, h: 100 }, 9999, 9999, "br", SAFE, MIN), { x: 10, y: 100, w: 370, h: 700 });
    assert.deepEqual(resizeRect({ x: 10, y: 300, w: 200, h: 100 }, 0, -9999, "tr", SAFE, MIN), { x: 10, y: 57, w: 200, h: 343 });
  });
  test("snap targets and edge detection are relative to the safe area", () => {
    assert.deepEqual(nearEdges({ x: 20, y: 60, w: 100, h: 100 }, SAFE, 24), { x: "left", y: "top" });
    assert.deepEqual(snapRect({ x: 20, y: 60, w: 100, h: 100 }, { x: "left", y: "top" }, SAFE, MIN), { x: 10, y: 57, w: 100, h: 100 });
    assert.deepEqual(snapRect({ x: 20, y: 60, w: 100, h: 100 }, { x: "right", y: "bottom" }, SAFE, MIN), { x: 280, y: 700, w: 100, h: 100 });
    // landscape: notch on the left
    const LAND = { w: 844, h: 390, inset: withMargin({ l: 47, t: 0, r: 47, b: 21 }, 10) };
    assert.deepEqual(snapRect({ x: 0, y: 0, w: 200, h: 100 }, { x: "left", y: "bottom" }, LAND, MIN), { x: 57, y: 259, w: 200, h: 100 });
  });
  test("corner icons and placeIcon respect the safe area", () => {
    assert.deepEqual(cornerIcon("bottom-right", SAFE), { x: 336, y: 756, w: 44, h: 44 });
    assert.deepEqual(cornerIcon("top-right", SAFE), { x: 336, y: 57, w: 44, h: 44 });
    assert.equal(placeIcon(cornerIcon("bottom-right", SAFE), [{ x: 0, y: 0, w: 390, h: 844 }], "up", 8, SAFE).y, 57);
  });
  test("mounted panel: defaults, snap and rotation use measured insets, refreshed on resize", () => {
    const e = env({ vp: { w: 390, h: 844 } });
    let pad = { paddingLeft: "0px", paddingTop: "47px", paddingRight: "0px", paddingBottom: "34px" };
    const m = mount(e, {
      margin: 10,
      readSafeArea: () => pad,
      defaultRect: (vp) => { const b = bounds(vp); return { x: b.l, y: b.t, w: 200, h: 150 }; },
    });
    assert.deepEqual(m.p.rect, { x: 10, y: 57, w: 200, h: 150 }, "default below the notch");
    m.bar.fire("pointerdown", { clientX: 100, clientY: 100 });
    m.bar.fire("pointermove", { clientX: 9999, clientY: 9999 });
    e.advance(2100);
    m.bar.fire("pointerup", { clientX: 9999, clientY: 9999 });
    assert.deepEqual(m.p.rect, { x: 180, y: 650, w: 200, h: 150 }, "snapped above the home indicator");
    pad = { paddingLeft: "47px", paddingTop: "0px", paddingRight: "47px", paddingBottom: "21px" };
    e.rotate(844, 390);
    assert.deepEqual(m.p.rect, { x: 587, y: 209, w: 200, h: 150 }, "re-measured insets after rotation");
    m.p.setCollapsed(true);
    assert.equal(m.icon.style.left, `${844 - 57 - 44}px`);
    assert.equal(m.icon.style.top, `${390 - 31 - 44}px`);
  });
});

group("touch pass-through", () => {
  test("passThroughBody: body ignores pointers; bar and grip still take them", () => {
    const e = env();
    const m = mount(e, { passThroughBody: true });
    assert.ok(m.root.classes.has("fdp-pass"));
    assert.equal(m.panelBody.style.pointerEvents, "none");
    const css = e.head.children.find((c) => c.tag === "style")!.textContent;
    assert.match(css, /\.fdp\.fdp-pass\{pointer-events:none\}/);
    assert.match(css, /\.fdp\.fdp-pass>\.fdp-bar,\.fdp\.fdp-pass>\.fdp-grip\{pointer-events:auto\}/);
    m.bar.fire("pointerdown", { clientX: 100, clientY: 310 });
    m.bar.fire("pointermove", { clientX: 120, clientY: 330 });
    m.bar.fire("pointerup", { clientX: 120, clientY: 330 });
    assert.deepEqual(m.p.rect, { x: 70, y: 320, w: 200, h: 150 }, "bar still drags");
  });
  test("default (diag): body keeps pointer events for scrolling/selection", () => {
    const m = mount(env());
    assert.ok(!m.root.classes.has("fdp-pass"));
    assert.equal(m.panelBody.style.pointerEvents, undefined);
  });
});

group("layout persistence", () => {
  test("round-trips collapsed, rect and snap edges", () => {
    const s = mem();
    saveLayout(s, "k", { collapsed: true, rect: { x: 1, y: 2, w: 3, h: 4 }, snap: { x: "right", y: "bottom" } });
    assert.deepEqual(loadLayout(s, "k", false), { collapsed: true, rect: { x: 1, y: 2, w: 3, h: 4 }, snap: { x: "right", y: "bottom" } });
  });
  test("garbage, partial or throwing storage falls back to defaults without throwing", () => {
    const s = mem();
    s.data.set("k", "{not json");
    assert.deepEqual(loadLayout(s, "k", true), { collapsed: true, rect: null });
    s.data.set("k", JSON.stringify({ collapsed: "yes", rect: { x: 1 }, snap: { x: "middle" } }));
    assert.deepEqual(loadLayout(s, "k", false), { collapsed: false, rect: null, snap: null });
    const bad: StorageLike = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("Quota"); } };
    assert.deepEqual(loadLayout(bad, "k", false), { collapsed: false, rect: null });
    saveLayout(bad, "k", { collapsed: true, rect: null });
    assert.deepEqual(loadLayout(null, "k", true), { collapsed: true, rect: null });
  });
});

group("edge snapping", () => {
  test("nearEdges detects sides and corners within the threshold", () => {
    assert.deepEqual(nearEdges({ x: 10, y: 300, w: 100, h: 100 }, VP, 24), { x: "left" });
    assert.deepEqual(nearEdges({ x: 290, y: 690, w: 100, h: 100 }, VP, 24), { x: "right", y: "bottom" });
    assert.equal(nearEdges({ x: 100, y: 300, w: 100, h: 100 }, VP, 24), null);
    assert.deepEqual(snapRect({ x: 290, y: 690, w: 100, h: 100 }, { x: "right", y: "bottom" }, VP, MIN), { x: 300, y: 700, w: 100, h: 100 });
  });
  test("dwell: ghost only after 2 s held near the edge; moving away hides it and resets the timer", () => {
    const t = new SnapTracker(() => VP, MIN, 24, 2000);
    const near = { x: 10, y: 300, w: 100, h: 100 };
    t.update(near, 0);
    assert.equal(t.tick(1999), false);
    assert.equal(t.ghost, null);
    assert.equal(t.tick(2000), true, "ghost appears from the timer alone (finger held still)");
    assert.deepEqual(t.ghost, { x: 0, y: 300, w: 100, h: 100 });
    assert.equal(t.update({ ...near, y: 320 }, 2100), true, "ghost follows along the same edge");
    assert.equal(t.update({ ...near, x: 150 }, 2200), true, "leaving the edge hides the ghost");
    assert.equal(t.ghost, null);
    t.update(near, 2300);
    assert.equal(t.tick(4000), false, "timer restarted on re-entry");
    assert.equal(t.tick(4300), true);
  });
  test("changing edges (side → corner) restarts the dwell", () => {
    const t = new SnapTracker(() => VP, MIN, 24, 2000);
    t.update({ x: 10, y: 300, w: 100, h: 100 }, 0);
    t.tick(2000);
    assert.ok(t.ghost);
    t.update({ x: 10, y: 690, w: 100, h: 100 }, 2100);
    assert.equal(t.ghost, null);
    t.tick(4100);
    assert.deepEqual(t.ghostEdges, { x: "left", y: "bottom" });
    assert.deepEqual(t.ghost, { x: 0, y: 700, w: 100, h: 100 });
  });
  test("release snaps only while the ghost shows", () => {
    const t = new SnapTracker(() => VP, MIN, 24, 2000);
    t.update({ x: 10, y: 300, w: 100, h: 100 }, 0);
    assert.equal(t.release(), null, "released before the dwell");
    t.update({ x: 10, y: 300, w: 100, h: 100 }, 0);
    t.tick(2500);
    assert.deepEqual(t.release(), { rect: { x: 0, y: 300, w: 100, h: 100 }, edges: { x: "left" } });
    assert.equal(t.ghost, null);
  });
});

// ---- DOM-level tests with the shared fake document/window (tests/support/fakeDom.ts) ----

function mount(e: ReturnType<typeof env>, extra: Partial<DebugPanelOptions> = {}) {
  const panelBody = new FakeEl("div");
  e.body.appendChild(panelBody);
  const p = mountDebugPanel({
    body: panelBody as unknown as HTMLElement,
    title: "stats",
    barEdge: "top",
    getText: () => "fps 60",
    storageKey: "k",
    defaultRect: () => ({ x: 50, y: 300, w: 200, h: 150 }),
    minSize: MIN,
    iconCorner: "bottom-right",
    iconSvg: ICONS.bug,
    avoid: [".obstacle"],
    storage: null,
    clipboard: null,
    doc: e.doc,
    win: e.win,
    now: e.now,
    margin: 0,
    readSafeArea: () => null,
    ...extra,
  });
  return { p, panelBody, root: p.root as unknown as FakeEl, bar: p.bar as unknown as FakeEl, grip: p.grip as unknown as FakeEl, ghost: p.ghost as unknown as FakeEl, icon: p.icon as unknown as FakeEl };
}

group("mountDebugPanel", () => {
  test("bar order: reset, copy, then collapse at the far right; buttons don't start a drag", () => {
    const e = env();
    const m = mount(e);
    const ids = m.bar.children.map((c) => [...c.classes].find((k) => k.startsWith("fdp-") && k !== "fdp-btn"));
    assert.deepEqual(ids.slice(-3), ["fdp-reset", "fdp-copy", "fdp-toggle"]);
    assert.equal((m.p.copyButton as unknown as FakeEl).fire("pointerdown"), true, "button pointerdown is stopped");
    assert.match((m.p.copyButton as unknown as FakeEl).innerHTML, /<svg/);
  });
  test("collapse shows only the corner icon; tapping it expands; state persists", () => {
    const e = env();
    const s = mem();
    const m = mount(e, { storage: s });
    assert.ok(!m.icon.classes.has("fdp-icon-on"));
    (m.p.toggleButton as unknown as FakeEl).click();
    assert.ok(m.root.classes.has("fdp-collapsed"));
    assert.ok(m.icon.classes.has("fdp-icon-on"));
    assert.equal(JSON.parse(s.data.get("k")!).collapsed, true);
    const again = mount(env(), { storage: s });
    assert.equal(again.p.collapsed, true, "restored collapsed");
    again.icon.click();
    assert.equal(again.p.collapsed, false);
  });
  test("onCollapsedChange fires for every collapse source (bar, icon, setCollapsed) but not on mount", () => {
    const e = env();
    const seen: boolean[] = [];
    const m = mount(e, { onCollapsedChange: (c) => seen.push(c) });
    assert.deepEqual(seen, [], "mounting must not announce the restored state; read `collapsed` for it");
    (m.p.toggleButton as unknown as FakeEl).click();
    assert.deepEqual(seen, [true], "bar collapse button");
    m.icon.click();
    assert.deepEqual(seen, [true, false], "corner icon expands");
    m.p.setCollapsed(true);
    assert.deepEqual(seen, [true, false, true], "host-driven setCollapsed too");
  });
  test("drag by the bar moves + clamps, uses pointer capture, and persists the rect", () => {
    const e = env();
    const s = mem();
    const m = mount(e, { storage: s });
    m.bar.fire("pointerdown", { clientX: 100, clientY: 310 });
    assert.equal(m.bar.captured, 1);
    m.bar.fire("pointermove", { clientX: 160, clientY: 2000 });
    assert.deepEqual(m.p.rect, { x: 110, y: 650, w: 200, h: 150 });
    assert.equal(m.root.style.top, "650px");
    m.bar.fire("pointerup", { clientX: 160, clientY: 2000 });
    assert.deepEqual(JSON.parse(s.data.get("k")!).rect, { x: 110, y: 650, w: 200, h: 150 });
    const again = mount(env(), { storage: s });
    assert.deepEqual(again.p.rect, { x: 110, y: 650, w: 200, h: 150 }, "restored position");
  });
  test("resize grip clamps to the viewport and min size", () => {
    const e = env();
    const m = mount(e);
    m.grip.fire("pointerdown", { clientX: 0, clientY: 0 });
    m.grip.fire("pointermove", { clientX: 9999, clientY: 9999 });
    m.grip.fire("pointerup");
    assert.deepEqual(m.p.rect, { x: 50, y: 300, w: 350, h: 500 });
    m.grip.fire("pointerdown", { clientX: 0, clientY: 0 });
    m.grip.fire("pointermove", { clientX: -9999, clientY: -9999 });
    m.grip.fire("pointerup");
    assert.deepEqual(m.p.rect, { x: 50, y: 300, w: 100, h: 60 });
  });
  test("edge snap: ghost after 2 s dwell (no moves needed), hides when moved away, snaps + persists on release", () => {
    const e = env();
    const s = mem();
    const m = mount(e, { storage: s });
    m.bar.fire("pointerdown", { clientX: 100, clientY: 310 });
    m.bar.fire("pointermove", { clientX: 60, clientY: 310 }); // x = 10, within 24px of the left edge
    e.advance(1900);
    assert.ok(!m.ghost.classes.has("fdp-ghost-on"));
    e.advance(200);
    assert.ok(m.ghost.classes.has("fdp-ghost-on"), "ghost visible");
    assert.equal(m.ghost.style.left, "0px");
    m.bar.fire("pointermove", { clientX: 200, clientY: 310 }); // away from the edge
    assert.ok(!m.ghost.classes.has("fdp-ghost-on"), "ghost hidden");
    m.bar.fire("pointermove", { clientX: 60, clientY: 310 });
    e.advance(1000);
    assert.ok(!m.ghost.classes.has("fdp-ghost-on"), "timer was reset");
    e.advance(1100);
    assert.ok(m.ghost.classes.has("fdp-ghost-on"));
    m.bar.fire("pointerup", { clientX: 60, clientY: 310 });
    assert.equal(m.p.rect.x, 0, "snapped flush left");
    assert.deepEqual(m.p.snap, { x: "left" });
    assert.ok(!m.ghost.classes.has("fdp-ghost-on"));
    const saved = JSON.parse(s.data.get("k")!);
    assert.deepEqual(saved.snap, { x: "left" });
    assert.equal(saved.rect.x, 0);
  });
  test("releasing before the dwell does not snap", () => {
    const e = env();
    const m = mount(e);
    m.bar.fire("pointerdown", { clientX: 100, clientY: 310 });
    m.bar.fire("pointermove", { clientX: 60, clientY: 310 });
    e.advance(500);
    m.bar.fire("pointerup", { clientX: 60, clientY: 310 });
    assert.equal(m.p.rect.x, 10);
    assert.equal(m.p.snap, null);
  });
  test("rotation keeps a corner-snapped panel flush and others clamped", () => {
    const e = env();
    const m = mount(e);
    m.bar.fire("pointerdown", { clientX: 100, clientY: 310 });
    m.bar.fire("pointermove", { clientX: 290, clientY: 950 }); // clamps to bottom-right corner
    e.advance(2100);
    m.bar.fire("pointerup", { clientX: 290, clientY: 950 });
    assert.deepEqual(m.p.snap, { x: "right", y: "bottom" });
    e.rotate(800, 400);
    assert.deepEqual(m.p.rect, { x: 600, y: 250, w: 200, h: 150 }, "flush bottom-right in landscape");
    const e2 = env();
    const m2 = mount(e2);
    m2.bar.fire("pointerdown", { clientX: 100, clientY: 310 });
    m2.bar.fire("pointermove", { clientX: 200, clientY: 700 });
    m2.bar.fire("pointerup", { clientX: 200, clientY: 700 });
    e2.rotate(800, 400);
    assert.deepEqual(m2.p.rect, { x: 150, y: 250, w: 200, h: 150 }, "clamped on-screen after rotation");
  });
  test("off-screen stored layout auto-resets; reset button restores the default", () => {
    const s = mem();
    saveLayout(s, "k", { collapsed: false, rect: { x: 1500, y: 20, w: 200, h: 150 }, snap: null });
    const m = mount(env(), { storage: s });
    assert.deepEqual(m.p.rect, { x: 50, y: 300, w: 200, h: 150 });
    assert.equal(JSON.parse(s.data.get("k")!).rect, null, "bad layout cleared");
    m.bar.fire("pointerdown", { clientX: 100, clientY: 310 });
    m.bar.fire("pointermove", { clientX: 150, clientY: 400 });
    m.bar.fire("pointerup", { clientX: 150, clientY: 400 });
    (m.p.resetButton as unknown as FakeEl).click();
    assert.deepEqual(m.p.rect, { x: 50, y: 300, w: 200, h: 150 });
    assert.equal(JSON.parse(s.data.get("k")!).rect, null);
  });
  test("collapsed icon slides above controls in the bottom-right corner", () => {
    const e = env();
    const pad = new FakeEl("div");
    pad.box = { left: 250, top: 600, width: 150, height: 200 };
    e.obstacles.push(pad);
    const m = mount(e, { margin: 10 });
    m.p.setCollapsed(true);
    assert.equal(m.icon.style.left, "346px");
    assert.equal(m.icon.style.top, `${600 - 8 - 44}px`);
  });
  test("copy uses the clipboard, falls back to execCommand, and reports failure", async () => {
    const written: string[] = [];
    const a = mount(env(), { clipboard: { writeText: async (t) => void written.push(t) } });
    const p = a.p.copy();
    assert.deepEqual(written, ["fps 60"], "synchronous inside the gesture");
    assert.equal(await p, true);
    const e = env();
    const b = mount(e, { clipboard: { writeText: () => Promise.reject(new Error("NotAllowed")) } });
    assert.equal(await b.p.copy(), true);
    assert.deepEqual(e.execs, ["copy"]);
    const c = mount(env({ execOk: false }));
    assert.equal(await c.p.copy(), false);
    assert.equal(copyResultLabel(false), "Copy failed");
  });
  test("dispose removes the panel, ghost and icon", () => {
    const e = env();
    const m = mount(e);
    m.p.dispose();
    assert.equal(e.body.children.length, 0);
  });
});

finish();
