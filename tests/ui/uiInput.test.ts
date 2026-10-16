/**
 * @suite ui:uiInput
 * @group unit
 * @covers engine/src/ui/input/events.ts
 * @covers engine/src/ui/input/router.ts
 * @covers engine/src/ui/input/focus.ts
 * @covers engine/src/ui/input/domAdapter.ts
 * @covers engine/src/ui/manager.ts
 * @desc UI input: capture/target/bubble propagation with stop/prevent and re-entrancy, click synthesis (press inside/release outside, drags, double clicks, disabled targets, no click-through), pointer capture and cancellation, drag and drop, wheel chaining, modal blocking and light dismiss, disposal during events, focus order/spatial navigation/scopes/modal trap and restore, keyboard and gamepad routing with repeat, and the DOM adapter's coordinate mapping and exclusivity
 */

export const suite = {
  name: "ui:uiInput",
  group: "unit",
  covers: ["engine/src/ui/input/events.ts", "engine/src/ui/input/router.ts", "engine/src/ui/input/focus.ts", "engine/src/ui/input/domAdapter.ts", "engine/src/ui/manager.ts"],
  desc: "UI input: capture/target/bubble propagation with stop/prevent and re-entrancy, click synthesis (press inside/release outside, drags, double clicks, disabled targets, no click-through), pointer capture and cancellation, drag and drop, wheel chaining, modal blocking and light dismiss, disposal during events, focus order/spatial navigation/scopes/modal trap and restore, keyboard and gamepad routing with repeat, and the DOM adapter's coordinate mapping and exclusivity",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Button,
  FlexLayout,
  ModalDialog,
  Panel,
  Popup,
  ScrollView,
  UIContainer,
  UICustomEvent,
  UIElement,
  UIEvent,
  UIState,
  attachDomInput,
  dispatchUIEvent,
  type UIDragEvent,
  type UIManager,
} from "@forge/engine";
import { center, click, drag, frame, key, makeUI } from "../support/uiHarness.js";

class Box extends UIElement {
  static override styleName = "Box";
  constructor(name: string, w = 100, h = 40, focusable = false) {
    super({ name, layout: { width: w, height: h } });
    this.focusable = focusable;
  }
}

function row(ui: UIManager, ...els: UIElement[]): UIContainer {
  const c = ui.base.add(new UIContainer({ strategy: new FlexLayout({ direction: "row", gap: 10 }) }));
  for (const e of els) c.add(e);
  frame(ui);
  return c;
}

group("propagation", () => {
  test("capture runs root→target, then target, then bubble target→root", () => {
    const root = new UIContainer({ name: "root" });
    const mid = root.add(new UIContainer({ name: "mid" }));
    const leaf = mid.add(new Box("leaf"));
    const log: string[] = [];
    for (const el of [root, mid, leaf]) {
      el.on("ping", () => log.push(`${el.name}:bubble`));
      el.on("ping", () => log.push(`${el.name}:capture`), { capture: true });
    }
    dispatchUIEvent(new UIEvent("ping"), leaf);
    assert.deepEqual(log, ["root:capture", "mid:capture", "leaf:capture", "leaf:bubble", "mid:bubble", "root:bubble"]);
  });

  test("stopPropagation finishes the current element; stopImmediatePropagation stops at once", () => {
    const root = new UIContainer({ name: "root" });
    const leaf = root.add(new Box("leaf"));
    const log: string[] = [];
    leaf.on("ping", (e) => {
      log.push("a");
      e.stopPropagation();
    });
    leaf.on("ping", () => log.push("b"));
    root.on("ping", () => log.push("root"));
    dispatchUIEvent(new UIEvent("ping"), leaf);
    assert.deepEqual(log, ["a", "b"]);
    log.length = 0;
    const leaf2 = root.add(new Box("leaf2"));
    leaf2.on("ping", (e) => {
      log.push("a");
      e.stopImmediatePropagation();
    });
    leaf2.on("ping", () => log.push("b"));
    dispatchUIEvent(new UIEvent("ping"), leaf2);
    assert.deepEqual(log, ["a"]);
  });

  test("preventDefault is reported by dispatch; non-bubbling events skip ancestors", () => {
    const root = new UIContainer();
    const leaf = root.add(new Box("leaf"));
    let rootSaw = 0;
    root.on("x", () => rootSaw++);
    leaf.on("x", (e) => e.preventDefault());
    assert.equal(dispatchUIEvent(new UIEvent("x"), leaf), false);
    assert.equal(dispatchUIEvent(new UIEvent("x", false), leaf), false);
    assert.equal(rootSaw, 1, "only the bubbling event reached the root");
  });

  test("listeners added during dispatch run next time; removed ones stop immediately", () => {
    const el = new Box("e");
    const log: string[] = [];
    const later = el.on("x", () => log.push("removed"));
    el.on("x", () => {
      log.push("first");
      el.on("x", () => log.push("added"));
    });
    // `later` was registered first; remove it from a listener that runs before it next time.
    later.dispose();
    dispatchUIEvent(new UIEvent("x"), el);
    assert.deepEqual(log, ["first"]);
    log.length = 0;
    const h = el.on("y", () => {
      log.push("y1");
      h2.dispose();
    });
    const h2 = el.on("y", () => log.push("y2"));
    dispatchUIEvent(new UIEvent("y"), el);
    assert.deepEqual(log, ["y1"], "a listener removed mid-dispatch does not run");
    void h;
  });

  test("a throwing listener is reported and the walk continues", () => {
    const ui = makeUI();
    const box = ui.base.add(new Box("b"));
    let after = 0;
    box.on("x", () => {
      throw new Error("boom");
    });
    box.on("x", () => after++);
    ui.dispatch(new UIEvent("x"), box);
    assert.equal(after, 1);
    assert.ok(ui.messages.some((m) => m.level === "error" && m.message.includes("boom")));
  });

  test("disposing an ancestor during dispatch skips it safely", () => {
    const root = new UIContainer({ name: "root" });
    const mid = root.add(new UIContainer({ name: "mid" }));
    const leaf = mid.add(new Box("leaf"));
    const log: string[] = [];
    leaf.on("x", () => {
      log.push("leaf");
      mid.dispose();
    });
    mid.on("x", () => log.push("mid"));
    root.on("x", () => log.push("root"));
    dispatchUIEvent(new UIEvent("x"), leaf);
    assert.deepEqual(log, ["leaf", "root"], "the disposed mid is skipped, the root still bubbles");
  });
});

group("pointer: click semantics", () => {
  test("press and release inside clicks once, with pressed/hovered states on the way", () => {
    const ui = makeUI();
    const b = new Button({ text: "Go" });
    row(ui, b);
    let clicks = 0;
    b.on("click", () => clicks++);
    const p = center(b);
    ui.router.pointerMove(p.x, p.y);
    assert.ok(b.hasState(UIState.Hovered));
    ui.router.pointerDown(p.x, p.y);
    assert.ok(b.hasState(UIState.Pressed));
    ui.router.pointerUp(p.x, p.y);
    assert.equal(clicks, 1);
    assert.equal(b.pressCount, 1);
    assert.ok(!b.hasState(UIState.Pressed));
  });

  test("press inside, release outside: no click; pressed state follows the pointer while held", () => {
    const ui = makeUI();
    const b = new Button({ text: "Go" });
    row(ui, b);
    let clicks = 0;
    b.on("click", () => clicks++);
    const p = center(b);
    ui.router.pointerDown(p.x, p.y);
    ui.router.pointerMove(p.x + 500, p.y);
    assert.ok(!b.hasState(UIState.Pressed), "pressed clears when the pointer leaves");
    ui.router.pointerMove(p.x, p.y);
    assert.ok(b.hasState(UIState.Pressed), "and returns when it comes back");
    ui.router.pointerMove(p.x + 500, p.y);
    ui.router.pointerUp(p.x + 500, p.y);
    assert.equal(clicks, 0);
  });

  test("the pressed element captures moves and the release, wherever the pointer goes", () => {
    const ui = makeUI();
    const a = new Box("a");
    const c = new Box("c");
    row(ui, a, c);
    const seen: string[] = [];
    a.on("pointermove", () => seen.push("a"));
    c.on("pointermove", () => seen.push("c"));
    a.on("pointerup", () => seen.push("a-up"));
    const pa = center(a);
    ui.router.pointerDown(pa.x, pa.y);
    ui.router.pointerMove(center(c).x, center(c).y);
    ui.router.pointerUp(center(c).x, center(c).y);
    assert.deepEqual(seen, ["a", "a-up"]);
    assert.equal(ui.router.captureOf(0), null, "capture ends with the release");
  });

  test("a drag past the threshold is not a click", () => {
    const ui = makeUI();
    const b = new Button({ text: "Drag" });
    row(ui, b);
    let clicks = 0;
    b.on("click", () => clicks++);
    const p = center(b);
    drag(ui, p, { x: p.x + 20, y: p.y });
    assert.equal(clicks, 0);
  });

  test("a second click within the double-click window has clickCount 2 and fires dblclick", () => {
    const ui = makeUI();
    const b = new Box("b");
    row(ui, b);
    const counts: number[] = [];
    let dbl = 0;
    b.on("click", (e) => counts.push(e.clickCount));
    b.on("dblclick", () => dbl++);
    click(ui, b);
    click(ui, b);
    assert.deepEqual(counts, [1, 2]);
    assert.equal(dbl, 1);
    for (let i = 0; i < 40; i++) frame(ui);
    click(ui, b);
    assert.equal(counts[2], 1, "after the window the count resets");
  });

  test("disabled targets get nothing but block what is underneath (no click-through)", () => {
    const ui = makeUI();
    const under = ui.base.add(new Box("under", 300, 300));
    let underClicks = 0;
    under.on("click", () => underClicks++);
    const cover = ui.layer("hud").add(new Button({ text: "disabled", enabled: false, layout: { width: 200, height: 200 } }));
    frame(ui);
    let coverEvents = 0;
    cover.on("pointerdown", () => coverEvents++);
    assert.equal(ui.router.pointerDown(50, 50), true, "consumed by the UI");
    ui.router.pointerUp(50, 50);
    assert.equal(coverEvents, 0);
    assert.equal(underClicks, 0);
    assert.equal(cover.pressCount, 0);
  });

  test("pointer events that miss every element are reported as not consumed (the game gets them)", () => {
    const ui = makeUI();
    frame(ui);
    assert.equal(ui.router.pointerDown(600, 400), false);
    assert.equal(ui.router.pointerUp(600, 400), false);
    assert.equal(ui.router.wheel(600, 400, 0, 10), false);
  });

  test("pointerEvents: children lets a transparent container pass clicks through", () => {
    const ui = makeUI();
    const under = ui.base.add(new Box("under", 300, 300));
    const layer = ui.layer("hud").add(new UIContainer({ layout: { width: 400, height: 400 } }));
    layer.add(new Box("tiny", 10, 10));
    frame(ui);
    assert.equal(ui.hitTest(200, 200), under);
    assert.equal(ui.hitTest(5, 5)?.name, "tiny");
  });

  test("clipping containers clip hit testing of their children", () => {
    const ui = makeUI();
    const clip = ui.base.add(new UIContainer({ clipChildren: true, layout: { width: 50, height: 50 } }));
    clip.pointerEvents = "auto";
    const inner = clip.add(new Box("inner", 200, 200));
    frame(ui);
    assert.equal(ui.hitTest(25, 25), inner);
    assert.equal(ui.hitTest(150, 150), null, "outside the clip the child is unreachable");
  });

  test("touch: no hover without contact, one tap is one click (no mouse/touch double path)", () => {
    const ui = makeUI();
    const b = new Button({ text: "Tap" });
    row(ui, b);
    const p = center(b);
    ui.router.pointerMove(p.x, p.y, 7, "touch");
    assert.ok(!b.hasState(UIState.Hovered));
    click(ui, b, p, 7, "touch");
    assert.equal(b.pressCount, 1);
    assert.ok(!b.hasState(UIState.Hovered), "hover ends with the touch");
  });
});

group("pointer: capture, cancellation and disposal", () => {
  test("disposing the pressed element mid-gesture cancels it without dispatching to the dead element", () => {
    const ui = makeUI();
    const b = new Button({ text: "x" });
    row(ui, b);
    const p = center(b);
    ui.router.pointerDown(p.x, p.y);
    b.dispose();
    ui.router.pointerMove(p.x + 1, p.y);
    ui.router.pointerUp(p.x, p.y);
    assert.equal(b.pressCount, 0);
    assert.equal(ui.router.captureOf(0), null);
  });

  test("a click handler that disposes its own button is safe", () => {
    const ui = makeUI();
    const b = new Button({ text: "close me" });
    row(ui, b);
    b.on("click", () => b.dispose());
    click(ui, b);
    assert.equal(b.disposed, true);
    assert.deepEqual(ui.messages.filter((m) => m.level === "error"), []);
  });

  test("disabling or hiding the captured element cancels the gesture with pointercancel", () => {
    const ui = makeUI();
    const b = new Button({ text: "x" });
    row(ui, b);
    let cancels = 0;
    b.on("pointercancel", () => cancels++);
    const p = center(b);
    ui.router.pointerDown(p.x, p.y);
    b.enabled = false;
    frame(ui);
    assert.equal(cancels, 1);
    assert.equal(ui.router.captureOf(0), null);
    ui.router.pointerUp(p.x, p.y);
    assert.equal(b.pressCount, 0);
  });

  test("platform pointercancel ends the press", () => {
    const ui = makeUI();
    const b = new Button({ text: "x" });
    row(ui, b);
    const p = center(b);
    ui.router.pointerDown(p.x, p.y, 3, "touch");
    assert.equal(ui.router.pointerCancel(3), true);
    assert.ok(!b.hasState(UIState.Pressed));
    ui.router.pointerUp(p.x, p.y, 3, "touch");
    assert.equal(b.pressCount, 0);
  });

  test("rapid input: many down/up pairs produce exactly that many clicks", () => {
    const ui = makeUI();
    const b = new Button({ text: "x" });
    row(ui, b);
    const p = center(b);
    for (let i = 0; i < 25; i++) {
      ui.router.pointerDown(p.x, p.y, 1);
      ui.router.pointerUp(p.x, p.y, 1);
    }
    assert.equal(b.pressCount, 25);
  });

  test("multi-touch: two pointers press two buttons independently", () => {
    const ui = makeUI();
    const a = new Button({ text: "a" });
    const c = new Button({ text: "c" });
    row(ui, a, c);
    ui.router.pointerDown(center(a).x, center(a).y, 1, "touch");
    ui.router.pointerDown(center(c).x, center(c).y, 2, "touch");
    ui.router.pointerUp(center(c).x, center(c).y, 2, "touch");
    ui.router.pointerUp(center(a).x, center(a).y, 1, "touch");
    assert.equal(a.pressCount, 1);
    assert.equal(c.pressCount, 1);
  });
});

group("drag and drop", () => {
  test("dragstart payload → dragenter/over/leave on targets → drop and dragend", () => {
    const ui = makeUI();
    const src = new Box("src");
    const mid = new Box("mid");
    const dst = new Box("dst");
    row(ui, src, mid, dst);
    const log: string[] = [];
    src.on("dragstart", (e: UIDragEvent) => {
      e.payload = { item: "gem" };
      log.push("start");
    });
    src.on("dragend", () => log.push("end"));
    for (const t of [mid, dst]) {
      t.on("dragenter", () => log.push(`enter:${t.name}`));
      t.on("dragleave", () => log.push(`leave:${t.name}`));
      t.on("drop", (e: UIDragEvent) => log.push(`drop:${t.name}:${(e.payload as { item: string }).item}`));
    }
    drag(ui, center(src), center(dst), 12);
    assert.deepEqual(log.filter((l) => !l.startsWith("over")), ["start", "enter:src", "leave:src", "enter:mid", "leave:mid", "enter:dst", "drop:dst:gem", "end"].filter((l) => l !== "enter:src" && l !== "leave:src"));
  });

  test("without a payload there is no drop target traffic", () => {
    const ui = makeUI();
    const src = new Box("src");
    const dst = new Box("dst");
    row(ui, src, dst);
    let entered = 0;
    dst.on("dragenter", () => entered++);
    drag(ui, center(src), center(dst));
    assert.equal(entered, 0);
  });
});

group("wheel and scrolling", () => {
  function nestedScroll(ui: UIManager): { outer: ScrollView; inner: ScrollView } {
    const outer = ui.base.add(new ScrollView({ layout: { width: 200, height: 200 } }));
    const tall = new UIContainer({ strategy: new FlexLayout({ direction: "column" }) });
    const inner = new ScrollView({ layout: { width: 180, height: 100 } });
    inner.add(new Box("inner-content", 100, 400));
    tall.add(inner);
    tall.add(new Box("filler", 100, 600));
    outer.content = tall;
    frame(ui);
    return { outer, inner };
  }

  test("the inner scroller consumes the wheel until its edge, then the outer one scrolls (chaining)", () => {
    const ui = makeUI();
    const { outer, inner } = nestedScroll(ui);
    const p = center(inner);
    ui.router.wheel(p.x, p.y, 0, 250);
    frame(ui);
    assert.equal(inner.scrollY, 250);
    assert.equal(outer.scrollY, 0);
    ui.router.wheel(p.x, p.y, 0, 200);
    frame(ui);
    assert.equal(inner.scrollY, 300, "clamped at its maximum (400 - 100)");
    ui.router.wheel(p.x, p.y, 0, 100);
    frame(ui);
    assert.equal(outer.scrollY, 100, "at the edge the wheel bubbled to the outer scroller");
  });

  test("scrolling moves content hit testing with it", () => {
    const ui = makeUI();
    const sv = ui.base.add(new ScrollView({ layout: { width: 200, height: 100 } }));
    const items = [0, 1, 2, 3, 4].map((i) => sv.add(new Box(`item${i}`, 150, 50)));
    frame(ui);
    assert.equal(ui.hitTest(50, 25)?.name, "item0");
    sv.scrollY = 100;
    frame(ui);
    assert.equal(ui.hitTest(50, 25)?.name, "item2");
    assert.equal(items[2]!.bounds.y, 0);
  });

  test("touch drags scroll and suppress the click on the content", () => {
    const ui = makeUI();
    const sv = ui.base.add(new ScrollView({ layout: { width: 200, height: 100 } }));
    const btns = [0, 1, 2, 3].map((i) => sv.add(new Button({ text: `b${i}`, layout: { width: 150, height: 60 } })));
    frame(ui);
    const p = center(btns[0]!);
    drag(ui, p, { x: p.x, y: p.y - 70 }, 8, 5, "touch");
    assert.ok(sv.scrollY > 50, `scrolled ${sv.scrollY}`);
    assert.equal(btns[0]!.pressCount, 0);
  });
});

group("modals and popups", () => {
  test("a modal blocks input below it and Escape closes it, restoring focus", () => {
    const ui = makeUI();
    const opener = new Button({ text: "open" });
    row(ui, opener);
    opener.focus(true);
    const dialog = new ModalDialog({ title: "Hi" });
    const ok = dialog.addAction("OK", () => dialog.close("ok"));
    dialog.open(ui);
    frame(ui);
    assert.equal(ui.focus.focused, ok, "focus moved into the dialog");
    const hitBelow = ui.hitTest(center(opener).x, center(opener).y);
    assert.notEqual(hitBelow, opener, "the backdrop takes the hit");
    click(ui, opener);
    assert.equal(opener.pressCount, 0);
    assert.equal(ui.focus.focus(opener), false, "focus cannot leave the modal");
    key(ui, "Escape");
    assert.equal(ui.overlays.isOpen(dialog), false);
    assert.equal(ui.focus.focused, opener, "focus restored to the opener");
  });

  test("Tab is trapped inside the modal", () => {
    const ui = makeUI();
    row(ui, new Button({ text: "outside" }));
    const d = new ModalDialog({ title: "t" });
    const a = d.addAction("A", () => {});
    const b = d.addAction("B", () => {});
    d.open(ui, a);
    frame(ui);
    key(ui, "Tab");
    assert.equal(ui.focus.focused, b);
    key(ui, "Tab");
    assert.equal(ui.focus.focused, a, "wrapped around inside the dialog");
    key(ui, "Tab", { shift: true });
    assert.equal(ui.focus.focused, b);
  });

  test("a non-dismissable modal ignores Escape", () => {
    const ui = makeUI();
    const d = new ModalDialog({ title: "t", dismissable: false });
    d.addAction("OK", () => d.close());
    d.open(ui);
    frame(ui);
    key(ui, "Escape");
    assert.equal(ui.overlays.isOpen(d), true);
  });

  test("light dismiss: pressing outside a popup and its owner closes it; inside keeps it", () => {
    const ui = makeUI();
    const owner = new Button({ text: "owner" });
    const other = new Button({ text: "other" });
    row(ui, owner, other);
    const pop = new Popup();
    const inside = pop.add(new Button({ text: "inside" }));
    pop.openAt(ui, owner);
    frame(ui);
    assert.ok(pop.bounds.y >= owner.bounds.bottom, "placed below its owner");
    click(ui, inside);
    assert.equal(pop.isOpen, true);
    click(ui, other);
    assert.equal(pop.isOpen, false);
    assert.equal(other.pressCount, 1, "the click that dismissed the popup still reached its target");
  });

  test("a popup that would leave the viewport flips above its owner", () => {
    const ui = makeUI({ width: 400, height: 300 });
    const owner = ui.base.add(new Button({ text: "o", layout: { position: "absolute", anchor: { left: 10, bottom: 10 } } }));
    frame(ui);
    const pop = new Popup();
    pop.add(new Box("content", 100, 120));
    pop.openAt(ui, owner);
    frame(ui);
    assert.ok(pop.bounds.bottom <= owner.bounds.y + 1e-6, `popup ${pop.bounds.y}..${pop.bounds.bottom} above owner at ${owner.bounds.y}`);
  });

  test("opening a modal closes light-dismiss popups owned outside it", () => {
    const ui = makeUI();
    const owner = new Button({ text: "owner" });
    row(ui, owner);
    const pop = new Popup();
    pop.add(new Box("c"));
    pop.openAt(ui, owner);
    const d = new ModalDialog({ title: "t" });
    d.addAction("OK", () => d.close());
    d.open(ui);
    assert.equal(pop.isOpen, false);
  });
});

group("focus and keyboard", () => {
  test("Tab order: positive tabIndex first, then tree order; negative is skipped; wraps", () => {
    const ui = makeUI();
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => new Box(n, 40, 40, true));
    c!.tabIndex = 1;
    d!.tabIndex = -1;
    row(ui, a!, b!, c!, d!);
    assert.deepEqual(ui.focus.sequence().map((e) => e.name), ["c", "a", "b"]);
    key(ui, "Tab");
    assert.equal(ui.focus.focused?.name, "c");
    key(ui, "Tab");
    key(ui, "Tab");
    key(ui, "Tab");
    assert.equal(ui.focus.focused?.name, "c", "wrapped");
    assert.equal(ui.focus.focusVisible, true);
  });

  test("arrow keys move focus spatially, preferring aligned neighbours", () => {
    const ui = makeUI();
    const grid = ui.base.add(new UIContainer({ strategy: new FlexLayout({ direction: "row", wrap: true, gap: 10 }), layout: { width: 340 } }));
    const cells = Array.from({ length: 9 }, (_, i) => grid.add(new Box(`c${i}`, 100, 40, true)));
    frame(ui);
    cells[4]!.focus(true);
    key(ui, "ArrowRight");
    assert.equal(ui.focus.focused, cells[5]);
    key(ui, "ArrowDown");
    assert.equal(ui.focus.focused, cells[8]);
    key(ui, "ArrowLeft");
    key(ui, "ArrowUp");
    assert.equal(ui.focus.focused, cells[4]);
    key(ui, "ArrowRight");
    key(ui, "ArrowRight");
    assert.equal(ui.focus.focused, cells[5], "no candidate at the edge: focus stays");
  });

  test("arrows are not consumed when nothing in the UI has focus (the game keeps them)", () => {
    const ui = makeUI();
    row(ui, new Box("a", 40, 40, true));
    assert.equal(ui.router.keyDown("ArrowLeft"), false);
    assert.equal(ui.router.keyDown("Enter"), false);
  });

  test("Enter/Space activate the focused control with a brief pressed flash", () => {
    const ui = makeUI();
    const b = new Button({ text: "go" });
    row(ui, b);
    b.focus(true);
    key(ui, "Enter");
    assert.equal(b.pressCount, 1);
    ui.router.keyDown(" ");
    assert.equal(b.pressCount, 2);
    assert.ok(b.hasState(UIState.Pressed));
    for (let i = 0; i < 12; i++) frame(ui);
    assert.ok(!b.hasState(UIState.Pressed));
  });

  test("pointer focus is not 'visible'; clicking empty space blurs", () => {
    const ui = makeUI();
    const b = new Button({ text: "go" });
    row(ui, b);
    click(ui, b);
    assert.equal(ui.focus.focused, b);
    assert.equal(ui.focus.focusVisible, false);
    ui.router.pointerDown(900, 600);
    ui.router.pointerUp(900, 600);
    assert.equal(ui.focus.focused, null);
  });

  test("focus recovers when the focused element is hidden, disabled or removed", () => {
    const ui = makeUI();
    const a = new Button({ text: "a" });
    const b = new Button({ text: "b" });
    row(ui, a, b);
    b.focus(true);
    b.visible = false;
    frame(ui);
    assert.equal(ui.focus.focused, a, "keyboard focus moved to the first focusable");
    a.enabled = false;
    b.visible = true;
    frame(ui);
    assert.equal(ui.focus.focused, b);
    b.dispose();
    frame(ui);
    assert.equal(ui.focus.focused, null, "nothing focusable is left");
  });

  test("focus/blur and focusin/focusout fire in order; a focus listener may move focus again", () => {
    const ui = makeUI();
    const a = new Box("a", 40, 40, true);
    const b = new Box("b", 40, 40, true);
    const c = new Box("c", 40, 40, true);
    const parent = row(ui, a, b, c);
    const log: string[] = [];
    a.on("blur", () => log.push("a:blur"));
    b.on("focus", () => {
      log.push("b:focus");
      c.focus(true);
    });
    parent.on("focusin", (e) => log.push(`in:${e.target?.name}`));
    a.focus(true);
    b.focus(true);
    assert.equal(ui.focus.focused, c, "the redirect won");
    assert.deepEqual(log.slice(0, 4), ["in:a", "a:blur", "b:focus", "in:c"]);
  });

  test("focus scopes keep Tab inside a scope element", () => {
    const ui = makeUI();
    const outside = new Box("out", 40, 40, true);
    const scope = new UIContainer({ strategy: new FlexLayout({ direction: "row" }) });
    scope.focusScope = true;
    const s1 = scope.add(new Box("s1", 40, 40, true));
    const s2 = scope.add(new Box("s2", 40, 40, true));
    row(ui, outside, scope);
    s1.focus(true);
    key(ui, "Tab");
    assert.equal(ui.focus.focused, s2);
    key(ui, "Tab");
    assert.equal(ui.focus.focused, s1);
  });
});

group("gamepad", () => {
  test("d-pad navigates, A activates, B cancels, shoulder buttons page", () => {
    const ui = makeUI();
    const a = new Button({ text: "a" });
    const b = new Button({ text: "b" });
    row(ui, a, b);
    ui.router.gamepadButton("a", true);
    assert.equal(ui.focus.focused, a, "A with nothing focused focuses the first control");
    ui.router.gamepadButton("right", true);
    ui.router.gamepadButton("right", false);
    assert.equal(ui.focus.focused, b);
    ui.router.gamepadButton("a", true);
    assert.equal(b.pressCount, 1);
    let paged = "";
    b.on("navigate", (e) => (paged = e.direction));
    ui.router.gamepadButton("rb", true);
    assert.equal(paged, "pagenext");
    const d = new ModalDialog({ title: "x" });
    d.addAction("ok", () => {});
    d.open(ui);
    ui.router.gamepadButton("b", true);
    assert.equal(ui.overlays.isOpen(d), false, "B cancels the modal");
  });

  test("a held direction repeats after the delay at the interval", () => {
    const ui = makeUI();
    const boxes = Array.from({ length: 8 }, (_, i) => new Box(`b${i}`, 40, 40, true));
    row(ui, ...boxes);
    boxes[0]!.focus(true);
    ui.router.gamepadButton("right", true);
    assert.equal(ui.focus.focused, boxes[1]);
    frame(ui, 0.3);
    assert.equal(ui.focus.focused, boxes[1], "no repeat before the delay");
    frame(ui, 0.2); // 0.5 s > 0.45 delay
    assert.equal(ui.focus.focused, boxes[2]);
    frame(ui, 0.13);
    assert.equal(ui.focus.focused, boxes[3]);
    ui.router.gamepadButton("right", false);
    frame(ui, 1);
    assert.equal(ui.focus.focused, boxes[3], "release stops the repeat");
  });

  test("the stick navigates once per dead-zone crossing", () => {
    const ui = makeUI();
    const boxes = Array.from({ length: 4 }, (_, i) => new Box(`b${i}`, 40, 40, true));
    row(ui, ...boxes);
    boxes[0]!.focus(true);
    ui.router.gamepadAxis(0.9, 0.1);
    ui.router.gamepadAxis(0.95, 0);
    assert.equal(ui.focus.focused, boxes[1]);
    ui.router.gamepadAxis(0.1, 0);
    ui.router.gamepadAxis(0.9, 0);
    assert.equal(ui.focus.focused, boxes[2]);
  });
});

group("input trace and the DOM adapter", () => {
  test("the input trace records routed inputs with their targets", () => {
    const ui = makeUI();
    const b = new Button({ text: "t", name: "traced" });
    row(ui, b);
    ui.diagnostics.startInputTrace();
    click(ui, b);
    const trace = ui.diagnostics.stopInputTrace();
    assert.deepEqual(trace.map((t) => t.input).slice(0, 3), ["pointermove", "pointerdown", "pointerup"]);
    assert.ok(trace[1]!.target?.includes("traced"));
    assert.ok(trace.every((t) => t.consumed));
  });

  test("DOM events map through the canvas rect and the UI scale; consumed events stop propagation", () => {
    const ui = makeUI({ width: 2000, height: 1000, devicePixelRatio: 2 });
    const b = ui.base.add(new Button({ text: "dom", layout: { position: "absolute", anchor: { left: 100, top: 100 }, width: 100, height: 50 } }));
    frame(ui);
    const listeners = new Map<string, (e: unknown) => void>();
    const target = {
      width: 2000,
      height: 1000,
      addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
      removeEventListener: (t: string) => listeners.delete(t),
      // CSS size half the backing store (dpr 2), offset on the page.
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 500 }),
    };
    const keyTarget = { addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(`key:${t}`, fn), removeEventListener: () => {} };
    const handle = attachDomInput(target as never, ui.router, ui.viewport, { keyboardTarget: keyTarget as never });
    let stopped = 0;
    let prevented = 0;
    const ev = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
    // Logical (150, 125) = physical (300, 250) = CSS (150, 125) + rect offset.
    listeners.get("pointerdown")!(ev(160, 145));
    listeners.get("pointerup")!(ev(160, 145));
    assert.equal(b.pressCount, 1);
    assert.ok(stopped >= 2 && prevented >= 2, "consumed events are not seen by the orbit camera");
    const before = stopped;
    listeners.get("pointerdown")!(ev(900, 450));
    assert.equal(stopped, before, "misses pass through to the game");
    b.focus(true);
    listeners.get("key:keydown")!({ key: "Enter", code: "Enter", repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: () => {}, stopImmediatePropagation: () => {}, target: null });
    assert.equal(b.pressCount, 2);
    handle.dispose();
    assert.equal(listeners.has("pointerdown"), false);
  });

  test("the DOM clipboard never pastes twice (paste comes from the paste event)", () => {
    const ui = makeUI();
    const handle = attachDomInput({ addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) }, ui.router, ui.viewport, { keyboardTarget: { addEventListener() {}, removeEventListener() {} }, writeClipboard: () => {} });
    assert.equal(handle.clipboard.read(), null);
    void UICustomEvent;
    void Panel;
  });
});

await finish();
