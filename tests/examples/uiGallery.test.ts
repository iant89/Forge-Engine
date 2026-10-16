/**
 * @suite examples:uiGallery
 * @group integration
 * @covers examples/src/ui/uiGallery.ts
 * @desc The UI gallery demo as a user drives it: every page lays out without invalid geometry or overlaps across phone, tablet, laptop, desktop and 4K-at-2x viewports; keyboard-only navigation reaches and activates controls; Quit asks for confirmation; every skin × theme renders without diagnostics; the virtualized data page filters 10,000 rows; inventory drag-and-drop and HUD bindings update the game state
 */

export const suite = {
  name: "examples:uiGallery",
  group: "integration",
  covers: ["examples/src/ui/uiGallery.ts"],
  desc: "The UI gallery demo as a user drives it: every page lays out without invalid geometry or overlaps across phone, tablet, laptop, desktop and 4K-at-2x viewports; keyboard-only navigation reaches and activates controls; Quit asks for confirmation; every skin × theme renders without diagnostics; the virtualized data page filters 10,000 rows; inventory drag-and-drop and HUD bindings update the game state",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { Button, ConfirmationDialog, HealthBar, TextInput, UIManager, type UIElement } from "@forge/engine";
import { buildUIGallery, type UIGalleryHandle } from "../../examples/src/ui/uiGallery.js";
import { advance, center, click, drag, frame, key, type as typeText } from "../support/uiHarness.js";

const VIEWPORTS: { name: string; width: number; height: number; dpr?: number; uiScale?: number; breakpoint: string }[] = [
  { name: "phone portrait", width: 390, height: 844, breakpoint: "compact" },
  { name: "phone landscape", width: 844, height: 390, breakpoint: "medium" },
  { name: "tablet", width: 820, height: 1180, breakpoint: "medium" },
  { name: "laptop", width: 1366, height: 768, breakpoint: "expanded" },
  { name: "desktop", width: 1920, height: 1080, breakpoint: "expanded" },
  { name: "4K at 2x", width: 3840, height: 2160, dpr: 2, breakpoint: "expanded" },
];

function setup(width = 1280, height = 720, dpr = 1): { ui: UIManager; g: UIGalleryHandle; quits: number[] } {
  const ui = new UIManager({ width, height, devicePixelRatio: dpr });
  const quits: number[] = [];
  const g = buildUIGallery(ui, { onQuit: () => quits.push(1) });
  frame(ui);
  frame(ui);
  return { ui, g, quits };
}

function find(root: UIElement, pred: (e: UIElement) => boolean): UIElement | null {
  let hit: UIElement | null = null;
  root.walk((e) => {
    if (!hit && pred(e)) hit = e;
  });
  return hit;
}

function labelled(root: UIElement, label: string): UIElement {
  const el = find(root, (e) => e.visible && e.accessibility.label === label);
  assert.ok(el, `no element labelled "${label}"`);
  return el;
}

group("responsive layout", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height}${vp.dpr ? ` @${vp.dpr}x` : ""}): every page lays out cleanly`, () => {
      const { ui, g } = setup(vp.width, vp.height, vp.dpr ?? 1);
      assert.equal(ui.breakpoint, vp.breakpoint);
      for (const id of Object.keys(g.pages)) {
        g.navigate(id);
        frame(ui);
        frame(ui);
        const issues = ui.diagnostics.validateLayout().filter((i) => i.kind === "invalid-geometry" || i.kind === "overlap");
        assert.deepEqual(issues, [], `${id}: ${JSON.stringify(issues)}`);
        const page = g.pages[id]!;
        assert.ok(page.bounds.width > 0 && page.bounds.height > 0, `${id} has area`);
        assert.ok(page.bounds.right <= ui.viewport.width + 0.5, `${id} fits horizontally`);
      }
      assert.deepEqual(ui.messages.filter((m) => m.level !== "info").map((m) => m.message), [], "no warnings or errors");
      g.dispose();
      ui.dispose();
    });
  }

  test("compact hides the skin/theme pickers and collapses the nav; widening restores them", () => {
    const { ui, g } = setup(1280, 720);
    assert.ok(!g.nav.collapsed);
    ui.setViewport(390, 844);
    frame(ui);
    assert.ok(g.nav.collapsed);
    const pickers = (g.root.children[0]!.children as UIElement[]).filter((c) => c.typeName === "Dropdown");
    assert.equal(pickers.length, 2);
    assert.ok(pickers.every((p) => !p.visible));
    ui.setViewport(1280, 720);
    frame(ui);
    assert.ok(!g.nav.collapsed && pickers.every((p) => p.visible));
  });
});

group("interaction", () => {
  test("keyboard only: Tab reaches the menu, Enter on Play opens the HUD page", () => {
    const { ui, g } = setup();
    const play = labelled(g.pages.menu!, "Play");
    let guard = 0;
    while (ui.focus.focused !== play && guard++ < 40) key(ui, "Tab");
    assert.equal(ui.focus.focused, play, `focus order: ${ui.diagnostics.focusOrder().join(", ")}`);
    assert.ok(ui.focus.focusVisible);
    key(ui, "Enter");
    assert.equal(g.page, "hud");
    assert.equal(g.nav.current, "hud");
  });

  test("gamepad: d-pad moves focus and A activates", () => {
    const { ui, g } = setup();
    labelled(g.pages.menu!, "Play").focus(true);
    ui.router.gamepadButton("down", true);
    ui.router.gamepadButton("down", false);
    frame(ui);
    // "Continue" is disabled, so down skips to Settings.
    assert.equal(ui.focus.focused?.accessibility.label, "Settings");
    ui.router.gamepadButton("a", true);
    ui.router.gamepadButton("a", false);
    frame(ui);
    assert.equal(g.page, "settings");
  });

  test("settings: only the selected tab's page is visible, at every breakpoint", () => {
    const { ui, g } = setup();
    g.navigate("settings");
    frame(ui);
    const tabs = find(g.pages.settings!, (e) => e.typeName === "TabContainer") as unknown as { tabCount: number; selectedIndex: number; page(i: number): UIElement | null };
    const visiblePages = (): number[] => Array.from({ length: tabs.tabCount }, (_, i) => i).filter((i) => tabs.page(i)!.visible);
    assert.deepEqual(visiblePages(), [0]);
    tabs.selectedIndex = 2;
    frame(ui);
    assert.deepEqual(visiblePages(), [2]);
    for (const [w, h] of [[390, 844], [820, 1180], [1920, 1080]] as const) {
      ui.setViewport(w, h);
      frame(ui);
      assert.deepEqual(visiblePages(), [2], `${w}x${h}: responsive grids must not re-show hidden tab pages`);
    }
  });

  test("Quit asks first: cancel keeps running, confirm calls onQuit", () => {
    const { ui, g, quits } = setup();
    click(ui, labelled(g.pages.menu!, "Quit"));
    const dlg = ui.topModal;
    assert.ok(dlg instanceof ConfirmationDialog);
    key(ui, "Escape");
    assert.equal(ui.topModal, null);
    assert.deepEqual(quits, []);
    click(ui, labelled(g.pages.menu!, "Quit"));
    click(ui, (ui.topModal as unknown as ConfirmationDialog).confirmButton);
    return Promise.resolve().then(() => {
      assert.deepEqual(quits, [1]);
    });
  });

  test("every skin × theme renders without diagnostics; skins always differ, themes recolour token-driven skins", () => {
    const { ui, g } = setup();
    const play = labelled(g.pages.menu!, "Play") as Button;
    const title = find(g.pages.menu!, (e) => e.variant === "title")!;
    const panel = find(g.pages.menu!, (e) => e.name === "main-menu")!;
    const look = new Map<string, string>();
    for (const skin of ui.resolver.skinNames) {
      for (const theme of ui.resolver.themeNames) {
        g.setSkin(skin);
        g.setTheme(theme);
        advance(ui, 0.5);
        const ps = play.computedStyle;
        const ms = panel.computedStyle;
        look.set(`${skin}/${theme}`, JSON.stringify([ps.background, ps.foreground, ps.radius.topLeft, ps.borderWidth, ms.background, ms.image, ms.radius.topLeft, ms.borderWidth, title.computedStyle.foreground]));
        assert.ok(ui.render().count > 50, `${skin}/${theme} draws`);
      }
    }
    const skins = ui.resolver.skinNames;
    const themes = ui.resolver.themeNames;
    for (const theme of themes) {
      const under = new Set(skins.map((skin) => look.get(`${skin}/${theme}`)));
      assert.equal(under.size, skins.length, `under ${theme} every skin looks different`);
    }
    // parchment is a fixed-palette sprite skin (no theme tokens), so only the token-driven skins must
    // change with the theme.
    for (const skin of skins.filter((s) => s !== "parchment")) {
      const across = new Set(themes.map((theme) => look.get(`${skin}/${theme}`)));
      assert.equal(across.size, themes.length, `${skin} changes with every theme`);
    }
    assert.notEqual(look.get("parchment/dark"), look.get("forge/dark"));
    assert.deepEqual(ui.messages.filter((m) => m.level !== "info").map((m) => m.message), []);
  });

  test("the data page filters 10,000 virtualized rows and keeps the element count small", () => {
    const { ui, g } = setup();
    g.navigate("data");
    frame(ui);
    assert.equal(g.dataList.count, 10_000);
    assert.ok(g.dataList.instantiated < 60, `instantiated ${g.dataList.instantiated}`);
    const filter = find(g.pages.data!, (e) => e instanceof TextInput) as TextInput;
    filter.focus(true);
    typeText(ui, "ERROR");
    assert.equal(g.dataList.count, 2_000);
    assert.ok(ui.elements < 600, `whole UI stays small (${ui.elements} elements)`);
  });

  test("inventory: dragging an item to an empty slot moves it; HUD bars follow the player store", () => {
    const { ui, g } = setup();
    g.navigate("inventory");
    frame(ui);
    const [from, , , , , , to] = g.inventory;
    const item = from!.item;
    assert.ok(item && to!.item === null);
    drag(ui, center(from!), center(to!));
    assert.equal(to!.item, item);
    assert.equal(from!.item, null);
    g.navigate("hud");
    frame(ui);
    const hp = find(g.pages.hud!, (e) => e instanceof HealthBar) as HealthBar;
    assert.equal(hp.value, 82);
    click(ui, labelled(g.pages.hud!, "Take 20 dmg"));
    assert.equal(g.player.get("shield"), 20, "shield absorbs first");
    click(ui, labelled(g.pages.hud!, "Take 20 dmg"));
    click(ui, labelled(g.pages.hud!, "Take 20 dmg"));
    assert.equal(g.player.get("health"), 62);
    frame(ui);
    assert.equal(hp.value, 62);
  });

  test("dispose leaves no elements behind", () => {
    const { ui, g } = setup();
    const before = ui.elements;
    g.dispose();
    frame(ui);
    assert.ok(ui.elements < before / 10, `${ui.elements} left of ${before}`);
    ui.dispose();
  });
});

await finish();
