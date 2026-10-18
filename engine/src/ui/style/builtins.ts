/**
 * Built-in themes and skins.
 *
 * Themes (tokens only): `frontier` (the default: warm near-black, cream text, ember-orange accent),
 * `dark` (cool slate and blue), `light`, `high-contrast` (WCAG AAA text contrast, thick focus and
 * borders, no translucency). Skins (construction only, written in tokens): `frontier` (the default:
 * letter-spaced uppercase controls and headings, gradient primary with glow, outlined accent
 * buttons), `forge` (rounded, soft shadows, mixed case), `flat` (extends forge: square corners, no
 * shadows, tighter padding) and `glass` (extends forge: translucent gradient surfaces). Any theme
 * works with any skin;
 * `tests/ui/uiStyle.test.ts` resolves every component in every combination and checks that no token
 * is missing.
 */

import type { ComponentSkin, SkinDefinition, ThemeDefinition, TransitionDefinition } from "./types.js";
import type { StyleResolver } from "./resolver.js";

const fast: TransitionDefinition[] = [{ properties: ["background", "borderColor", "foreground", "accent"], duration: 0.12, easing: "easeOut" }];

export const DARK_THEME: ThemeDefinition = {
  name: "dark",
  kind: "dark",
  tokens: {
    color: {
      background: "#0b0f17",
      surface: "#151b26",
      surfaceAlt: "#1d2533",
      surfaceHover: "#263043",
      surfacePressed: "#10151f",
      border: "#2f3a4d",
      text: "#e5e7eb",
      textMuted: "#9aa4b5",
      textInverse: "#0b0f17",
      accent: "#3b82f6",
      accentHover: "#60a5fa",
      accentPressed: "#2563eb",
      accentText: "#ffffff",
      accentEnd: "#2563eb",
      accentBorder: "#3b82f680",
      accentGlow: "#3b82f640",
      highlight: "#fbbf24",
      successSurface: "#14532d80",
      danger: "#ef4444",
      dangerHover: "#f87171",
      success: "#22c55e",
      warning: "#f59e0b",
      track: "#0000005c",
      selection: "#3b82f633",
      backdrop: "#000000a6",
      shadow: "#00000080",
      tooltip: "#e5e7eb",
      tooltipText: "#0b0f17",
      health: "#ef4444",
      healthLow: "#fb923c",
      shield: "#38bdf8",
      trail: "#fde68acc",
      positive: "#4ade80",
      negative: "#f87171",
      mark: "#ffffff",
      thumb: "#ffffff",
      sweep: "#000000b3",
    },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
    radius: { sm: 4, md: 8, lg: 12, pill: 999 },
    font: { body: "default", heading: "default" },
    fontSize: { sm: 12, md: 14, lg: 18, xl: 22, xxl: 30 },
    duration: { fast: 0.12, normal: 0.2 },
    number: { border: 1, focus: 2, controlHeight: 34, iconSize: 18 },
  },
};

export const LIGHT_THEME: ThemeDefinition = {
  name: "light",
  kind: "light",
  extends: "dark",
  tokens: {
    color: {
      background: "#f3f4f6",
      surface: "#ffffff",
      surfaceAlt: "#f1f5f9",
      surfaceHover: "#e2e8f0",
      surfacePressed: "#cbd5e1",
      border: "#cbd5e1",
      text: "#111827",
      textMuted: "#4b5563",
      textInverse: "#ffffff",
      accent: "#2563eb",
      accentHover: "#1d4ed8",
      accentPressed: "#1e40af",
      accentEnd: "#1d4ed8",
      accentBorder: "#2563eb80",
      accentGlow: "#2563eb33",
      highlight: "#b45309",
      successSurface: "#dcfce7",
      track: "#0f172a1f",
      selection: "#2563eb26",
      backdrop: "#0f172a66",
      shadow: "#0f172a33",
      tooltip: "#111827",
      tooltipText: "#f9fafb",
      trail: "#f59e0bcc",
      positive: "#16a34a",
      negative: "#dc2626",
      sweep: "#0f172a99",
    },
  },
};

export const HIGH_CONTRAST_THEME: ThemeDefinition = {
  name: "high-contrast",
  kind: "high-contrast",
  extends: "dark",
  tokens: {
    color: {
      background: "#000000",
      surface: "#000000",
      surfaceAlt: "#000000",
      surfaceHover: "#1a1a1a",
      surfacePressed: "#333333",
      border: "#ffffff",
      text: "#ffffff",
      textMuted: "#ffffff",
      textInverse: "#000000",
      accent: "#ffff00",
      accentHover: "#ffff66",
      accentPressed: "#cccc00",
      accentText: "#000000",
      accentEnd: "#ffff00",
      accentBorder: "#ffff00",
      accentGlow: "#00000000",
      highlight: "#ffff00",
      successSurface: "#000000",
      danger: "#ff6b6b",
      track: "#333333",
      selection: "#ffff0066",
      backdrop: "#000000e6",
      shadow: "#00000000",
      tooltip: "#ffffff",
      tooltipText: "#000000",
      mark: "#000000",
      thumb: "#ffff00",
    },
    number: { border: 2, focus: 3 },
  },
};

/**
 * Default theme: warm near-black surfaces, cream text, tan secondary text and an ember-orange accent
 * (a dusty-planet palette). Text contrast is AA or better on its surfaces (pinned by uiStyle tests).
 */
export const FRONTIER_THEME: ThemeDefinition = {
  name: "frontier",
  kind: "dark",
  extends: "dark",
  tokens: {
    color: {
      background: "#0c0907",
      surface: "#15100d",
      surfaceAlt: "#1c1612",
      surfaceHover: "#2a211b",
      surfacePressed: "#100c0a",
      border: "#3a2c22",
      text: "#f3e9dc",
      textMuted: "#a8968a",
      textInverse: "#1c0f06",
      accent: "#f98b47",
      accentHover: "#ff9d5e",
      accentPressed: "#de6c2a",
      accentText: "#1f1007",
      accentEnd: "#e3702e",
      accentBorder: "#f98b4766",
      accentGlow: "#f5853f59",
      highlight: "#f7c24a",
      danger: "#e2553e",
      dangerHover: "#ef6a52",
      success: "#7bc67e",
      successSurface: "#7bc67e14",
      warning: "#f2b24c",
      track: "#00000066",
      selection: "#f98b4729",
      backdrop: "#080504b8",
      shadow: "#000000a6",
      tooltip: "#f3e9dc",
      tooltipText: "#1c0f06",
      health: "#e2553e",
      healthLow: "#f98b47",
      shield: "#62b6d4",
      trail: "#f6d58acc",
      positive: "#7bc67e",
      negative: "#ef6a52",
      mark: "#1f1007",
      thumb: "#f3e9dc",
    },
    radius: { sm: 6, md: 10, lg: 18, pill: 999 },
    fontSize: { sm: 12, md: 15, lg: 18, xl: 26, xxl: 46 },
    number: { border: 1, focus: 2, controlHeight: 40, iconSize: 18 },
  },
};

/**
 * Default skin: letter-spaced uppercase labels on controls and headings, an orange gradient primary
 * button with a soft glow, outlined accent buttons, large rounded cards. Written in tokens, so it
 * works with every theme; under `frontier` it reads as a mission-control console.
 *
 * Extra variants it adds: `Label` `eyebrow` (small accent kicker over a heading), `stat` / `statLabel`
 * (a number over a spaced caption), `body` (also on `RichText`); `Button` `outline` (accent text and
 * border, no fill); `Panel` `inset` (a list row inside a card); `Badge` `status` (green outlined pill).
 */
export const FRONTIER_SKIN: SkinDefinition = {
  name: "frontier",
  version: 1,
  extends: "forge",
  components: {
    Label: {
      variants: {
        title: { fontSize: "$fontSize.xxl", fontWeight: 800, letterSpacing: 7, textTransform: "uppercase", lineHeight: 1.05 },
        heading: { fontSize: "$fontSize.xl", fontWeight: 800, letterSpacing: 3, textTransform: "uppercase" },
        eyebrow: { foreground: "$color.accent", fontSize: 11.5, fontWeight: 700, letterSpacing: 3.4, textTransform: "uppercase" },
        body: { foreground: "$color.textMuted", fontSize: "$fontSize.md", lineHeight: 1.6 },
        muted: { foreground: "$color.textMuted", fontSize: "$fontSize.md", lineHeight: 1.5 },
        caption: { foreground: "$color.textMuted", fontSize: "$fontSize.sm", letterSpacing: 1.2 },
        stat: { fontSize: 30, fontWeight: 800 },
        statLabel: { foreground: "$color.textMuted", fontSize: 10.5, fontWeight: 600, letterSpacing: 2.2, textTransform: "uppercase" },
      },
    },
    Panel: {
      background: "$color.surface",
      borderColor: "$color.border",
      radius: "$radius.lg",
      padding: 22,
      shadowColor: "$color.shadow",
      shadowBlur: 28,
      shadowOffsetY: 10,
      variants: { inset: { radius: "$radius.md", padding: [14, 14], shadowColor: "#00000000", shadowBlur: 0, shadowOffsetY: 0 } },
    },
    RichText: { variants: { body: { foreground: "$color.textMuted", fontSize: "$fontSize.md", lineHeight: 1.6 } } },
    ModalDialog: { padding: 24 },
    Button: {
      background: "$color.surfaceAlt",
      borderColor: "$color.border",
      radius: "$radius.md",
      padding: [12, 18],
      minHeight: 44,
      fontSize: 14,
      fontWeight: 700,
      letterSpacing: 2.2,
      textTransform: "uppercase",
      states: {
        hovered: { background: "$color.surfaceHover", borderColor: "$color.accentBorder" },
        pressed: { background: "$color.surfacePressed" },
      },
      variants: {
        primary: {
          background: "$color.accent",
          backgroundEnd: "$color.accentEnd",
          gradient: "vertical",
          borderColor: "$color.accentHover",
          foreground: "$color.accentText",
          shadowColor: "$color.accentGlow",
          shadowBlur: 24,
          shadowOffsetY: 4,
          states: { hovered: { background: "$color.accentHover" }, pressed: { background: "$color.accentPressed", backgroundEnd: "$color.accentPressed" } },
        },
        outline: {
          background: "#00000000",
          borderColor: "$color.accentBorder",
          foreground: "$color.accent",
          fontSize: "$fontSize.sm",
          letterSpacing: 1.8,
          padding: [8, 12],
          minHeight: 36,
          iconSize: 10,
          spacing: 6,
          states: { hovered: { background: "$color.selection", borderColor: "$color.accent" }, pressed: { background: "$color.surfacePressed" } },
        },
        danger: { background: "$color.danger", borderColor: "$color.danger", foreground: "#ffffff", states: { hovered: { background: "$color.dangerHover" } } },
        ghost: { background: "#00000000", borderColor: "#00000000", foreground: "$color.textMuted", states: { hovered: { background: "$color.surfaceHover", foreground: "$color.text" } } },
        // Navigation reads as tabs, not commands: mixed case, so six items fit beside the pickers.
        nav: { textTransform: "none", letterSpacing: 0.3, fontWeight: 600, padding: [8, 12], minHeight: 36, background: "#00000000", borderColor: "#00000000", foreground: "$color.textMuted", states: { hovered: { background: "$color.surfaceHover", foreground: "$color.text" }, checked: { background: "$color.selection", borderColor: "#00000000", foreground: "$color.accent" } } },
        menu: { letterSpacing: 1.5, fontSize: "$fontSize.sm", minHeight: 30 },
        crumb: { textTransform: "none", letterSpacing: 0, minHeight: 24, fontWeight: 600 },
        "crumb-current": { textTransform: "none", letterSpacing: 0, minHeight: 24 },
        choice: { textTransform: "none", letterSpacing: 0, fontWeight: 500 },
      },
    },
    IconButton: { padding: 6, letterSpacing: 0, minWidth: 34 },
    TabButton: { fontSize: "$fontSize.sm", letterSpacing: 2, padding: [9, 14], minHeight: 36, radius: [10, 10, 0, 0] },
    TabPages: { radius: [0, 12, 12, 12] },
    TextInput: { radius: "$radius.md", padding: [10, 12], minHeight: 40 },
    Dropdown: { radius: "$radius.md", padding: [9, 12] },
    Popup: { radius: "$radius.md" },
    NavigationBar: { background: "$color.background" },
    Badge: {
      variants: {
        status: { background: "$color.successSurface", foreground: "$color.success", borderColor: "$color.success", borderWidth: 1, padding: [6, 14], fontSize: "$fontSize.sm", letterSpacing: 2.5, textTransform: "uppercase" },
      },
    },
    CollapseHeader: { textTransform: "uppercase", letterSpacing: 2, fontSize: "$fontSize.sm" },
    NotificationToast: { radius: "$radius.md" },
    StatDisplay: { custom: { positive: "#7bc67e", negative: "#ef6a52" } },
  },
};

/** The previous default skin: rounded corners, soft shadows, token colours. */
export const FORGE_SKIN: SkinDefinition = {
  name: "forge",
  version: 1,
  components: {
    Element: { foreground: "$color.text", fontSize: "$fontSize.md", fontFamily: "$font.body", accent: "$color.accent", track: "$color.track", borderColor: "$color.border", iconSize: "$number.iconSize", spacing: "$space.sm" },
    Label: {
      variants: {
        heading: { fontSize: "$fontSize.xl", fontWeight: 700 },
        title: { fontSize: "$fontSize.xxl", fontWeight: 700 },
        strong: { fontWeight: 700 },
        muted: { foreground: "$color.textMuted", fontSize: "$fontSize.sm" },
        caption: { foreground: "$color.textMuted", fontSize: "$fontSize.sm" },
        eyebrow: { foreground: "$color.accent", fontSize: "$fontSize.sm", fontWeight: 700, letterSpacing: 1.5 },
        body: { foreground: "$color.textMuted", lineHeight: 1.45 },
        stat: { fontSize: "$fontSize.xl", fontWeight: 700 },
        statLabel: { foreground: "$color.textMuted", fontSize: "$fontSize.sm" },
        badge: { background: "$color.accent", foreground: "$color.accentText", radius: "$radius.sm", padding: [1, 6], fontSize: "$fontSize.sm", fontWeight: 700 },
      },
    },
    Panel: {
      background: "$color.surface",
      borderColor: "$color.border",
      borderWidth: "$number.border",
      radius: "$radius.lg",
      padding: "$space.lg",
      shadowColor: "$color.shadow",
      shadowBlur: 18,
      shadowOffsetY: 6,
      variants: { inset: { background: "$color.surfaceAlt", radius: "$radius.md", padding: "$space.md", shadowColor: "#00000000", shadowBlur: 0, shadowOffsetY: 0 } },
    },
    RichText: { variants: { body: { foreground: "$color.textMuted", lineHeight: 1.45 } } },
    ModalBackdrop: { background: "$color.backdrop" },
    ModalDialog: { padding: 20 },
    Tooltip: { background: "$color.tooltip", foreground: "$color.tooltipText", radius: "$radius.sm", padding: [6, 10], fontSize: "$fontSize.sm", shadowColor: "$color.shadow", shadowBlur: 8, shadowOffsetY: 2 },
    Control: {
      minHeight: "$number.controlHeight",
      transition: fast,
      states: {
        disabled: { opacity: 0.45 },
      },
    },
    Button: {
      background: "$color.surfaceAlt",
      borderColor: "$color.border",
      borderWidth: "$number.border",
      radius: "$radius.md",
      padding: [8, 14],
      textAlign: "center",
      fontWeight: 600,
      minWidth: 34,
      states: {
        hovered: { background: "$color.surfaceHover" },
        pressed: { background: "$color.surfacePressed" },
        checked: { background: "$color.selection", borderColor: "$color.accent" },
        selected: { background: "$color.selection", borderColor: "$color.accent" },
      },
      variants: {
        primary: { background: "$color.accent", borderColor: "$color.accent", foreground: "$color.accentText", states: { hovered: { background: "$color.accentHover" }, pressed: { background: "$color.accentPressed" } } },
        danger: { background: "$color.danger", borderColor: "$color.danger", foreground: "#ffffff", states: { hovered: { background: "$color.dangerHover" } } },
        ghost: { background: "#00000000", borderColor: "#00000000", textAlign: "start", states: { hovered: { background: "$color.surfaceHover" } } },
        nav: { background: "#00000000", borderColor: "#00000000", states: { hovered: { background: "$color.surfaceHover" }, checked: { background: "$color.selection", borderColor: "#00000000", foreground: "$color.accent" } } },
        menu: { background: "#00000000", borderColor: "#00000000", radius: "$radius.sm", padding: [6, 10], states: { hovered: { background: "$color.surfaceHover" }, expanded: { background: "$color.selection" } } },
        crumb: { background: "#00000000", borderColor: "#00000000", foreground: "$color.accent", padding: [4, 6], minHeight: 24, fontWeight: 400, states: { hovered: { background: "$color.surfaceHover" } } },
        "crumb-current": { background: "#00000000", borderColor: "#00000000", padding: [4, 6], minHeight: 24 },
        choice: { textAlign: "start", background: "$color.surfaceAlt" },
        outline: { background: "#00000000", borderColor: "$color.accentBorder", foreground: "$color.accent", states: { hovered: { background: "$color.selection", borderColor: "$color.accent" } } },
      },
    },
    IconButton: { padding: 8, minWidth: "$number.controlHeight" },
    TabButton: {
      background: "#00000000",
      borderColor: "#00000000",
      radius: [8, 8, 0, 0],
      foreground: "$color.textMuted",
      states: { hovered: { background: "$color.surfaceHover", foreground: "$color.text" }, selected: { background: "$color.surfaceAlt", borderColor: "$color.border", foreground: "$color.text" } },
    },
    TabStrip: { borderColor: "$color.border" },
    TabPages: { background: "$color.surfaceAlt", radius: [0, 8, 8, 8], padding: "$space.md" },
    Checkbox: { background: "$color.surfaceAlt", borderColor: "$color.border", borderWidth: 1.5, radius: "$radius.sm", custom: { mark: "#ffffff" }, states: { hovered: { borderColor: "$color.accent" } } },
    Switch: { custom: { mark: "#ffffff" } },
    RadioButton: { background: "$color.surfaceAlt", borderColor: "$color.border", states: { hovered: { borderColor: "$color.accent" } } },
    Slider: { borderWidth: 4, iconSize: 18 },
    RangeSlider: { borderWidth: 4, iconSize: 18 },
    RangeThumb: { minHeight: 0 },
    TextInput: {
      background: "$color.background",
      borderColor: "$color.border",
      borderWidth: "$number.border",
      radius: "$radius.md",
      padding: [8, 10],
      states: { hovered: { borderColor: "$color.textMuted" }, focused: { borderColor: "$color.accent" }, invalid: { borderColor: "$color.danger" } },
    },
    Dropdown: {
      background: "$color.surfaceAlt",
      borderColor: "$color.border",
      borderWidth: "$number.border",
      radius: "$radius.md",
      padding: [8, 10],
      states: { hovered: { background: "$color.surfaceHover" }, expanded: { borderColor: "$color.accent" } },
    },
    Popup: { background: "$color.surface", borderColor: "$color.border", borderWidth: "$number.border", radius: "$radius.md", padding: 4, shadowColor: "$color.shadow", shadowBlur: 16, shadowOffsetY: 6 },
    ListBox: { background: "$color.background", radius: "$radius.md", padding: 2 },
    ListItem: { padding: [4, 8], radius: "$radius.sm", states: { hovered: { background: "$color.surfaceHover" }, selected: { background: "$color.selection", foreground: "$color.text" }, disabled: { opacity: 0.45 } } },
    TreeView: { background: "$color.background", radius: "$radius.md", padding: 2 },
    MenuItem: { padding: [6, 10], radius: "$radius.sm", minHeight: 30, background: "#00000000", borderWidth: 0, states: { hovered: { background: "$color.surfaceHover" }, focused: { background: "$color.selection" } } },
    MenuSeparator: { borderColor: "$color.border" },
    MenuBar: { background: "$color.surface", borderColor: "$color.border", padding: [2, 4] },
    NavigationBar: { background: "$color.surface", padding: [4, 8], borderColor: "$color.border" },
    Separator: { borderColor: "$color.border", borderWidth: 1 },
    ProgressBar: { track: "$color.track", accent: "$color.accent", radius: "$radius.pill", minHeight: 10, fontSize: "$fontSize.sm" },
    CircularProgress: { borderWidth: 6, minWidth: 48, fontSize: "$fontSize.sm" },
    LoadingIndicator: { borderWidth: 3, minWidth: 24 },
    Badge: { background: "$color.accent", foreground: "$color.accentText", radius: "$radius.pill", padding: [2, 7], fontSize: "$fontSize.sm", fontWeight: 700, variants: { danger: { background: "$color.danger" }, success: { background: "$color.success" }, status: { background: "$color.successSurface", foreground: "$color.success", borderColor: "$color.success", borderWidth: 1, padding: [4, 10] } } },
    StatDisplay: { custom: { positive: "#4ade80", negative: "#f87171" } },
    StatusIndicator: { iconSize: 14 },
    ScrollView: { foreground: "$color.textMuted" },
    SplitDivider: { minWidth: 6, borderColor: "$color.border", minHeight: 0 },
    CollapseHeader: { padding: [6, 4], minHeight: 30, fontWeight: 600, background: "#00000000", borderWidth: 0, states: { hovered: { background: "$color.surfaceHover" } } },
    NotificationToast: {
      padding: [10, 14],
      radius: "$radius.md",
      borderWidth: 0,
      variants: {
        info: { background: "$color.surfaceAlt" },
        success: { background: "#14532d", borderColor: "$color.success", borderWidth: 1 },
        warning: { background: "#713f12", borderColor: "$color.warning", borderWidth: 1 },
        error: { background: "#7f1d1d", borderColor: "$color.danger", borderWidth: 1 },
      },
    },
    Drawer: { radius: 0 },
    CommandPalette: { padding: 12 },
    // Game
    ResourceBar: { minHeight: 16, radius: "$radius.sm", fontSize: "$fontSize.sm", fontWeight: 700, track: "#00000080", borderColor: "#00000099", borderWidth: 1, custom: { trail: "#fde68acc" } },
    HealthBar: { accent: "$color.health", states: { alert: { accent: "$color.healthLow" } } },
    ShieldBar: { accent: "$color.shield", minHeight: 10 },
    ResourceCounter: { fontWeight: 700, accent: "#fbbf24", custom: { positive: "#4ade80", negative: "#f87171" } },
    AbilityButton: { minWidth: 52, padding: 0, radius: "$radius.md", fontSize: "$fontSize.sm", states: { alert: { borderColor: "$color.accent" }, loading: { background: "$color.surfacePressed" } } },
    CooldownIndicator: { fontSize: "$fontSize.md", fontWeight: 700, custom: { sweep: "#000000b3" } },
    InventorySlot: { background: "#0000004d", borderColor: "$color.border", borderWidth: 1, radius: "$radius.sm", minWidth: 52, padding: 0, minHeight: 0, states: { hovered: { borderColor: "$color.textMuted" }, focused: { borderColor: "$color.accent" }, selected: { borderColor: "$color.accent", background: "$color.selection" } } },
    EquipmentSlot: { background: "#00000066" },
    ItemTooltip: { background: "$color.surface", padding: "$space.md", radius: "$radius.md", fontSize: "$fontSize.sm" },
    ObjectiveTracker: {},
    ObjectiveRow: { fontSize: "$fontSize.sm", iconSize: 14, accent: "$color.success", states: { alert: { foreground: "$color.success" } } },
    QuestTracker: {},
    MinimapContainer: { borderColor: "$color.border", borderWidth: 2, track: "#0f172a", imageTint: "#ffffff" },
    TargetHealthDisplay: { padding: "$space.sm", radius: "$radius.md", background: "#0b0f17cc", shadowBlur: 0, shadowColor: "#00000000" },
    InteractionPrompt: { fontSize: "$fontSize.md", fontWeight: 600, track: "#000000a6", accent: "$color.accent" },
    RadialMenu: { background: "$color.surface", accent: "$color.accent", iconSize: 22, fontWeight: 700 },
    DialogueBox: { background: "#0b0f17e6", padding: "$space.lg" },
    WorldSpaceLabel: {},
  } satisfies Record<string, ComponentSkin>,
};

/** Square corners, no shadows, tighter padding. */
export const FLAT_SKIN: SkinDefinition = {
  name: "flat",
  version: 1,
  extends: "forge",
  components: {
    Panel: { radius: 0, shadowColor: "#00000000", shadowBlur: 0, padding: "$space.md" },
    Button: { radius: 0, padding: [6, 12], borderWidth: 0 },
    TabButton: { radius: 0 },
    TabPages: { radius: 0 },
    TextInput: { radius: 0 },
    Dropdown: { radius: 0 },
    Popup: { radius: 0, shadowColor: "#00000000" },
    Checkbox: { radius: 0 },
    Tooltip: { radius: 0, shadowColor: "#00000000" },
    ProgressBar: { radius: 0 },
    ResourceBar: { radius: 0 },
    InventorySlot: { radius: 0 },
    NotificationToast: { radius: 0 },
    ListItem: { radius: 0 },
    MenuItem: { radius: 0 },
  },
};

/** Translucent gradient surfaces (works best over a 3D scene). */
export const GLASS_SKIN: SkinDefinition = {
  name: "glass",
  version: 1,
  extends: "forge",
  components: {
    Panel: { background: "#ffffff1f", backgroundEnd: "#ffffff0a", gradient: "vertical", borderColor: "#ffffff40", shadowBlur: 24 },
    Button: {
      background: "#ffffff26",
      backgroundEnd: "#ffffff0d",
      gradient: "vertical",
      borderColor: "#ffffff4d",
      radius: "$radius.pill",
      states: { hovered: { background: "#ffffff40" }, pressed: { background: "#ffffff14" } },
    },
    TextInput: { background: "#0000004d", borderColor: "#ffffff40", radius: "$radius.pill" },
    Dropdown: { background: "#ffffff26", borderColor: "#ffffff4d", radius: "$radius.pill" },
    Popup: { background: "#151b26f2" },
    TabPages: { background: "#ffffff14" },
  },
};

export function registerBuiltinStyles(resolver: StyleResolver): void {
  resolver.registerTheme(DARK_THEME);
  resolver.registerTheme(FRONTIER_THEME);
  resolver.registerTheme(LIGHT_THEME);
  resolver.registerTheme(HIGH_CONTRAST_THEME);
  resolver.registerSkin(FORGE_SKIN);
  resolver.registerSkin(FRONTIER_SKIN);
  resolver.registerSkin(FLAT_SKIN);
  resolver.registerSkin(GLASS_SKIN);
}
