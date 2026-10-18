/**
 * The UI gallery: every documented UI example, built only from `@forge/engine`'s public API.
 *
 * Pages (NavigationBar at the top; it collapses into a menu button + drawer when compact):
 *  * **Menu** — a main menu (keyboard/gamepad navigable, Quit asks through a ConfirmationDialog).
 *  * **Settings** — a responsive settings screen: tabbed, two columns when wide, one when compact;
 *    the Accessibility tab changes text scale, reduced motion, high contrast and the locale live.
 *  * **HUD** — health/shield bound to an `ObservableStore` driven by a simulated game loop, resource
 *    counters, an ability hotbar with cooldowns, minimap, objectives, interaction prompt, target frame,
 *    the custom `CompassStrip` widget and a dialogue box.
 *  * **Inventory** — a drag-and-drop grid with rich item tooltips and typed equipment slots.
 *  * **Widgets** — the general control set, toasts, context menu, command palette, drawer.
 *  * **Data** — a 10,000-row virtualized list with a live filter.
 *
 * Skin and theme switchers sit in the top bar; `parchment` is a sprite (nine-slice) skin registered
 * at runtime like a mod would. Everything is DOM-free so `tests/examples/uiGallery.test.ts` drives it
 * on Node exactly as the browser does.
 */

import {
  Badge,
  Breadcrumbs,
  Button,
  Checkbox,
  CircularProgress,
  ComboBox,
  CommandPalette,
  ConfirmationDialog,
  ContextMenu,
  DialogueBox,
  Drawer,
  Dropdown,
  EquipmentSlot,
  Grid,
  HealthBar,
  Hotbar,
  InteractionPrompt,
  InventorySlot,
  Label,
  ListBox,
  LoadingIndicator,
  MinimapContainer,
  NavigationBar,
  ObjectiveTracker,
  ObservableStore,
  Panel,
  ProgressBar,
  RadioButton,
  RadioGroup,
  RangeSlider,
  ResourceCounter,
  RichText,
  ScrollView,
  ShieldBar,
  Slider,
  Spacer,
  Stack,
  StatDisplay,
  StatusIndicator,
  Switch,
  TabContainer,
  TargetHealthDisplay,
  TextArea,
  TextInput,
  Toasts,
  TreeView,
  UIElement,
  VirtualizedList,
  WorldSpaceLabel,
  computed,
  type InventoryItem,
  type ResolvedStyle,
  type UIElementOptions,
  type UIManager,
  type UIPainter,
  type WorldCamera,
  type WorldPoint,
  SafeArea,
  Separator,
} from "@forge/engine";

// ====================================================================== custom component

/**
 * A custom game widget: a compass heading strip. It is not a built-in — it is registered through
 * `ui.components.register` and drawn with the same painter every widget uses.
 */
export class CompassStrip extends UIElement {
  static override styleName = "CompassStrip";
  private _heading = 0;
  /** Degrees visible across the strip. */
  span = 120;

  constructor(options: UIElementOptions & { heading?: number } = {}) {
    super(options);
    this._heading = options.heading ?? 0;
    this.pointerEvents = "none";
    this.accessibility.role = "img";
    this.accessibility.label = "Compass";
  }

  get heading(): number {
    return this._heading;
  }
  set heading(deg: number) {
    const h = ((deg % 360) + 360) % 360;
    if (h === this._heading) return;
    this._heading = h;
    this.accessibility.value = `${Math.round(h)}°`;
    this.invalidateRender();
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    return { width: Math.min(availableWidth, 360), height: 30 };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const ctx = this.context;
    if (!ctx) return;
    p.pushClip(c.x, c.y, c.width, c.height);
    const pxPerDeg = c.width / this.span;
    const labels: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    const start = Math.floor((this._heading - this.span / 2) / 15) * 15;
    for (let d = start; d <= this._heading + this.span / 2; d += 15) {
      const x = c.x + c.width / 2 + (d - this._heading) * pxPerDeg;
      const deg = ((d % 360) + 360) % 360;
      const label = labels[deg];
      if (label) {
        const l = ctx.text.layout({ text: label, family: "default", size: 12, weight: 700 });
        p.text(l, x - l.width / 2, c.y + 2, deg === 0 ? s.accent : s.foreground);
      } else p.fillRect(x - 0.5, c.y + c.height - 10, 1, 8, s.foreground);
    }
    p.popClip();
    p.fillRect(c.x + c.width / 2 - 1, c.y + c.height - 14, 2, 14, s.accent);
  }
}

// ====================================================================== procedural assets

/** A 128×128 "terrain" image for the minimap (value noise, sea/sand/grass/rock bands). */
export function makeMinimapPixels(size = 128): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number): number => {
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const noise = (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const s = (t: number): number => t * t * (3 - 2 * t);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = noise(x / 24, y / 24) * 0.6 + noise(x / 9, y / 9) * 0.3 + noise(x / 4, y / 4) * 0.1;
      const o = (y * size + x) * 4;
      const [r, g, b] = h < 0.38 ? [30, 70, 130] : h < 0.43 ? [194, 178, 128] : h < 0.68 ? [70, 120, 60] : h < 0.8 ? [110, 100, 90] : [235, 235, 240];
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** A 48×48 nine-slice "parchment" frame (12 px borders) for the sprite skin. */
export function makeParchmentPixels(size = 48, border = 12): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const grain = ((x * 7 + y * 13) % 5) * 3;
      if (edge < 3) {
        out.set([92, 58, 30, 255], o);
      } else if (edge < border - 6) {
        out.set([150 + grain, 104 + grain, 54, 255], o);
      } else {
        out.set([233 - grain, 214 - grain, 170 - grain, 255], o);
      }
    }
  }
  return out;
}

// ====================================================================== gallery

export interface UIGalleryOptions {
  /** World camera for the world-space label (null in Node tests). */
  camera?: () => WorldCamera | null;
  /** World point the world-space label follows. */
  labelTarget?: () => WorldPoint;
  /** Called when the main menu's Quit is confirmed. */
  onQuit?: () => void;
}

export interface PlayerState extends Record<string, unknown> {
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  gold: number;
  gems: number;
  heading: number;
}

export interface UIGalleryHandle {
  readonly root: UIElement;
  readonly pages: Readonly<Record<string, UIElement>>;
  readonly nav: NavigationBar;
  readonly player: ObservableStore<PlayerState>;
  readonly toasts: Toasts;
  readonly dataList: VirtualizedList<string>;
  readonly inventory: InventorySlot[];
  readonly hotbar: Hotbar;
  readonly confirmQuit: () => Promise<boolean>;
  /** Current page id. */
  readonly page: string;
  navigate(id: string): void;
  setSkin(name: string): void;
  setTheme(name: string): void;
  /** Advance the simulated game state (health regen/damage, compass). */
  update(dt: number): void;
  dispose(): void;
}

const ITEMS: InventoryItem[] = [
  { id: "sword", name: "Ember Blade", icon: "swords", rarity: "epic", type: "weapon", stats: { Attack: 24, Speed: -2 }, description: "Forged in the caldera; warm to the touch." },
  { id: "shield", name: "Oak Buckler", icon: "square", rarity: "uncommon", type: "offhand", stats: { Armor: 12 } },
  { id: "potion", name: "Health Potion", icon: "heart", rarity: "common", count: 5, type: "consumable", description: "Restores 50 health." },
  { id: "gem", name: "Star Shard", icon: "star", rarity: "legendary", count: 2, type: "material", description: "Hums faintly at night." },
  { id: "bolt", name: "Storm Rune", icon: "lightning", rarity: "rare", type: "trinket", stats: { Haste: 8 } },
  { id: "ring", name: "Band of Echoes", icon: "circle", rarity: "rare", type: "trinket", stats: { Mana: 30 } },
];

export const GALLERY_STRINGS = {
  en: {
    "menu.title": "Red Frontier",
    "menu.continue": "Continue",
    "menu.new": "New expedition",
    "menu.saved": "Saved expeditions",
    "menu.settings": "Settings",
    "menu.quit": "Quit",
    "settings.title": "Settings",
    "hud.objective": "Reach the beacon",
    "inv.title": "Inventory",
  },
  de: {
    "menu.title": "Rote Grenze",
    "menu.continue": "Fortsetzen",
    "menu.new": "Neue Expedition",
    "menu.saved": "Gespeicherte Expeditionen",
    "menu.settings": "Einstellungen",
    "menu.quit": "Beenden",
    "settings.title": "Einstellungen",
    "hud.objective": "Erreiche das Leuchtfeuer",
    "inv.title": "Inventar",
  },
  fr: {
    "menu.title": "Frontière rouge",
    "menu.continue": "Continuer",
    "menu.new": "Nouvelle expédition",
    "menu.saved": "Expéditions sauvegardées",
    "menu.settings": "Paramètres",
    "menu.quit": "Quitter",
    "settings.title": "Paramètres",
    "hud.objective": "Atteindre la balise",
    "inv.title": "Inventaire",
  },
};

export function buildUIGallery(ui: UIManager, options: UIGalleryOptions = {}): UIGalleryHandle {
  // --- assets, strings, custom component, sprite skin
  ui.assets.registerPixels("gallery.minimap", 128, 128, makeMinimapPixels());
  ui.assets.registerPixels("gallery.parchment", 48, 48, makeParchmentPixels());
  ui.assets.registerSprite("parchment.frame", { texture: "gallery.parchment", x: 0, y: 0, width: 48, height: 48, slice: 12 });
  for (const [loc, table] of Object.entries(GALLERY_STRINGS)) ui.localizer.addTable(loc, table);
  ui.localizer.setLocale("en", ["en"]);
  if (!ui.components.has("CompassStrip")) {
    ui.components.register("CompassStrip", {
      create: (o) => new CompassStrip(o as never),
      properties: [{ name: "heading", type: "number", animatable: true, affects: ["render"], description: "Degrees clockwise from north" }],
      category: "game",
      description: "Heading strip (custom component example)",
      plugin: "examples.gallery",
    });
  }
  if (!ui.resolver.skinNames.includes("parchment")) {
    ui.resolver.registerSkin({
      name: "parchment",
      version: 1,
      extends: "forge",
      components: {
        Panel: { background: "#00000000", image: "parchment.frame", imageTint: "#ffffff", borderWidth: 0, shadowColor: "#00000066", padding: 20, foreground: "#3b2a16" },
        // Body text sits on parchment; the title and captions sit on the 3D scene, so they stay light.
        Label: { foreground: "#3b2a16", variants: { title: { foreground: "#f3e3c3" }, muted: { foreground: "#c9b28a" }, caption: { foreground: "#c9b28a" } } },
        // Variants are restyled too: by the precedence rules a parent skin's variant block beats this
        // skin's base block, so leaving them out would keep forge's blue/red primary and danger buttons.
        Button: {
          background: "#8a5a2b",
          borderColor: "#5c3a1a",
          foreground: "#fdf6e3",
          radius: 3,
          states: { hovered: { background: "#a06a35" }, pressed: { background: "#6d4521" } },
          variants: {
            primary: { background: "#4f6b2a", borderColor: "#34481b", foreground: "#fdf6e3", states: { hovered: { background: "#5f7f33" }, pressed: { background: "#3f5621" } } },
            danger: { background: "#8b2a1e", borderColor: "#5e1b13", foreground: "#fdf6e3", states: { hovered: { background: "#a33526" }, pressed: { background: "#6e2117" } } },
          },
        },
        CompassStrip: { foreground: "#3b2a16", accent: "#b91c1c" },
      },
    });
  }

  const player = new ObservableStore<PlayerState>({ health: 82, maxHealth: 100, shield: 40, maxShield: 50, gold: 1250, gems: 7, heading: 30 });
  const toasts = new Toasts(ui, "bottom-right");

  // --- frame
  const root = new SafeArea({ name: "gallery", direction: "column", gap: 0 });
  root.setLayout({ alignSelf: "stretch", justifySelf: "stretch" });
  ui.base.add(root);

  const topBar = root.add(new Stack({ direction: "row", gap: 8, align: "center", name: "top-bar" }));
  topBar.setLayout({ padding: [6, 12] });
  topBar.style = { background: "$color.surface", borderColor: "$color.border" };
  const pageIds = ["menu", "settings", "hud", "inventory", "widgets", "data"];
  const titles: Record<string, string> = { menu: "Menu", settings: "Settings", hud: "HUD", inventory: "Inventory", widgets: "Widgets", data: "Data" };
  const icons: Record<string, string> = { menu: "home", settings: "settings", hud: "heart", inventory: "diamond", widgets: "square-outline", data: "menu" };
  const nav = topBar.add(new NavigationBar({ items: pageIds.map((id) => ({ id, label: titles[id]!, icon: icons[id] })), current: "menu", onNavigate: (id) => navigate(id) }));
  nav.setLayout({ flexGrow: 1, flexShrink: 1 });
  const skinPicker = topBar.add(new Dropdown({ items: ui.resolver.skinNames.map((s) => ({ label: `Skin: ${s}`, value: s })), selectedIndex: ui.resolver.skinNames.indexOf(ui.skin), onChange: (_i, item) => item && setSkin(item.value as string) }));
  skinPicker.setLayout({ width: 170 });
  const themePicker = topBar.add(new Dropdown({ items: ui.resolver.themeNames.map((t) => ({ label: `Theme: ${t}`, value: t })), selectedIndex: ui.resolver.themeNames.indexOf(ui.theme), onChange: (_i, item) => item && setTheme(item.value as string) }));
  themePicker.setLayout({ width: 190 });
  ui.responsive(skinPicker, { compact: { visible: false } });
  ui.responsive(themePicker, { compact: { visible: false } });

  const content = root.add(new Stack({ direction: "column", name: "pages" }));
  content.setLayout({ flexGrow: 1, flexShrink: 1, alignSelf: "stretch", padding: 16 });

  const pages: Record<string, UIElement> = {};
  let current = "menu";

  // ------------------------------------------------------------------ Menu page
  const confirmQuit = (): Promise<boolean> =>
    new ConfirmationDialog({ title: "Quit to desktop?", message: "Unsaved progress since the last checkpoint will be lost.", confirmText: "Quit", danger: true }).ask(ui).then((ok) => {
      if (ok) options.onQuit?.();
      return ok;
    });
  // The menu page follows the frontier look: eyebrow kicker, large spaced title, body copy with
  // highlighted words, a stat row, then one card that switches between the main menu and the saved
  // expeditions list (the same card, so focus and layout never jump between two panels).
  const saves = [
    { name: "Ares Expo 2", meta: "Sol 6 · Pioneer · Territory · Terra Sirenum · Sep 22, 2026" },
    { name: "Test 3", meta: "Sol 10 · Pioneer · Planetary Survey · Jezero crater · Sep 20, 2026" },
    { name: "Ares Expedition", meta: "Sol 17 · Pioneer · Territory · Arabia Terra · Sep 17, 2026" },
  ];
  let showSaved: (on: boolean) => void = () => {};
  {
    // Scrolls rather than squeezing: on a phone the menu (like the reference app's) is taller than
    // the screen, and flex items shrunk below their content would overlap.
    const page = new ScrollView({ name: "page-menu", contentLayout: { direction: "column", gap: 0, align: "center" } });
    page.setLayout({ flexGrow: 1, alignSelf: "stretch" });
    const col = page.add(new Stack({ direction: "column", gap: 14, name: "menu-column" }));
    col.setLayout({ width: 520, maxWidth: "100%", margin: [8, 0, 56, 0] });
    col.add(new Label({ text: "Ares Expeditionary Command · 2066", variant: "eyebrow", wrap: "word" })).setLayout({ alignSelf: "stretch" });
    col.add(new Label({ textKey: "menu.title", variant: "title", wrap: "word" })).setLayout({ alignSelf: "stretch" });
    col.add(
      new RichText({
        markup: "One human. A handful of machines. An entire planet that doesn't want you there. Found a colony, keep the air on, and automate yourself out of the daily grind — before [b][color=$color.highlight]Mars[/color][/b] automates [b][color=$color.highlight]you[/color][/b] out of existence.",
        variant: "body",
      }),
    ).setLayout({ alignSelf: "stretch" });
    const stats = col.add(new Stack({ direction: "row", gap: 14, name: "menu-stats" }));
    stats.setLayout({ alignSelf: "stretch", margin: [4, 0, 4, 0] });
    for (const [value, label] of [["3", "Expeditions"], ["33", "Sols survived"], ["18", "Landing zones"]] as const) {
      stats.add(new Separator({ orientation: "vertical" }));
      const stat = stats.add(new Stack({ direction: "column", gap: 2 }));
      stat.setLayout({ flexShrink: 1 });
      stat.add(new Label({ text: value, variant: "stat" }));
      stat.add(new Label({ text: label, variant: "statLabel", overflow: "ellipsis" }));
    }

    // Main menu card.
    const menu = col.add(new Panel({ gap: 12, name: "main-menu" }));
    menu.setLayout({ alignSelf: "stretch" });
    const mk = (key: string, subtitle: string, icon: string, onPress: () => void, variant?: string): Button => {
      const b = menu.add(new Button({ textKey: key, subtitle, icon, variant, onPress, style: { textAlign: "start", padding: [14, 22], spacing: 22 } }));
      b.setLayout({ alignSelf: "stretch" });
      return b;
    };
    mk("menu.continue", `${saves[0]!.name} · Sol 6 · Pioneer · Sep 22, 2026`, "triangle-right", () => navigate("hud"), "primary");
    mk("menu.new", "Found a colony on untouched ground", "star", () => navigate("hud"));
    mk("menu.saved", `${saves.length} colonies on file`, "menu", () => showSaved(true));
    mk("menu.settings", "Graphics, audio, controls, accessibility", "settings", () => navigate("settings"));
    mk("menu.quit", "Back to the desktop", "close", () => void confirmQuit());
    menu.add(new Label({ text: "Prototype 5 · deterministic sim · autosaves locally", variant: "caption", align: "center", wrap: "word" })).setLayout({ alignSelf: "stretch", margin: [4, 0, 0, 0] });

    // Saved expeditions card (same column, swapped with the main menu).
    const saved = col.add(new Panel({ gap: 12, name: "saved-expeditions", visible: false }));
    saved.setLayout({ alignSelf: "stretch" });
    const head = saved.add(new Stack({ direction: "row", gap: 8, align: "center", wrap: true }));
    head.setLayout({ alignSelf: "stretch" });
    head.add(new Button({ text: "Back", icon: "arrow-left", variant: "ghost", onPress: () => showSaved(false) }));
    head.add(new Spacer());
    head.add(new Button({ text: "New expedition", icon: "star", onPress: () => navigate("hud") }));
    saved.add(new Label({ text: "Colony records", variant: "eyebrow" }));
    saved.add(new Label({ text: "Saved expeditions", variant: "heading", wrap: "word" })).setLayout({ alignSelf: "stretch" });
    saved.add(new Label({ text: "Most recently played first. Select a colony to resume it where you left off.", variant: "muted", wrap: "word" })).setLayout({ alignSelf: "stretch" });
    for (const save of saves) {
      const row = saved.add(new Panel({ direction: "row", gap: 10, align: "center", variant: "inset", name: `save-${save.name}` }));
      row.setLayout({ alignSelf: "stretch" });
      const info = row.add(new Stack({ direction: "column", gap: 4 }));
      info.setLayout({ flexGrow: 1, flexShrink: 1, flexBasis: 0 });
      info.add(new Label({ text: save.name, variant: "strong", style: { fontSize: "$fontSize.lg" } }));
      info.add(new Label({ text: save.meta, variant: "muted", wrap: "word" })).setLayout({ alignSelf: "stretch" });
      row.add(new Button({ text: "Resume", icon: "triangle-right", iconAfter: true, variant: "outline", onPress: () => navigate("hud"), accessibility: { label: `Resume ${save.name}` } }));
      const more = row.add(new Button({ text: "•••", variant: "ghost", tooltip: "More options", accessibility: { label: `More options for ${save.name}` }, onPress: () => toasts.show(`${save.name}: rename, duplicate or delete`) }));
      more.style = { padding: [6, 4], letterSpacing: 1, minWidth: 30 };
    }

    showSaved = (on: boolean): void => {
      menu.visible = !on;
      saved.visible = on;
      const first = ui.focus.sequence(on ? saved : menu)[0];
      if (ui.focus.focusVisible && first) first.focus(true);
    };

    const build = col.add(new Badge({ text: "Latest build · 3bd4b39", variant: "status", name: "build-badge" }));
    build.setLayout({ alignSelf: "end" });
    pages.menu = page;
  }

  // ------------------------------------------------------------------ Settings page (responsive)
  {
    const page = new Stack({ direction: "column", gap: 10, name: "page-settings" });
    page.setLayout({ flexGrow: 1, alignSelf: "stretch" });
    page.add(new Breadcrumbs({ path: [{ label: "Menu", id: "menu" }, { label: "Settings", id: "settings" }], onNavigate: (id) => navigate(id) }));
    const tabs = page.add(new TabContainer());
    tabs.setLayout({ flexGrow: 1, alignSelf: "stretch" });
    const row = (grid: Grid, label: string, control: UIElement): void => {
      grid.add(new Label({ text: label }));
      grid.add(control);
    };
    const settingsGrid = (): Grid => {
      const g = new Grid({ columns: ["auto", "1fr", "auto", "1fr"], columnGap: 16, rowGap: 10, alignItems: "center" });
      ui.responsive(g, { compact: { apply: (el) => (el as Grid).setColumns(["auto", "1fr"]) }, default: { apply: (el) => (el as Grid).setColumns(["auto", "1fr", "auto", "1fr"]) } });
      return g;
    };
    const gfx = settingsGrid();
    row(gfx, "Quality", new Dropdown({ items: ["Low", "Medium", "High", "Ultra"], selectedIndex: 2 }));
    row(gfx, "Shadows", new Switch({ checked: true }));
    row(gfx, "Render scale", new Slider({ value: 1, min: 0.5, max: 1, step: 0.05 }));
    row(gfx, "Bloom", new Checkbox({ text: "Enabled", checked: true }));
    row(gfx, "Field of view", new Slider({ value: 75, min: 60, max: 110, step: 1 }));
    row(gfx, "V-Sync", new Switch({ checked: false }));
    tabs.addTab("Graphics", gfx, "settings");
    const audio = settingsGrid();
    row(audio, "Master", new Slider({ value: 0.8 }));
    row(audio, "Music", new Slider({ value: 0.5 }));
    row(audio, "Effects", new Slider({ value: 0.9 }));
    row(audio, "Voice", new Slider({ value: 1 }));
    tabs.addTab("Audio", audio);
    const controls = settingsGrid();
    const invert = new RadioGroup({ direction: "row", gap: 12, value: "normal" });
    invert.add(new RadioButton({ text: "Normal", value: "normal" }));
    invert.add(new RadioButton({ text: "Inverted", value: "inverted" }));
    row(controls, "Look Y", invert);
    row(controls, "Sensitivity", new Slider({ value: 0.4 }));
    row(controls, "Dead zone", new RangeSlider({ low: 0.1, high: 0.9 }));
    row(controls, "Name", new TextInput({ placeholder: "Pilot name", maxLength: 16 }));
    tabs.addTab("Controls", controls);
    const a11y = settingsGrid();
    const textScale = new Slider({ value: 1, min: 0.8, max: 1.6, step: 0.1, onChange: (v) => (ui.textScale = v) });
    row(a11y, "Text size", textScale);
    row(a11y, "Reduce motion", new Switch({ onChange: (v) => (ui.reducedMotion = v) }));
    row(a11y, "High contrast", new Switch({ onChange: (v) => setTheme(v ? "high-contrast" : "dark") }));
    const locale = new Dropdown({
      items: [{ label: "English", value: "en" }, { label: "Deutsch", value: "de" }, { label: "Français", value: "fr" }, { label: "Pseudo (long)", value: "pseudo" }],
      selectedIndex: 0,
      onChange: (_i, item) => {
        const v = item?.value as string;
        ui.localizer.pseudo = v === "pseudo";
        ui.localizer.setLocale(v === "pseudo" ? "en" : v, ["en"]);
      },
    });
    row(a11y, "Language", locale);
    tabs.addTab("Accessibility", a11y);
    pages.settings = page;
  }

  // ------------------------------------------------------------------ HUD page
  const hotbar = new Hotbar({
    abilities: [
      { icon: "swords", cooldown: 1.5 },
      { icon: "lightning", cooldown: 4, cost: 20 },
      { icon: "heart", cooldown: 8, onUse: () => player.set("health", Math.min(player.get("maxHealth"), player.get("health") + 25)) },
      { icon: "star", cooldown: 12, cost: 50 },
    ],
  });
  let worldLabel: WorldSpaceLabel | null = null;
  {
    const page = new Stack({ direction: "row", gap: 16, name: "page-hud", wrap: true });
    page.setLayout({ flexGrow: 1, alignSelf: "stretch" });
    const left = page.add(new Panel({ gap: 8, name: "vitals" }));
    left.setLayout({ width: 280 });
    left.add(new Label({ text: "Vitals", variant: "heading" }));
    const hp = left.add(new HealthBar({ max: 100, value: 82 }));
    const sh = left.add(new ShieldBar({ max: 50, value: 40 }));
    ui.bind(hp, "value", [player, "health"]);
    ui.bind(hp, "max", [player, "maxHealth"]);
    ui.bind(sh, "value", [player, "shield"]);
    ui.bind(sh, "max", [player, "maxShield"]);
    const res = left.add(new Stack({ direction: "row", gap: 16 }));
    const gold = res.add(new ResourceCounter({ icon: "circle", value: 1250 }));
    const gems = res.add(new ResourceCounter({ icon: "diamond", value: 7 }));
    ui.bind(gold, "value", [player, "gold"]);
    ui.bind(gems, "value", [player, "gems"]);
    const healthText = computed([player.field("health"), player.field("maxHealth")], () => `${Math.round(player.get("health"))} / ${player.get("maxHealth")} HP`);
    const hpLabel = left.add(new Label({ variant: "muted" }));
    ui.bind(hpLabel, "text", healthText);
    left.own(healthText);
    left.add(hotbar);
    const btns = left.add(new Stack({ direction: "row", gap: 6, wrap: true }));
    btns.add(new Button({ text: "Take 20 dmg", variant: "danger", onPress: () => damage(20) }));
    btns.add(new Button({ text: "+100 gold", onPress: () => player.set("gold", player.get("gold") + 100) }));

    const mid = page.add(new Panel({ gap: 10, name: "world" }));
    mid.setLayout({ width: 260 });
    const compass = mid.add(new CompassStrip());
    compass.setLayout({ alignSelf: "stretch" });
    ui.bind(compass, "heading", [player, "heading"]);
    const map = mid.add(new MinimapContainer({ map: "gallery.minimap", size: 180, zoom: 0.5 }));
    map.setLayout({ alignSelf: "center" });
    map.setMarkers([
      { x: 0.62, y: 0.4, color: "#facc15", icon: "star" },
      { x: 0.2, y: 0.85, color: "#ef4444" },
      { x: 0.95, y: 0.05, color: "#22d3ee", icon: "triangle-up" },
    ]);
    mid.add(new InteractionPrompt({ key: "E", action: "Open supply crate" }));
    mid.add(new TargetHealthDisplay({ target: { name: "Ridge Stalker", level: 12, health: 640, maxHealth: 900, shield: 120, maxShield: 200 } }));

    const right = page.add(new Panel({ gap: 8, name: "quest" }));
    right.setLayout({ width: 300 });
    right.add(new Label({ text: "Objectives", variant: "heading" }));
    const obj = right.add(new ObjectiveTracker({
      objectives: [
        { id: "beacon", text: "Reach the beacon", done: false },
        { id: "crates", text: "Collect supply crates", current: 2, target: 5 },
        { id: "scan", text: "Scan the ridge", current: 1, target: 1 },
      ],
    }));
    let crates = 2;
    right.add(new Button({ text: "Collect crate", onPress: () => obj.progress("crates", (crates = Math.min(5, crates + 1))) }));
    const dialogue = right.add(new DialogueBox({ speed: 40 }));
    dialogue.say("Quartermaster", "The beacon's been dark for three nights. Take the ridge path — and mind the stalkers.", [
      { text: "On my way.", onSelect: () => toasts.show("Objective updated", "success") },
      { text: "What's in it for me?", onSelect: () => player.set("gold", player.get("gold") + 50) },
    ]);
    pages.hud = page;
    if (options.camera && options.labelTarget) {
      worldLabel = new WorldSpaceLabel({ target: options.labelTarget, camera: options.camera, offsetY: 12 });
      const tag = worldLabel.add(new Panel({ gap: 2 }));
      tag.setLayout({ padding: [4, 8] });
      tag.add(new Label({ text: "Supply Crate", variant: "strong" }));
      tag.add(new ProgressBar({ value: 0.6 })).setLayout({ width: 90, height: 6 });
      ui.layer("hud").add(worldLabel);
      worldLabel.visible = false;
    }
  }

  // ------------------------------------------------------------------ Inventory page
  const inventory: InventorySlot[] = [];
  {
    const page = new Stack({ direction: "row", gap: 16, wrap: true, name: "page-inventory" });
    page.setLayout({ flexGrow: 1, alignSelf: "stretch" });
    const bag = page.add(new Panel({ gap: 10, name: "bag" }));
    bag.add(new Label({ textKey: "inv.title", variant: "heading" }));
    const grid = bag.add(new Grid({ columns: { autoFill: 52 }, columnGap: 6, rowGap: 6 }));
    grid.setLayout({ width: 6 * 52 + 5 * 6, maxWidth: "90vw" });
    for (let i = 0; i < 24; i++) {
      const slot = grid.add(new InventorySlot({ item: ITEMS[i] ?? null }));
      inventory.push(slot);
    }
    bag.add(new Label({ text: "Drag items between slots · hover or focus a slot for details", variant: "caption", wrap: "word" })).setLayout({ maxWidth: 330 });
    const gear = page.add(new Panel({ gap: 10, name: "equipment" }));
    gear.add(new Label({ text: "Equipment", variant: "heading" }));
    const eq = gear.add(new Grid({ columns: [52, 52], columnGap: 6, rowGap: 6 }));
    for (const [type, icon] of [["weapon", "swords"], ["offhand", "square-outline"], ["trinket", "circle"], ["trinket", "diamond"]] as const) {
      eq.add(new EquipmentSlot({ slotType: type, placeholderIcon: icon, tooltip: `${type} slot` }));
    }
    gear.add(new StatDisplay({ label: "Attack", value: 31, delta: 4 }));
    gear.add(new StatDisplay({ label: "Armor", value: 18, delta: -2 }));
    pages.inventory = page;
  }

  // ------------------------------------------------------------------ Widgets page
  {
    const page = new ScrollView({ name: "page-widgets", contentLayout: { direction: "row", gap: 16, wrap: true } });
    page.setLayout({ flexGrow: 1, alignSelf: "stretch" });
    const col = (title: string): Panel => {
      const p = page.add(new Panel({ gap: 8 }));
      p.setLayout({ width: 300 });
      p.add(new Label({ text: title, variant: "heading" }));
      return p;
    };
    const inputs = col("Inputs");
    inputs.add(new TextInput({ placeholder: "Search…" })).setLayout({ alignSelf: "stretch" });
    inputs.add(new TextInput({ placeholder: "Password", password: true })).setLayout({ alignSelf: "stretch" });
    inputs.add(new TextInput({ placeholder: "Digits only", filter: (c) => /\d/.test(c), validate: (v) => (v.length > 0 && v.length < 4 ? "At least 4 digits" : null) })).setLayout({ alignSelf: "stretch" });
    inputs.add(new TextArea({ placeholder: "Notes (multi-line)", rows: 3 })).setLayout({ alignSelf: "stretch" });
    inputs.add(new ComboBox({ placeholder: "Planet", items: ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"] })).setLayout({ alignSelf: "stretch" });
    inputs.add(new Checkbox({ text: "Indeterminate", indeterminate: true }));
    const toggles = col("Feedback");
    const pb = toggles.add(new ProgressBar({ value: 0.35, showLabel: true, smoothing: 0.3 }));
    pb.setLayout({ alignSelf: "stretch", height: 16 });
    const prog = toggles.add(new Stack({ direction: "row", gap: 12, align: "center" }));
    prog.add(new CircularProgress({ value: 0.7, showLabel: true }));
    prog.add(new LoadingIndicator());
    prog.add(new Badge({ count: 3 }));
    prog.add(new Badge({ text: "NEW", variant: "success" }));
    toggles.add(new StatusIndicator({ status: "online", label: "Squad online" }));
    toggles.add(new StatusIndicator({ status: "busy", label: "Server busy" }));
    toggles.add(new Slider({ value: 0.35, onChange: (v) => (pb.value = v) })).setLayout({ alignSelf: "stretch" });
    toggles.add(new RichText({ markup: "[b]Rich text[/b]: [color=#f87171]red[/color], [color=$color.accent]accent[/color], [size=20]big[/size] and an [icon=star] icon." })).setLayout({ alignSelf: "stretch" });
    const overlays = col("Overlays");
    overlays.add(new Button({ text: "Show toast", onPress: () => toasts.show("Settings saved", "success", { title: "Saved" }) }));
    overlays.add(new Button({ text: "Show error toast", onPress: () => toasts.show("Connection lost — retrying", "error") }));
    const menuBtn = overlays.add(new Button({ text: "Context menu", icon: "menu" }));
    const ctxMenu = new ContextMenu({
      items: [
        { label: "Copy", shortcut: "Ctrl+C", onSelect: () => toasts.show("Copied") },
        { label: "Paste", shortcut: "Ctrl+V", disabled: true },
        { separator: true },
        { label: "Sort by", items: [{ label: "Name", onSelect: () => toasts.show("Sorted by name") }, { label: "Rarity", onSelect: () => toasts.show("Sorted by rarity") }] },
        { label: "Show hidden", checked: true },
      ],
    });
    menuBtn.on("press", () => ctxMenu.openAt(ui, menuBtn, "below"));
    menuBtn.own({ dispose: () => ctxMenu.dispose() });
    const palette = new CommandPalette({
      commands: [
        { id: "inv", label: "Open inventory", shortcut: "I", run: () => navigate("inventory") },
        { id: "set", label: "Open settings", run: () => navigate("settings") },
        { id: "hud", label: "Show HUD", run: () => navigate("hud") },
        { id: "theme", label: "Toggle light theme", run: () => setTheme(ui.theme === "light" ? "dark" : "light") },
        { id: "flat", label: "Use flat skin", run: () => setSkin("flat") },
      ],
    });
    overlays.add(new Button({ text: "Command palette", icon: "command", onPress: () => palette.show(ui) }));
    overlays.own({ dispose: () => palette.dispose() });
    const drawer = new Drawer({ title: "Side drawer", side: "right" });
    drawer.add(new Label({ text: "Drawers are modal panels docked to an edge.", wrap: "word" }));
    drawer.add(new Button({ text: "Close", onPress: () => drawer.close() }));
    overlays.add(new Button({ text: "Open drawer", onPress: () => drawer.open(ui) }));
    overlays.own({ dispose: () => drawer.dispose() });
    const lists = col("Lists");
    lists.add(new ListBox({ items: ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"], selectedIndex: 1, selection: "multiple" })).setLayout({ alignSelf: "stretch", height: 150 });
    lists.add(new TreeView({ nodes: [{ label: "Assets", expanded: true, children: [{ label: "Textures", children: [{ label: "rock.ktx2" }, { label: "sand.ktx2" }] }, { label: "Models", children: [{ label: "rover.glb" }] }] }, { label: "Scripts", children: [{ label: "beacon.ts" }] }] })).setLayout({ alignSelf: "stretch", height: 150 });
    pages.widgets = page;
  }

  // ------------------------------------------------------------------ Data page
  const rows = Array.from({ length: 10_000 }, (_, i) => `#${String(i + 1).padStart(5, "0")}  ${["INFO", "WARN", "INFO", "DEBUG", "ERROR"][i % 5]}  chunk ${(i * 7919) % 512} streamed in ${((i * 37) % 900) / 10} ms`);
  const dataList = new VirtualizedList<string>({
    items: rows,
    itemExtent: 24,
    createItem: () => new Label({ overflow: "ellipsis" }),
    bindItem: (el, item) => ((el as Label).text = item),
  });
  {
    const page = new Stack({ direction: "column", gap: 8, name: "page-data" });
    page.setLayout({ flexGrow: 1, alignSelf: "stretch" });
    const head = page.add(new Stack({ direction: "row", gap: 8, align: "center" }));
    head.add(new Label({ text: "10,000 log rows (virtualized)", variant: "heading" }));
    head.add(new Spacer());
    const count = head.add(new Label({ text: `${rows.length} rows`, variant: "muted" }));
    const filter = head.add(new TextInput({ placeholder: "Filter (e.g. ERROR)" }));
    filter.setLayout({ width: 220 });
    filter.on("change", () => {
      const q = filter.value.trim().toLowerCase();
      const next = q ? rows.filter((r) => r.toLowerCase().includes(q)) : rows;
      dataList.setItems(next);
      count.text = `${next.length} rows`;
    });
    const panel = page.add(new Panel({ gap: 0 }));
    panel.setLayout({ flexGrow: 1, alignSelf: "stretch", padding: 8 });
    panel.add(dataList).setLayout({ flexGrow: 1, alignSelf: "stretch" });
    pages.data = page;
  }

  for (const id of pageIds) {
    const p = pages[id]!;
    p.visible = id === current;
    content.add(p);
  }

  function navigate(id: string): void {
    if (!pages[id] || id === current) return;
    pages[current]!.visible = false;
    current = id;
    pages[id]!.visible = true;
    if (nav.current !== id) nav.current = id;
    if (worldLabel) worldLabel.visible = id === "hud";
    const first = ui.focus.sequence(pages[id]!)[0];
    if (ui.focus.focusVisible && first) first.focus(true);
  }

  function setSkin(name: string): void {
    ui.setSkin(name);
    const i = ui.resolver.skinNames.indexOf(name);
    if (skinPicker.selectedIndex !== i) skinPicker.selectedIndex = i;
  }

  function setTheme(name: string): void {
    ui.setTheme(name);
    const i = ui.resolver.themeNames.indexOf(name);
    if (themePicker.selectedIndex !== i) themePicker.selectedIndex = i;
  }

  function damage(n: number): void {
    const shield = player.get("shield");
    const absorbed = Math.min(shield, n);
    player.update({ shield: shield - absorbed, health: Math.max(0, player.get("health") - (n - absorbed)) });
  }

  let regen = 0;
  return {
    root,
    pages,
    nav,
    player,
    toasts,
    dataList,
    inventory,
    hotbar,
    confirmQuit,
    get page() {
      return current;
    },
    navigate,
    setSkin,
    setTheme,
    update(dt: number): void {
      regen += dt;
      if (regen >= 0.5) {
        regen = 0;
        player.update({
          shield: Math.min(player.get("maxShield"), player.get("shield") + 1),
          heading: (player.get("heading") + 3) % 360,
        });
      }
    },
    dispose(): void {
      root.dispose();
      worldLabel?.dispose();
    },
  };
}
