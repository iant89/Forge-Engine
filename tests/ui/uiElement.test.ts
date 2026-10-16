/**
 * @suite ui:uiElement
 * @group unit
 * @covers engine/src/ui/core/element.ts
 * @covers engine/src/ui/core/container.ts
 * @covers engine/src/ui/core/registry.ts
 * @covers engine/src/ui/core/geometry.ts
 * @covers engine/src/ui/core/color.ts
 * @covers engine/src/ui/index.ts
 * @covers engine/src/ui/core/context.ts
 * @desc UI component tree: ownership, safe reparenting, cycle prevention, recursive disposal, split invalidation with layout boundaries, the component registry (factories, descriptors, collisions, aliases, validation), geometry and colour helpers
 */

export const suite = {
  name: "ui:uiElement",
  group: "unit",
  covers: [
    "engine/src/ui/core/element.ts",
    "engine/src/ui/core/container.ts",
    "engine/src/ui/core/registry.ts",
    "engine/src/ui/core/geometry.ts",
    "engine/src/ui/core/color.ts",
    "engine/src/ui/index.ts",
    "engine/src/ui/core/context.ts",
  ],
  desc: "UI component tree: ownership, safe reparenting, cycle prevention, recursive disposal, split invalidation with layout boundaries, the component registry (factories, descriptors, collisions, aliases, validation), geometry and colour helpers",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  ComponentRegistry,
  ObjectDisposedError,
  UIContainer,
  UIElement,
  UIRect,
  UIState,
  UIViewport,
  UsageError,
  colorToHex,
  contrastRatio,
  lerpColor,
  parseColor,
  rgba,
  toCorners,
  toInsets,
  tryParseColor,
  validateProperty,
  withAlpha,
  type ResolvedStyle,
  type UIPainter,
} from "@forge/engine";
import { frame, makeUI } from "../support/uiHarness.js";

class Leaf extends UIElement {
  static override styleName = "Leaf";
  disposedHook = 0;
  attachedHook = 0;
  detachedHook = 0;
  w = 10;
  h = 10;
  protected override measureContent(): { width: number; height: number } {
    return { width: this.w, height: this.h };
  }
  protected override onDispose(): void {
    this.disposedHook++;
  }
  protected override onAttach(): void {
    this.attachedHook++;
  }
  protected override onDetach(): void {
    this.detachedHook++;
  }
}

group("tree ownership", () => {
  test("add sets the parent; adding to another container moves the child (no two parents)", () => {
    const a = new UIContainer();
    const b = new UIContainer();
    const c = new Leaf();
    a.add(c);
    assert.equal(c.parent, a);
    b.add(c);
    assert.equal(c.parent, b);
    assert.deepEqual(a.children, []);
    assert.deepEqual(b.children, [c]);
  });

  test("insert at an index and re-insert within the same parent reorders", () => {
    const p = new UIContainer();
    const [x, y, z] = [new Leaf({ name: "x" }), new Leaf({ name: "y" }), new Leaf({ name: "z" })];
    p.addAll(x, y);
    p.insert(z, 0);
    assert.deepEqual(p.children.map((c) => c.name), ["z", "x", "y"]);
    p.insert(z, 2);
    assert.deepEqual(p.children.map((c) => c.name), ["x", "y", "z"]);
  });

  test("an element cannot be added to itself or to its own descendant", () => {
    const a = new UIContainer();
    const b = new UIContainer();
    a.add(b);
    assert.throws(() => a.add(a), UsageError);
    assert.throws(() => b.add(a), /cycle/);
    assert.equal(a.parent, null, "the failed insert left the tree unchanged");
  });

  test("remove detaches without disposing; the element can be reused", () => {
    const p = new UIContainer();
    const c = new Leaf();
    p.add(c);
    assert.equal(p.remove(c), true);
    assert.equal(c.parent, null);
    assert.equal(c.disposed, false);
    assert.equal(p.remove(c), false);
    new UIContainer().add(c);
  });

  test("dispose is recursive, detaches, runs hooks once and makes the element unusable", () => {
    const root = new UIContainer();
    const mid = root.add(new UIContainer());
    const leaf = mid.add(new Leaf());
    mid.dispose();
    assert.equal(mid.disposed, true);
    assert.equal(leaf.disposed, true);
    assert.equal(leaf.disposedHook, 1);
    assert.deepEqual(root.children, []);
    mid.dispose();
    assert.equal(leaf.disposedHook, 1, "dispose is idempotent");
    assert.throws(() => mid.add(new Leaf()), ObjectDisposedError);
    assert.throws(() => root.add(leaf), ObjectDisposedError);
  });

  test("disposing releases owned resources in reverse order and listeners", () => {
    const el = new Leaf();
    const order: number[] = [];
    el.own({ dispose: () => order.push(1) });
    el.own({ dispose: () => order.push(2) });
    el.on("click", () => {});
    assert.equal(el.listenerCount, 1);
    el.dispose();
    assert.deepEqual(order, [2, 1]);
    assert.equal(el.listenerCount, 0);
    let late = 0;
    el.own({ dispose: () => late++ });
    assert.equal(late, 1, "owning after dispose disposes immediately");
  });

  test("findById, walk and isAncestorOf", () => {
    const root = new UIContainer({ id: "root" });
    const a = root.add(new UIContainer({ id: "a" }));
    const b = a.add(new Leaf({ id: "b" }));
    assert.equal(root.findById("b"), b);
    assert.equal(root.findById("nope"), null);
    const seen: string[] = [];
    root.walk((e) => {
      seen.push(e.id ?? "");
      return e !== a;
    });
    assert.deepEqual(seen, ["root", "a"], "returning false skips a subtree");
    assert.equal(root.isAncestorOf(b), true);
    assert.equal(b.isAncestorOf(root), false);
  });

  test("uids are unique and never reused", () => {
    const ids = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const e = new Leaf();
      ids.add(e.uid);
      e.dispose();
    }
    assert.equal(ids.size, 100);
  });

  test("paint order follows zIndex with stable ties", () => {
    const p = new UIContainer();
    const a = p.add(new Leaf({ name: "a" }));
    p.add(new Leaf({ name: "b" }));
    const c = p.add(new Leaf({ name: "c" }));
    c.setLayout({ zIndex: -1 });
    a.setLayout({ zIndex: 5 });
    assert.deepEqual(p.paintOrder.map((e) => e.name), ["c", "b", "a"]);
  });
});

group("attachment to a manager", () => {
  test("attach/detach hooks run for whole subtrees; the context is only present while attached", () => {
    const ui = makeUI();
    const box = new UIContainer();
    const leaf = box.add(new Leaf());
    assert.equal(leaf.context, null);
    ui.base.add(box);
    assert.equal(leaf.attachedHook, 1);
    assert.equal(leaf.context, ui);
    box.removeFromParent();
    assert.equal(leaf.detachedHook, 1);
    assert.equal(leaf.context, null);
  });

  test("duplicate author ids are diagnosed, findById returns the first", () => {
    const ui = makeUI();
    const a = ui.base.add(new Leaf({ id: "dup" }));
    ui.base.add(new Leaf({ id: "dup" }));
    assert.equal(ui.findById("dup"), a);
    assert.ok(ui.messages.some((m) => m.level === "error" && m.message.includes('duplicate element id "dup"')));
  });

  test("element count tracks attach/detach and disposal", () => {
    const ui = makeUI();
    const before = ui.elements;
    const box = ui.base.add(new UIContainer());
    box.add(new Leaf());
    box.add(new Leaf());
    assert.equal(ui.elements, before + 3);
    box.dispose();
    assert.equal(ui.elements, before);
  });

  test("enabled propagates the disabled state to descendants", () => {
    const ui = makeUI();
    const box = ui.base.add(new UIContainer());
    const leaf = box.add(new Leaf());
    box.enabled = false;
    assert.equal(leaf.effectivelyEnabled, false);
    assert.equal(leaf.hasState(UIState.Disabled), true);
    box.enabled = true;
    assert.equal(leaf.hasState(UIState.Disabled), false);
  });
});

group("invalidation", () => {
  test("a clean frame does no style, layout or render work", () => {
    const ui = makeUI();
    ui.base.add(new Leaf());
    frame(ui);
    const f = ui.update(1 / 60);
    assert.equal(f.styleResolves, 0);
    assert.equal(f.layoutPasses, 0);
    assert.equal(f.measures, 0);
    assert.equal(f.arranges, 0);
    ui.render();
    assert.equal(ui.lastFrame.drawListRebuilt, false);
  });

  test("a change inside a fixed-size panel does not re-measure the panel's ancestors", () => {
    const ui = makeUI();
    const outer = ui.base.add(new UIContainer({ name: "outer" }));
    const fixed = outer.add(new UIContainer({ name: "fixed", layout: { width: 200, height: 100 } }));
    const leaf = fixed.add(new Leaf());
    frame(ui);
    assert.equal(fixed.isLayoutBoundary, true);
    const outerMeasures = outer._measureCount;
    leaf.w = 50;
    leaf.invalidateLayout();
    assert.equal(outer._measureDirty, false, "the boundary stopped measure propagation");
    assert.equal(fixed._arrangeDirty, true);
    frame(ui);
    assert.equal(outer._measureCount, outerMeasures, "outer was not re-measured");
    assert.equal(leaf.bounds.width, 200, "the leaf was re-arranged inside its fixed parent");
  });

  test("measure results are cached until invalidated or the available size changes", () => {
    const ui = makeUI();
    const leaf = ui.base.add(new Leaf());
    frame(ui);
    const n = leaf._measureCount;
    const ctx = { viewportWidth: 1280, viewportHeight: 720 };
    leaf.measure(1280, 720, ctx);
    assert.equal(leaf._measureCount, n, "same constraints → cached");
    leaf.measure(100, 720, ctx);
    assert.equal(leaf._measureCount, n + 1);
  });

  test("hidden elements take no space and toggling visibility re-lays out the parent", () => {
    const ui = makeUI();
    const col = ui.base.add(new UIContainer());
    col.layout = new (class {
      readonly kind = "sum";
      measureContent(node: import("@forge/engine").LayoutNode) {
        let h = 0;
        for (const c of node.layoutChildren) if (c.isFlowChild) h += 10;
        return { width: 10, height: h };
      }
      arrangeContent() {}
    })();
    const a = col.add(new Leaf());
    col.add(new Leaf());
    frame(ui);
    assert.equal(col.bounds.height, 20);
    a.visible = false;
    frame(ui);
    assert.equal(col.bounds.height, 10);
  });

  test("a style change that does not affect layout only re-renders", () => {
    const ui = makeUI();
    const leaf = ui.base.add(new Leaf());
    frame(ui);
    leaf.style = { background: "#ff0000" };
    const f = ui.update(1 / 60);
    assert.equal(f.styleResolves, 1);
    assert.equal(f.measures, 0, "background colour is paint-only");
    assert.equal(ui.needsRender, true);
  });
});

group("geometry, painting hooks and transforms", () => {
  test("UIRect intersect/deflate never go negative; isValid rejects NaN", () => {
    const r = new UIRect(0, 0, 10, 10).intersect(new UIRect(20, 20, 5, 5));
    assert.equal(r.width, 0);
    assert.equal(r.height, 0);
    const d = new UIRect(0, 0, 10, 10).deflate({ top: 8, right: 8, bottom: 8, left: 8 });
    assert.equal(d.width, 0);
    assert.equal(new UIRect(NaN, 0, 1, 1).isValid, false);
  });

  test("insets and corners shorthands follow CSS order", () => {
    assert.deepEqual(toInsets([1, 2]), { top: 1, right: 2, bottom: 1, left: 2 });
    assert.deepEqual(toInsets([1, 2, 3, 4]), { top: 1, right: 2, bottom: 3, left: 4 });
    assert.deepEqual(toInsets({ left: 5 }), { top: 0, right: 0, bottom: 0, left: 5 });
    assert.deepEqual(toCorners(3), { topLeft: 3, topRight: 3, bottomRight: 3, bottomLeft: 3 });
  });

  test("viewport conversions use one scale (dpr × uiScale)", () => {
    const vp = new UIViewport();
    vp.physicalWidth = 2000;
    vp.physicalHeight = 1000;
    vp.devicePixelRatio = 2;
    vp.uiScale = 1.25;
    assert.equal(vp.scale, 2.5);
    assert.equal(vp.width, 800);
    const p = vp.physicalToLogical(250, 500);
    assert.deepEqual(p, { x: 100, y: 200 });
    assert.deepEqual(vp.logicalToPhysical(p.x, p.y), { x: 250, y: 500 });
    assert.deepEqual(vp.cssToLogical(125, 250), { x: 100, y: 200 });
  });

  test("render transforms move hit testing with the pixels (toLocal inverts them)", () => {
    const ui = makeUI();
    const leaf = ui.base.add(new Leaf({ layout: { width: 100, height: 100 } }));
    frame(ui);
    leaf.translateX = 300;
    assert.equal(ui.hitTest(50, 50), null, "the old position is empty");
    assert.equal(ui.hitTest(350, 50), leaf);
    leaf.scale = 2;
    // Scaled about its centre (50, 50) then translated: (350 ± 100) covers 250..450.
    assert.equal(ui.hitTest(260, 50), leaf);
    const local = leaf.toLocal(350, 50);
    assert.deepEqual(local, { x: 50, y: 50 });
    assert.throws(() => (leaf.scale = 0), UsageError);
  });

  test("custom paint hooks receive the paint style and run inside the element's opacity", () => {
    const ui = makeUI();
    const calls: number[] = [];
    class Painted extends Leaf {
      protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
        calls.push(s.opacity);
        p.fillRect(this.bounds.x, this.bounds.y, 5, 5, 0xff0000ff);
      }
    }
    const el = ui.base.add(new Painted());
    el.opacity = 0.5;
    frame(ui);
    assert.equal(calls.length, 1);
    const list = ui.render();
    assert.ok(list.count >= 1);
    // The fill's alpha carries the inherited opacity.
    const alpha = list.data[8 + 3]!;
    assert.ok(Math.abs(alpha - 0.5) < 1e-6, `alpha ${alpha}`);
  });

  test("a zero-opacity element is neither painted nor hit", () => {
    const ui = makeUI();
    const leaf = ui.base.add(new Leaf({ layout: { width: 50, height: 50 }, style: { background: "#fff" } }));
    frame(ui);
    leaf.opacity = 0;
    frame(ui);
    assert.equal(ui.hitTest(10, 10), null);
  });
});

group("component registry", () => {
  class Slot extends UIElement {
    static override styleName = "Slot";
    count = 0;
    constructor(o: { count?: number } = {}) {
      super();
      this.count = o.count ?? 0;
    }
  }
  const register = (r: ComponentRegistry): void => {
    r.register<{ count?: number }>("Slot", {
      create: (o) => new Slot(o),
      properties: [{ name: "count", type: "number", min: 0, max: 99, default: 0 }],
      category: "game",
      description: "test slot",
      version: 2,
      aliases: ["ItemSlot"],
      plugin: "test-plugin",
    });
  };

  test("registered factories create typed instances and stamp the type name", () => {
    const r = new ComponentRegistry();
    register(r);
    const s = r.create<Slot>("Slot", { count: 3 });
    assert.ok(s instanceof Slot);
    assert.equal(s.count, 3);
    assert.equal(s.typeName, "Slot");
    assert.equal(r.create("ItemSlot").typeName, "Slot", "aliases resolve to the canonical name");
  });

  test("unknown types and properties fail loudly with suggestions", () => {
    const r = new ComponentRegistry();
    register(r);
    assert.throws(() => r.create("slot"), /did you mean "Slot"/);
    assert.throws(() => r.create("Slot", { cuont: 1 }), /no property "cuont"/);
    assert.throws(() => r.create("Slot", { count: 500 }), /above the maximum/);
    // Base options and event callbacks are always accepted.
    r.create("Slot", { id: "x", onPress: () => {} });
  });

  test("collisions: error by default, replace or ignore on request", () => {
    const r = new ComponentRegistry();
    register(r);
    assert.throws(() => register(r), /already registered \(by test-plugin\)/);
    assert.equal(r.register("Slot", { create: () => new Slot() }, { onConflict: "ignore" }), false);
    assert.equal(r.register("Slot", { create: () => new Slot({ count: 7 }) }, { onConflict: "replace" }), true);
    assert.equal(r.create<Slot>("Slot").count, 7);
    assert.equal(r.has("ItemSlot"), false, "replacing removed the old aliases");
  });

  test("unregister removes the type and aliases but leaves live instances alone", () => {
    const r = new ComponentRegistry();
    register(r);
    const s = r.create("Slot");
    assert.equal(r.unregister("ItemSlot"), true);
    assert.equal(r.has("Slot"), false);
    assert.equal(s.disposed, false);
    assert.throws(() => r.create("Slot"), /unknown component type/);
  });

  test("discovery lists metadata for tooling", () => {
    const r = new ComponentRegistry();
    register(r);
    const [entry] = r.list();
    assert.equal(entry!.name, "Slot");
    assert.equal(entry!.registration.category, "game");
    assert.equal(entry!.registration.version, 2);
    assert.equal(entry!.properties.get("count")!.max, 99);
  });

  test("invalid defaults, duplicate descriptors and bad names are rejected at registration", () => {
    const r = new ComponentRegistry();
    assert.throws(() => r.register("Bad", { create: () => new Slot(), properties: [{ name: "n", type: "number", default: "x" }] }), /default is invalid/);
    assert.throws(() => r.register("Dup", { create: () => new Slot(), properties: [{ name: "n", type: "number" }, { name: "n", type: "number" }] }), /twice/);
    assert.throws(() => r.register("has space", { create: () => new Slot() }), /not a valid component name/);
  });

  test("setProperty validates through the descriptor and assigns through the setter", () => {
    const r = new ComponentRegistry();
    register(r);
    const s = r.create<Slot>("Slot");
    r.setProperty(s, "count", 9);
    assert.equal(s.count, 9);
    assert.throws(() => r.setProperty(s, "count", -1), /below the minimum/);
    assert.throws(() => r.setProperty(s, "nope", 1), /no registered property/);
  });

  test("validateProperty covers every descriptor type", () => {
    assert.equal(validateProperty({ name: "c", type: "color" }, "#abc"), null);
    assert.match(validateProperty({ name: "c", type: "color" }, "nope") ?? "", /not a colour/);
    assert.match(validateProperty({ name: "e", type: "enum", values: ["a", "b"] }, "c") ?? "", /not one of/);
    assert.equal(validateProperty({ name: "l", type: "length" }, "50%"), null);
    assert.match(validateProperty({ name: "l", type: "length" }, "fifty") ?? "", /not a length/);
    assert.match(validateProperty({ name: "b", type: "boolean" }, 1) ?? "", /boolean/);
    assert.match(validateProperty({ name: "a", type: "array" }, {}) ?? "", /array/);
    assert.match(validateProperty({ name: "v", type: "string", validate: (v) => (v === "bad" ? "no bad" : null) }, "bad") ?? "", /no bad/);
  });

  test("the built-in library is registered with descriptors for declarative use", () => {
    const ui = makeUI();
    for (const name of ["Button", "Label", "Panel", "Grid", "Slider", "HealthBar", "InventorySlot", "ScrollContainer", "SelectableList"]) assert.ok(ui.components.has(name), name);
    assert.ok(ui.components.list().length >= 60);
    assert.equal(ui.components.get("Slider")!.properties.get("value")!.animatable, true);
  });
});

group("colour", () => {
  test("parse/format round trip and the supported syntaxes", () => {
    assert.equal(parseColor("#ff8000"), 0xff8000ff);
    assert.equal(parseColor("#f80"), 0xff8800ff);
    assert.equal(parseColor("#ff800080"), 0xff800080);
    assert.equal(parseColor("rgba(255, 128, 0, 0.5)"), 0xff800080);
    assert.equal(parseColor("transparent"), 0);
    assert.equal(colorToHex(0x11223344), "#11223344");
    assert.equal(tryParseColor("bogus"), null);
    assert.throws(() => parseColor("bogus"), UsageError);
    assert.equal(rgba(300, -5, 128, 2), 0xff0080ff, "channels clamp");
  });

  test("lerp, alpha scaling and WCAG contrast", () => {
    assert.equal(lerpColor(0x000000ff, 0xffffffff, 0.5), 0x808080ff);
    assert.equal(lerpColor(0x000000ff, 0xffffffff, 2), 0xffffffff);
    assert.equal(withAlpha(0xffffffff, 0.5), 0xffffff80);
    assert.ok(Math.abs(contrastRatio(0x000000ff, 0xffffffff) - 21) < 1e-9);
    assert.equal(contrastRatio(0x777777ff, 0x777777ff), 1);
  });
});

await finish();
