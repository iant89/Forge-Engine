/**
 * Registers every built-in widget with the component registry, with property descriptors for the
 * properties the declarative loader, the binder and the inspector may set by name.
 *
 * Third-party components register exactly the same way (`ui.components.register(...)`).
 */

import type { ComponentRegistry, PropertyDescriptor } from "../core/registry.js";
import type { UIElement } from "../core/element.js";
import { UIContainer } from "../core/container.js";
import { Canvas, CollapsiblePanel, Grid, HStack, Overlay, Panel, SafeArea, ScrollView, Separator, Spacer, SplitPane, Stack, VStack } from "./structural.js";
import { Badge, CircularProgress, Icon, Label, LoadingIndicator, NumericDisplay, ProgressBar, RichText, StatDisplay, StatusIndicator, UIImage } from "./display.js";
import { Button, Checkbox, IconButton, RadioButton, RadioGroup, RangeSlider, Slider, Switch, ToggleButton } from "./interactive.js";
import { TextArea, TextInput } from "./textInput.js";
import { ComboBox, Dropdown, ListBox, TreeView, VirtualizedGrid, VirtualizedList } from "./collections.js";
import { ConfirmationDialog, ContextMenu, Drawer, ModalDialog, NotificationToast, Popup } from "./overlays.js";
import { Breadcrumbs, CommandPalette, MenuBar, NavigationBar, TabButton, TabContainer } from "./navigation.js";
import { TooltipBubble } from "./overlayHosts.js";
import {
  AbilityButton,
  CooldownIndicator,
  DialogueBox,
  EquipmentSlot,
  HealthBar,
  Hotbar,
  InteractionPrompt,
  InventorySlot,
  ItemTooltip,
  MinimapContainer,
  ObjectiveTracker,
  QuestTracker,
  RadialMenu,
  ResourceBar,
  ResourceCounter,
  ShieldBar,
  TargetHealthDisplay,
} from "./game.js";

const P = {
  text: { name: "text", type: "string", affects: ["layout"], description: "Displayed text" } as PropertyDescriptor,
  textKey: { name: "textKey", type: "string", affects: ["layout"], description: "Localization key" } as PropertyDescriptor,
  icon: { name: "icon", type: "string", affects: ["layout", "render"], description: "Sprite or glyph-icon name" } as PropertyDescriptor,
  value01: { name: "value", type: "number", animatable: true, affects: ["render"], description: "Current value" } as PropertyDescriptor,
  checked: { name: "checked", type: "boolean", affects: ["style"], description: "Checked state" } as PropertyDescriptor,
  direction: { name: "direction", type: "enum", values: ["row", "column"], affects: ["layout"] } as PropertyDescriptor,
  gap: { name: "gap", type: "number", min: 0, affects: ["layout"], editor: { step: 1 } } as PropertyDescriptor,
  justify: { name: "justify", type: "enum", values: ["start", "center", "end", "space-between", "space-around", "space-evenly"], affects: ["layout"] } as PropertyDescriptor,
  align: { name: "align", type: "enum", values: ["start", "center", "end", "stretch"], affects: ["layout"] } as PropertyDescriptor,
  wrapFlex: { name: "wrap", type: "boolean", affects: ["layout"] } as PropertyDescriptor,
  opacity: { name: "opacity", type: "number", min: 0, max: 1, animatable: true, affects: ["render"] } as PropertyDescriptor,
  translateX: { name: "translateX", type: "number", animatable: true, affects: ["render"] } as PropertyDescriptor,
  translateY: { name: "translateY", type: "number", animatable: true, affects: ["render"] } as PropertyDescriptor,
  scale: { name: "scale", type: "number", min: 0.0001, animatable: true, affects: ["render"] } as PropertyDescriptor,
  min: { name: "min", type: "number", serializable: true } as PropertyDescriptor,
  max: { name: "max", type: "number", affects: ["render"] } as PropertyDescriptor,
  placeholder: { name: "placeholder", type: "string", affects: ["render"] } as PropertyDescriptor,
  title: { name: "title", type: "string", affects: ["layout"] } as PropertyDescriptor,
  items: { name: "items", type: "array", affects: ["layout"] } as PropertyDescriptor,
};

/** Properties every element has (merged into each registration). */
const COMMON: PropertyDescriptor[] = [P.opacity, P.translateX, P.translateY, P.scale, { name: "tooltip", type: "string", affects: ["render"] }];

function reg<O>(registry: ComponentRegistry, name: string, create: (o: O) => UIElement, props: PropertyDescriptor[], meta: { category: string; description: string; acceptsChildren?: boolean; aliases?: string[] }): void {
  registry.register<O>(name, {
    create,
    properties: [...COMMON, ...props],
    category: meta.category,
    description: meta.description,
    acceptsChildren: meta.acceptsChildren ?? false,
    aliases: meta.aliases,
    version: 1,
    plugin: "forge.ui.builtin",
  });
}

export function registerBuiltinComponents(r: ComponentRegistry): void {
  const S = "structural";
  const flex = [P.direction, P.gap, P.justify, P.align, P.wrapFlex];
  reg(r, "Container", (o) => new UIContainer(o as never), [], { category: S, description: "Plain container (children stacked over the content box)", acceptsChildren: true });
  reg(r, "Panel", (o) => new Panel(o as never), flex, { category: S, description: "Skinned surface; flex column", acceptsChildren: true });
  reg(r, "Stack", (o) => new Stack(o as never), flex, { category: S, description: "Flex container", acceptsChildren: true });
  reg(r, "HorizontalStack", (o) => new HStack(o as never), [P.gap, P.justify, P.align, P.wrapFlex], { category: S, description: "Flex row", acceptsChildren: true, aliases: ["HStack"] });
  reg(r, "VerticalStack", (o) => new VStack(o as never), [P.gap, P.justify, P.align], { category: S, description: "Flex column", acceptsChildren: true, aliases: ["VStack"] });
  reg(r, "Grid", (o) => new Grid(o as never), [{ name: "columns", type: "any" }, { name: "rows", type: "array" }, { name: "autoRows", type: "any" }, { name: "columnGap", type: "number", min: 0 }, { name: "rowGap", type: "number", min: 0 }, { name: "justifyItems", type: "enum", values: ["start", "center", "end", "stretch"] }, { name: "alignItems", type: "enum", values: ["start", "center", "end", "stretch"] }], { category: S, description: "Grid tracks, spans, auto-fill", acceptsChildren: true });
  reg(r, "Overlay", (o) => new Overlay(o as never), [{ name: "alignX", type: "enum", values: ["start", "center", "end", "stretch"] }, { name: "alignY", type: "enum", values: ["start", "center", "end", "stretch"] }], { category: S, description: "Children layered over each other", acceptsChildren: true });
  reg(r, "Canvas", (o) => new Canvas(o as never), [], { category: S, description: "Anchor (free-form) container", acceptsChildren: true });
  reg(r, "SafeArea", (o) => new SafeArea(o as never), flex, { category: S, description: "Pads content by the viewport safe-area insets", acceptsChildren: true });
  reg(r, "Spacer", (o) => new Spacer(o as never), [{ name: "size", type: "number", min: 0 }], { category: S, description: "Flexible empty space" });
  reg(r, "Separator", (o) => new Separator(o as never), [{ name: "orientation", type: "enum", values: ["horizontal", "vertical"] }], { category: S, description: "Thin rule" });
  reg(r, "ScrollView", (o) => new ScrollView(o as never), [{ name: "direction", type: "enum", values: ["vertical", "horizontal", "both"] }, { name: "scrollX", type: "number", animatable: true }, { name: "scrollY", type: "number", animatable: true }, { name: "showScrollbars", type: "boolean" }], { category: S, description: "Clipped scrolling content", acceptsChildren: true, aliases: ["ScrollContainer"] });
  reg(r, "SplitPane", (o) => new SplitPane(o as never), [{ name: "orientation", type: "enum", values: ["horizontal", "vertical"] }, { name: "ratio", type: "number", min: 0, max: 1, animatable: true }], { category: S, description: "Two panes with a draggable divider" });
  reg(r, "CollapsiblePanel", (o) => new CollapsiblePanel(o as never), [P.title, { name: "expanded", type: "boolean" }, { name: "animate", type: "boolean" }], { category: S, description: "Header toggling an animated body", acceptsChildren: true });
  reg(r, "TabContainer", (o) => new TabContainer(o as never), [], { category: S, description: "Tab strip over pages" });
  reg(r, "VirtualizedList", (o) => new VirtualizedList(o as never), [P.items, { name: "itemExtent", type: "number", min: 1 }, { name: "overscan", type: "number", min: 0 }], { category: S, description: "Recycling list (createItem/bindItem)" });
  reg(r, "VirtualizedGrid", (o) => new VirtualizedGrid(o as never), [P.items, { name: "cellWidth", type: "number", min: 1 }, { name: "cellHeight", type: "number", min: 1 }], { category: S, description: "Recycling grid (createItem/bindItem)" });

  const D = "display";
  reg(r, "Label", (o) => new Label(o as never), [P.text, P.textKey, { name: "textParams", type: "object" }, { name: "wrap", type: "enum", values: ["word", "char", "none"] }, { name: "maxLines", type: "number", min: 1 }, { name: "overflow", type: "enum", values: ["visible", "clip", "ellipsis"] }, { name: "align", type: "enum", values: ["start", "center", "end"] }, { name: "color", type: "color", affects: ["render"], animatable: true }], { category: D, description: "Text" });
  reg(r, "RichText", (o) => new RichText(o as never), [{ name: "markup", type: "string", affects: ["layout"] }], { category: D, description: "Text with [b] [color] [size] [icon] tags" });
  reg(r, "Image", (o) => new UIImage(o as never), [{ name: "source", type: "string", affects: ["layout"] }, { name: "fit", type: "enum", values: ["fill", "contain", "cover", "none"] }, { name: "tint", type: "color", animatable: true }], { category: D, description: "Texture or sprite" });
  reg(r, "Icon", (o) => new Icon(o as never), [P.icon, { name: "size", type: "number", min: 1 }, { name: "color", type: "color", animatable: true }], { category: D, description: "Sprite or glyph icon" });
  reg(r, "ProgressBar", (o) => new ProgressBar(o as never), [P.value01, P.min, P.max, { name: "indeterminate", type: "boolean" }, { name: "showLabel", type: "boolean" }, { name: "smoothing", type: "number", min: 0 }, { name: "orientation", type: "enum", values: ["horizontal", "vertical"] }], { category: D, description: "Linear progress" });
  reg(r, "CircularProgress", (o) => new CircularProgress(o as never), [P.value01, P.min, P.max, { name: "indeterminate", type: "boolean" }, { name: "showLabel", type: "boolean" }, { name: "size", type: "number", min: 8 }], { category: D, description: "Ring progress" });
  reg(r, "Badge", (o) => new Badge(o as never), [P.text, { name: "count", type: "number", min: 0 }], { category: D, description: "Pill with a short text or count" });
  reg(r, "Tooltip", (o) => new TooltipBubble((o as { text?: string }).text ?? ""), [P.text], { category: D, description: "Tooltip bubble (the manager shows one for `tooltip` text)" });
  reg(r, "StatDisplay", (o) => new StatDisplay(o as never), [{ name: "label", type: "string" }, { name: "labelKey", type: "string" }, { name: "value", type: "any" }, { name: "delta", type: "number" }], { category: D, description: "Label + value (+ delta)" });
  reg(r, "NumericDisplay", (o) => new NumericDisplay(o as never), [{ name: "value", type: "number", animatable: true }, { name: "format", type: "object" }, { name: "duration", type: "number", min: 0 }], { category: D, description: "Counting number" });
  reg(r, "LoadingIndicator", (o) => new LoadingIndicator(o as never), [{ name: "size", type: "number", min: 8 }], { category: D, description: "Spinner" });
  reg(r, "StatusIndicator", (o) => new StatusIndicator(o as never), [{ name: "status", type: "enum", values: ["online", "away", "busy", "offline", "error", "success", "warning"] }, { name: "label", type: "string" }], { category: D, description: "Coloured status dot" });

  const I = "interactive";
  const press = { name: "onPress", type: "any", serializable: false } as PropertyDescriptor;
  reg(r, "Button", (o) => new Button(o as never), [P.text, P.textKey, P.icon, { name: "iconAfter", type: "boolean" }, press], { category: I, description: "Push button" });
  reg(r, "IconButton", (o) => new IconButton(o as never), [P.icon, { name: "label", type: "string" }, press], { category: I, description: "Icon-only button" });
  reg(r, "ToggleButton", (o) => new ToggleButton(o as never), [P.text, P.icon, P.checked], { category: I, description: "Latching button" });
  reg(r, "TabButton", (o) => new TabButton(o as never), [P.text, P.icon], { category: I, description: "Tab strip button" });
  reg(r, "Checkbox", (o) => new Checkbox(o as never), [P.text, P.checked, { name: "indeterminate", type: "boolean" }], { category: I, description: "Check box" });
  reg(r, "Switch", (o) => new Switch(o as never), [P.text, P.checked], { category: I, description: "On/off switch" });
  reg(r, "RadioButton", (o) => new RadioButton(o as never), [P.text, { name: "value", type: "string" }, P.checked], { category: I, description: "Radio option (inside a RadioGroup)" });
  reg(r, "RadioGroup", (o) => new RadioGroup(o as never), [P.direction, P.gap, { name: "value", type: "string" }], { category: I, description: "Exclusive radio selection", acceptsChildren: true });
  reg(r, "Slider", (o) => new Slider(o as never), [P.value01, P.min, P.max, { name: "step", type: "number", min: 0 }, { name: "orientation", type: "enum", values: ["horizontal", "vertical"] }], { category: I, description: "Value slider" });
  reg(r, "RangeSlider", (o) => new RangeSlider(o as never), [P.min, P.max, { name: "step", type: "number", min: 0 }, { name: "low", type: "number" }, { name: "high", type: "number" }], { category: I, description: "Two-thumb range" });
  reg(r, "TextInput", (o) => new TextInput(o as never), [{ name: "value", type: "string" }, P.placeholder, { name: "maxLength", type: "number", min: 0 }, { name: "password", type: "boolean" }, { name: "readOnly", type: "boolean" }], { category: I, description: "Single-line text entry" });
  reg(r, "TextArea", (o) => new TextArea(o as never), [{ name: "value", type: "string" }, P.placeholder, { name: "rows", type: "number", min: 1 }], { category: I, description: "Multi-line text entry" });
  reg(r, "Dropdown", (o) => new Dropdown(o as never), [P.items, { name: "selectedIndex", type: "number" }, P.placeholder], { category: I, description: "Select one option from a popup list" });
  reg(r, "ComboBox", (o) => new ComboBox(o as never), [P.items, { name: "value", type: "string" }, P.placeholder], { category: I, description: "Text entry with suggestions" });
  reg(r, "ListBox", (o) => new ListBox(o as never), [P.items, { name: "selection", type: "enum", values: ["single", "multiple", "none"] }, { name: "selectedIndex", type: "number" }], { category: I, description: "Selectable virtualized list", aliases: ["SelectableList"] });
  reg(r, "TreeView", (o) => new TreeView(o as never), [{ name: "nodes", type: "array" }], { category: I, description: "Expandable hierarchy" });

  const O = "overlay";
  reg(r, "Popup", (o) => new Popup(o as never), [{ name: "placement", type: "enum", values: ["below", "above", "right", "left"] }], { category: O, description: "Anchored light-dismiss container", acceptsChildren: true });
  reg(r, "ModalDialog", (o) => new ModalDialog(o as never), [P.title, { name: "dismissable", type: "boolean" }, { name: "width", type: "number", min: 1 }], { category: O, description: "Modal dialog", acceptsChildren: true });
  reg(r, "ConfirmationDialog", (o) => new ConfirmationDialog(o as never), [P.title, { name: "message", type: "string" }, { name: "confirmText", type: "string" }, { name: "cancelText", type: "string" }, { name: "danger", type: "boolean" }], { category: O, description: "Confirm/cancel modal" });
  reg(r, "ContextMenu", (o) => new ContextMenu(o as never), [P.items], { category: O, description: "Command menu with submenus" });
  reg(r, "NotificationToast", (o) => new NotificationToast(o as never), [{ name: "message", type: "string" }, P.title, { name: "kind", type: "enum", values: ["info", "success", "warning", "error"] }, { name: "duration", type: "number", min: 0 }], { category: O, description: "Transient message" });
  reg(r, "Drawer", (o) => new Drawer(o as never), [{ name: "side", type: "enum", values: ["left", "right"] }, { name: "width", type: "number", min: 1 }, P.title], { category: O, description: "Edge-docked modal panel", acceptsChildren: true });
  reg(r, "NavigationBar", (o) => new NavigationBar(o as never), [P.items, { name: "current", type: "string" }], { category: O, description: "Destinations; collapses to a drawer when compact" });
  reg(r, "Breadcrumbs", (o) => new Breadcrumbs(o as never), [{ name: "path", type: "array" }, { name: "separator", type: "string" }], { category: O, description: "Path segments" });
  reg(r, "MenuBar", (o) => new MenuBar(o as never), [{ name: "menus", type: "array" }], { category: O, description: "Top-level menus" });
  reg(r, "CommandPalette", (o) => new CommandPalette(o as never), [{ name: "commands", type: "array" }, P.placeholder], { category: O, description: "Fuzzy command search" });

  const G = "game";
  const bar = [P.value01, P.max, { name: "showValues", type: "boolean" }, { name: "lowThreshold", type: "number", min: 0, max: 1 }] as PropertyDescriptor[];
  reg(r, "ResourceBar", (o) => new ResourceBar(o as never), bar, { category: G, description: "Value/max bar with damage trail" });
  reg(r, "HealthBar", (o) => new HealthBar(o as never), bar, { category: G, description: "Health bar" });
  reg(r, "ShieldBar", (o) => new ShieldBar(o as never), bar, { category: G, description: "Shield bar" });
  reg(r, "ResourceCounter", (o) => new ResourceCounter(o as never), [P.icon, { name: "value", type: "number" }], { category: G, description: "Icon + animated count" });
  reg(r, "CooldownIndicator", (o) => new CooldownIndicator(o as never), [{ name: "showSeconds", type: "boolean" }], { category: G, description: "Radial cooldown sweep" });
  reg(r, "AbilityButton", (o) => new AbilityButton(o as never), [P.icon, { name: "hotkey", type: "string" }, { name: "cooldown", type: "number", min: 0 }, { name: "cost", type: "number", min: 0 }], { category: G, description: "Ability with cooldown" });
  reg(r, "InventorySlot", (o) => new InventorySlot(o as never), [{ name: "item", type: "object" }], { category: G, description: "Drag-and-drop item slot" });
  reg(r, "EquipmentSlot", (o) => new EquipmentSlot(o as never), [{ name: "item", type: "object" }, { name: "slotType", type: "string" }], { category: G, description: "Typed item slot" });
  reg(r, "ItemTooltip", () => new ItemTooltip(), [], { category: G, description: "Rich item tooltip" });
  reg(r, "ObjectiveTracker", (o) => new ObjectiveTracker(o as never), [{ name: "objectives", type: "array" }], { category: G, description: "Objectives with progress" });
  reg(r, "QuestTracker", (o) => new QuestTracker(o as never), [], { category: G, description: "Quests with objectives" });
  reg(r, "MinimapContainer", (o) => new MinimapContainer(o as never), [{ name: "map", type: "string" }, { name: "zoom", type: "number", min: 0.01, max: 1 }, { name: "circular", type: "boolean" }, { name: "size", type: "number", min: 16 }], { category: G, description: "Map window with markers" });
  reg(r, "TargetHealthDisplay", (o) => new TargetHealthDisplay(o as never), [{ name: "target", type: "object" }], { category: G, description: "Target name/level/health" });
  reg(r, "InteractionPrompt", (o) => new InteractionPrompt(o as never), [{ name: "key", type: "string" }, { name: "action", type: "string" }, { name: "hold", type: "number", min: 0, max: 1, animatable: true }], { category: G, description: "Key + action prompt" });
  reg(r, "RadialMenu", (o) => new RadialMenu(o as never), [P.items, { name: "size", type: "number", min: 32 }], { category: G, description: "Wedge menu" });
  reg(r, "DialogueBox", (o) => new DialogueBox(o as never), [{ name: "speed", type: "number", min: 0 }], { category: G, description: "Typewriter dialogue with choices" });
  reg(r, "Hotbar", (o) => new Hotbar(o as never), [{ name: "abilities", type: "array" }], { category: G, description: "Numbered ability row" });
}
