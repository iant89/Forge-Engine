# Forge UI — developer guide

How to build interfaces with the engine's retained-mode UI framework. `docs/UI.md` explains the
architecture and the decisions behind it; this file is the practical reference: setup, the element
model, layout, widgets, skins and themes, input, animation, binding, text, declarative UI,
diagnostics, performance and limitations. Every API named here is exported from `@forge/engine`.

The runnable reference is the gallery demo: `npm run demo`, then open `?scene=ui` (aliases
`ui-gallery`, `widgets`; `&uipage=settings|hud|inventory|widgets|data`, `&uiskin=`, `&uitheme=`).
Its source is `examples/src/ui/uiGallery.ts`, and `tests/examples/uiGallery.test.ts` drives it.

## 1. Setup

```ts
import { UIManager, UIGpuRenderer, attachDomInput, VStack, Button, Label } from "@forge/engine";

const dpr = Math.min(2, devicePixelRatio);
const ui = new UIManager({ width: canvas.width, height: canvas.height, devicePixelRatio: dpr });
const uiRenderer = new UIGpuRenderer(engine.gpu, ui);
const overlay = engine.renderer.addOverlay(uiRenderer); // forge.ui pass, after tonemap, loads the swapchain
const input = attachDomInput(canvas, ui.router, ui.viewport); // pointer, wheel, keyboard, text, gamepad

const menu = ui.base.add(new VStack({ gap: 8, layout: { padding: 24 } }));
menu.add(new Label({ text: "Forge", variant: "title" }));
menu.add(new Button({ text: "Play", variant: "primary", onPress: () => startGame() }));

engine.onUpdate((dt) => {
  input.pollGamepads();
  ui.update(dt); // styles, animation, layout; the renderer calls ui.render() when it records
});
```

Teardown is explicit: `overlay.dispose(); input.dispose(); uiRenderer.dispose(); ui.dispose();`.
When the canvas is resized call `ui.setViewport(width, height, dpr)` (the GPU backend also follows
the swapchain size on its own so drawing and hit testing never disagree).

Without a GPU (tests, servers, tools) the same `UIManager` runs on Node: `ui.update(dt)` then
`ui.render()` returns the `UIDrawList` the GPU backend would upload.

`UIManagerOptions`: `width`, `height`, `devicePixelRatio`, `uiScale`, `scaleMode`, `textScale`,
`theme`, `skin`, `breakpoints`, `breakpointHysteresis`, `reducedMotion`, `tooltipDelay`,
`maxLayoutPasses`, `bare` (no built-in widgets/skins).

## 2. Elements, containers and lifetime

* `UIElement` is the base of everything: bounds, visibility, enabled state, opacity, translate/scale
  render transforms, `variant`, per-instance `style`, `tooltip`, `accessibility`, `focusable`,
  `tabIndex`, events (`on(type, fn)` returns a `Disposable`), and the measure/arrange/paint hooks.
* `UIContainer` holds children (`add`, `insert`, `remove`, `clear`) and a layout strategy.
* Layers: `ui.base`, and `ui.layer("hud" | "modal" | "popup" | "tooltip" | "toast" | "debug")`,
  painted in that order and hit-tested in reverse.
* `dispose()` is recursive and final: listeners, bindings (`element.own(disposable)`), animations,
  focus, pointer capture and hover are released, and the element leaves its parent. `remove(child)`
  only detaches; the child can be re-added.
* Invalidation is automatic: setters call `invalidateStyle`, `invalidateLayout` or
  `invalidateRender`, and the next `ui.update` does only the dirty work. An element with a fixed
  size is a *layout boundary*: changes inside it do not re-measure its ancestors.

## 3. Layout

Lengths are numbers (logical units), `"auto"`, `"50%"`, `"30vw"`/`"30vh"`. Every element accepts
`layout: { width, height, minWidth, maxWidth, minHeight, maxHeight, aspectRatio, margin, padding,
flexGrow, flexShrink, flexBasis, alignSelf, justifySelf, position: "absolute", anchor: { left, top,
right, bottom, centerX, centerY }, column, row, columnSpan, rowSpan, zIndex }`.

| Container | Strategy |
| --- | --- |
| `Stack` / `VStack` / `HStack` / `Panel` | flex: `direction`, `gap`, `justify` (start/center/end/space-between/space-around/space-evenly), `align` (start/center/end/stretch), `wrap` |
| `Grid` | tracks (`120`, `"auto"`, `"1fr"`, `"minmax(…)"`), `{ autoFill: cellMin }`, `columnGap`/`rowGap`, explicit placement and spans |
| `Overlay` | children stacked on top of each other, aligned by `alignX`/`alignY` |
| `Canvas` / any container with `position: "absolute"` children | anchors to the parent's edges or centre |
| `ScrollView` | scrolls content (wheel, drag, scrollbar, keyboard, reveal-on-focus) |
| `SafeArea` | pads its content by `ui.setSafeArea({ top, … })` |
| `SplitPane` | two panes with a draggable divider (`ratio`) |

`ui.diagnostics.validateLayout()` reports invalid geometry, overlaps, overflow and elements below
their minimum size; layout that keeps invalidating itself is reported as non-converging with the
elements involved.

### Responsive layout

```ts
ui.responsive(sidebar, {
  compact: { visible: false },
  medium: { layout: { width: 220 } },
  default: { layout: { width: 300 } },
});
ui.responsive(grid, { compact: { apply: (g) => (g as Grid).setColumns(1) }, default: { apply: (g) => (g as Grid).setColumns(3) } });
```

Breakpoints (`compact ≥ 0`, `medium ≥ 640`, `expanded ≥ 1024` logical units by default, replace with
`setBreakpoints`) switch with hysteresis (12 units by default) so a window resting on a boundary does
not thrash. Leaving a breakpoint restores the element's own values. `ui.onBreakpointChange` and
`ui.onViewportChange` are signals.

**The UI scales with the viewport by default** (`DEFAULT_SCALE_MODE`): a layout authored for a
1280×720 (CSS pixel) window is drawn larger on larger screens at the same proportions — 1920×1080 →
×1.5, 2560×1440 → ×2, a 4K panel at 2× (1920×1080 CSS) → ×1.5, capped at ×3 — using the smaller of
the width and height ratios (`match: "expand"`), so the whole reference layout always fits on wide
or tall screens. It never scales *below* 1: phones, tablets and small windows keep their authored
text size and adapt through breakpoints instead (breakpoints read the logical width after scaling,
so a 1920×1080 window is still `expanded`). Because everything is laid out in logical units, a
resize changes only the scale — no layout work beyond the usual relayout — and input is divided by
the same scale the GPU multiplies by.

Change it with `new UIManager({ scaleMode: { referenceWidth, referenceHeight, match, min, max } })`
or `ui.setScaleMode(...)` — `match` is `"expand"`, `"shrink"` (the larger ratio) or a number in
[0, 1] (log-space blend: 0 follows width, 1 height). `uiScale: s` / `ui.setUiScale(s)` pin a fixed
scale (e.g. a player's "UI size" setting); `scaleMode: "fixed"` with no `uiScale` restores the old
unscaled behaviour. Text alone scales with `ui.textScale`.

## 4. Widgets

All are registered with `ui.components` (name, category, property descriptors) and usable from
code or declarative definitions.

* **Structural**: Container, Panel, Stack, VStack (VerticalStack), HStack (HorizontalStack), Grid,
  Overlay, Canvas, SafeArea, ScrollView, SplitPane, Spacer, Separator, CollapsiblePanel,
  TabContainer, VirtualizedList, VirtualizedGrid.
* **Display**: Label (wrap, max lines, ellipsis, `textKey` localization), RichText (`[b]`, `[color=]`,
  `[size=]`, `[icon=]`; unknown tags are shown, never executed), Icon, Image (fit, tint, nine-slice
  sprites), ProgressBar, CircularProgress, LoadingIndicator, Badge, StatusIndicator, NumericDisplay,
  StatDisplay, Tooltip.
* **Interactive**: Button, IconButton, ToggleButton, Checkbox (tri-state), RadioButton + RadioGroup,
  Switch, Slider, RangeSlider, TextInput (selection, clipboard, undo, password, filter, validate,
  max length), TextArea, Dropdown, ComboBox, ListBox (single/multiple selection, type-ahead),
  TreeView.
* **Overlays & navigation**: Popup, ModalDialog, ConfirmationDialog (`await dlg.ask(ui)`),
  ContextMenu (submenus), NotificationToast + `Toasts`, Drawer, NavigationBar (collapses to a drawer
  at chosen breakpoints), Breadcrumbs, MenuBar, CommandPalette (fuzzy search), TabButton.
* **Game**: HealthBar / ShieldBar / ResourceBar (damage trail, low alert), ResourceCounter
  (count-up, floating gains), CooldownIndicator, AbilityButton, Hotbar, InventorySlot and
  EquipmentSlot (drag and drop, accept/reject feedback, item tooltips), ItemTooltip,
  ObjectiveTracker, QuestTracker, MinimapContainer (markers, edge clamping), WorldSpaceLabel
  (follows a world point with distance fade and an occlusion callback), TargetHealthDisplay,
  InteractionPrompt (hold progress), DialogueBox (typewriter text, choices), RadialMenu.

### Writing a custom widget

```ts
class CompassStrip extends UIElement {
  static override styleName = "CompassStrip"; // skins style it by this name
  private _heading = 0;
  get heading() { return this._heading; }
  set heading(v: number) { this._heading = v; this.invalidateRender(); } // render-only change
  protected override measureContent() { return { width: 240, height: 28 }; }
  protected override paintContent(p: UIPainter, s: ResolvedStyle) {
    const b = this.contentRect;
    p.pushClip(b.x, b.y, b.width, b.height);
    // … p.fillRect, p.text(ctx.text.layout({...}), x, y, s.foreground), p.image, p.arc …
    p.popClip(); // every push needs its pop; an unbalanced hook is reported as an error
  }
}
ui.components.register("CompassStrip", {
  create: (o) => new CompassStrip(o),
  properties: [{ name: "heading", type: "number", animatable: true, affects: ["render"] }],
  category: "game",
});
```

`UIControl` adds focus, press handling (pointer, Enter/Space, gamepad A), hover/pressed states and
`onPress`; `TextPart` lays out and caches a text run for paint hooks. The full working example is
`CompassStrip` in `examples/src/ui/uiGallery.ts`.

## 5. Skins, themes and visual states

* A **theme** is a set of tokens: `{ name, extends?, kind?, tokens: { color, space, radius, font,
  size, … } }`, referenced from skins as `"$color.accent"`. Built in: **`frontier` (the default:
  warm near-black surfaces, cream text, tan secondary text, ember-orange accent)**, `dark` (cool slate
  and blue), `light`, `high-contrast`.
* A **skin** is per-component styling: `{ name, version, extends?, components: { Button: { …block,
  variants: { primary: {…} }, states: { hovered: {…}, pressed: {…} } } } }`. Built in: **`frontier`
  (the default: letter-spaced uppercase controls and headings, a vertical-gradient primary button
  with a soft glow, outlined accent buttons, large rounded cards)**, `forge` (mixed case, the base the
  others extend), `flat`, `glass`. Pick the old look with `new UIManager({ theme: "dark", skin:
  "forge" })`. A block sets background (solid or gradient), border, radius, padding, foreground,
  accent, track, font, letter spacing, `textTransform` (`"uppercase"` changes only what is drawn and
  measured; `text` and the accessible label keep their case), shadow, opacity, `image`
  (sprite/nine-slice) and `transition`.
* Variants every built-in skin defines (so they are safe to use whatever skin is active): `Label`
  `title`, `heading`, `eyebrow` (small accent kicker), `body`, `muted`, `caption`, `strong`, `stat` /
  `statLabel` (a number over a caption); `RichText` `body`; `Button` `primary`, `outline`, `danger`,
  `ghost`; `Panel` `inset` (a list row inside a card); `Badge` `status` (outlined green pill).
  `Button` also takes a `subtitle` (a smaller mixed-case second line, which is also its accessible
  description). The gallery's menu page and saved-expeditions card show all of them.
* Register with `ui.resolver.registerSkin(def)` / `registerTheme(def)`; switch at runtime with
  `ui.setSkin(name)` / `ui.setTheme(name)` (everything restyles; transitions animate). Unknown parents,
  `extends` cycles, unknown properties, unknown states and malformed colours are rejected at
  registration with a path to the problem.
* States: `hovered`, `focused`, `pressed`, `selected`, `checked`, `expanded`, `invalid`, `loading`,
  `alert`, `disabled`, plus application states from `ui.resolver.states.define("burning")` (define
  before a skin uses them).
* Precedence is fixed: defaults → component chain (generic to specific; each skin level over its
  parent) → variant → states in the order above → per-instance `style`. `ui.diagnostics.styleSources(el)`
  lists the blocks that contributed.

Sprite skins: `ui.assets.registerPixels(name, w, h, rgba)` (or `registerImage`, `loadImage`,
`registerGpuTexture`), then `ui.assets.registerSprite("frame", { texture, x, y, width, height, slice:
12 })` and use `image: "frame"` in a skin block. The gallery's `parchment` skin is the example.

## 6. Input, events and focus

* Events propagate capture → target → bubble: `pointerdown/up/move/enter/leave`, `click`
  (`clickCount` 2 also fires `dblclick`), `wheel`, `dragstart/dragenter/dragover/dragleave/drop/
  dragend` (with a `payload`), `keydown/keyup`, `textinput`, `focus/blur`,
  `navigate`, `activate`, `cancel`, and widget events (`press`, `change`, `select`, `toggle`,
  `close`, `submit`, …). `e.stopPropagation()`, `e.preventDefault()`.
* Pointer capture during presses and drags, mouse/touch/pen pointer types, drag thresholds,
  double-click timing and gamepad auto-repeat are handled by `InputRouter`; `attachDomInput` feeds it from the canvas (converting CSS pixels to
  logical units with the same scale the GPU uses).
* Focus: Tab/Shift+Tab follow `tabIndex` then tree order; arrows and the gamepad d-pad move
  spatially; Enter/Space/A activate; Escape/B cancel. Modals trap focus and restore it on close;
  a focused element that becomes hidden, disabled or removed hands focus to a sensible neighbour.
  The focus ring shows for keyboard/gamepad focus, not for clicks.
* Arrow keys belong to the UI only while something in it has focus (or a modal is open), so a game
  using arrows for movement keeps them otherwise; `router.keyDown(...)` returns whether the UI consumed
  the key.

## 7. Animation and transitions

```ts
ui.animator.animate(panel, { opacity: 1, translateY: 0 }, { duration: 0.25, easing: "easeOutCubic" });
const seq = ui.animator.sequence([() => ui.animator.animate(a, { scale: 1.1 }, { duration: 0.1 }), () => ui.animator.animate(a, { scale: 1 }, { duration: 0.1 })]);
```

Options: `duration`, `delay`, `easing` (named or a function), `repeat`, `yoyo`, `essential`
(runs under reduced motion), `onUpdate`, `onComplete`, `onCancel`. Animating a property cancels the
previous animation of the same property. Skin blocks can declare `transition: { duration, easing,
properties }` entries (a list) so state changes blend colours, radii, border width and opacity. `ui.reducedMotion = true` jumps
non-essential animations to their end; `ui.animator.timeScale` and `paused` affect UI time only.

## 8. Data binding

```ts
const player = new ObservableStore({ health: 82, maxHealth: 100 });
ui.bind(healthBar, "value", [player, "health"]);                               // one-way
ui.bind(volumeSlider, "value", [settings, "volume"], { mode: "two-way" });   // writes back on change
const text = computed([player.field("health"), player.field("maxHealth")], () => `${player.get("health")} HP`);
ui.bind(label, "text", text);
player.update({ health: 60 }); // batched: dependents update once
```

Bindings check that the target has the property (two-way bindings need an element that reports
edits with `change` events), convert with
`convert`/`convertBack`, and are owned by the target element (disposed with it).
`ui.binder.activeBindings` counts live bindings.

## 9. Text, fonts and localization

* The built-in **Forge Sans** SDF font (generated by `tools/gen-ui-font.py` from DejaVu Sans,
  `engine/src/ui/text/FONT-LICENSE.md`) covers printable ASCII and Latin-1 (Western European
  languages), typographic punctuation, €/™, arrows and the glyph icons widgets use. Other code points
  are drawn by the dynamic fallback face (`createCanvasRasterizer` in the browser), which rasterises
  them on demand into an atlas page. A code point no face can draw renders as `?` and is counted in
  `ui.text.stats.missingGlyphs`, so it is visible rather than silently blank.
* `ui.text.defineFamily(name, faces)` and `addFallback(family, face)` add families; `TextLayout`
  supports wrapping (word/char), max lines, ellipsis, alignment, line height and synthetic bold.
* Localization: `ui.localizer.addTable("de", {...})`, `setLocale("de", ["en"])`, `t(key, params)`
  with `{name}` interpolation and plural forms; widgets with `textKey` update on locale change.
  `localizer.pseudo = true` produces expanded pseudo-locale text to find truncation.

## 10. Declarative UI

```ts
const result = buildUI({
  type: "VStack", props: { gap: 8 },
  children: [
    { type: "Button", id: "play", props: { text: "Play" }, on: { press: "play" } },
    { type: "Slider", bind: { value: { source: "settings.volume", mode: "two-way" } } },
    { type: "Button", props: { text: "Quit" }, responsive: { compact: { visible: false } } },
  ],
}, { ui, handlers: { play: () => start() }, stores: { settings } });
ui.base.add(result.root);
const next = result.replace(editedDefinition); // hot reload in place
```

Definitions are data: functions are rejected, handlers and converters are looked up by name in the
build context, every component/property/layout/style/binding is validated against the registry
(`validateUIDefinition` reports every problem with a JSON path and a "did you mean" for typos), and
the version is checked.

## 11. Diagnostics

`ui.diagnostics`: `inspect(el)`, `dumpTree()`, `styleSources(el)`, `validateLayout()`,
`focusOrder()`, `renderOrder()`, `accessibilityTree()`, `resourceReport()`, `missingAssets`,
`startInputTrace()`/`stopInputTrace()`, and the debug overlay (`overlay.enabled`, bounds, padding,
focus order, hovered element, frame stats). `ui.lastFrame` has per-frame counters (style resolves,
layout passes, measures, arranges, draw instances/batches, active animations, update/render ms) and
`ui.messages` collects diagnostics (missing assets, unknown tags, non-converging layout, unbalanced
paint hooks). In the demo, `__forge.ui()` exposes the gallery's manager and renderer.

## 12. Performance

Measured with `npm run bench` (`benchmarks/src/ui.bench.ts`) on 2026-10-17 with the default
frontier theme and skin: Node 22.22.0, a 4-vCPU Intel Xeon @ 2.80 GHz cloud container, no GPU (the
headless pipeline produces the instance list the WebGPU backend uploads; GPU time is not included).
One run; runs on this shared host vary noticeably (the 2026-10-16 run of the forge skin measured
roughly twice these times), so read the table for proportions, not absolutes.

| Workload | Count | Total | Per item |
| --- | --- | --- | --- |
| Build + first layout, 1,000 buttons in a wrapping grid | 1,000 | 49.3 ms | 49 µs / button |
| Steady frame (`update` + `render`, nothing changed) | 300 frames | 0.49 ms | 1.6 µs / frame |
| Hover sweep (state change → restyle → transition → repaint) | 300 frames | 149 ms | 0.50 ms / frame |
| One label's text changes inside a fixed-size panel | 300 frames | 138 ms | 0.46 ms / frame |
| Viewport resize, full relayout of ~2,000 elements | 60 frames | 545 ms | 9.1 ms / frame |
| Draw-list rebuild only (1,000 buttons → 1,934 instances) | 200 | 63.2 ms | 0.32 ms / rebuild |
| Virtualized list, 100,000 rows, scrolled every frame | 600 frames | 69.8 ms | 0.12 ms / frame |
| Text layout, cache miss (SDF font, ~40-char strings) | 800 | 20.5 ms | 26 µs / string |
| Text layout, warmed cache hit | 800 | 1.7 ms | 2.2 µs / string |

What the guards (shape checks, not stopwatch thresholds) establish on every run:

* a steady frame does **0** measures, **0** style resolves and does not rebuild the draw list;
* a text change behind a layout boundary measures **1** element per frame against **2,015** for a
  full relayout;
* 1,000 skinned buttons with labels draw as **1** batch (solid primitives and SDF glyphs share the
  font atlas; only a different texture splits a batch);
* the 100,000-row list keeps **37** elements alive;
* after one untimed cache-branch warm-up, the timed pass over the same strings is served entirely
  from the text cache (the warm-up keeps JIT transition cost out of the cache-hit shape guard).

Reading the numbers: any render-dirty change rebuilds the whole draw list (0.3–1 ms per 1,000
buttons here, depending on the run), which is what dominates the hover and text-change rows; layout and style work in
those frames is local. Interfaces with many thousands of simultaneously visible widgets should
virtualize (`VirtualizedList`/`VirtualizedGrid`) or split static content into layers that do not
change. A window drag relayouts everything once per resize event.

## 13. Verification

| Gate | What it proves |
| --- | --- |
| `tests/ui/*.test.ts` (10 suites) | element tree, layout, styles, input, text, animation/binding, widgets, overlays/game widgets, manager (responsive, draw list, diagnostics, declarative), mock-GPU backend |
| `tests/examples/uiGallery.test.ts` | the gallery at six viewports (phone to 4K@2x) without overlaps or invalid geometry, keyboard and gamepad navigation, quit confirmation, all skin × theme combinations, virtualized filtering, inventory drag and drop, HUD bindings |
| `npm run check:wgsl` | `UI_SHADER` structure and the generated `UiFrame` uniform layout |
| `npm run check:browser:ui` | real WebGPU (headless Chromium + SwiftShader): the `forge.ui` pass runs with zero GPU errors, pages render differently, real mouse/keyboard input switches pages, focuses and closes dialogs, theme/skin switches change pixels, a phone viewport collapses the navigation without layout issues, hit testing agrees with drawn pixels, steady frames allocate no textures. Scoped: it is not part of the full `check:browser` gate. |
| `npm run bench` | the UI benchmark's shape guards (§12) |

## 14. Known limitations

See `docs/UI.md` §11: no bidirectional text or complex shaping, no IME composition, no rotated
elements, no native screen-reader bridge, world-space UI is projected 2D, no ColorPicker.
