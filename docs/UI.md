# Forge UI — architecture, as built

`engine/src/ui/` is Forge's retained-mode, engine-native UI framework: a component tree, a layout
engine (flex, grid, anchor, absolute, stack, scroll), a skin + theme system, a centralized input,
event and focus model, animation, data binding, text layout with a built-in signed-distance-field
font, and a WebGPU renderer that records one render-graph pass after the frame's tonemap. It
draws through WebGPU only: the browser DOM is never the rendering architecture. The demo's
optional DOM *input* adapter is the only place the UI touches a DOM API, and it only translates
pointer, keyboard and gamepad input into the router's device-independent calls.

This document is the Phase 1 deliverable (audit + plan) kept current as the system was built.
The user-facing guide (API reference, recipes) is [`UI-GUIDE.md`](UI-GUIDE.md).

---

## 1. Repository audit (2026-10-16, before any UI code)

| Question | What the repository actually had |
| --- | --- |
| Language / modules | Strict TypeScript, ESM, `.js` relative specifiers, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. One public barrel, `engine/src/index.ts`. |
| Lifecycle | `Engine.initialize → setScene → step()/start() → dispose()`. Every GPU object is released in a `dispose()`; the mock GPU's `outstanding` set is asserted empty by leak tests. |
| Rendering | WebGPU only (`lint:arch` rejects any WebGL mention). Every pass goes through `RenderGraph` (`engine/src/rendering/renderGraph.ts`), which validates reads/writes and culls passes whose outputs nobody consumes unless they write an imported texture. The swapchain is `bgra8unorm`/`rgba8unorm`, **not** an sRGB format; HDR frames end in `forge.tonemap`, LDR frames write `forge.main`/`forge.ldr.scale` straight to the swapchain. **No hook existed for adding a pass after the tonemap.** |
| Scene / ECS | `EntityWorld` with typed-array stores and systems; nothing UI-related. |
| Camera / coordinates | +Y up, left-handed view space, column-major `Mat4`, WebGPU `[0,1]` depth (AGENTS.md §3). Used by the world-space UI projection. |
| Input | **None in the engine.** Each demo control (`examples/src/controls/*.ts`) listens to DOM pointer events itself; the HUD and toolbar are DOM. |
| Text / fonts | **None.** No glyph atlas, no text measurement, no font asset type. |
| Textures / assets | `Texture` (`resources/texture.ts`), `ResourceRegistry` refcounting, glTF/KTX2 loaders. No sprite atlas or nine-slice concept. |
| Time | `Clock` (`core/time.ts`) gives `deltaTime`; systems receive `SystemContext.dt`. |
| Events | `EventTarget2`/`EventBus`/`Signal`/`DisposableGroup` in `core/events.ts`: zero-allocation emit, re-entrancy-safe add/remove, `Disposable` handles. |
| Diagnostics | `Profiler` scopes (`debug/profiler.ts`), `engine.stats()`, the demo HUD. |
| Tests | Repository-local **selrun**: each `tests/<area>/*.test.ts` has a JSDoc header plus an exported `suite` manifest with explicit `@covers`; `tests/full.test.ts` is the ordered link list with a `report(n)` count; `npm run test:check` validates all of it. Areas must be real repository directories. |
| Validation commands | `npm run typecheck`, `npm test`, `npm run test:check`, `npm run lint:arch`, `npm run check:wgsl`, `npm run docs:check`, `npm run check:browser*` (real WebGPU in headless Chromium + SwiftShader). |
| Existing UI code | None in the engine. The demo HUD/toolbar/profiler panel are DOM in `examples/`. ARCHITECTURE.md §4 already reserved a `ui` stage between tonemap and present. |

Baseline before the first UI change: `typecheck` clean, `lint:arch` OK (216 engine sources),
`test:check` OK (109 linked suites, 831 coverage claims), full `npm test` run recorded in the
Phase 1 report in `change-log.md`.

### 1.1 Reused engine capabilities

* `RenderGraph` + `GraphicsDevice` + `PipelineFactory`-style WGSL validation (`validateWgsl`, via `check:wgsl`).
* `core/events.ts` (`EventTarget2`, `Disposable`, `DisposableGroup`) for every subscription the UI hands out.
* `core/errors.ts` (`UsageError`) for misuse, `Logger`-compatible diagnostics.
* `math` (`Mat4`, `Vec3`) for world-space projection.
* `MockGPUDevice` for leak-checked GPU tests without a GPU.

### 1.2 Missing capabilities the UI had to add

| Missing | Added | Why it is not a competing system |
| --- | --- | --- |
| Pass after tonemap | `Renderer.addOverlay(overlay)` (`rendering/renderer.ts`) | The renderer still owns the graph; an overlay only declares one more pass on the imported swapchain with `loadOp: "load"`, validated like every other pass. |
| Text + fonts | `ui/text/*`: SDF font, `TextLayout`, glyph fallback chain | There was no text system to integrate with. |
| Input normalization | `ui/input/router.ts` + `ui/input/domAdapter.ts` | The engine had no input layer; the router is device-independent so a future `engine/src/input` can feed it unchanged. |

### 1.3 Systems deliberately left untouched

The forward renderer, shaders, scene/ECS stores, physics, vehicles, environment and scripting are not
modified. The only engine-side changes outside `engine/src/ui/` are the overlay seam in
`rendering/renderer.ts`, the barrel exports, the `lint:arch` rule for `ui`, and the WGSL gate entry.

### 1.4 Integration risks (and what was done about each)

| Risk | Mitigation |
| --- | --- |
| A UI pass that breaks the steady-frame `texturesCreated: 0` invariant | The UI pass creates no graph transients; it loads and stores the imported swapchain. Pinned by `tests/ui/uiGpu.test.ts`. |
| WebKit rejecting a relaxed uniform layout | The UI uniform is generated from a `StructDef`; the shader is in `check:wgsl`. |
| Colour-space mismatch | UI colours are display-referred sRGB values, written unmodified to the non-sRGB swapchain and blended there exactly as CSS blends them. The scene's "linear inside, encode at output" rule is about scene radiance; the UI runs after that encode. |
| Per-frame allocation | Draw list is a growable `Float32Array`; styles and text layouts are cached; a clean tree records nothing (`stats.drawListRebuilt === false`). |
| Pointer + touch double clicks | The router only accepts unified pointer events; the DOM adapter listens to Pointer Events only, never to mouse *and* touch. |
| Callbacks that dispose or reparent elements mid-dispatch | Propagation paths are snapshotted and every hop re-checks `disposed`/manager membership. |

### 1.5 Performance constraints

The engine targets 60 Hz in the browser with SwiftShader as the CI floor. The UI budget is: no
work at all for a clean tree (no layout, no style resolution, no draw-list rebuild, no upload), and
for dirty frames work proportional to the dirty subtrees (layout) or to visible elements (draw list).
Virtualized collections instantiate only visible rows plus overscan. Measurements are in
[§10](#10-performance-measured).

---

## 2. Module boundaries

```
engine/src/ui/
  core/        geometry, colour, element tree, container, registry, property metadata
  layout/      length parsing, constraints, strategies (flex, grid, anchor, stack), engine
  style/       theme tokens, skins, resolver + cache, visual states
  input/       UI events + propagation, router (hit test, capture, click, drag), focus, DOM adapter
  text/        font interface, built-in SDF font, fallback chain, text layout + cache, localization
  render/      draw list (typed-array instances, batching by texture), debug overlay
  gpu/         WebGPU backend: pipeline, WGSL, atlas uploads, render-graph overlay pass
  anim/        animator (tweens, easing, groups), binding (observables, binder)
  widgets/     structural, display, interactive, overlays/navigation, game
  manager.ts   UIManager: viewport, breakpoints, layers, per-frame pipeline, stats
  declarative.ts  JSON UI definitions (validated, no code execution)
  diagnostics.ts  inspector, layout validation, invalidation tracking, input trace
  worldSpace.ts   world → screen projection for world-anchored widgets
```

Dependency rule (enforced by `npm run lint:arch` and `tests/engine/architecture.test.ts`):

* `ui/**` (except `ui/gpu/**`) imports only `core`, `math` and `ui`. The whole framework runs and is
  tested on Node without a GPU.
* `ui/gpu/**` additionally imports `gpu` and `rendering` (the render-graph types and the overlay
  contract). Nothing outside `ui/gpu` imports it except the barrel.
* `rendering` never imports `ui`; the overlay contract (`RenderOverlay`) is defined in `rendering`
  and implemented by `ui/gpu`.

```
core ◄── math ◄── ui (core, layout, style, input, text, render, anim, widgets, manager)
  ▲                ▲
  │                │
 gpu ◄── rendering ◄── ui/gpu  (UIGpuRenderer implements RenderOverlay)
```

Inside `ui`: `core` ← `layout`, `style`, `text`, `render` ← `input` ← `anim` ← `widgets` ←
`manager`/`declarative`/`diagnostics`. Widgets never import the manager's internals; they reach
services through the `UIContext` interface the manager implements.

## 3. The frame

```
UIManager.update(dt)
  1. bindings: flush batched source changes into element properties
  2. animations: advance tweens (delta time, time scale, reduced motion)
  3. element update hooks (only elements that registered for ticks)
  4. responsive: breakpoint re-evaluation (only after a viewport change)
  5. styles: resolve the style-dirty set (cached per skin/theme/type/variant/state)
  6. layout: measure + arrange from the dirty roots only
  7. focus validation (focused element hidden/disabled/removed → recover)
UIManager.render(drawList)   (called by the GPU overlay when it records)
  8. if anything was render-dirty: rebuild the draw list in paint order; else reuse it
UIGpuRenderer.record(graph, swapchain)
  9. upload instances (only when rebuilt) + dirty atlas rows; one `forge.ui` pass, one draw per texture run
```

## 4. Phased roadmap (and status)

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Audit, boundaries, this document | done |
| 2 | Element tree, containers, lifecycle/disposal, invalidation, registry/factory, property metadata | done |
| 3 | Geometry, lengths, constraints, flex/grid/anchor/absolute/stack/scroll layout, caching | done |
| 4 | Themes, skins, inheritance + cycle detection, state styles, precedence, cache, runtime switching | done |
| 5 | Events + propagation, router, hit testing, capture, click/drag/double-click, focus, modal trap, gamepad | done |
| 6 | Widget library (see UI-GUIDE.md §Widgets for the list and what each one does) | done |
| 7 | Breakpoints with hysteresis, UI scale, text scale, safe areas, viewport changes | done |
| 8 | Animator, transitions, data binding, text layout, SDF font, fallback glyphs, localization | done |
| 9 | Draw list + batching, WebGPU overlay pass, debug overlay, counters, benchmark | done |
| 10 | Hardening, docs, examples, gates | done; limitations in §11 |

Each phase's engineering report is recorded in `change-log.md` (phase entries) and summarized in
`mnemosyne.md`.

## 5. Ownership and disposal

* An element is owned by its parent. `dispose()` is recursive, removes the element from its parent,
  releases its listeners, bindings, animations, focus, capture and hover, and leaves it permanently
  unusable (`UsageError` on `add`, `ObjectDisposed` state readable via `disposed`). Removing without
  disposing (`remove(child)`) detaches only; the child can be re-added elsewhere.
* The manager owns the root, layers, router, focus manager, animator, binder and resolver; `UIManager.dispose()` disposes all of them.
* Shared visual resources (fonts, textures, atlases, skins, themes) are owned by `UIAssets`
  (registered by name, refcounted by the GPU backend). Elements hold *names*, never GPU objects, so a
  skin or texture swap can never leave a dangling GPU reference in the tree.
* `UIGpuRenderer` owns every GPU object it creates and releases them in `dispose()`; the mock-GPU
  test asserts nothing is outstanding.

## 6. Style precedence (deterministic)

1. Framework fallback defaults (`DEFAULT_STYLE`).
2. The active skin's component style for the element's **style chain** (e.g. `IconButton → Button →
   Control`, most generic first), each skin level resolved through its `extends` chain (base first).
3. The element's named variant, if the skin defines one (`components.Button.variants.primary`).
4. State layers in a fixed order: `hovered`, `focused`, `pressed`, `selected`, `checked`, `expanded`,
   `invalid`, `loading`, `disabled`, then application-defined states in registration order. Later
   layers win per property; earlier layers' other properties survive (a focused + selected button
   keeps its selection colour unless the focused layer sets the same property). Variant state blocks
   apply after the base state blocks.
5. Per-instance overrides (`element.style = {...}`).

Token references (`"$color.accent"`, `"$space.md"`) are resolved against the active theme at step
time; a missing token produces one diagnostic per (skin, token) and falls back to the property's
default, not to an unrelated style. Skin and theme `extends` chains are validated for unknown parents
and cycles at registration.

## 7. Coordinates

* **Physical pixels**: the swapchain. **Logical units**: `physical / (devicePixelRatio × uiScale)`.
  All layout, hit testing and drawing are in logical units; the GPU backend multiplies by one
  scale in the vertex shader, and the input adapter divides by the same value, so rendering and hit
  testing cannot disagree (pinned by `tests/ui/uiManager.test.ts`).
* **Element-local**: `element.toLocal(x, y)` / `toGlobal`. Scroll offsets are applied by the scroll
  container to its content's arrangement, so `bounds` is always in viewport logical units.
* **World space**: `projectToViewport(world, viewProj, viewport)` (`ui/worldSpace.ts`), the same
  `Mat4` convention as the renderer.

## 8. Rendering

The draw list stores one 36-float instance per primitive (rect, gradient, border, per-corner radius,
SDF glyph, coverage glyph, image/nine-slice cell, arc, soft shadow), each carrying its own clip
rectangle. Clipping therefore never breaks a batch; only a texture change does. Instances are
recorded in paint order (parent before children, layers in order), and batches are consecutive
runs that share a texture, so translucent overlap order is never changed. The WGSL fragment shader
evaluates a rounded-box SDF for fills/borders/shadows, an arc SDF for circular progress, and the
glyph SDF threshold (with a weight bias for synthetic bold).

## 9. Accessibility

Every element carries `accessibility: { role, label, description }`; widgets fill sensible
defaults (`button`, `checkbox`, `slider` with value text…). `UIDiagnostics.accessibilityTree()`
exports that tree. **No native screen reader bridge exists** (Forge draws into one canvas); the
metadata is the documented extension point for one. Keyboard and gamepad navigation, focus
indicators, reduced motion, high-contrast theme and text scaling are implemented.

## 10. Performance (measured)

See `UI-GUIDE.md` §Performance for the benchmark table (`npm run bench`, `benchmarks/src/ui.bench.ts`),
including host and methodology. Numbers are never quoted without a run.

## 11. Known limitations

* No bidirectional text, complex-script shaping or ligatures. Text is laid out codepoint by codepoint
  with the built-in font's advances and fallback glyph sources; RTL scripts render in logical order.
* No IME composition events (the router accepts committed text only). No OS clipboard access from
  the engine; the DOM adapter forwards paste text when the browser provides it.
* Transforms are translation + uniform scale; rotated UI elements are not supported.
* No native screen-reader integration (see §9).
* World-space UI is projected screen-space UI (labels/bars anchored to world points with distance
  fade and an optional occlusion callback); there is no in-world 3D panel geometry.
* ColorPicker is not shipped (no engine requirement); the `RichText`/`Image` primitives are enough to
  build one.
