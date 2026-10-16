/**
 * Built-in themes and skins.
 *
 * Themes (tokens only): `dark` (default), `light`, `high-contrast` (WCAG AAA text contrast, thick
 * focus and borders, no translucency). Skins (construction only, written in tokens): `forge`
 * (rounded, soft shadows — the default), `flat` (extends forge: square corners, no shadows, tighter
 * padding) and `glass` (extends forge: translucent gradient surfaces). Any theme works with any skin;
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

/** Default skin: rounded corners, soft shadows, token colours. */
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
        badge: { background: "$color.accent", foreground: "$color.accentText", radius: "$radius.sm", padding: [1, 6], fontSize: "$fontSize.sm", fontWeight: 700 },
      },
    },
    Panel: { background: "$color.surface", borderColor: "$color.border", borderWidth: "$number.border", radius: "$radius.lg", padding: "$space.lg", shadowColor: "$color.shadow", shadowBlur: 18, shadowOffsetY: 6 },
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
    Badge: { background: "$color.accent", foreground: "$color.accentText", radius: "$radius.pill", padding: [2, 7], fontSize: "$fontSize.sm", fontWeight: 700, variants: { danger: { background: "$color.danger" }, success: { background: "$color.success" } } },
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
  resolver.registerTheme(LIGHT_THEME);
  resolver.registerTheme(HIGH_CONTRAST_THEME);
  resolver.registerSkin(FORGE_SKIN);
  resolver.registerSkin(FLAT_SKIN);
  resolver.registerSkin(GLASS_SKIN);
}
