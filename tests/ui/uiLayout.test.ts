/**
 * @suite ui:uiLayout
 * @group unit
 * @covers engine/src/ui/layout/types.ts
 * @covers engine/src/ui/layout/flex.ts
 * @covers engine/src/ui/layout/grid.ts
 * @covers engine/src/ui/layout/anchor.ts
 * @covers engine/src/ui/layout/stack.ts
 * @covers engine/src/ui/core/element.ts
 * @desc UI layout engine: lengths (px, %, vw/vh, auto), min/max and aspect ratio, flex grow/shrink/basis/justify/align/wrap with min/max freezing, grid tracks (fixed/auto/fr/minmax/auto-fill) with spans and auto-placement, anchor and absolute placement, stack alignment, and a viewport × scale matrix with no invalid geometry
 */

export const suite = {
  name: "ui:uiLayout",
  group: "unit",
  covers: [
    "engine/src/ui/layout/types.ts",
    "engine/src/ui/layout/flex.ts",
    "engine/src/ui/layout/grid.ts",
    "engine/src/ui/layout/anchor.ts",
    "engine/src/ui/layout/stack.ts",
    "engine/src/ui/core/element.ts",
  ],
  desc: "UI layout engine: lengths (px, %, vw/vh, auto), min/max and aspect ratio, flex grow/shrink/basis/justify/align/wrap with min/max freezing, grid tracks (fixed/auto/fr/minmax/auto-fill) with spans and auto-placement, anchor and absolute placement, stack alignment, and a viewport × scale matrix with no invalid geometry",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AnchorLayout,
  FlexLayout,
  GridLayout,
  LengthUnit,
  StackLayout,
  UIContainer,
  UIElement,
  UsageError,
  lengthToString,
  parseLength,
  parseTrack,
  resolveLength,
  type LayoutPropsInput,
} from "@forge/engine";
import { frame, makeUI } from "../support/uiHarness.js";

/** A leaf with a fixed intrinsic size. */
class Box extends UIElement {
  static override styleName = "TestBox";
  constructor(
    public w = 20,
    public h = 10,
    layout: LayoutPropsInput = {},
    name = "",
  ) {
    super({ layout, name });
  }
  protected override measureContent(): { width: number; height: number } {
    return { width: this.w, height: this.h };
  }
}

/** A container placed at the top-left of the base layer with a fixed size. */
function host(layout: LayoutPropsInput, strategy: FlexLayout | GridLayout | AnchorLayout | StackLayout) {
  const ui = makeUI({ bare: true });
  const c = ui.base.add(new UIContainer({ layout, strategy }));
  return { ui, c };
}

const r = (el: UIElement): number[] => [el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height].map((v) => Math.round(v * 100) / 100);

group("lengths", () => {
  test("parse and resolve px, %, vw, vh and auto", () => {
    assert.equal(parseLength(12).unit, LengthUnit.Px);
    assert.equal(resolveLength(parseLength("50%"), 300, 1000, 800), 150);
    assert.equal(resolveLength(parseLength("10vw"), 300, 1000, 800), 100);
    assert.equal(resolveLength(parseLength("25vh"), 300, 1000, 800), 200);
    assert.ok(Number.isNaN(resolveLength(parseLength("auto"), 300, 1000, 800)));
    assert.ok(Number.isNaN(resolveLength(parseLength("50%"), Infinity, 1000, 800)), "a percentage of an indefinite size is auto");
    assert.equal(lengthToString(parseLength("40vh")), "40vh");
  });

  test("invalid lengths are rejected with the offending text", () => {
    assert.throws(() => parseLength(-1), UsageError);
    assert.throws(() => parseLength("12px" as never), /is not a length/);
    assert.throws(() => parseLength(Infinity), UsageError);
  });

  test("min/max clamp (min wins over max) and aspect ratio derives the free axis", () => {
    const { ui, c } = host({ width: 400, height: 300 }, new FlexLayout({ direction: "column", align: "start" }));
    const a = c.add(new Box(500, 10, { maxWidth: 200 }));
    const b = c.add(new Box(10, 10, { minWidth: 150, maxWidth: 100 }));
    const d = c.add(new Box(0, 0, { width: 120, aspectRatio: 2 }));
    frame(ui);
    assert.equal(a.bounds.width, 200);
    assert.equal(b.bounds.width, 150);
    assert.equal(d.bounds.height, 60);
  });

  test("percentages resolve against the container's content box", () => {
    const { ui, c } = host({ width: 400, height: 200, padding: 50 }, new FlexLayout({ direction: "row", align: "start" }));
    const a = c.add(new Box(0, 0, { width: "50%", height: "100%" }));
    frame(ui);
    assert.deepEqual(r(a), [50, 50, 150, 100]);
  });

  test("viewport units follow the logical viewport", () => {
    const { ui, c } = host({ width: "50vw", height: "25vh" }, new StackLayout());
    frame(ui);
    assert.deepEqual(r(c), [0, 0, 640, 180]);
    ui.setViewport(1000, 400);
    frame(ui);
    assert.deepEqual(r(c), [0, 0, 500, 100]);
  });
});

group("flex", () => {
  test("row: gap, intrinsic sizes, start alignment", () => {
    const { ui, c } = host({ width: 300, height: 50 }, new FlexLayout({ direction: "row", gap: 10, align: "start" }));
    const a = c.add(new Box(20, 10));
    const b = c.add(new Box(30, 20));
    frame(ui);
    assert.deepEqual(r(a), [0, 0, 20, 10]);
    assert.deepEqual(r(b), [30, 0, 30, 20]);
  });

  test("grow distributes free space by factor", () => {
    const { ui, c } = host({ width: 300, height: 40 }, new FlexLayout({ direction: "row" }));
    const a = c.add(new Box(0, 10, { flexGrow: 1 }));
    const b = c.add(new Box(0, 10, { flexGrow: 2 }));
    frame(ui);
    assert.equal(a.bounds.width, 100);
    assert.equal(b.bounds.width, 200);
  });

  test("grow respects max and re-distributes to the others (freeze loop)", () => {
    const { ui, c } = host({ width: 300, height: 40 }, new FlexLayout({ direction: "row" }));
    const a = c.add(new Box(0, 10, { flexGrow: 1, maxWidth: 50 }));
    const b = c.add(new Box(0, 10, { flexGrow: 1 }));
    frame(ui);
    assert.equal(a.bounds.width, 50);
    assert.equal(b.bounds.width, 250);
  });

  test("shrink is weighted by basis and stops at min", () => {
    const { ui, c } = host({ width: 100, height: 40 }, new FlexLayout({ direction: "row" }));
    const a = c.add(new Box(100, 10));
    const b = c.add(new Box(50, 10, { minWidth: 40 }));
    frame(ui);
    // 50 too much: b can only lose 10 (min 40), a takes the rest.
    assert.equal(b.bounds.width, 40);
    assert.equal(a.bounds.width, 60);
  });

  test("flexBasis overrides intrinsic size; zero shrink overflows", () => {
    const { ui, c } = host({ width: 100, height: 40 }, new FlexLayout({ direction: "row" }));
    const a = c.add(new Box(10, 10, { flexBasis: 80, flexShrink: 0 }));
    const b = c.add(new Box(10, 10, { flexBasis: 80, flexShrink: 0 }));
    frame(ui);
    assert.equal(a.bounds.width, 80);
    assert.equal(b.bounds.x, 80, "overflowing items keep their size and overflow");
  });

  test("justify variants place items along the main axis", () => {
    const expect: Record<string, number[]> = {
      start: [0, 20],
      center: [40, 60],
      end: [80, 100],
      "space-between": [0, 100],
      "space-around": [20, 80],
      "space-evenly": [26.67, 73.33],
    };
    for (const [justify, xs] of Object.entries(expect)) {
      const { ui, c } = host({ width: 120, height: 20 }, new FlexLayout({ direction: "row", justify: justify as never }));
      const a = c.add(new Box(20, 10));
      const b = c.add(new Box(20, 10));
      frame(ui);
      assert.deepEqual([a.bounds.x, b.bounds.x].map((v) => Math.round(v * 100) / 100), xs, justify);
    }
  });

  test("cross alignment: stretch fills, alignSelf overrides, center and end offset", () => {
    const { ui, c } = host({ width: 200, height: 100 }, new FlexLayout({ direction: "row", align: "stretch" }));
    const s = c.add(new Box(10, 10));
    const ce = c.add(new Box(10, 10, { alignSelf: "center" }));
    const en = c.add(new Box(10, 10, { alignSelf: "end" }));
    const fixed = c.add(new Box(10, 10, { height: 30 }));
    frame(ui);
    assert.equal(s.bounds.height, 100);
    assert.equal(ce.bounds.y, 45);
    assert.equal(en.bounds.y, 90);
    assert.equal(fixed.bounds.height, 30, "a definite cross size is not stretched");
  });

  test("column direction and margins", () => {
    const { ui, c } = host({ width: 100, height: 200 }, new FlexLayout({ direction: "column", gap: 5, align: "start" }));
    const a = c.add(new Box(20, 10, { margin: [3, 4] }));
    const b = c.add(new Box(20, 10));
    frame(ui);
    assert.deepEqual(r(a), [4, 3, 20, 10]);
    assert.deepEqual(r(b), [0, 21, 20, 10]);
  });

  test("wrap breaks lines when the main axis is full and stacks lines with lineGap", () => {
    const { ui, c } = host({ width: 100, height: 200 }, new FlexLayout({ direction: "row", wrap: true, gap: 10, lineGap: 4, align: "start" }));
    const items = [0, 1, 2, 3].map(() => c.add(new Box(40, 10)));
    frame(ui);
    assert.deepEqual(items.map(r), [
      [0, 0, 40, 10],
      [50, 0, 40, 10],
      [0, 14, 40, 10],
      [50, 14, 40, 10],
    ]);
  });

  test("measure reports the content size of a shrink-wrapped flex container", () => {
    const ui = makeUI({ bare: true });
    const c = ui.base.add(new UIContainer({ strategy: new FlexLayout({ direction: "row", gap: 4 }), layout: { padding: 6 } }));
    c.add(new Box(20, 10));
    c.add(new Box(30, 15));
    frame(ui);
    assert.deepEqual(r(c), [0, 0, 6 + 20 + 4 + 30 + 6, 6 + 15 + 6]);
  });

  test("a single-line container's line is the container's cross size (wide items overflow, not grow it)", () => {
    const { ui, c } = host({ width: 100, height: 50 }, new FlexLayout({ direction: "column", align: "stretch" }));
    const wide = c.add(new Box(500, 10, { flexShrink: 0 }));
    const normal = c.add(new Box(10, 10));
    frame(ui);
    assert.equal(normal.bounds.width, 100);
    assert.equal(wide.bounds.width, 100, "stretched items take the line, which is the container");
  });

  test("hidden and absolute children are not flow items", () => {
    const { ui, c } = host({ width: 200, height: 50 }, new FlexLayout({ direction: "row", gap: 10 }));
    const a = c.add(new Box(20, 10));
    const hidden = c.add(new Box(20, 10));
    hidden.visible = false;
    const abs = c.add(new Box(20, 10, { position: "absolute", anchor: { right: 0, bottom: 0 } }));
    const b = c.add(new Box(20, 10));
    frame(ui);
    assert.equal(a.bounds.x, 0);
    assert.equal(b.bounds.x, 30, "the hidden and absolute boxes took no space");
    assert.deepEqual(r(abs), [180, 40, 20, 10], "absolute children anchor to the border box");
  });
});

group("grid", () => {
  test("track parsing: fixed, auto, fr, minmax", () => {
    assert.deepEqual(parseTrack(40), { kind: 0, value: 40, min: 40, max: 40 });
    assert.equal(parseTrack("auto").kind, 1);
    assert.equal(parseTrack("2fr").value, 2);
    assert.equal(parseTrack({ min: 60, max: "1fr" }).min, 60);
    assert.throws(() => parseTrack("2px" as never), /is not a track/);
  });

  test("fixed + auto + fr columns share the width; rows size to content", () => {
    const g = new GridLayout({ columns: [50, "auto", "1fr", "2fr"], columnGap: 10, rowGap: 5 });
    const { ui, c } = host({ width: 400, height: 300 }, g);
    const cells = [new Box(10, 10), new Box(40, 20), new Box(10, 10), new Box(10, 30)].map((b) => c.add(b));
    frame(ui);
    // free = 400 - 50 - 40 - 3*10 = 280 → 1fr = 93.33
    const cols = g.lastColumnSizes.map((v) => Math.round(v * 100) / 100);
    assert.deepEqual(cols, [50, 40, 93.33, 186.67]);
    assert.deepEqual(g.lastRowSizes, [30]);
    assert.ok(Math.abs(cells[3]!.bounds.x - (50 + 10 + 40 + 10 + 280 / 3 + 10)) < 1e-6);
    assert.equal(cells[0]!.bounds.height, 30, "items stretch to the row by default");
  });

  test("auto-flow places unplaced items row-major; explicit placement and spans are honoured", () => {
    const g = new GridLayout({ columns: [20, 20, 20], columnGap: 0, rowGap: 0, autoRows: 10 });
    const { ui, c } = host({ width: 60, height: 100 }, g);
    const span = c.add(new Box(1, 1, { column: 2, row: 1, columnSpan: 2 }));
    const a = c.add(new Box(1, 1));
    const b = c.add(new Box(1, 1));
    const tall = c.add(new Box(1, 1, { rowSpan: 2 }));
    frame(ui);
    assert.deepEqual(r(span), [20, 0, 40, 10]);
    assert.deepEqual(r(a), [0, 0, 20, 10]);
    assert.deepEqual(r(b), [0, 10, 20, 10]);
    assert.deepEqual(r(tall), [20, 10, 20, 20]);
  });

  test("fr tracks freeze at their minimum and the rest share what is left", () => {
    const g = new GridLayout({ columns: [{ min: 150, max: "1fr" }, "1fr"], columnGap: 0 });
    const { ui, c } = host({ width: 200, height: 50 }, g);
    c.add(new Box());
    c.add(new Box());
    frame(ui);
    assert.deepEqual(g.lastColumnSizes, [150, 50]);
  });

  test("autoFill columns respond to the available width", () => {
    const g = new GridLayout({ columns: { autoFill: 50 }, columnGap: 10 });
    const ui = makeUI({ bare: true });
    const c = ui.base.add(new UIContainer({ strategy: g, layout: { width: 230 } }));
    for (let i = 0; i < 7; i++) c.add(new Box(10, 10));
    frame(ui);
    assert.equal(g.columnCount, 4, "4 × 50 + 3 × 10 = 230 fits exactly");
    c.setLayout({ width: 229 });
    frame(ui);
    assert.equal(g.columnCount, 3, "one unit narrower drops a column");
    assert.deepEqual(g.lastColumnSizes.map((v) => Math.round(v * 100) / 100), [69.67, 69.67, 69.67], "the fr columns share the width");
  });

  test("a multi-span item widens the auto tracks it crosses", () => {
    const g = new GridLayout({ columns: ["auto", "auto"], columnGap: 0 });
    const ui = makeUI({ bare: true });
    const c = ui.base.add(new UIContainer({ strategy: g }));
    c.add(new Box(100, 10, { columnSpan: 2 }));
    frame(ui);
    assert.deepEqual(g.lastColumnSizes, [50, 50]);
  });

  test("setColumns changes tracks at runtime (responsive grids)", () => {
    const g = new GridLayout({ columns: 4 });
    const { ui, c } = host({ width: 400, height: 100 }, g);
    for (let i = 0; i < 4; i++) c.add(new Box());
    frame(ui);
    assert.equal(g.lastRowSizes.length, 1);
    g.setColumns(2);
    c.invalidateLayout();
    frame(ui);
    assert.equal(g.lastRowSizes.length, 2);
    assert.throws(() => g.setColumns(0), UsageError);
  });
});

group("anchor and stack", () => {
  test("edges, stretch between anchors, centre offsets and percentage anchors", () => {
    const { ui, c } = host({ width: 400, height: 200 }, new AnchorLayout());
    const tl = c.add(new Box(20, 10, { anchor: { left: 5, top: 6 } }));
    const br = c.add(new Box(20, 10, { anchor: { right: 5, bottom: 6 } }));
    const stretch = c.add(new Box(20, 10, { anchor: { left: 10, right: 10, top: 0 } }));
    const center = c.add(new Box(20, 10, { anchor: { centerX: 0, centerY: 10 } }));
    const pct = c.add(new Box(20, 10, { anchor: { left: "25%", top: "50%" } }));
    frame(ui);
    assert.deepEqual(r(tl), [5, 6, 20, 10]);
    assert.deepEqual(r(br), [375, 184, 20, 10]);
    assert.deepEqual(r(stretch), [10, 0, 380, 10]);
    assert.deepEqual(r(center), [190, 105, 20, 10]);
    assert.deepEqual(r(pct), [100, 100, 20, 10]);
  });

  test("conflicting anchors are rejected", () => {
    assert.throws(() => new Box(1, 1, { anchor: { centerX: 0, left: 0 } }), /centerX cannot be combined/);
  });

  test("stack: stretch by default, per-child alignment, content = largest child", () => {
    const { ui, c } = host({ width: 200, height: 100 }, new StackLayout());
    const fill = c.add(new Box(10, 10));
    const corner = c.add(new Box(30, 20, { justifySelf: "end", alignSelf: "end" }));
    const mid = c.add(new Box(30, 20, { justifySelf: "center", alignSelf: "center" }));
    frame(ui);
    assert.deepEqual(r(fill), [0, 0, 200, 100]);
    assert.deepEqual(r(corner), [170, 80, 30, 20]);
    assert.deepEqual(r(mid), [85, 40, 30, 20]);
  });
});

group("robustness", () => {
  test("a viewport smaller than a minimum overflows instead of producing negative sizes", () => {
    const ui = makeUI({ bare: true, width: 200, height: 100 });
    const c = ui.base.add(new UIContainer({ strategy: new FlexLayout({ direction: "row" }), layout: { width: "100%", height: "100%" } }));
    const a = c.add(new Box(10, 10, { minWidth: 150 }));
    const b = c.add(new Box(10, 10, { minWidth: 150 }));
    frame(ui);
    assert.equal(a.bounds.width, 150);
    assert.equal(b.bounds.width, 150);
    assert.ok(b.bounds.right > 200, "overflow is reported by validateLayout instead of being hidden");
  });

  test("viewport × UI-scale matrix: no NaN, infinite or negative geometry in a nested layout", () => {
    for (const [w, h] of [[320, 568], [800, 600], [1280, 720], [2560, 1080], [3840, 2160]] as const) {
      for (const scale of [0.75, 1, 1.5, 2]) {
        const ui = makeUI({ bare: true, width: w, height: h, uiScale: scale });
        const outer = ui.base.add(new UIContainer({ strategy: new FlexLayout({ direction: "column", gap: 8 }), layout: { width: "100%", height: "100%", padding: 12 } }));
        const row = outer.add(new UIContainer({ strategy: new FlexLayout({ direction: "row", gap: 8, wrap: true }) }));
        for (let i = 0; i < 12; i++) row.add(new Box(90, 30, { flexGrow: 1, minWidth: 60 }));
        const grid = outer.add(new UIContainer({ strategy: new GridLayout({ columns: { autoFill: 80 }, columnGap: 4, rowGap: 4 }), layout: { flexGrow: 1 } }));
        for (let i = 0; i < 20; i++) grid.add(new Box(20, 20, { aspectRatio: 1 }));
        frame(ui);
        ui.root.walk((e) => {
          assert.ok(e.bounds.isValid, `${w}x${h}@${scale}: ${e.debugName} has invalid bounds ${r(e)}`);
        });
      }
    }
  });

  test("layout converges and reports elements that keep invalidating", () => {
    const ui = makeUI({ bare: true, maxLayoutPasses: 4 });
    class Restless extends Box {
      protected override onArranged(): void {
        this.w++;
        this.invalidateLayout();
      }
    }
    ui.base.add(new Restless());
    frame(ui);
    assert.ok(ui.messages.some((m) => m.message.includes("did not converge after 4 passes")), JSON.stringify(ui.messages));
  });
});

await finish();
