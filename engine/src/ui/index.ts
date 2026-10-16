/**
 * Forge UI — retained-mode, engine-native UI framework (docs/UI.md, docs/UI-GUIDE.md).
 *
 * Everything here runs without a GPU; `UIGpuRenderer` (ui/gpu) draws a manager's output as one
 * render-graph pass after the frame's tonemap.
 */

// Core
export { UIRect, UIViewport, ZERO_INSETS, toInsets, toCorners, insetsEqual, type UISize, type UIPoint, type UIInsets, type UICorners, type InsetsInput, type CornersInput } from "./core/geometry.js";
export { rgba, parseColor, tryParseColor, colorToHex, lerpColor, withAlpha, colorR, colorG, colorB, colorA, relativeLuminance, contrastRatio, TRANSPARENT, WHITE, BLACK, type UIColor, type ColorInput } from "./core/color.js";
export { UIElement, DETACHED_STYLE, LAYOUT_COUNTERS, type UIElementOptions, type AccessibilityInfo, type PointerEventsMode } from "./core/element.js";
export { UIContainer, type UIContainerOptions } from "./core/container.js";
export { UI_LAYERS, type UIContext, type UILayerName, type UIFocusService, type UIOverlayService, type UIStyleService } from "./core/context.js";
export { ComponentRegistry, validateProperty, BASE_OPTION_KEYS, type ComponentRegistration, type PropertyDescriptor, type PropertyType, type RegisteredComponent, type ConflictPolicy } from "./core/registry.js";

// Layout
export { parseLength, px, resolveLength, lengthToString, AUTO, LengthUnit, type Length, type LengthInput, type LayoutPropsInput, type CompiledLayoutProps, type LayoutStrategy, type LayoutContext, type LayoutNode, type Align, type Justify, type AnchorInput } from "./layout/types.js";
export { FlexLayout, type FlexOptions } from "./layout/flex.js";
export { GridLayout, parseTrack, type GridOptions, type TrackInput } from "./layout/grid.js";
export { AnchorLayout, placeAnchored } from "./layout/anchor.js";
export { StackLayout } from "./layout/stack.js";

// Style
export { UIState, BUILTIN_STATES, FIRST_CUSTOM_STATE_BIT, TRANSITION_PROPERTIES, type ResolvedStyle, type StyleBlock, type StatefulStyleBlock, type ComponentSkin, type SkinDefinition, type ThemeDefinition, type ThemeTokens, type TransitionDefinition, type TransitionProperty, type Easing, type GradientDirection, type TextAlign } from "./style/types.js";
export { StyleResolver, StateRegistry, DEFAULT_STYLE, validateSkin, validateTheme } from "./style/resolver.js";
export { DARK_THEME, LIGHT_THEME, HIGH_CONTRAST_THEME, FORGE_SKIN, FLAT_SKIN, GLASS_SKIN, registerBuiltinStyles } from "./style/builtins.js";

// Input
export {
  UIEvent,
  UIPointerEvent,
  UIWheelEvent,
  UIKeyEvent,
  UITextEvent,
  UIFocusEvent,
  UINavigateEvent,
  UIActionEvent,
  UIDragEvent,
  UICustomEvent,
  EventPhase,
  NO_MODIFIERS,
  dispatchUIEvent,
  type Modifiers,
  type PointerType,
  type NavigationDirection,
  type InputSource,
  type UIEventListener,
  type UIEventMap,
} from "./input/events.js";
export { InputRouter, type GamepadButton, type InputTraceEntry } from "./input/router.js";
export { FocusManager } from "./input/focus.js";
export { attachDomInput, type DomInputOptions, type DomInputHandle, type DomEventTargetLike } from "./input/domAdapter.js";

// Text
export { TextEngine, type TextEngineStats } from "./text/textEngine.js";
export { layoutText, hitTestText, isIdeographic, type TextLayoutParams, type TextLayoutResult, type TextLine, type WrapMode, type TextOverflow } from "./text/textLayout.js";
export { ForgeSansFace, DynamicGlyphFace, UIAtlasPage, createCanvasRasterizer, type UIFontFace, type GlyphInfo, type GlyphRasterizer } from "./text/font.js";
export { Localizer, pseudoLocalize, type StringTable, type PluralForms } from "./text/localization.js";

// Animation & data
export { UIAnimator, AnimationHandle, AnimationGroup, EASINGS, type AnimationOptions, type AnimationState, type EasingFn } from "./anim/animator.js";
export { Observable, Computed, ObservableStore, Binder, Binding, batch, observable, computed, type BindingOptions, type BindingSource, type FieldSource, type Subscribable } from "./data/binding.js";

// Rendering (renderer-independent)
export { UIDrawList, DrawListPainter, INSTANCE_FLOATS, INSTANCE_BYTES, PrimitiveKind, type DrawBatch, type DrawListStats, type ImageSource, type ImageResolver } from "./render/drawList.js";
export { UIAssets, BUILTIN_GLYPH_ICONS, type UITextureSource, type SpriteDef, type GlyphIcon } from "./render/assets.js";
export type { UIPainter, BoxPaint, ImagePaint } from "./render/painter.js";

// Manager, responsive, diagnostics, declarative, world space
export { UIManager, type UIManagerOptions, type UIFrameStats, type UIDiagnostic } from "./manager.js";
export { BreakpointSet, ResponsiveProfile, computeUiScale, DEFAULT_BREAKPOINTS, type Breakpoint, type ResponsiveRule, type ResponsiveRules, type ScaleMode } from "./responsive.js";
export { UIDiagnostics, type InspectNode, type LayoutIssue, type AccessibilityNode, type DebugOverlayOptions } from "./diagnostics.js";
export { buildUI, validateUIDefinition, UI_DEFINITION_VERSION, type UIDefinition, type UIBuildContext, type UIBuildResult } from "./declarative.js";
export { projectToViewport, distanceFade, type WorldPoint, type ProjectedPoint, type WorldCamera } from "./worldSpace.js";

// Widgets
export { UIControl, TextPart, RangeModel, SelectionModel, ScrollModel, activate, nearestControl, attachScrolling, type UIControlOptions, type TextPartOptions } from "./widgets/base.js";
export { Panel, Stack, HStack, VStack, Grid, Overlay, Canvas, SafeArea, Spacer, Separator, ScrollView, SplitPane, SplitDivider, CollapsiblePanel, type StackOptions, type GridWidgetOptions, type ScrollViewOptions } from "./widgets/structural.js";
export { Label, RichText, UIImage, Icon, ProgressBar, CircularProgress, LoadingIndicator, Badge, StatDisplay, NumericDisplay, StatusIndicator, formatNumber, paintIcon, type LabelOptions, type ProgressOptions, type ImageFit, type NumericFormat, type Status } from "./widgets/display.js";
export { Button, IconButton, ToggleButton, Checkbox, Switch, RadioButton, RadioGroup, Slider, RangeSlider, RangeThumb, type ButtonOptions, type SliderOptions } from "./widgets/interactive.js";
export { TextInput, TextArea, MemoryClipboard, type TextInputOptions, type Clipboard } from "./widgets/textInput.js";
export { VirtualizedList, VirtualizedGrid, ListBox, SelectableList, ListItem, TreeView, Dropdown, ComboBox, toItemData, type VirtualizedOptions, type ListItemData, type ListItemInput, type ListBoxOptions, type TreeNode, type DropdownOptions } from "./widgets/collections.js";
export { Popup, ModalDialog, ConfirmationDialog, ContextMenu, MenuItem, NotificationToast, Toasts, Drawer, type Placement, type MenuItemDef, type ModalDialogOptions, type ToastKind } from "./widgets/overlays.js";
export { TabButton, TabContainer, NavigationBar, Breadcrumbs, MenuBar, CommandPalette, fuzzyScore, type NavItem, type MenuDef, type Command } from "./widgets/navigation.js";
export { ModalHost, TooltipBubble } from "./widgets/overlayHosts.js";
export {
  ResourceBar,
  HealthBar,
  ShieldBar,
  ResourceCounter,
  CooldownIndicator,
  AbilityButton,
  InventorySlot,
  EquipmentSlot,
  ItemTooltip,
  ObjectiveTracker,
  QuestTracker,
  MinimapContainer,
  WorldSpaceLabel,
  TargetHealthDisplay,
  InteractionPrompt,
  RadialMenu,
  DialogueBox,
  Hotbar,
  RARITY_COLORS,
  type ResourceBarOptions,
  type AbilityButtonOptions,
  type InventoryItem,
  type InventorySlotOptions,
  type DragPayload,
  type Objective,
  type MapMarker,
  type WorldSpaceLabelOptions,
  type TargetInfo,
  type RadialItem,
} from "./widgets/game.js";
export { registerBuiltinComponents } from "./widgets/registerBuiltins.js";
