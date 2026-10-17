/**
 * @suite ui:uiManager
 * @group integration
 * @covers engine/src/ui/manager.ts
 * @covers engine/src/ui/responsive.ts
 * @covers engine/src/ui/diagnostics.ts
 * @covers engine/src/ui/declarative.ts
 * @covers engine/src/ui/render/drawList.ts
 * @covers engine/src/ui/render/painter.ts
 * @covers engine/src/ui/render/assets.ts
 * @covers engine/src/ui/widgets/registerBuiltins.ts
 * @desc The UI manager end to end: breakpoints with hysteresis and responsive profiles, scale modes, safe areas and viewport changes, draw-list batching/clipping/culling and painter balance, hit testing agreeing with what is drawn at any UI scale, tooltips, diagnostics (inspector, layout validation, accessibility tree, input trace) and declarative definitions (validation, build, binding, hot replace)
 */

export const suite = {
  name: "ui:uiManager",
  group: "integration",
  covers: [
    "engine/src/ui/manager.ts",
    "engine/src/ui/responsive.ts",
    "engine/src/ui/diagnostics.ts",
    "engine/src/ui/declarative.ts",
    "engine/src/ui/render/drawList.ts",
    "engine/src/ui/render/painter.ts",
    "engine/src/ui/render/assets.ts",
    "engine/src/ui/widgets/registerBuiltins.ts",
  ],
  desc: "The UI manager end to end: breakpoints with hysteresis and responsive profiles, scale modes, safe areas and viewport changes, draw-list batching/clipping/culling and painter balance, hit testing agreeing with what is drawn at any UI scale, tooltips, diagnostics (inspector, layout validation, accessibility tree, input trace) and declarative definitions (validation, build, binding, hot replace)",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  BreakpointSet,
  Button,
  computeUiScale,
  DEFAULT_SCALE_MODE,
  Grid,
  HStack,
  INSTANCE_FLOATS,
  Label,
  ObservableStore,
  Panel,
  ScrollView,
  Slider,
  UIElement,
  UIManager,
  VStack,
  buildUI,
  validateUIDefinition,
  type ResolvedStyle,
  type UIDefinition,
  type UIPainter,
} from "@forge/engine";
import { center, click, frame, key, makeUI } from "../support/uiHarness.js";

group("responsive", () => {
  test("BreakpointSet: hysteresis prevents thrashing on a boundary in both directions", () => {
    const bp = new BreakpointSet(undefined, 12);
    assert.equal(bp.update(700) && bp.current, "medium");
    assert.equal(bp.update(1030), false, "1030 < 1024 + 12: stays medium");
    assert.equal(bp.current, "medium");
    assert.equal(bp.update(1040), true);
    assert.equal(bp.current, "expanded");
    assert.equal(bp.update(1015), false, "1015 ≥ 1024 − 12: stays expanded");
    assert.equal(bp.update(1000), true);
    assert.equal(bp.current, "medium");
    assert.equal(bp.update(100), true);
    assert.equal(bp.current, "compact", "a big drop skips straight down");
    assert.equal(bp.update(2000), true);
    assert.equal(bp.current, "expanded", "a big jump skips straight up");
    assert.throws(() => new BreakpointSet([]), /at least one/);
    assert.throws(() => new BreakpointSet([{ name: "a", minWidth: 0 }, { name: "a", minWidth: 5 }]), /duplicate/);
  });

  test("computeUiScale: fixed, width-matched, height-matched, geometric blend and clamping", () => {
    assert.equal(computeUiScale("fixed", 999, 999, 1.5), 1.5);
    const ref = { referenceWidth: 1920, referenceHeight: 1080 };
    assert.ok(Math.abs(computeUiScale({ ...ref, match: 0 }, 960, 1080, 1) - 0.5) < 1e-12);
    assert.ok(Math.abs(computeUiScale({ ...ref, match: 1 }, 960, 1080, 1) - 1) < 1e-12);
    assert.ok(Math.abs(computeUiScale({ ...ref, match: 0.5 }, 960, 1080, 1) - Math.SQRT1_2) < 1e-12, "log-space midpoint");
    assert.equal(computeUiScale({ ...ref, min: 0.75 }, 100, 100, 1), 0.75);
  });

  test("responsive profiles restore the element's own values when leaving a breakpoint", () => {
    const ui = makeUI();
    const panel = ui.base.add(new Panel({ layout: { width: 300 }, variant: "card" }));
    ui.responsive(panel, { compact: { layout: { width: "100%" }, variant: "flat" }, expanded: { visible: true } });
    frame(ui);
    assert.equal(panel.bounds.width, 300);
    const changes: string[] = [];
    ui.onBreakpointChange.on(() => changes.push(ui.breakpoint));
    ui.setViewport(500, 800);
    frame(ui);
    assert.equal(ui.breakpoint, "compact");
    assert.equal(panel.bounds.width, 500);
    assert.equal(panel.variant, "flat");
    ui.setViewport(1280, 720);
    frame(ui);
    assert.equal(panel.bounds.width, 300, "snapshot restored");
    assert.equal(panel.variant, "card");
    assert.deepEqual(changes, ["compact", "expanded"]);
    assert.throws(() => ui.responsive(panel, { compact: { layout: { colour: 1 } as never } }), /unknown layout property/);
  });

  test("a profile never writes aspects no rule mentions (visibility owned elsewhere survives)", () => {
    const ui = makeUI();
    const page = ui.base.add(new Panel({ layout: { width: 300 } }));
    ui.responsive(page, { compact: { layout: { width: 200 } }, default: { apply: () => {} } });
    page.visible = false; // e.g. a TabContainer hiding an inactive page
    page.variant = "card";
    ui.setViewport(400, 800);
    frame(ui);
    ui.setViewport(1280, 720);
    frame(ui);
    assert.equal(page.visible, false, "visibility untouched");
    assert.equal(page.variant, "card", "variant untouched");
  });

  test("a responsive grid changes its column count without rebuilding the tree", () => {
    const ui = makeUI();
    const grid = ui.base.add(new Grid({ columns: 3, columnGap: 4, rowGap: 4, layout: { width: "100%" } }));
    const cells = Array.from({ length: 6 }, (_, i) => grid.add(new Label({ text: `c${i}` })));
    ui.responsive(grid, { compact: { apply: (g) => (g as Grid).setColumns(1) }, default: { apply: (g) => (g as Grid).setColumns(3) } });
    frame(ui);
    assert.equal(cells[1]!.bounds.y, cells[0]!.bounds.y);
    ui.setViewport(400, 900);
    frame(ui);
    assert.ok(cells[1]!.bounds.y > cells[0]!.bounds.y, "one column");
    assert.equal(cells[5]!.parent, grid, "same elements");
    assert.equal(ui.diagnostics.validateLayout().filter((i) => i.kind === "overlap").length, 0);
  });

  test("uiScale and devicePixelRatio change the logical viewport; scale modes follow resizes", () => {
    const ui = makeUI();
    ui.setViewport(2560, 1440, 2);
    assert.deepEqual([ui.viewport.width, ui.viewport.height], [1280, 720]);
    ui.setUiScale(2);
    assert.deepEqual([ui.viewport.width, ui.viewport.height], [640, 360]);
    assert.equal(ui.breakpoint, "medium", "breakpoints use logical width");
    ui.setScaleMode({ referenceWidth: 1280, referenceHeight: 720, match: 0 });
    assert.equal(ui.viewport.uiScale, 1);
    ui.setViewport(5120, 2880, 2);
    assert.equal(ui.viewport.uiScale, 2, "reference mode tracks the resize");
    assert.throws(() => ui.setViewport(0, 10), /positive/);
    assert.throws(() => ui.setUiScale(0), /> 0/);
  });

  test("by default the UI scales with the viewport: up on large screens, never below its authored size", () => {
    const cases: [number, number, number, number][] = [
      // css width, css height, dpr, expected uiScale
      [1280, 720, 1, 1],
      [1920, 1080, 1, 1.5],
      [2560, 1440, 1, 2],
      [1920, 1080, 2, 1.5], // a 4K panel at 2x: 3840×2160 pixels, a 1920×1080 CSS viewport
      [2560, 1080, 1, 1.5], // ultrawide: height limits ("expand" keeps the reference layout whole)
      [390, 844, 1, 1], // phone: breakpoints adapt, text keeps its size
      [1024, 1366, 1, 1], // tablet portrait
    ];
    for (const [w, h, dpr, expected] of cases) {
      const ui = new UIManager({ width: w * dpr, height: h * dpr, devicePixelRatio: dpr });
      assert.ok(Math.abs(ui.viewport.uiScale - expected) < 1e-9, `${w}x${h}@${dpr}: ${ui.viewport.uiScale}`);
      assert.ok(Math.abs(ui.viewport.width - w / expected) < 1e-6 && Math.abs(ui.viewport.height - h / expected) < 1e-6);
    }
    const ui = new UIManager({ width: 1280, height: 720 });
    const b = ui.base.add(new Button({ text: "Scale" }));
    frame(ui);
    const logical = b.bounds.width;
    ui.setViewport(2560, 1440);
    frame(ui);
    assert.equal(ui.viewport.uiScale, 2, "a resize rescales");
    assert.equal(b.bounds.width, logical, "layout is unchanged in logical units: everything is drawn 2× larger");
    assert.equal(ui.breakpoint, "expanded");
    assert.deepEqual(new UIManager({ width: 2560, height: 1440, uiScale: 1.25 }).viewport.uiScale, 1.25, "an explicit uiScale is fixed");
    assert.equal(computeUiScale(DEFAULT_SCALE_MODE, 9000, 9000, 1), 3, "clamped to max");
    assert.equal(computeUiScale({ referenceWidth: 100, referenceHeight: 100, match: "shrink" }, 300, 150, 1), 3, "shrink takes the larger ratio");
  });

  test("text scale re-measures text without touching the UI scale", () => {
    const ui = makeUI();
    const l = ui.base.add(new Label({ text: "Accessibility" }));
    frame(ui);
    const w = l.bounds.width;
    ui.textScale = 1.5;
    frame(ui);
    assert.ok(Math.abs(l.bounds.width / w - 1.5) < 0.1);
    assert.equal(ui.viewport.uiScale, 1);
  });
});

group("rendering", () => {
  test("solid primitives share a batch; a texture change breaks it; clipping never does", () => {
    const ui = makeUI();
    ui.assets.registerPixels("a", 4, 4, new Uint8Array(64).fill(255));
    ui.assets.registerPixels("b", 4, 4, new Uint8Array(64).fill(128));
    class Painted extends UIElement {
      protected override measureContent(): { width: number; height: number } {
        return { width: 100, height: 100 };
      }
      protected override paintContent(p: UIPainter): void {
        p.fillRect(0, 0, 10, 10, 0xff0000ff);
        p.pushClip(0, 0, 50, 50);
        p.fillRect(5, 5, 10, 10, 0x00ff00ff);
        p.popClip();
        p.image("a", 0, 0, 10, 10);
        p.image("a", 20, 0, 10, 10);
        p.fillRect(0, 20, 10, 10, 0x0000ffff);
        p.image("b", 40, 0, 10, 10);
      }
    }
    ui.base.add(new Painted());
    frame(ui);
    const dl = ui.render();
    assert.equal(dl.count, 6);
    assert.deepEqual(dl.batches.map((b) => [b.texture, b.count]), [["a", 5], ["b", 1]], "solids join any batch; only a second texture splits");
    assert.equal(ui.lastFrame.drawBatches, 2);
  });

  test("elements outside the viewport or their clip are culled", () => {
    const ui = makeUI();
    ui.base.add(new Button({ text: "off", layout: { position: "absolute", anchor: { left: 5000, top: 10 } } }));
    frame(ui);
    const dl = ui.render();
    assert.equal(dl.count, 0, "nothing of the off-screen button reaches the draw list");
    const ui2 = makeUI();
    const sv = ui2.base.add(new ScrollView({ layout: { width: 200, height: 100 } }));
    for (let i = 0; i < 50; i++) sv.add(new Label({ text: `row ${i}` }));
    frame(ui2);
    const n = ui2.render().stats.elementsPainted;
    assert.ok(n < 20, `only rows inside the scroll viewport are painted (${n})`);
  });

  test("a steady frame does not rebuild the draw list; any change does", () => {
    const ui = makeUI();
    const b = ui.base.add(new Button({ text: "x" }));
    frame(ui);
    const v = ui.drawListVersion;
    frame(ui);
    frame(ui);
    assert.equal(ui.drawListVersion, v);
    assert.equal(ui.needsRender, false);
    b.text = "y";
    ui.update(1 / 60);
    assert.equal(ui.needsRender, true);
    ui.render();
    assert.equal(ui.drawListVersion, v + 1);
  });

  test("an unbalanced paint hook is reported and the frame still ends cleanly", () => {
    const ui = makeUI();
    class Leaky extends UIElement {
      protected override measureContent(): { width: number; height: number } {
        return { width: 10, height: 10 };
      }
      protected override paintContent(p: UIPainter, _s: ResolvedStyle): void {
        p.pushClip(0, 0, 5, 5);
      }
    }
    ui.base.add(new Leaky());
    frame(ui);
    assert.ok(ui.messages.some((m) => m.level === "error" && m.message.includes("unbalanced")));
    const b = ui.base.add(new Button({ text: "after" }));
    frame(ui);
    assert.ok(b.bounds.width > 0);
  });

  test("instances carry logical-unit rects; hit testing agrees with what is drawn at any UI scale", () => {
    for (const scale of [1, 1.5, 2]) {
      const ui = new UIManager({ width: 1600, height: 900, uiScale: scale });
      const col = ui.base.add(new VStack({ gap: 6, layout: { padding: 20 } }));
      const buttons = Array.from({ length: 4 }, (_, i) => col.add(new Button({ text: `b${i}` })));
      frame(ui);
      const dl = ui.render();
      for (const b of buttons) {
        const c = center(b);
        assert.equal(ui.hitTest(c.x, c.y), b, `scale ${scale}: hit at the centre`);
        let found = false;
        for (let i = 0; i < dl.count && !found; i++) {
          const [x, y, w, h] = dl.rectAt(i);
          found = Math.abs(x - b.bounds.x) < 1e-3 && Math.abs(y - b.bounds.y) < 1e-3 && Math.abs(w - b.bounds.width) < 1e-3 && Math.abs(h - b.bounds.height) < 1e-3;
        }
        assert.ok(found, `scale ${scale}: a background instance matches the bounds`);
      }
      assert.equal(dl.data.length % INSTANCE_FLOATS, 0);
    }
  });
});

group("tooltips and overlays", () => {
  test("hover tooltips appear after the delay, follow the hovered element and go on leave", () => {
    const ui = makeUI({ tooltipDelay: 0.5 });
    const row = ui.base.add(new HStack({ gap: 20, layout: { padding: 40 } }));
    const a = row.add(new Button({ text: "a", tooltip: "Alpha tip" }));
    const b = row.add(new Button({ text: "b", tooltip: "Bravo tip" }));
    frame(ui);
    ui.router.pointerMove(center(a).x, center(a).y, 1, "mouse");
    for (let i = 0; i < 20; i++) frame(ui);
    assert.equal(ui.layer("tooltip").children.length, 0, "not yet");
    for (let i = 0; i < 20; i++) frame(ui);
    const tip = ui.layer("tooltip").children[0];
    assert.ok(tip);
    assert.equal(tip.accessibility.label, "Alpha tip");
    assert.ok(tip.bounds.y >= a.bounds.bottom || tip.bounds.bottom <= a.bounds.y, "does not cover its target");
    ui.router.pointerMove(center(b).x, center(b).y, 1, "mouse");
    for (let i = 0; i < 40; i++) frame(ui);
    assert.equal(ui.layer("tooltip").children[0]!.accessibility.label, "Bravo tip");
    ui.router.pointerMove(1200, 700, 1, "mouse");
    frame(ui);
    assert.equal(ui.layer("tooltip").children.length, 0);
  });

  test("overlay layers paint above the base and hit-test first", () => {
    const ui = makeUI();
    const under = ui.base.add(new Button({ text: "under", layout: { width: 200, height: 60 } }));
    const over = new Panel({ layout: { position: "absolute", anchor: { left: 0, top: 0 }, width: 100, height: 100 } });
    ui.overlays.show(over, "popup");
    frame(ui);
    assert.equal(ui.hitTest(50, 30), over);
    assert.equal(ui.hitTest(150, 30), under);
    const order = ui.diagnostics.renderOrder();
    assert.ok(order.indexOf(over.debugName) > order.indexOf(under.debugName));
    ui.overlays.close(over);
    assert.equal(ui.hitTest(50, 30), under);
  });
});

group("diagnostics", () => {
  test("inspector, tree dump, style sources, focus order and accessibility tree", () => {
    const ui = makeUI();
    const col = ui.base.add(new VStack({ id: "menu", gap: 4 }));
    const play = col.add(new Button({ id: "play", text: "Play", variant: "primary" }));
    col.add(new Slider({ id: "volume", min: 0, max: 1, value: 0.5, accessibility: { label: "Volume" } }));
    frame(ui);
    const node = ui.diagnostics.inspect(col);
    assert.equal(node.id, "menu");
    assert.equal(node.children.length, 2);
    assert.equal(node.children[0]!.variant, "primary");
    assert.ok(ui.diagnostics.dumpTree().includes("variant=primary"));
    play.focus(true);
    frame(ui);
    assert.ok(ui.diagnostics.inspect(play).states.includes("focused"));
    const sources = ui.diagnostics.styleSources(play);
    assert.equal(sources[0], "defaults");
    assert.ok(sources.some((s) => s.endsWith(".variants.primary")));
    ui.router.pointerMove(center(play).x, center(play).y, 1, "mouse");
    frame(ui);
    assert.ok(ui.diagnostics.styleSources(play).some((s) => s.endsWith(".states.hovered")));
    assert.equal(ui.diagnostics.focusOrder().length, 2);
    const a11y = ui.diagnostics.accessibilityTree(col);
    assert.equal(a11y.children[0]!.role, "button");
    assert.equal(a11y.children[0]!.label, "Play");
    assert.equal(a11y.children[1]!.label, "Volume");
    assert.equal(a11y.children[1]!.value, "0.5");
    assert.equal(ui.findById("volume")?.accessibility.role, "slider");
  });

  test("validateLayout finds overlaps and overflow; a clean layout reports nothing", () => {
    const ui = makeUI();
    const col = ui.base.add(new VStack({ gap: 4, layout: { padding: 8 } }));
    col.add(new Button({ text: "ok" }));
    frame(ui);
    assert.deepEqual(ui.diagnostics.validateLayout(), []);
    const box = col.add(new Panel({ layout: { width: 100, height: 40 } }));
    box.add(new Panel({ layout: { position: "absolute", anchor: { left: 0, top: 0 }, width: 300, height: 10 } }));
    const row = col.add(new HStack({ gap: -20 }));
    row.add(new Button({ text: "left" }));
    row.add(new Button({ text: "right" }));
    frame(ui);
    const kinds = ui.diagnostics.validateLayout().map((i) => i.kind);
    assert.ok(kinds.includes("overlap"), kinds.join(","));
  });

  test("input trace records routed events; resource report counts listeners and ticking elements", () => {
    const ui = makeUI();
    const b = ui.base.add(new Button({ text: "x" }));
    frame(ui);
    ui.diagnostics.startInputTrace();
    click(ui, b);
    key(ui, "Tab");
    const trace = ui.diagnostics.stopInputTrace();
    assert.ok(trace.some((t) => t.input.startsWith("pointerdown")));
    assert.ok(trace.some((t) => t.input === "keydown Tab"));
    const report = ui.diagnostics.resourceReport();
    assert.ok(report.elements >= 2 && report.listeners >= 0);
  });

  test("the debug overlay draws bounds into the debug pass and is free when disabled", () => {
    const ui = makeUI();
    ui.base.add(new Button({ text: "x" }));
    frame(ui);
    const off = ui.render().count;
    ui.diagnostics.overlay.enabled = true;
    ui.markRenderDirty();
    const on = ui.render().count;
    assert.ok(on > off);
    ui.diagnostics.overlay.enabled = false;
    ui.markRenderDirty();
    assert.equal(ui.render().count, off);
  });

  test("dispose tears everything down and further updates are refused", () => {
    const ui = makeUI();
    const b = ui.base.add(new Button({ text: "x" }));
    frame(ui);
    ui.dispose();
    assert.ok(b.disposed);
    assert.throws(() => ui.update(0.016), /disposed/);
    ui.dispose();
  });
});

group("declarative", () => {
  const menu: UIDefinition = {
    version: 1,
    type: "VStack",
    id: "root",
    props: { gap: 8 },
    children: [
      { type: "Label", id: "title", props: { text: "Main menu" }, variant: "heading" },
      { type: "Button", id: "play", props: { text: "Play" }, on: { press: "play" } },
      { type: "Slider", id: "vol", props: { min: 0, max: 1, step: 0.1 }, bind: { value: { source: "settings.volume", mode: "two-way" } } },
      { type: "Label", id: "volText", bind: { text: { source: "settings.volume", convert: "percent" } } },
      { type: "Button", id: "quit", props: { text: "Quit" }, responsive: { compact: { visible: false } } },
    ],
  };

  test("validation reports every problem with a path and never runs code", () => {
    const ui = makeUI();
    const bad = {
      type: "VStack",
      extra: 1,
      children: [
        { type: "Buton" },
        { type: "Button", props: { text: 5, onPress: "x", wobble: 1 } },
        { type: "Label", children: [] },
        { type: "Button", on: { press: "missing" } },
        { type: "Button", id: "dup" },
        { type: "Button", id: "dup", layout: { width: "lots" } },
        { type: "Slider", bind: { value: "nostore.x" } },
        { type: "Button", props: { text: () => 1 } },
      ],
    };
    const r = validateUIDefinition(bad, { ui, handlers: {} });
    const joined = r.errors.join("\n");
    for (const needle of ["$.extra: unknown key", 'unknown component "Buton" (did you mean "Button"', "$.children[1].props.text", "$.children[1].props.wobble", "does not accept children", 'no handler named "missing"', 'duplicate id "dup"', "$.children[5].layout", 'no store named "nostore"', "functions are not allowed"]) {
      assert.ok(joined.includes(needle), `missing: ${needle}\n${joined}`);
    }
    assert.throws(() => buildUI(bad as UIDefinition, { ui }), /ui definition is invalid/);
    assert.ok(validateUIDefinition({ type: "Label", version: 99 }, { ui }).errors[0]!.includes("newer"));
  });

  test("build wires handlers, two-way bindings, converters and responsive rules", () => {
    const ui = makeUI();
    const settings = new ObservableStore({ volume: 0.5 });
    let plays = 0;
    const built = buildUI(menu, { ui, handlers: { play: () => plays++ }, stores: { settings }, converters: { percent: (v) => `${Math.round((v as number) * 100)}%` } });
    ui.base.add(built.root);
    frame(ui);
    assert.equal(built.byId.size, 6);
    assert.equal((built.byId.get("volText") as Label).text, "50%");
    click(ui, built.byId.get("play")!);
    assert.equal(plays, 1);
    const vol = built.byId.get("vol") as Slider;
    vol.focus(true);
    key(ui, "ArrowRight");
    assert.ok(Math.abs(settings.get("volume") - 0.6) < 1e-9, "two-way: the slider writes the store");
    frame(ui);
    assert.equal((built.byId.get("volText") as Label).text, "60%");
    settings.set("volume", 0.2);
    frame(ui);
    assert.equal(vol.value, 0.2, "and the store drives the slider");
    ui.setViewport(400, 800);
    frame(ui);
    assert.equal(built.byId.get("quit")!.visible, false);
  });

  test("hot replace swaps the subtree in place and disposes the old bindings", () => {
    const ui = makeUI();
    const settings = new ObservableStore({ volume: 0.5 });
    const ctx = { ui, handlers: { play: () => {} }, stores: { settings }, converters: { percent: (v: unknown) => String(v) } };
    const host = ui.base.add(new VStack());
    host.add(new Label({ text: "before" }));
    const first = buildUI(menu, ctx);
    host.add(first.root);
    host.add(new Label({ text: "after" }));
    frame(ui);
    const bindingsBefore = ui.binder.activeBindings;
    const next = buildUI({ ...menu, children: [{ type: "Label", id: "title", props: { text: "Reloaded" } }] }, ctx);
    next.dispose();
    const second = first.replace({ ...menu, children: [{ type: "Label", id: "title", props: { text: "Reloaded" } }] });
    frame(ui);
    assert.equal(host.children.indexOf(second.root), 1, "same position");
    assert.ok(first.root.disposed);
    assert.ok(ui.binder.activeBindings < bindingsBefore, "old bindings released");
    assert.equal((second.byId.get("title") as Label).text, "Reloaded");
  });

  test("every registered built-in builds from a bare definition, lays out and disposes cleanly", () => {
    const ui = makeUI();
    const names = ui.components.list().map((c) => c.name);
    assert.ok(names.length >= 60, `${names.length} built-ins`);
    const col = ui.base.add(new VStack({ gap: 2 }));
    for (const type of names) {
      const r = buildUI({ type }, { ui });
      col.add(r.root);
      frame(ui);
      assert.ok(r.root.bounds.isValid, `${type} has valid bounds`);
      assert.ok(Number.isFinite(r.root.bounds.width) && Number.isFinite(r.root.bounds.height), type);
      r.dispose();
    }
    frame(ui);
    assert.deepEqual(ui.messages.filter((m) => m.level === "error").map((m) => m.message), []);
    assert.equal(col.children.length, 0);
  });

  test("custom components register like built-ins and are usable from definitions", () => {
    const ui = makeUI();
    class Gauge extends UIElement {
      level = 0;
      protected override measureContent(): { width: number; height: number } {
        return { width: 40, height: 8 };
      }
    }
    ui.components.register<{ level?: number }>("Gauge", {
      create: (o) => {
        const g = new Gauge();
        g.level = o.level ?? 0;
        return g;
      },
      properties: [{ name: "level", type: "number", min: 0, max: 1 }],
    });
    const r = validateUIDefinition({ type: "Gauge", props: { level: 2 } }, { ui });
    assert.ok(r.errors.some((e) => e.includes("level")), "range checked from the descriptor");
    const g = buildUI({ type: "Gauge", props: { level: 0.7 } }, { ui }).root as Gauge;
    assert.equal(g.level, 0.7);
    assert.throws(() => ui.components.register("Gauge", { create: () => new Gauge() }), /already registered/);
  });
});

await finish();
