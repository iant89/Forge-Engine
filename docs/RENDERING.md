# Rendering — as built (Phase 2, sky + fog from Phase 8a)

This is the description of what the renderer *does today*, not of where the design wants it to end
up (that is `ARCHITECTURE.md` §4–§5). Everything here is exercised by `npm test` on the mock device
and by `npm run check:browser` on real WebGPU; `docs/VERIFICATION.md` says which assertion covers
which claim. The sky pass and the fog are summarised here and described in `docs/ENVIRONMENT.md`.

## 1. One frame

`Renderer.renderScene(scene)` is the whole frame. It gathers scene data on the CPU, describes the
frame as passes on a `RenderGraph`, and executes the graph, which records and submits exactly one
command buffer.

```
CPU                                          GPU passes (default settings, 3 cascades, 720p)
─────────────────────────────────────────    ────────────────────────────────────────────────
camera + lights from the scene               forge.shadow.0  ─┐
computeCascades()  (engine/src/rendering/    forge.shadow.1   ├─ depth24plus 2d-array, 1 layer each
  shadows.ts)                                forge.shadow.2  ─┘
collectBatches()   (frustum cull, sort,      forge.main        rgba16float "hdr" + depth24plus "depth"
  instance merge — no allocation)            forge.sky         hdr (load) + depth (read-only): far-plane triangle
per-frame / light / shadow / sky / object /  forge.bloom.prefilter    hdr        → bloom.1 (½ res)
  instance uniform uploads                   forge.bloom.down.2..5    bloom.n    → bloom.n+1
buildFrame() → graph.execute()               forge.bloom.up.4..1      bloom.n+1  +→ bloom.n (additive tent)
                                             forge.tonemap     hdr + bloom.1 → swapchain (sRGB encoded)
```

Which passes exist is decided per frame from `scene.settings` capped by the renderer's quality
options:

| Setting | Effect on the pass list |
| --- | --- |
| `settings.hdr` (default `true`) | on: `forge.main` renders into an `rgba16float` target and `forge.tonemap` resolves to the swapchain. off: `forge.main` writes the swapchain directly and applies exposure + tone curve + sRGB encode in the standard shader; no post passes exist. |
| `settings.postProcessing && settings.bloom.enabled` and `RendererOptions.bloom !== false` | adds the bloom chain between `forge.main` and `forge.tonemap`. Requires `hdr`. Skipped silently when the half-resolution mip would be under 16 px. |
| `settings.shadow.enabled`, a directional light with `castShadow`, at least one `Renderable.castShadow` batch, `RendererOptions.shadows !== false` | one `forge.shadow.<i>` pass per cascade, `i < min(4, settings.shadow.cascades, RendererOptions.shadowCascades)`. |
| `settings.shadow.mapSize` capped by `RendererOptions.shadowMapSize` (floor 256) | edge size of every cascade layer. `EngineConfig.shadowMapSize`/`shadowCascades` feed these options. |
| `settings.renderScale` (HDR only) | the HDR target and depth buffer are allocated at `round(size × scale)`; tonemap upsamples to the swapchain. |
| `settings.toneMapping` | `aces` / `filmic` / `reinhard` / `none`, applied in `forge.tonemap` (HDR) or in-shader (LDR). |
| `settings.skyEnabled` (default `true`; `setSky()` sets it, `setBackgroundColor()` clears it) and `RendererOptions.sky !== false`; `settings.sky.quality` capped by `RendererOptions.skyQuality` (`EngineConfig.skyQuality`: minimal/low → `low`, medium → `medium`, high/ultra → `high`) | adds `forge.sky` directly after `forge.main`: one fullscreen triangle emitted at z = 1 into the same colour target (`loadOp: "load"`), depth-tested `less-equal` against the scene depth bound **read-only**, so only pixels no geometry covered are shaded and there is no overdraw behind terrain. `forge.main` stores its depth (instead of discarding it) only while this pass exists. Parameters come from `settings.sky` (+ a one-frame `setSkyOverride`), uploaded as `SkyUniforms` (128 B). Off: the clear colour is the background. |
| `settings.fog.mode` (`none` default, `linear`, `exp2`, `height`) | no pass; the standard shader blends every opaque/transparent fragment toward `fog.color` by the transmittance in `WGSL_FOG` (`fogParams` in `PerFrameUniforms`). The sky pass fogs its own planet ground in every mode and the sky itself in `height` mode only. |
| `settings.shadow.debugCascades` | tints receivers red/green/blue/yellow by the cascade that shadowed them (flag bit 0 of `ShadowUniforms.flags`). |

A scene with no camera clears the swapchain in a single `forge.clear` pass and still counts as a
rendered frame, so the HUD keeps ticking while a scene loads.

`Renderer.stats` (also `engine.stats().render`) reports the frame that just ran: `drawCalls`,
`triangles`, `instances`, `batches`, `culled`, `shadowsDrawn`, `shadowsCulled`, `shadowCascades`,
`hdr`, `bloomMips`, `sky`, `skySamples`, `passes`, `culledPasses`, `transientTextures`,
`physicalTextures`, `aliasedBytes`, `texturesCreated`. `Renderer.passNames` (`engine.stats().renderPasses`) is the executed pass list in
order; the demo HUD prints a summary and `tools/browser-check.mjs` asserts on both.

## 2. Render graph (`engine/src/rendering/renderGraph.ts`)

The graph is declarative and rebuilt every frame — describing ~15 passes costs a few dozen small
objects, which is deliberate: the alternative (a persistent graph that is patched when settings
change) is where stale-attachment bugs come from. GPU resources are *not* rebuilt every frame; see
pooling below.

```ts
const g = new RenderGraph(device);           // once
g.begin();                                   // per frame
const swap = g.importTexture("swapchain", device.currentTexture);
const hdr = g.createTexture("hdr", { width, height, format: "rgba16float", usage: RENDER_ATTACHMENT | TEXTURE_BINDING });
g.addPass({
  name: "forge.main",
  color: [{ texture: hdr, loadOp: "clear", clearValue: [r, g, b, 1] }],
  depth: { texture: depth, depthLoadOp: "clear", depthClearValue: 1 },
  execute(ctx) { const pass = ctx.beginRenderPass(); /* draws */ pass.end(); },
});
g.addPass({ name: "forge.tonemap", reads: [hdr], color: [{ texture: swap }], execute(ctx) { ... } });
const stats = g.execute();                   // validates, plans, records, submits
```

**Passes declare what they touch.** `reads` are sampled textures, `color`/`depth` are attachments
(writes). A `view` on a colour or depth attachment selects a `mipLevel`/`arrayLayer`, and the graph
tracks producers per *subresource* (`layer/mip`), so `forge.shadow.1` writing layer 1 of the cascade
array is a real write even though layer 0 was written by another pass. `sideEffect: true` marks a
pass as a root regardless of what it writes.

**Validation happens before anything is recorded.** `execute()` throws `UsageError` (and discards
the frame) for: reading or `loadOp: "load"`-ing a transient nobody has written; attaching the same
texture twice in one pass; using a texture as both colour and depth; reading and writing the same
texture in one pass (WebGPU forbids it, and the message says which pass); using a handle from a
previous frame; a texture smaller than 1×1; using the graph after `dispose()`. `addPass` before
`begin()` is the same error. Mistakes in the pass description therefore fail as one exception with
the pass name in it, instead of as a WebGPU validation error two frames later.

**Dead passes are culled.** A pass survives if it has a side effect, writes an imported texture, or
(transitively) feeds a pass that does. Culled passes never execute and never allocate; the count is
in `stats.culledPasses` and the HUD (`14 passes (0 culled)`).

**Transients alias by live range.** Each transient gets a `[firstPass, lastPass]` range from the
surviving passes. Two transients with identical descriptors and disjoint ranges share one physical
texture; `stats.aliasedBytes` is the memory that saved. (In the default frame nothing aliases: the
bloom mips all differ in size and the HDR target is read by the last pass. The mechanism is covered by
`tests/renderGraph.test.ts` rather than by the demo.)

**Physical textures are pooled across frames.** Textures are keyed by their descriptor
(`rg.<w>x<h>x<layers>:<format>:u<usage>:s<samples>:m<mips>#n` — that label is what you see in a GPU
capture and in `mock.outstanding`). A steady frame creates nothing (`texturesCreated: 0` is asserted
on both the mock and real WebGPU). A shape that goes unused survives two idle frames — a setting that
flips and flips back costs nothing — and is destroyed on the third; `retireAfterFrames` in the
constructor changes the grace period. `dispose()` destroys everything the graph created; imported
textures are never destroyed.

`RenderGraphPassContext` gives a pass its `encoder`, `beginRenderPass(label?)` (attachments come
from the declaration; the label defaults to the pass name and lands in the debug group and in
`mock.passes`), `texture(h)`, `view(h, desc?)` (memoised per frame, so a pass may call it every frame),
`size(h)` and `colorFormat(index)` for building pipelines against whatever the attachment happens to
be. Failure inside `execute()` propagates and the frame is discarded; the next `execute()` requires a
fresh `begin()`.

## 3. HDR, bloom and tone mapping (`shaders/post.ts`)

The forward pass writes scene-referred linear radiance into `rgba16float`. Post uses one fullscreen
triangle, one shader module with four fragment entry points, and one dynamic-offset uniform buffer
(`PostUniforms`, 48 B; `Renderer` reserves a slot per post draw).

1. **Prefilter** (`fsPrefilter`, hdr → ½ res): 13-tap downsample with a **Karis average** on each 2×2
   quad so a single hot pixel cannot flash the whole screen, `× exposure`, then a **soft-knee
   threshold** — zero below `threshold − knee`, the full excess above `threshold`, quadratic between.
   The threshold is measured after exposure, so `bloom.threshold = 1` means "brighter than display
   white" irrespective of the exposure the scene chose.
2. **Downsample** (`fsDownsample`, mip n → n+1): the same 13-tap kernel without Karis, for every mip
   whose height is ≥ 16 px. 720p gives 5 mips; the count is `stats.bloomMips`.
3. **Upsample** (`fsUpsample`, mip n+1 → n, additive blend): 3×3 tent of radius `bloom.radius`
   texels. Because the pipeline blends additively onto the finer mip, mip n ends up as
   `D(n) + tent(U(n+1))` all the way to mip 1.
4. **Tonemap** (`fsTonemap`, hdr + bloom.1 → swapchain): `hdr × exposure + bloom × intensity`, the
   tone curve (`FLAG_NO_TONEMAP` for `none`), then sRGB encode. This is the only pass that writes the
   swapchain in HDR mode.

Bloom flags: `BLOOM = 1` (composite reads the second texture), `KARIS = 2`, `NO_TONEMAP = 4`. The
bindings are fixed (`POST_BINDINGS`: uniforms 0, source 1, second 2, sampler 3) and the sampler is
linear/clamp, so every post pipeline shares one bind group layout.

The LDR path (`settings.hdr = false`) is the Phase 1 renderer: exposure and tone curve inside
`standard.ts`, no bloom, no float target. `perFrame.flags` bit 1 tells the standard shader which
world it is in (HDR: output linear radiance untouched).

## 4. Cascaded shadow maps (`shadows.ts`, `standard.ts`)

`computeCascades()` is pure math and unit-tested in isolation:

* **Splits** follow the practical split scheme, `λ` from `settings.shadow.splitLambda` (default 0.6)
  blended between uniform and logarithmic spacing over `[camera.near, settings.shadow.distance]`.
* **Fit** — each slice's eight frustum corners (world space, perspective or orthographic camera) are
  wrapped in a bounding sphere padded by 2 %. A sphere, not the tight box, so the light-space extent
  is invariant under camera rotation; that is what stops shadow edges from swimming when you orbit.
* **Snap** — the sphere centre is quantised to whole shadow texels in light view space, so a
  translating camera moves the shadow map by an integer number of texels and the sampled edge stays
  put. `Cascade.texelWorld` is the world size of one texel and drives the normal-offset bias.
* **Depth range** — the light's orthographic box starts `casterBackoff × radius` (default 4) behind
  the sphere so objects between the sun and the visible slice still cast, and ends at the sphere's
  far side. A straight-down sun switches the up vector to +Z instead of producing a degenerate basis.

The renderer draws each cascade into its layer of one `depth24plus` 2d-array with the depth-only
pipeline (`DEPTH_VERTEX`; group 0 is the per-cascade `ShadowPassUniforms` at a dynamic offset,
group 1 the same object/instance layout the main pass uses, so instanced batches cast as one draw).
Batches are culled per cascade against the cascade's light-space frustum (`stats.shadowsCulled`);
transparent and overlay batches never cast.

Sampling (`standard.ts`): the cascade is picked by view depth against `cascadeSplits`, the receiver
is pushed along its normal by `normalBias` texels (normal-offset shadows, which remove acne on
low-poly surfaces without the peter-panning of a large constant bias), and coverage is a 3×3 PCF over
a comparison sampler on `texture_depth_2d_array`. The last 15 % of each cascade blends into the next
so the resolution step is not a visible line, and everything fades to lit between `fadeStart` and
`shadowDistance`. Everything the shader needs is in `ShadowUniforms` (320 B; `cascadeViewProj[4]`,
`cascadeSplits`, `cascadeTexelWorld`, biases, `flags`).

## 5. Conventions

The rules every module above assumes (pinned by `tests/math.test.ts`; the long form is `AGENTS.md`
§3):

* +Y up; cameras and lights look down their local +Z; view space is left-handed; `Mat4.setLookAt`
  is a *view* matrix; perspective and orthographic projections map depth to WebGPU's `[0, 1]`;
  pipelines use `frontFace: "cw"`.
* Positions uploaded to the GPU are render-local float32 (relative to the scene's coordinate-space
  origin); the cascade fit works in the same space.
* Column-major matrices, uploaded as-is. `transformPoint`/`transformDirection`/`rotateVector` are
  alias-safe (`out === v` is allowed).
* Colour is linear from vertex fetch to the final encode. In HDR mode only `forge.tonemap` encodes;
  in LDR mode only `standard.ts` and `sky.ts` do (`perFrame.flags` bit 1 says which). Clear colours
  are pre-encoded on the CPU for the target they clear. Fog is applied scene-referred (before
  exposure and the tone curve) so both paths agree.
* Compass: north is +Z, east is +X (`environment/solar.ts`); azimuth is clockwise from north.
* Uniform structs are generated from `uniforms.ts` — scalar `u32` padding, 16-byte aligned struct and
  array members — because WebKit rejects the relaxed layouts Chromium accepts.

## 6. Materials

A `Material` is a shared data record: an 80-byte `MaterialUniforms` block (base colour, metallic,
roughness, emissive factor × strength, texture flags) written only when `dirty`, plus one bind group
created once with the material's textures (missing maps resolve to shared 1×1 defaults so the layout
has no optional slots). Pipeline choice depends only on `technique` (`standard`, `unlit`, `emissive`,
`debug-line`, `blit`), which maps are bound, `transparent`, alpha test and `doubleSided`; changing a
colour costs one uniform write and no pipeline. Emissive is `emissiveFactor × emissiveStrength` **not** modulated by the base colour
(glTF semantics) — that is what makes an emissive cube a bloom source regardless of its albedo.

## 7. Pipeline cache (`pipeline.ts`)

`PipelineFactory.get(key)` returns a `{ pipeline, key, layout }` bundle; identical keys are identical
objects and never touch the device. The key covers everything that changes the GPU pipeline:
`technique` (`standard` / `unlit` / `depth` / `debug` / `post` / `sky`), `colorFormat` (`null` for
depth-only), `depthFormat` (`null` for post), `transparent` (blend + no depth write), `doubleSided`,
`instanced`, `additive` (bloom upsample) and `fragmentEntry` (post entry point). Bind group layouts —
seven of them (frame, shadow-pass frame, draw, material, blit, post, sky) — are created once and
shared; `stats()` reports `{ pipelines, creates, cacheHits, layouts }`. The `sky` technique forces
`depthWriteEnabled: false` (its pass binds the depth attachment read-only) and binds one group:
`PerFrameUniforms` (vertex + fragment, for `invViewProj`) and `SkyUniforms`. `invalidate()` drops pipelines *and* layouts, which is
what device-loss recovery calls; the next `get` rebuilds lazily. All post entry points live in one
WGSL module (one compile for four pipelines), and every module goes through `ShaderCache`, which
runs `validateWgsl` so a WebKit-illegal uniform layout is rejected here rather than on Safari.

## 8. Extending the frame

To add a pass:

1. Declare its resources in `Renderer.buildFrame`: `g.createTexture` for a new transient (give it a
   stable name; names are for debugging, descriptors are for pooling) and `addPass` with explicit
   `reads`/`color`/`depth`. If it should run even when nothing consumes it, say `sideEffect: true`.
2. Write the body against `RenderGraphPassContext`; build pipelines with `ctx.colorFormat(0)` rather
   than a hard-coded format, and reserve uniform slots from the existing arenas (no per-frame
   buffers).
3. Add its name to the `passNames` assertions in `tests/frame.test.ts` and, if it is user visible,
   to `tools/browser-check.mjs`; update `docs/VERIFICATION.md`.

A pass that only *tests* against the scene depth (the sky is the example) declares
`depth: { texture, depthReadOnly: true }` — the graph treats it as a read, the mock enforces the
spec's rule that a read-only attachment carries no load/store ops, and the producing pass must then
`store` its depth rather than discard it (`forge.main` switches per frame).

New WGSL uniform structs go in `uniforms.ts` and are generated, never hand-written; `npm run
check:wgsl` enforces the uniform layout rules WebKit applies, plus the constant-argument rules a strict compiler enforces (`smoothstep` with constant `low >= high`). New shader modules are added to
`tools/wgsl-check.mjs` and `tests/wgsl.test.ts` (the sky module is the template).

## 9. Limitations (honest list)

* No per-object cascade assignment: a caster is drawn into every cascade whose light-space box it
  intersects, so a small object close to the camera is rendered up to N times. Cheap for the demo,
  not for a city.
* Only the first shadow-casting directional light casts; spot and point shadows are not implemented.
* The default 2048² × 3 `depth24plus` array is ≈ 48 MB; tests use `shadowMapSize: 256` because the
  mock device allocates texture storage eagerly.
* Nothing aliases in the default frame (see §2). The bloom chain would alias against a depth
  prepass or an SSAO buffer; neither exists yet.
* `renderScale` scales the HDR target only; the LDR path always renders at swapchain resolution.
* The graph builds one command buffer and submits it; there are no timestamp queries yet, so
  `renderTimeMs` in the HUD is CPU time.
