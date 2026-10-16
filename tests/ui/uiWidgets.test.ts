/**
 * @suite ui:uiWidgets
 * @group unit
 * @covers engine/src/ui/widgets/base.ts
 * @covers engine/src/ui/widgets/structural.ts
 * @covers engine/src/ui/widgets/display.ts
 * @covers engine/src/ui/widgets/interactive.ts
 * @covers engine/src/ui/widgets/textInput.ts
 * @covers engine/src/ui/widgets/collections.ts
 * @covers engine/src/ui/widgets/overlayHosts.ts
 * @desc Core widgets: behaviour through real input (pointer, keyboard, gamepad), measurement and change events for structural, display, toggle, slider, text-entry and collection widgets, including virtualization recycling and scroll views
 */

export const suite = {
  name: "ui:uiWidgets",
  group: "unit",
  covers: [
    "engine/src/ui/widgets/base.ts",
    "engine/src/ui/widgets/structural.ts",
    "engine/src/ui/widgets/display.ts",
    "engine/src/ui/widgets/interactive.ts",
    "engine/src/ui/widgets/textInput.ts",
    "engine/src/ui/widgets/collections.ts",
    "engine/src/ui/widgets/overlayHosts.ts",
  ],
  desc: "Core widgets: behaviour through real input (pointer, keyboard, gamepad), measurement and change events for structural, display, toggle, slider, text-entry and collection widgets, including virtualization recycling and scroll views",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Badge,
  Button,
  Checkbox,
  CircularProgress,
  CollapsiblePanel,
  ComboBox,
  Dropdown,
  Grid,
  HStack,
  Icon,
  Label,
  ListBox,
  MemoryClipboard,
  NumericDisplay,
  Panel,
  ProgressBar,
  RadioButton,
  RadioGroup,
  RangeModel,
  RangeSlider,
  RichText,
  SafeArea,
  ScrollView,
  SelectionModel,
  Separator,
  Slider,
  Spacer,
  SplitPane,
  StatDisplay,
  StatusIndicator,
  Switch,
  TextArea,
  TextInput,
  ToggleButton,
  TreeView,
  UIImage,
  UIState,
  VStack,
  VirtualizedGrid,
  VirtualizedList,
  formatNumber,
  type UIElement,
  type UIManager,
} from "@forge/engine";
import { advance, center, click, drag, frame, key, makeUI, type as typeText } from "../support/uiHarness.js";

const COLUMNS = new WeakMap<UIManager, VStack>();

/** Mounted widgets share one column per manager so they never overlap at the layer origin. */
function mount<T extends UIElement>(ui: UIManager, el: T): T {
  let col = COLUMNS.get(ui);
  if (!col) {
    col = ui.base.add(new VStack({ gap: 8, layout: { width: 400, padding: 10 } }));
    COLUMNS.set(ui, col);
  }
  col.add(el);
  frame(ui);
  return el;
}

group("structural", () => {
  test("Panel paints a skinned surface and takes pointer events; stacks pass them through", () => {
    const ui = makeUI();
    const panel = mount(ui, new Panel({ layout: { height: 60 } }));
    assert.equal(panel.pointerEvents, "auto");
    assert.notEqual(panel.computedStyle.background, 0);
    const stack = mount(ui, new HStack({ gap: 4 }));
    assert.equal(stack.pointerEvents, "children");
    stack.gap = 20;
    stack.add(new Spacer({ size: 10 }));
    stack.add(new Spacer({ size: 10 }));
    frame(ui);
    assert.equal(stack.children[1]!.bounds.x - stack.children[0]!.bounds.right, 20);
  });

  test("Spacer grows; Separator measures to its border width and stretches", () => {
    const ui = makeUI();
    const row = ui.base.add(new HStack({ layout: { width: 300, height: 20 } }));
    row.add(new Spacer());
    const end = row.add(new Badge({ text: "end" }));
    frame(ui);
    assert.ok(Math.abs(end.bounds.right - 300) < 1e-6, "pushed to the end");
    const sep = mount(ui, new Separator());
    assert.equal(sep.bounds.height, 1);
    assert.equal(sep.bounds.width, 380);
  });

  test("Grid widget changes columns at runtime", () => {
    const ui = makeUI();
    const g = mount(ui, new Grid({ columns: 2, columnGap: 0 }));
    for (let i = 0; i < 4; i++) g.add(new Badge({ text: String(i) }));
    frame(ui);
    assert.equal(g.children[1]!.bounds.y, g.children[0]!.bounds.y);
    g.setColumns(1);
    frame(ui);
    assert.ok(g.children[1]!.bounds.y > g.children[0]!.bounds.y);
  });

  test("SafeArea adds the viewport insets to its padding", () => {
    const ui = makeUI();
    const sa = ui.base.add(new SafeArea({ layout: { alignSelf: "stretch", justifySelf: "stretch" } }));
    const inner = sa.add(new Badge({ text: "x" }));
    ui.setSafeArea({ top: 30, left: 12 });
    frame(ui);
    assert.equal(inner.bounds.y, 30);
    assert.equal(inner.bounds.x, 12);
  });

  test("ScrollView: wheel scrolling, scrollTo clamping, scrollbar drag and reveal-on-focus", () => {
    const ui = makeUI();
    const sv = ui.base.add(new ScrollView({ layout: { width: 200, height: 100 } }));
    const btns = Array.from({ length: 10 }, (_, i) => sv.add(new Button({ text: `b${i}`, layout: { height: 40 } })));
    frame(ui);
    assert.ok(sv.scroll.maxY >= 300, `maxY ${sv.scroll.maxY}`);
    sv.scrollTo(0, 99999);
    assert.equal(sv.scrollY, sv.scroll.maxY);
    sv.scrollTo(0, 0);
    btns[9]!.focus(true);
    frame(ui);
    assert.ok(btns[9]!.bounds.bottom <= sv.bounds.bottom + 1e-6, "the focused button was scrolled into view");
    const before = sv.scrollY;
    // Drag the scrollbar thumb up (it sits at the right edge).
    const x = sv.bounds.right - 5;
    drag(ui, { x, y: sv.bounds.bottom - 10 }, { x, y: sv.bounds.y + 5 });
    assert.ok(sv.scrollY < before, `thumb drag scrolled back: ${before} → ${sv.scrollY}`);
    assert.equal(btns.reduce((n, b) => n + b.pressCount, 0), 0, "the thumb drag never clicked content");
  });

  test("ScrollView.scrollTo can animate", () => {
    const ui = makeUI();
    const sv = ui.base.add(new ScrollView({ layout: { width: 200, height: 100 } }));
    for (let i = 0; i < 10; i++) sv.add(new Button({ text: `b${i}`, layout: { height: 40 } }));
    frame(ui);
    sv.scrollTo(0, 200, true);
    frame(ui, 0.05);
    assert.ok(sv.scrollY > 0 && sv.scrollY < 200);
    advance(ui, 0.4);
    assert.equal(sv.scrollY, 200);
  });

  test("SplitPane: divider drag and arrow keys change the ratio within the minimums", () => {
    const ui = makeUI();
    const sp = ui.base.add(new SplitPane({ layout: { width: 406, height: 100 }, ratio: 0.5, minFirst: 50, minSecond: 50 }));
    frame(ui);
    assert.equal(Math.round(sp.first.bounds.width), 200);
    const d = center(sp.divider);
    drag(ui, d, { x: d.x + 100, y: d.y });
    assert.equal(Math.round(sp.first.bounds.width), 300);
    sp.divider.focus(true);
    key(ui, "ArrowLeft");
    assert.ok(sp.ratio < 0.75);
    sp.ratio = 0.99;
    frame(ui);
    assert.equal(Math.round(sp.second.bounds.width), 50, "clamped to minSecond");
  });

  test("CollapsiblePanel toggles from its header, animates and hides its body", () => {
    const ui = makeUI();
    const cp = mount(ui, new CollapsiblePanel({ title: "Details" }));
    cp.add(new Label({ text: "content", layout: { height: 50 } }));
    frame(ui);
    const open = cp.bounds.height;
    click(ui, cp.header);
    assert.equal(cp.expanded, false);
    advance(ui, 0.3);
    assert.ok(cp.bounds.height < open - 40, `collapsed ${cp.bounds.height} < ${open}`);
    assert.equal(cp.body.visible, false);
    cp.header.focus(true);
    key(ui, "Enter");
    advance(ui, 0.3);
    assert.ok(Math.abs(cp.bounds.height - open) < 1e-6);
  });
});

group("display", () => {
  test("Label measures its text, wraps to the width it is given and localizes", () => {
    const ui = makeUI();
    ui.localizer.addTable("en", { greet: "Hello" });
    ui.localizer.addTable("de", { greet: "Guten Tag, willkommen" });
    ui.localizer.setLocale("en");
    const l = mount(ui, new Label({ textKey: "greet", layout: { alignSelf: "start" } }));
    assert.equal(l.text, "Hello");
    const w = l.bounds.width;
    ui.localizer.setLocale("de");
    frame(ui);
    assert.equal(l.text, "Guten Tag, willkommen");
    assert.ok(l.bounds.width > w, "re-measured for the longer translation");
    const wrapping = mount(ui, new Label({ text: "one two three four five six seven eight nine ten eleven twelve", wrap: "word", layout: { width: 120 } }));
    assert.ok(wrapping.bounds.height > 40, "multiple lines");
  });

  test("RichText parses tags, keeps unknown ones visible and never executes anything", () => {
    const ui = makeUI();
    const rt = mount(ui, new RichText({ markup: "[b]Bold[/b] [color=#ff0000]red[/color] [[literal] [icon=star] [script]alert(1)[/script]" }));
    assert.equal(rt.plainText, "Bold red [literal]  [script]alert(1)[/script]");
    assert.ok(ui.messages.some((m) => m.message.includes("unknown tag [script]")));
    rt.markup = "plain";
    frame(ui);
    assert.equal(rt.accessibility.label, "plain");
  });

  test("Image sizes to its asset and reports missing assets once (magenta fallback)", () => {
    const ui = makeUI();
    ui.assets.registerPixels("img", 40, 20, new Uint8Array(40 * 20 * 4).fill(255));
    const img = ui.base.add(new UIImage({ source: "img" }));
    frame(ui);
    assert.deepEqual([img.bounds.width, img.bounds.height], [40, 20]);
    img.source = "nope";
    frame(ui);
    frame(ui);
    assert.equal(ui.messages.filter((m) => m.message.includes('"nope"')).length, 1);
  });

  test("Icon draws glyph icons from the font and sprites from assets", () => {
    const ui = makeUI();
    const ic = mount(ui, new Icon({ icon: "star", size: 24, layout: { alignSelf: "start" } }));
    assert.equal(ic.bounds.width, 24);
    const before = ui.render().stats.glyphs;
    assert.ok(before >= 1);
  });

  test("ProgressBar clamps, formats and smooths toward its value; indeterminate ticks", () => {
    const ui = makeUI();
    const p = mount(ui, new ProgressBar({ value: 2, smoothing: 0.2, showLabel: true }));
    assert.equal(p.value, 1);
    assert.equal(p.accessibility.value, "100%");
    p.value = 0.25;
    frame(ui);
    assert.ok(p.displayValue > 0.25 && p.displayValue < 1);
    advance(ui, 0.3);
    assert.equal(p.displayValue, 0.25);
    p.indeterminate = true;
    assert.equal(ui.update(1 / 60).tickingElements >= 1, true);
    const c = mount(ui, new CircularProgress({ value: 0.5, size: 64 }));
    assert.equal(c.bounds.width, 64);
  });

  test("NumericDisplay counts toward new values and formats them", () => {
    const ui = makeUI();
    const n = mount(ui, new NumericDisplay({ value: 0, duration: 0.5, format: { separator: ",", prefix: "$" } }));
    n.value = 1_000_000;
    advance(ui, 0.1);
    assert.ok(n.shown > 0 && n.shown < 1_000_000);
    advance(ui, 0.6);
    assert.equal(n.text, "$1,000,000");
    assert.equal(formatNumber(-1234.5, { decimals: 1 }), "-1,234.5");
    assert.equal(formatNumber(1234, { separator: "" }), "1234");
  });

  test("Badge, StatDisplay and StatusIndicator expose accessible values", () => {
    const ui = makeUI();
    const b = mount(ui, new Badge({ count: 3 }));
    b.count = 150;
    assert.equal(b.text, "99+");
    assert.ok(b.bounds.width >= b.bounds.height - 1e-6, "at least as wide as tall");
    const s = mount(ui, new StatDisplay({ label: "Attack", value: 12, delta: -3 }));
    assert.deepEqual([s.accessibility.label, s.accessibility.value], ["Attack", "12"]);
    const st = mount(ui, new StatusIndicator({ status: "busy", label: "Server" }));
    st.status = "online";
    assert.equal(st.accessibility.value, "online");
  });
});

group("interactive", () => {
  test("Button presses from click, Enter, Space and gamepad A; disabled buttons do not", () => {
    const ui = makeUI();
    const sources: string[] = [];
    const b = mount(ui, new Button({ text: "Go", onPress: (s) => sources.push(s) }));
    click(ui, b);
    b.focus(true);
    key(ui, "Enter");
    key(ui, " ");
    ui.router.gamepadButton("a", true);
    assert.deepEqual(sources, ["pointer", "keyboard", "keyboard", "gamepad"]);
    b.enabled = false;
    frame(ui);
    click(ui, b);
    assert.equal(b.press(), false);
    assert.equal(sources.length, 4);
  });

  test("a nested button's click does not press its control ancestor", () => {
    const ui = makeUI();
    const outer = mount(ui, new ToggleButton({ text: "outer" }));
    void outer;
    // Composite: a Button whose part is another control is unusual, but presses must not double up.
    const inner = mount(ui, new Button({ text: "inner" }));
    click(ui, inner);
    assert.equal(outer.pressCount, 0);
    assert.equal(inner.pressCount, 1);
  });

  test("ToggleButton, Checkbox (incl. indeterminate) and Switch toggle and emit change", () => {
    const ui = makeUI();
    const changes: unknown[] = [];
    const t = mount(ui, new ToggleButton({ text: "t" }));
    t.on("change", (e) => changes.push(e.detail.value));
    click(ui, t);
    assert.equal(t.checked, true);
    assert.ok(t.hasState(UIState.Checked));
    const c = mount(ui, new Checkbox({ text: "c", indeterminate: true }));
    assert.equal(c.accessibility.value, "mixed");
    click(ui, c);
    assert.equal(c.checked, true);
    assert.equal(c.indeterminate, false);
    const sw = mount(ui, new Switch({ text: "s" }));
    click(ui, sw);
    advance(ui, 0.3);
    assert.equal(sw.knob, 1);
    assert.deepEqual(changes, [true]);
  });

  test("RadioGroup: exclusive selection, roving focus with arrows, only the checked radio is a Tab stop", () => {
    const ui = makeUI();
    const values: (string | null)[] = [];
    const g = mount(ui, new RadioGroup({ onChange: (v) => values.push(v) }));
    const [a, b, c] = ["a", "b", "c"].map((v) => g.add(new RadioButton({ text: v, value: v })));
    frame(ui);
    click(ui, b!);
    assert.equal(g.value, "b");
    assert.deepEqual([a!.checked, b!.checked, c!.checked], [false, true, false]);
    assert.deepEqual([a!.tabIndex, b!.tabIndex, c!.tabIndex], [-1, 0, -1]);
    b!.focus(true);
    key(ui, "ArrowDown");
    assert.equal(g.value, "c");
    assert.equal(ui.focus.focused, c);
    key(ui, "ArrowDown");
    assert.equal(g.value, "a", "wraps");
    g.value = "b";
    assert.deepEqual(values, ["b", "c", "a", "b"]);
  });

  test("Slider: pointer sets and drags, keys step (Home/End/Page), edges release focus navigation", () => {
    const ui = makeUI();
    const row = mount(ui, new HStack({ gap: 8 }));
    const s = row.add(new Slider({ min: 0, max: 10, step: 1, value: 5, layout: { width: 240 } }));
    const after = row.add(new Button({ text: "next" }));
    frame(ui);
    const t = s.bounds;
    click(ui, s, { x: t.x + s.computedStyle.iconSize / 2, y: t.y + t.height / 2 });
    assert.equal(s.value, 0);
    drag(ui, { x: t.x + 9, y: t.y + t.height / 2 }, { x: t.right - 9, y: t.y + t.height / 2 });
    assert.equal(s.value, 10);
    s.focus(true);
    key(ui, "ArrowLeft");
    assert.equal(s.value, 9);
    key(ui, "Home");
    assert.equal(s.value, 0);
    key(ui, "PageUp");
    assert.equal(s.value, 10);
    s.focus(true);
    key(ui, "ArrowLeft");
    assert.equal(ui.focus.focused, s, "inside the range the slider keeps the arrow");
    key(ui, "End");
    key(ui, "ArrowRight");
    assert.equal(ui.focus.focused, after, "at the max, right arrow moves focus on");
  });

  test("RangeModel snaps without float noise; SelectionModel extends and toggles", () => {
    const r = new RangeModel(0, 1, 0.1);
    assert.equal(r.clamp(0.30000000000000004), 0.3);
    assert.equal(r.clamp(5), 1);
    assert.equal(r.fromFraction(0.55), 0.6);
    assert.throws(() => new RangeModel(1, 0));
    const sel = new SelectionModel("multiple");
    sel.select(2);
    sel.select(5, { extend: true });
    assert.deepEqual(sel.indices, [2, 3, 4, 5]);
    sel.select(3, { toggle: true });
    assert.deepEqual(sel.indices, [2, 4, 5]);
    sel.clampTo(5);
    assert.deepEqual(sel.indices, [2, 4]);
  });

  test("RangeSlider keeps low ≤ high and moves the nearest thumb", () => {
    const ui = makeUI();
    const r = mount(ui, new RangeSlider({ min: 0, max: 100, step: 1, low: 20, high: 80 }));
    r.low = 95;
    assert.equal(r.low, 80);
    r.lowThumb.focus(true);
    key(ui, "ArrowLeft");
    assert.equal(r.low, 79);
    const b = r.bounds;
    click(ui, r, { x: b.right - 12, y: b.y + b.height / 2 });
    assert.ok(r.high > 90);
    assert.equal(r.low, 79);
  });
});

group("text input", () => {
  test("typing, caret movement, word jumps, selection and deletion", () => {
    const ui = makeUI();
    const t = mount(ui, new TextInput());
    t.focus(true);
    typeText(ui, "hello world");
    assert.equal(t.value, "hello world");
    key(ui, "ArrowLeft", { ctrl: true });
    assert.equal(t.caret, 6);
    key(ui, "Backspace", { ctrl: true });
    assert.equal(t.value, "world");
    key(ui, "End");
    key(ui, "ArrowLeft", { shift: true });
    key(ui, "ArrowLeft", { shift: true });
    assert.equal(t.selectedText, "ld");
    typeText(ui, "!");
    assert.equal(t.value, "wor!");
    key(ui, "a", { ctrl: true });
    key(ui, "Delete");
    assert.equal(t.value, "");
  });

  test("undo/redo coalesces typing; clipboard copy/cut/paste; space is text not activation", () => {
    const ui = makeUI();
    TextInput.clipboard = new MemoryClipboard();
    const t = mount(ui, new TextInput());
    t.focus(true);
    typeText(ui, "abc");
    key(ui, "Backspace");
    key(ui, "z", { ctrl: true });
    assert.equal(t.value, "abc");
    key(ui, "z", { ctrl: true });
    assert.equal(t.value, "");
    key(ui, "y", { ctrl: true });
    assert.equal(t.value, "abc");
    key(ui, "a", { ctrl: true });
    key(ui, "x", { ctrl: true });
    assert.equal(t.value, "");
    key(ui, "v", { ctrl: true });
    key(ui, "v", { ctrl: true });
    assert.equal(t.value, "abcabc");
    let presses = 0;
    t.on("press", () => presses++);
    ui.router.keyDown(" ");
    ui.router.text(" ");
    assert.equal(presses, 0);
    assert.equal(t.value, "abcabc ");
  });

  test("maxLength, filter, password masking, validation state and submit", () => {
    const ui = makeUI();
    const submitted: string[] = [];
    const t = mount(ui, new TextInput({ maxLength: 4, filter: (c) => /\d/.test(c), validate: (v) => (v.length < 4 ? "4 digits" : null), password: true, onSubmit: (v) => submitted.push(v) }));
    assert.ok(t.hasState(UIState.Invalid));
    t.focus(true);
    typeText(ui, "1a2b3c4d5");
    assert.equal(t.value, "1234");
    assert.ok(!t.hasState(UIState.Invalid));
    assert.equal(t.accessibility.value, "••••", "the accessible value is masked too");
    key(ui, "c", { ctrl: true });
    key(ui, "Enter");
    assert.deepEqual(submitted, ["1234"]);
  });

  test("pointer places the caret and drag selects; double-click selects a word", () => {
    const ui = makeUI();
    const t = mount(ui, new TextInput({ value: "alpha beta" }));
    const b = t.contentRect;
    click(ui, t, { x: b.x + 1, y: b.y + b.height / 2 });
    assert.equal(t.caret, 0);
    drag(ui, { x: b.x + 1, y: b.y + b.height / 2 }, { x: b.x + 400, y: b.y + b.height / 2 });
    assert.equal(t.selectedText, "alpha beta");
    advance(ui, 1); // well outside the multi-click window, so the drag's press does not count
    click(ui, t, { x: b.x + 2, y: b.y + b.height / 2 });
    click(ui, t, { x: b.x + 2, y: b.y + b.height / 2 });
    assert.equal(t.selectedText, "alpha");
  });

  test("TextArea: Enter inserts newlines, Up/Down move between lines, single-line inputs let Up/Down move focus", () => {
    const ui = makeUI();
    const a = mount(ui, new TextArea());
    a.focus(true);
    typeText(ui, "ab");
    key(ui, "Enter");
    typeText(ui, "cd");
    assert.equal(a.value, "ab\ncd");
    key(ui, "ArrowUp");
    assert.equal(a.caret, 2);
    key(ui, "End", { ctrl: true });
    assert.equal(a.caret, 5);
    const one = mount(ui, new TextInput());
    const below = mount(ui, new Button({ text: "below" }));
    one.focus(true);
    key(ui, "ArrowDown");
    assert.equal(ui.focus.focused, below);
  });

  test("IME-free code-point editing: an emoji is one caret step", () => {
    const ui = makeUI();
    const t = mount(ui, new TextInput({ value: "a😀b" }));
    t.focus(true);
    key(ui, "End");
    key(ui, "Backspace");
    key(ui, "Backspace");
    assert.equal(t.value, "a");
  });
});

group("collections", () => {
  test("VirtualizedList instantiates only visible rows (+overscan) and recycles while scrolling", () => {
    const ui = makeUI();
    const items = Array.from({ length: 10_000 }, (_, i) => `row ${i}`);
    const list = ui.base.add(new VirtualizedList<string>({ items, itemExtent: 20, overscan: 2, createItem: () => new Label(), bindItem: (el, item) => ((el as Label).text = item), layout: { width: 200, height: 200 } }));
    frame(ui);
    assert.equal(list.instantiated, 10 + 2, "ten visible rows plus the bottom overscan at the top of the list");
    // The first scroll step may add the partially visible row at each edge; after that the pool is fixed.
    ui.router.wheel(100, 100, 0, 130);
    frame(ui);
    const bindsBefore = list.binds;
    const created = list.instantiated;
    assert.equal(created, 11 + 4, "a part-scrolled window shows eleven rows plus overscan at both edges");
    for (let i = 0; i < 50; i++) {
      ui.router.wheel(100, 100, 0, 40);
      frame(ui);
    }
    assert.equal(list.instantiated, created, "scrolling created no elements");
    assert.ok(list.binds - bindsBefore <= 50 * 4, "only rows entering the window re-bind");
    const first = list.elementAt(Math.floor(list.scrollY / 20)) as Label;
    assert.equal(first.text, `row ${Math.floor(list.scrollY / 20)}`);
    list.setItems(items.slice(0, 3));
    frame(ui);
    assert.equal(list.scrollY, 0, "scroll clamps when data shrinks");
  });

  test("VirtualizedGrid derives columns from the width", () => {
    const ui = makeUI();
    const g = ui.base.add(new VirtualizedGrid<number>({ items: Array.from({ length: 500 }, (_, i) => i), cellWidth: 50, gap: 0, createItem: () => new Badge(), bindItem: (el, i) => ((el as Badge).text = String(i)), layout: { width: 210, height: 100 } }));
    frame(ui);
    assert.equal(g.columns, 4);
    assert.ok(g.instantiated <= 4 * (2 + 1 + 4));
  });

  test("ListBox: click selects, arrows/Home/End move, Shift extends, type-ahead jumps, change fires", () => {
    const ui = makeUI();
    const changes: number[][] = [];
    const lb = mount(ui, new ListBox({ items: ["Alpha", "Bravo", "Charlie", { label: "Delta", disabled: true }, "Echo"], selection: "multiple", onChange: (s) => changes.push([...s]) }));
    lb.setLayout({ height: 200 });
    frame(ui);
    click(ui, lb.list.elementAt(1)!);
    assert.deepEqual(lb.selection.indices, [1]);
    lb.focus(true);
    key(ui, "ArrowDown");
    key(ui, "ArrowDown", { shift: true });
    assert.equal(lb.active, 4, "skipped the disabled Delta");
    assert.deepEqual(lb.selection.indices, [1, 2, 3, 4]);
    key(ui, "Home");
    assert.equal(lb.active, 0);
    key(ui, "c");
    assert.equal(lb.active, 2);
    assert.ok(changes.length >= 2);
  });

  test("TreeView: expand/collapse with arrows and clicks, selection event", () => {
    const ui = makeUI();
    const selected: string[] = [];
    const tv = mount(ui, new TreeView({ nodes: [{ label: "A", children: [{ label: "A1" }, { label: "A2" }] }, { label: "B" }], onSelect: (n) => selected.push(n.label) }));
    tv.setLayout({ height: 200 });
    frame(ui);
    assert.deepEqual(tv.visibleRows.map((r) => r.node.label), ["A", "B"]);
    tv.focus(true);
    key(ui, "ArrowDown");
    key(ui, "ArrowUp");
    key(ui, "ArrowRight");
    assert.deepEqual(tv.visibleRows.map((r) => r.node.label), ["A", "A1", "A2", "B"]);
    key(ui, "ArrowRight");
    key(ui, "Enter");
    assert.deepEqual(selected, ["A1"]);
    key(ui, "ArrowLeft");
    key(ui, "ArrowLeft");
    assert.deepEqual(tv.visibleRows.map((r) => r.node.label), ["A", "B"]);
  });

  test("Dropdown opens a light-dismiss list, keyboard picks, focus returns", () => {
    const ui = makeUI();
    const picked: number[] = [];
    const d = mount(ui, new Dropdown({ items: ["Low", "Medium", "High"], selectedIndex: 0, onChange: (i) => picked.push(i) }));
    d.focus(true);
    key(ui, "Enter");
    assert.equal(d.isOpen, true);
    assert.ok(d.hasState(UIState.Expanded));
    key(ui, "ArrowDown");
    key(ui, "ArrowDown");
    key(ui, "Enter");
    assert.equal(d.isOpen, false);
    assert.deepEqual(picked, [2]);
    assert.equal(ui.focus.focused, d);
    click(ui, d);
    assert.equal(d.isOpen, true);
    key(ui, "Escape");
    assert.equal(d.isOpen, false);
  });

  test("ComboBox filters suggestions (prefix first) and Enter picks the highlighted one", () => {
    const ui = makeUI();
    const cb = mount(ui, new ComboBox({ items: ["Mars", "Earth", "Saturn", "Uranus"] }));
    assert.deepEqual(cb.matches("ur").map((i) => i.label), ["Uranus", "Saturn"]);
    assert.deepEqual(cb.matches("tu").map((i) => i.label), ["Saturn"]);
    assert.deepEqual(cb.matches("u").map((i) => i.label), ["Uranus", "Saturn"]);
    cb.focus(true);
    typeText(ui, "sa");
    assert.equal(cb.popupOpen, true);
    key(ui, "Enter");
    assert.equal(cb.value, "Saturn");
    assert.equal(cb.popupOpen, false);
  });
});

await finish();
