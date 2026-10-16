/**
 * @suite ui:uiWidgetsGame
 * @group unit
 * @covers engine/src/ui/widgets/overlays.ts
 * @covers engine/src/ui/widgets/navigation.ts
 * @covers engine/src/ui/widgets/game.ts
 * @covers engine/src/ui/worldSpace.ts
 * @desc Overlay, navigation and game widgets through real input: popups (placement, flip, light dismiss), modal dialogs (focus trap, Escape, focus return), context menus with submenus, toasts, drawers, tabs, menu bar, command palette, health/resource bars, cooldown abilities, inventory drag-and-drop with tooltips, objectives, minimap and world-space labels
 */

export const suite = {
  name: "ui:uiWidgetsGame",
  group: "unit",
  covers: ["engine/src/ui/widgets/overlays.ts", "engine/src/ui/widgets/navigation.ts", "engine/src/ui/widgets/game.ts", "engine/src/ui/worldSpace.ts"],
  desc: "Overlay, navigation and game widgets through real input: popups (placement, flip, light dismiss), modal dialogs (focus trap, Escape, focus return), context menus with submenus, toasts, drawers, tabs, menu bar, command palette, health/resource bars, cooldown abilities, inventory drag-and-drop with tooltips, objectives, minimap and world-space labels",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AbilityButton,
  Breadcrumbs,
  Button,
  CommandPalette,
  ConfirmationDialog,
  ContextMenu,
  Drawer,
  EquipmentSlot,
  HealthBar,
  HStack,
  InventorySlot,
  Label,
  Mat4,
  MenuBar,
  MinimapContainer,
  ModalDialog,
  NavigationBar,
  ObjectiveTracker,
  Popup,
  QuestTracker,
  ResourceCounter,
  TabContainer,
  TargetHealthDisplay,
  Toasts,
  UIState,
  VStack,
  WorldSpaceLabel,
  distanceFade,
  fuzzyScore,
  projectToViewport,
  type InventoryItem,
  type UICustomEvent,
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

const SWORD: InventoryItem = { id: "sword", name: "Sword", icon: "star", type: "weapon", rarity: "rare", stats: { damage: 12 } };
const POTION: InventoryItem = { id: "potion", name: "Potion", icon: "heart", type: "consumable", count: 3 };

group("popups and dialogs", () => {
  test("Popup sits below its owner, flips above near the bottom edge and light-dismisses", () => {
    const ui = makeUI();
    const owner = mount(ui, new Button({ text: "open" }));
    const pop = new Popup();
    pop.add(new Label({ text: "content" }));
    pop.openAt(ui, owner);
    frame(ui);
    assert.ok(pop.isOpen);
    assert.ok(Math.abs(pop.bounds.y - (owner.bounds.bottom + pop.offset)) < 1e-6, "below the owner");
    assert.equal(pop.bounds.x, owner.bounds.x);
    // An owner near the bottom edge flips the popup above it.
    const low = ui.base.add(new Button({ text: "low", layout: { position: "absolute", anchor: { left: 20, bottom: 4 } } }));
    frame(ui);
    pop.openAt(ui, low);
    frame(ui);
    assert.ok(pop.bounds.bottom <= low.bounds.y, "flipped above");
    assert.ok(pop.bounds.y >= 0);
    // Pressing on the popup keeps it; pressing elsewhere closes it.
    click(ui, pop);
    assert.ok(pop.isOpen);
    click(ui, owner, { x: 900, y: 300 });
    assert.ok(!pop.isOpen, "light dismiss");
  });

  test("Popup opened at a point is clamped inside the viewport", () => {
    const ui = makeUI();
    const pop = new Popup({ layout: { width: 200, height: 100 } });
    pop.openAtPoint(ui, 1250, 700);
    frame(ui);
    assert.ok(pop.bounds.right <= 1280 && pop.bounds.bottom <= 720);
    assert.equal(pop.bounds.width, 200);
  });

  test("ModalDialog traps focus, blocks the page below, closes on Escape and returns focus", () => {
    const ui = makeUI();
    const opener = mount(ui, new Button({ text: "opener" }));
    const outside = mount(ui, new Button({ text: "outside" }));
    let outsidePresses = 0;
    outside.on("press", () => outsidePresses++);
    opener.focus(true);
    const dlg = new ModalDialog({ title: "Settings" });
    const a = dlg.add(new Button({ text: "a" }));
    const b = dlg.addAction("b", () => {});
    dlg.open(ui, a);
    frame(ui);
    assert.equal(ui.topModal, dlg);
    assert.equal(ui.focus.focused, a);
    key(ui, "Tab");
    assert.equal(ui.focus.focused, b);
    key(ui, "Tab");
    assert.equal(ui.focus.focused, a, "Tab wraps inside the dialog");
    key(ui, "Tab", { shift: true });
    assert.equal(ui.focus.focused, b);
    click(ui, outside);
    assert.equal(outsidePresses, 0, "input below the modal is blocked");
    assert.ok(dlg.attached);
    key(ui, "Escape");
    assert.ok(!ui.isOpen(dlg));
    assert.equal(ui.topModal, null);
    assert.equal(ui.focus.focused, opener, "focus returned to the opener");
  });

  test("a non-dismissable dialog ignores Escape", () => {
    const ui = makeUI();
    const dlg = new ModalDialog({ title: "Required", dismissable: false });
    const ok = dlg.addAction("OK", () => dlg.close("ok"));
    dlg.open(ui, ok);
    frame(ui);
    key(ui, "Escape");
    assert.ok(ui.isOpen(dlg));
    key(ui, "Enter");
    assert.ok(!ui.isOpen(dlg));
    assert.equal(dlg.result, "ok");
  });

  test("ConfirmationDialog.ask resolves with the choice; focus starts on Cancel", async () => {
    const ui = makeUI();
    const dlg = new ConfirmationDialog({ title: "Quit?", message: "Unsaved progress will be lost.", danger: true });
    const first = dlg.ask(ui);
    frame(ui);
    assert.equal(ui.focus.focused, dlg.cancelButton, "the safe choice has focus");
    assert.equal(dlg.confirmButton.variant, "danger");
    click(ui, dlg.confirmButton);
    assert.equal(await first, true);
    const second = dlg.ask(ui);
    frame(ui);
    key(ui, "Escape");
    assert.equal(await second, false);
  });

  test("opening a modal closes light-dismiss popups owned outside it", () => {
    const ui = makeUI();
    const owner = mount(ui, new Button({ text: "menu" }));
    const pop = new Popup();
    pop.add(new Label({ text: "x" }));
    pop.openAt(ui, owner);
    frame(ui);
    const dlg = new ModalDialog({ title: "t" });
    dlg.addAction("ok", () => dlg.close());
    dlg.open(ui);
    frame(ui);
    assert.ok(!pop.isOpen);
  });
});

group("menus", () => {
  test("ContextMenu: arrows wrap and skip disabled, Right opens a submenu, Left closes it, Enter selects and closes all", () => {
    const ui = makeUI();
    const owner = mount(ui, new Button({ text: "owner" }));
    const picked: string[] = [];
    const menu = new ContextMenu({
      items: [
        { label: "Cut", shortcut: "Ctrl+X", onSelect: () => picked.push("cut") },
        { label: "Copy", disabled: true },
        { separator: true },
        { label: "Share", items: [{ label: "Mail", onSelect: () => picked.push("mail") }, { label: "Link" }] },
      ],
    });
    menu.openAt(ui, owner);
    menu.focusFirst();
    frame(ui);
    const [cut, copy, share] = menu.menuItems;
    assert.equal(ui.focus.focused, cut);
    assert.ok(!copy!.canFocus);
    key(ui, "ArrowDown");
    assert.equal(ui.focus.focused, share, "skipped the disabled item and the separator");
    key(ui, "ArrowDown");
    assert.equal(ui.focus.focused, cut, "wraps");
    key(ui, "ArrowUp");
    key(ui, "ArrowRight");
    const focused = ui.focus.focused as UIElement;
    assert.ok(focused !== share && (focused.accessibility.label === "Mail"), "submenu opened with its first item focused");
    assert.ok(focused.bounds.x >= share!.bounds.right, "submenu placed to the right");
    key(ui, "ArrowLeft");
    assert.equal(ui.focus.focused, share, "Left closes the submenu and returns to its item");
    key(ui, "ArrowRight");
    key(ui, "Enter");
    assert.deepEqual(picked, ["mail"]);
    assert.ok(!menu.isOpen, "selecting in a submenu closes the whole chain");
    assert.equal(ui.focus.focused, owner, "focus returns to the owner");
  });

  test("ContextMenu: hovering an item with children opens its submenu, clicking a leaf selects", () => {
    const ui = makeUI();
    const selected: string[] = [];
    const menu = new ContextMenu({ items: [{ label: "New", items: [{ label: "File" }] }, { label: "Open" }] });
    menu.onSelect = (d) => selected.push(d.label ?? "");
    menu.openAtPoint(ui, 100, 100);
    frame(ui);
    const [newItem, open] = menu.menuItems;
    ui.router.pointerMove(center(newItem!).x, center(newItem!).y, 1, "mouse");
    frame(ui);
    assert.equal(ui.openOverlayElements.filter((e) => e instanceof ContextMenu).length, 2, "submenu open on hover");
    click(ui, open!);
    assert.deepEqual(selected, ["Open"]);
    assert.equal(ui.openOverlayElements.filter((e) => e instanceof ContextMenu).length, 0);
  });

  test("MenuBar: click opens, hovering another title switches, arrows move between menus, Escape closes", () => {
    const ui = makeUI();
    const bar = mount(ui, new MenuBar({ menus: [{ label: "File", items: [{ label: "New" }, { label: "Quit" }] }, { label: "Edit", items: [{ label: "Undo" }] }] }));
    const [file, edit] = bar.children as UIElement[];
    click(ui, file!);
    assert.equal(bar.openMenuIndex, 0);
    ui.router.pointerMove(center(edit!).x, center(edit!).y, 1, "mouse");
    frame(ui);
    assert.equal(bar.openMenuIndex, 1, "hover switches while a menu is open");
    bar.openMenu(0, "keyboard");
    frame(ui);
    assert.equal((ui.focus.focused as UIElement).accessibility.label, "New");
    key(ui, "ArrowRight");
    assert.equal(bar.openMenuIndex, 1);
    assert.equal((ui.focus.focused as UIElement).accessibility.label, "Undo");
    key(ui, "Escape");
    assert.equal(bar.openMenuIndex, -1);
    assert.ok(!edit!.hasState(UIState.Expanded));
  });

  test("CommandPalette: fuzzy ranking, arrows pick, Enter runs and closes", () => {
    assert.ok(fuzzyScore("os", "Open Settings") > fuzzyScore("os", "Close"), "word starts beat scattered hits");
    assert.equal(fuzzyScore("zz", "Open"), -1);
    const ui = makeUI();
    const ran: string[] = [];
    const pal = new CommandPalette({
      commands: [
        { id: "open", label: "Open Settings", run: () => ran.push("open") },
        { id: "close", label: "Close Window", run: () => ran.push("close") },
        { id: "save", label: "Save Game", shortcut: "Ctrl+S", run: () => ran.push("save") },
      ],
    });
    pal.show(ui);
    frame(ui);
    assert.equal(ui.focus.focused, pal.input);
    assert.equal(pal.matches.length, 3);
    typeText(ui, "sg");
    assert.deepEqual(pal.matches.map((c) => c.id), ["save", "open"], "word-start hits rank first");
    key(ui, "Backspace");
    key(ui, "Backspace");
    typeText(ui, "o");
    key(ui, "ArrowDown");
    key(ui, "Enter");
    assert.equal(ran.length, 1);
    assert.equal(ran[0], pal.matches[1]!.id);
    assert.ok(!ui.isOpen(pal));
  });
});

group("toasts and drawers", () => {
  test("Toasts stack in the corner, expire after their duration (not while hovered) and cap the count", () => {
    const ui = makeUI({ reducedMotion: true });
    const toasts = new Toasts(ui, "bottom-right");
    const a = toasts.show("Saved", "success", { duration: 1 });
    const b = toasts.show("Second", "info", { duration: 0 });
    frame(ui);
    assert.equal(toasts.count, 2);
    assert.ok(a.bounds.right <= 1280 - 16 + 1e-6 && b.bounds.bottom <= 720 - 16 + 1e-6, "anchored to the corner");
    assert.ok(b.bounds.y > a.bounds.y, "newest at the bottom");
    ui.router.pointerMove(center(a).x, center(a).y, 1, "mouse");
    advance(ui, 1.5);
    assert.ok(!a.disposed, "hover holds the toast");
    ui.router.pointerMove(5, 5, 1, "mouse");
    advance(ui, 1.1);
    assert.ok(a.disposed);
    assert.equal(toasts.count, 1);
    for (let i = 0; i < 6; i++) toasts.show(`n${i}`, "warning", { duration: 0 });
    frame(ui);
    assert.equal(toasts.count, toasts.maxVisible);
    const err = toasts.show("Boom", "error");
    assert.equal(err.accessibility.role, "alert");
  });

  test("Drawer slides in from its side as a modal and Escape slides it out", () => {
    const ui = makeUI();
    const d = new Drawer({ side: "right", title: "Menu" });
    const item = d.add(new Button({ text: "Item" }));
    d.open(ui);
    frame(ui);
    assert.equal(ui.topModal, d);
    assert.ok(d.translateX > 0, "starts off to the right");
    advance(ui, 0.4);
    assert.equal(d.translateX, 0);
    assert.ok(Math.abs(d.bounds.right - 1280) < 1e-6, "docked to the right edge");
    item.focus(true);
    key(ui, "Escape");
    assert.ok(!ui.isOpen(d));
  });
});

group("navigation", () => {
  test("TabContainer: click and arrows switch tabs, only the selected tab is a Tab stop, page keys cycle", () => {
    const ui = makeUI();
    const changes: number[] = [];
    const tabs = mount(ui, new TabContainer({ onChange: (i) => changes.push(i) }));
    const pages = ["Video", "Audio", "Controls"].map((t) => {
      const page = new Label({ text: `${t} page` });
      tabs.addTab(t, page);
      return page;
    });
    frame(ui);
    assert.equal(tabs.selectedIndex, 0);
    assert.deepEqual(pages.map((p) => p.visible), [true, false, false]);
    const buttons = tabs.strip.children as UIElement[];
    click(ui, buttons[2]!);
    assert.equal(tabs.selectedIndex, 2);
    assert.ok(buttons[2]!.hasState(UIState.Selected));
    assert.deepEqual(pages.map((p) => p.visible), [false, false, true]);
    assert.deepEqual(buttons.map((b) => b.tabIndex), [-1, -1, 0]);
    buttons[2]!.focus(true);
    key(ui, "ArrowRight");
    assert.equal(tabs.selectedIndex, 0, "wraps");
    assert.equal(ui.focus.focused, buttons[0]);
    ui.router.gamepadButton("rb", true);
    ui.router.gamepadButton("rb", false);
    frame(ui);
    assert.equal(tabs.selectedIndex, 1, "shoulder buttons page through tabs");
    assert.deepEqual(changes, [0, 2, 0, 1], "the first tab added is selected (and reported)");
  });

  test("NavigationBar collapses to a menu button at compact widths and navigates through its drawer", () => {
    const ui = makeUI();
    const nav: string[] = [];
    const bar = mount(ui, new NavigationBar({ items: [{ id: "home", label: "Home" }, { id: "store", label: "Store" }], current: "home", onNavigate: (id) => nav.push(id), collapseAt: ["compact"] }));
    assert.ok(!bar.collapsed);
    assert.ok(bar.row.visible && !bar.menuButton.visible);
    const store = bar.row.children.find((c) => c.accessibility.label === "Store") as UIElement;
    click(ui, store);
    assert.deepEqual(nav, ["store"]);
    assert.equal(bar.current, "store");
    ui.setViewport(400, 800);
    frame(ui);
    assert.equal(ui.breakpoint, "compact");
    assert.ok(bar.collapsed && bar.menuButton.visible && !bar.row.visible);
    click(ui, bar.menuButton);
    advance(ui, 0.4);
    const drawer = ui.topModal as UIElement;
    assert.ok(drawer instanceof Drawer);
    const home = (drawer as Drawer).children.find((c) => c.accessibility.label === "Home") as UIElement;
    click(ui, home);
    advance(ui, 0.4);
    assert.deepEqual(nav, ["store", "home"]);
    assert.equal(ui.topModal, null, "choosing closes the drawer");
  });

  test("Breadcrumbs navigate to earlier segments and mark the last as current", () => {
    const ui = makeUI();
    const went: string[] = [];
    const bc = mount(ui, new Breadcrumbs({ path: [{ label: "Root", id: "r" }, { label: "Maps", id: "m" }, { label: "Mars", id: "mars" }], onNavigate: (id) => went.push(id) }));
    const crumbs = bc.children.filter((c) => c instanceof Button) as Button[];
    assert.equal(crumbs.length, 3);
    assert.equal(crumbs[2]!.accessibility.value, "current");
    click(ui, crumbs[1]!);
    assert.deepEqual(went, ["m"]);
  });
});

group("game HUD", () => {
  test("HealthBar: damage leaves a trailing value that catches up after the delay; low health raises alert", () => {
    const ui = makeUI();
    const hp = mount(ui, new HealthBar({ value: 100, max: 100, trailDelay: 0.2 }));
    hp.value = 60;
    frame(ui);
    assert.equal(hp.trailValue, 100, "trail holds the pre-damage value");
    advance(ui, 0.15);
    assert.equal(hp.trailValue, 100, "still inside the delay");
    advance(ui, 0.8);
    assert.ok(Math.abs(hp.trailValue - 60) < 1e-6);
    hp.value = 20;
    assert.ok(hp.hasState(UIState.Alert), "≤25% is low");
    hp.value = 90;
    assert.equal(hp.trailValue, 90, "healing snaps the trail");
    assert.ok(!hp.hasState(UIState.Alert));
    assert.equal(hp.accessibility.label, "Health");
  });

  test("ResourceCounter counts up smoothly and floats a +N gain that expires", () => {
    const ui = makeUI();
    const c = mount(ui, new ResourceCounter({ value: 100 }));
    c.value = 150;
    frame(ui);
    assert.equal(c.floatingGains, 1);
    assert.equal(c.accessibility.value, "150");
    advance(ui, 1.5);
    assert.equal(c.floatingGains, 0);
    const reduced = makeUI({ reducedMotion: true });
    const r = mount(reduced, new ResourceCounter({ value: 1 }));
    r.value = 2;
    frame(reduced);
    assert.equal(r.floatingGains, 0, "reduced motion: no floating text");
  });

  test("AbilityButton: use starts the cooldown, presses are refused until ready, cost gates it", () => {
    const ui = makeUI();
    const used: string[] = [];
    const refused: string[] = [];
    const ab = mount(ui, new AbilityButton({ icon: "star", hotkey: "Q", cooldown: 1, cost: 20, onUse: (s) => used.push(s) }));
    ab.on("refused", (e) => refused.push((e as UICustomEvent<{ reason: string }>).detail.reason));
    let readyEvents = 0;
    ab.on("ready", () => readyEvents++);
    click(ui, ab);
    assert.deepEqual(used, ["pointer"]);
    assert.ok(ab.cooldown.active && ab.hasState(UIState.Loading));
    click(ui, ab);
    assert.deepEqual(refused, ["cooldown"]);
    advance(ui, 0.5);
    assert.ok(Math.abs(ab.cooldown.progress - 0.5) < 0.05);
    advance(ui, 0.6);
    assert.ok(ab.ready);
    assert.equal(readyEvents, 1);
    assert.ok(ab.cooldown.hasState(UIState.Alert), "ready flash");
    ab.affordable = false;
    assert.equal(ab.press(), false);
    assert.deepEqual(refused, ["cooldown", "cost"]);
    assert.equal(used.length, 1);
  });

  test("Inventory: drag swaps items, equipment slots reject the wrong type with feedback", () => {
    const ui = makeUI();
    const row = mount(ui, new HStack({ gap: 8 }));
    const a = row.add(new InventorySlot({ item: SWORD }));
    const b = row.add(new InventorySlot({ item: POTION }));
    const weapon = row.add(new EquipmentSlot({ slotType: "weapon" }));
    frame(ui);
    const drops: number[] = [];
    b.on("itemdrop", () => drops.push(1));
    drag(ui, center(a), center(b));
    assert.equal(a.item, POTION);
    assert.equal(b.item, SWORD);
    assert.deepEqual(drops, [1]);
    // Potion onto the weapon slot: rejected while hovering, nothing moves on drop.
    ui.router.pointerMove(center(a).x, center(a).y, 1, "mouse");
    ui.router.pointerDown(center(a).x, center(a).y, 1, "mouse", 0);
    for (let i = 1; i <= 6; i++) ui.router.pointerMove(center(a).x + ((center(weapon).x - center(a).x) * i) / 6, center(a).y, 1, "mouse");
    frame(ui);
    assert.equal(weapon.dropState, "reject");
    assert.ok(weapon.hasState(UIState.Invalid));
    ui.router.pointerUp(center(weapon).x, center(weapon).y, 1, "mouse", 0);
    frame(ui);
    assert.equal(weapon.item, null);
    assert.equal(a.item, POTION);
    assert.equal(weapon.dropState, "none");
    drag(ui, center(b), center(weapon));
    assert.equal(weapon.item, SWORD, "the sword fits");
    assert.equal(b.item, null);
    assert.equal(b.accessibility.label, "Empty slot");
  });

  test("Inventory tooltips appear after the hover delay, on keyboard focus, and go away on leave", () => {
    const ui = makeUI();
    const slot = mount(ui, new InventorySlot({ item: SWORD, tooltipDelay: 0.3 }));
    ui.router.pointerMove(center(slot).x, center(slot).y, 1, "mouse");
    advance(ui, 0.1);
    assert.ok(!slot.tooltipVisible);
    advance(ui, 0.3);
    assert.ok(slot.tooltipVisible);
    const tip = ui.layer("tooltip").children[0]!;
    assert.ok(tip.bounds.x >= slot.bounds.right, "beside the slot");
    ui.router.pointerMove(1000, 600, 1, "mouse");
    frame(ui);
    assert.ok(!slot.tooltipVisible);
    assert.equal(ui.layer("tooltip").children.length, 0, "tooltip disposed");
    slot.focus(true);
    frame(ui);
    assert.ok(slot.tooltipVisible, "keyboard focus shows it immediately");
    slot.blur();
    assert.ok(!slot.tooltipVisible);
  });

  test("ObjectiveTracker and QuestTracker report progress and completion", () => {
    const ui = makeUI();
    const tracker = mount(ui, new ObjectiveTracker({ objectives: [{ id: "rocks", text: "Collect rocks", current: 0, target: 3 }, { id: "base", text: "Return to base" }] }));
    const done: string[] = [];
    tracker.on("complete", (e) => done.push((e as UICustomEvent<{ id: string }>).detail.id));
    tracker.progress("rocks", 2);
    assert.ok(!tracker.isComplete("rocks"));
    tracker.progress("rocks", 3);
    assert.ok(tracker.isComplete("rocks"));
    assert.deepEqual(done, ["rocks"]);
    assert.ok(!tracker.allComplete);
    tracker.removeObjective("base");
    assert.ok(tracker.allComplete);
    const quests = mount(ui, new QuestTracker());
    const finished: string[] = [];
    quests.on("questcomplete", (e) => finished.push((e as UICustomEvent<{ id: string }>).detail.id));
    const q = quests.addQuest("q1", "First steps", [{ id: "a", text: "A", done: false }, { id: "b", text: "B", done: false }]);
    q.setObjective({ id: "a", text: "A", done: true });
    assert.deepEqual(finished, []);
    q.setObjective({ id: "b", text: "B", done: true });
    assert.deepEqual(finished, ["q1"]);
    quests.removeQuest("q1");
    assert.equal(quests.quest("q1"), null);
  });

  test("TargetHealthDisplay shows name/level/health and hides the shield bar without shields", () => {
    const ui = makeUI();
    const t = mount(ui, new TargetHealthDisplay({ target: { name: "Rover", level: 3, health: 40, maxHealth: 80 } }));
    assert.equal(t.health.fraction, 0.5);
    assert.ok(!t.shield.visible);
    assert.equal(t.accessibility.value, "40 of 80");
    t.setTarget({ name: "Lander", health: 10, maxHealth: 10, shield: 5, maxShield: 20 });
    assert.ok(t.shield.visible && !t.levelLabel.visible);
    t.setTarget(null);
    assert.ok(!t.visible);
  });

  test("Minimap maps world points into the widget and clamps distant markers to the rim", () => {
    const ui = makeUI();
    const mm = mount(ui, new MinimapContainer({ size: 200, zoom: 0.5, circular: true }));
    mm.setView(0.5, 0.5);
    const c = mm.mapToLocal(0.5, 0.5);
    assert.deepEqual([c.x, c.y, c.clamped], [100, 100, false]);
    const right = mm.mapToLocal(0.6, 0.5);
    assert.ok(Math.abs(right.x - 140) < 1e-9 && !right.clamped);
    const far = mm.mapToLocal(1, 1);
    assert.ok(far.clamped);
    assert.ok(Math.abs(Math.hypot(far.x - 100, far.y - 100) - 94) < 1e-9, "on the rim (radius − 6)");
    mm.setMarkers([{ x: 0.6, y: 0.5 }, { x: 1, y: 1, clampToEdge: false }]);
    const draw = ui.render();
    assert.ok(draw.stats.instances > 0);
  });
});

group("world space", () => {
  test("projectToViewport and WorldSpaceLabel follow a point, hide behind the camera and fade with distance", () => {
    assert.equal(distanceFade(10, 30, 60), 1);
    assert.equal(distanceFade(45, 30, 60), 0.5);
    assert.equal(distanceFade(70, 30, 60), 0);
    const view = new Mat4().setLookAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const proj = new Mat4().setPerspective(Math.PI / 2, 1280 / 720, 0.1, 1000);
    const viewProj = new Mat4().multiplyMatrices(proj, view).m;
    const ahead = projectToViewport({ x: 0, y: 0, z: 10 }, viewProj, 1280, 720);
    assert.ok(ahead.inFront && ahead.onScreen);
    assert.ok(Math.abs(ahead.x - 640) < 1e-3 && Math.abs(ahead.y - 360) < 1e-3, "straight ahead is the centre");
    const up = projectToViewport({ x: 0, y: 5, z: 10 }, viewProj, 1280, 720);
    assert.ok(up.y < 360, "+Y is up on screen");
    assert.ok(!projectToViewport({ x: 0, y: 0, z: -10 }, viewProj, 1280, 720).inFront);

    const ui = makeUI();
    let target = { x: 0, y: 0, z: 10 };
    let occluded = false;
    const camera = { viewProj: viewProj, position: { x: 0, y: 0, z: 0 } };
    const wl = ui.layer("hud").add(new WorldSpaceLabel({ target: () => target, camera: () => camera, occluded: () => occluded, fadeStart: 20, maxDistance: 40 }));
    wl.add(new Label({ text: "Beacon" }));
    frame(ui);
    frame(ui);
    assert.ok(wl.shown);
    assert.ok(Math.abs(wl.translateX + wl.bounds.width / 2 - 640) <= 1, "centred over the point");
    assert.ok(wl.translateY + wl.bounds.height <= 360, "above the point");
    target = { x: 0, y: 0, z: 30 };
    frame(ui);
    assert.ok(wl.shown && Math.abs(wl.opacity - 0.5) < 1e-6, "half faded");
    target = { x: 0, y: 0, z: -5 };
    frame(ui);
    assert.ok(!wl.shown && wl.opacity === 0, "behind the camera");
    target = { x: 0, y: 0, z: 10 };
    occluded = true;
    frame(ui);
    assert.ok(!wl.shown, "occluded");
  });
});

await finish();
