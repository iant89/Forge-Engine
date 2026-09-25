# Rendering — as built (Phase 2, sky + fog from Phase 8a, depth prepass + SSAO + clustered lighting from Phase 13)

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
collectBatches()   (frustum cull, sort,      forge.prepass     depth24plus "depth" only (clear + store), no fragment stage
  instance merge — no allocation)            forge.ssao        depth → ssao.raw   (rg16float, ½ res)
classifyPrepass()  (which batches lay        forge.ssao.blur.h ssao.raw  → ssao.blur
  down depth; state + front-to-back sort)    forge.ssao.blur.v ssao.blur → ssao.result (same memory as ssao.raw)
buildClusters()    (local lights into a      forge.main        rgba16float "hdr" + depth (load) + ssao.result
  16x8x24 view grid; no pass — §4b)          forge.sky         hdr (load) + depth (load, never written): far-plane triangle
per-frame / light / cluster / shadow /       forge.bloom.prefilter    hdr        → bloom.1 (½ res)
  sky / object / instance uniform uploads    forge.bloom.down.2..5    bloom.n    → bloom.n+1
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
| `settings.skyEnabled` (default `true`; `setSky()` sets it, `setBackgroundColor()` clears it) and `RendererOptions.sky !== false`; `settings.sky.quality` capped by `RendererOptions.skyQuality` (`EngineConfig.skyQuality`: minimal/low → `low`, medium → `medium`, high/ultra → `high`) | adds `forge.sky` directly after `forge.main`: one fullscreen triangle emitted at z = 1 into the same colour target (`loadOp: "load"`), depth-tested `less-equal` against the scene depth, which the pass **loads explicitly** (`depthLoadOp: "load"`, `depthStoreOp: "store"`, pipeline `depthWriteEnabled: false`) so only pixels no geometry covered are shaded and there is no overdraw behind terrain. The spec's `depthReadOnly` attach implies the same load, but that implicit load is the one primitive no sandbox check can exercise — on iOS Safari it returned without the main pass's depth and the sky's fogged planet ground painted a flat beige disc over the whole scene — so the renderer uses the portable explicit spelling. `forge.main` stores its depth (instead of discarding it) only while this pass exists. Parameters come from `settings.sky` (+ a one-frame `setSkyOverride`), uploaded as `SkyUniforms` (128 B). Off: the clear colour is the background. |
| `settings.fog.mode` (`none` default, `linear`, `exp2`, `height`) | no pass; the standard shader blends every opaque/transparent fragment toward `fog.color` by the transmittance in `WGSL_FOG` (`fogParams` in `PerFrameUniforms`). The sky pass fogs its own planet ground in every mode and the sky itself in `height` mode only. |
| `settings.clusteredLighting` (default `true`) and `RendererOptions.clusteredLighting !== false` (`EngineConfig.clusteredLighting`: off on minimal/low), a perspective camera, at least one local light | **adds no pass.** Local (point/spot) lights are indexed on the CPU into a 16×8×24 view-space grid and the fragment stage walks only its own cluster's list (`perFrame.flags` bit 5), which lifts the frame's light cap from 16 to 256. Off — or on an orthographic camera — every light goes through the fixed 16-entry uniform list, as before. See §4b. |
| `settings.shadow.debugCascades` | tints receivers red/green/blue/yellow by the cascade that shadowed them (flag bit 0 of `ShadowUniforms.flags`). |
| `settings.depthPrepass` (default `true`) and `RendererOptions.depthPrepass !== false` (`EngineConfig.depthPrepass`: off on minimal/low, on for medium/high/ultra), and at least one eligible batch | adds `forge.prepass` before `forge.main`: the eligible batches' depth, cleared and stored; `forge.main` then **loads** it (`depthLoadOp: "load"`) and draws those batches with depth writes off. See §4a. |
| `settings.ssao.enabled` (default `true`), `RendererOptions.ssao !== false` (`EngineConfig.ssao`: same profiles), the prepass running, a perspective camera, `radius > 0` and `intensity > 0` | adds `forge.ssao`, `forge.ssao.blur.h`, `forge.ssao.blur.v` between `forge.prepass` and `forge.main`, which reads the result (`perFrame.flags` bit 4). `radius` (1 m), `intensity` (1), `bias` (0.02 m), `samples` (12, clamped 1–32) are uploaded as `SsaoUniforms` (112 B). See §4a. |

A scene with no camera clears the swapchain in a single `forge.clear` pass and still counts as a
rendered frame, so the HUD keeps ticking while a scene loads.

`Renderer.stats` (also `engine.stats().render`) reports the frame that just ran: `drawCalls`,
`triangles`, `instances`, `batches`, `culled`, `shadowsDrawn`, `shadowsCulled`, `shadowCascades`,
`hdr`, `bloomMips`, `sky`, `skySamples`, `depthPrepass`, `prepassDraws` (depth-only draws, not in
`drawCalls`, like `shadowsDrawn`), `ssao`, `passes`, `culledPasses`, `transientTextures`,
`physicalTextures`, `aliasedBytes`, `texturesCreated`, `clusteredLighting`, `lights` (every light in
the frame, global and local), `clusteredLights` (the local ones the grid carries), `clustersUsed`,
`clusterIndices`, `maxLightsPerCluster` (the largest list actually built) and `lightsDropped` (§4b).
The three SSAO fullscreen draws count in
`drawCalls` (as the post passes do) but not in `triangles`. `Renderer.passNames` (`engine.stats().renderPasses`) is the executed pass list in
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
texture; `stats.aliasedBytes` is the memory that saved. In the default frame the SSAO chain is what
aliases: `ssao.raw` is dead once `forge.ssao.blur.h` has read it, so `ssao.result` (same descriptor,
first written by `forge.ssao.blur.v`) gets its memory — `(w/2)·(h/2)·4` bytes, 921,600 B at
1280×720, asserted by `tests/frame.test.ts` and on real WebGPU by `check:browser`. The bloom mips
all differ in size and the HDR target is read by the last pass, so nothing else aliases.

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

## 4a. Depth prepass and SSAO (Phase 13.1, 13.2)

**Which batches are prepassed.** After `collectBatches`, `classifyPrepass` flags every batch that is
drawn in view (not shadow-only), not `transparent` or `overlay`, not water, and whose material is
opaque (`!material.transparent`), not alpha-tested and fully opaque (`opacity ≥ 0.999`) — surfaces
whose `forge.main` fragment can never be discarded. They are sorted by pipeline state (instanced ×
double-sided: at most four prepass pipelines), then front to back. No eligible batch, no pass.

**Why the depths match exactly.** The prepass pipelines are the *standard* module's own
`vertexMain` / `vertexMainInstanced` in a depth-only pipeline (`technique: "prepass"`: no fragment
stage, `depthCompare: "less"`, no depth bias, same cull mode). The layout is just the per-frame block
plus the draw group (`prepass.layout`), so the same `ShaderCache` entry serves both passes, and the
clip position is `@invariant` — WGSL's guarantee that the same data through the same control flow
yields bit-identical positions in *different* pipelines. `forge.main` then draws the prepassed
batches with `writeDepth: false` and `less-equal`, so each passes exactly on its own depth, and
early-Z survives the forward shader's `discard` because nothing is written. Everything else (cutout,
fading, transparent, water, overlays) is drawn exactly as without a prepass, depth writes included.
The real-WebGPU gate proves it: with SSAO off, the frame is pixel-identical with the prepass on or off.
`DEPTH_VERTEX` (the shadow program, with its polygon offset) is never reused here.

**SSAO** (`shaders/ssao.ts`, one module, three fragment entry points over the shared fullscreen
triangle):

* `fsSsao` → `ssao.raw` (`rg16float`, half resolution): per AO texel, the depth texel under it is
  turned into a view-space position through `SsaoUniforms.invProj`; the normal is rebuilt from the
  neighbouring depth texels (per axis the neighbour on the same surface, oriented toward the camera).
  A 12-tap spiral (interleaved-gradient rotation per pixel) of radius `radius` metres, projected with
  `projScale = ½·height·proj[1][1]` and clamped to 10 % of the frame height, accumulates for each tap
  its cosine above the tangent plane `(v·n − bias)/|v|`, less a 0.1 angle bias, times the falloff
  `1 − |v|²/r²`; visibility = `1 − 2·intensity·Σ/N`. Output: (visibility, view depth); pixels without
  geometry carry the sky key 65 000.
* `fsBlurH`, `fsBlurV` → `ssao.blur` → `ssao.result`: a 9-tap Gaussian per direction whose taps are
  dropped when their view depth differs from the centre's by more than 10 % (`sharpness` 10), so
  occlusion never bleeds across a silhouette.
* `forge.main` (`ambientOcclusion()` in `standard.ts`, group 0 binding 5): a 2×2 bilateral
  `textureLoad` of the result against the fragment's own view depth (`clip.w`); texels from another
  surface get no weight, and a fragment no texel agrees with is unoccluded. The visibility scales the
  **ambient term only** — direct light already has shadow maps. With SSAO off the binding holds a
  1×1 "unoccluded" texel and the shader skips it (`perFrame.flags` bit 4).

The estimator is the normal-oriented hemisphere form, sampled like SAO (McGuire et al., HPG 2012):
SAO's own `(r² − v·v)³/(v·v)` weighting was tried first and all but ignores occluders beyond half the
radius — on the PBR fixture it darkened 0.04 % of the frame. Because only ambient light is occluded,
how much SSAO shows depends on the lighting: the PBR fixture (strong sun and point lights, floating
spheres) darkens ~0.4 % of its pixels by up to ~5 levels, which is what `check:browser` measures.

## 4b. Clustered (Forward+) lighting (Phase 13.3)

Local lights are indexed on the CPU into a view-space grid — `CLUSTER_TILES_X × CLUSTER_TILES_Y ×
CLUSTER_SLICES` = 16 × 8 × 24 = 3 072 clusters (`engine/src/rendering/clusters.ts`) — and the fragment
stage walks only the list of the cluster it lands in, so the cost follows the lights near a pixel
instead of the lights in the scene. Directional lights are never clustered: they reach every pixel, so
there is nothing to cull, and they stay in the small uniform `LightBlock` where the cascade caster's
`shadowIndex` lives. Clustering is a *data* change and not a pass — the graph is identical with it on or
off (§1) — and it lifts the frame's light cap from `MAX_LIGHTS_PER_FRAME` = 16 to `MAX_CLUSTERED_LIGHTS`
= 256 local lights.

**Engaging.** `settings.clusteredLighting` (default `true`) and `RendererOptions.clusteredLighting !==
false` (`EngineConfig.clusteredLighting`, which the minimal and low profiles turn off), a perspective
camera, and at least one local light. `perFrame.flags` bit 5 (`FLAGS_CLUSTERED`) tells the shader which
of the two loops to run; both are always compiled, so one pipeline serves either and the demo can A/B
them without a rebuild.

**The grid.** A fragment's cluster is `(slice × 8 + tileY) × 16 + tileX`, the tile coming from
`@builtin(position).xy / renderExtent` and the slice logarithmic in view depth (`clip.w`) between the
camera's near plane and `clusterFar` — the deepest live light, capped by the far plane:
`slice = clamp(i32((log(max(depth, near)) − logNear) · sliceScale), 0, 23)`. Logarithmic because a metre
of depth matters more at 2 m than at 50 m, and because it keeps the slice count independent of the far
plane. `ClusterUniforms` (48 B) carries exactly the five constants that expression needs, so the CPU
builder and the fragment stage compute the same slice from the same numbers; the builder still widens
each light by one slice on each side, because it quantises in float64 and the shader in float32, and a
widened slice contributes exactly `+0.0`.

**Conservative assignment.** Under-inclusion is the one failure mode a viewer cannot diagnose — a light
that silently stops lighting part of a surface — so the builder over-covers and never under-covers.
Each light becomes a view-space bounding sphere (a spot's cone gets `spotBoundingSphere`), the sphere
becomes a box, and the box is projected at **both** of its depths, taking the corner min/max:
`ndc.x = proj00·x/z` moves toward the centre as `z` grows, so for a box that does not straddle the view
axis the *far* edge at the far depth reaches further in than the near edge at the near depth does.
Projecting at the near depth alone — the obvious thing to write — cost an off-axis lamp the inner
crescent of its own pool: `check:browser` saw it as 181 darker pixels in a 40-light frame, and
`tests/clusters.test.ts` now walks that crescent at 2 cm. A sphere that reaches the near plane projects
without bound and takes every tile; lights fully off frame (NDC beyond ±(1 + 2·`TILE_EPS`)), behind the
near plane or past the far plane are dropped before they cost anything.

**Caps and eviction.** A cluster holds at most `MAX_LIGHTS_PER_CLUSTER` = 32 lights. When it has more
candidates than that, the least influential lose — influence is `intensity ×` the Rec.709 luma of the
colour, a *per-light* measure, so the same lights lose in every cluster and a light cannot pop out at
one cluster boundary and back in at the next. Lists stay in light order after the eviction sort, which
is what keeps the shader's accumulation order (and so its floating-point sum) the unclustered path's
own. The flat index list is sized for the worst case — `CLUSTER_COUNT × MAX_LIGHTS_PER_CLUSTER` =
98 304 entries — so the cap is what limits a cluster and never the buffer: a light dropped because a
buffer ran out would be a light dropped for a reason nobody can see in the scene.

**Buffers.** Group 0 bindings 6–8, created once and never re-created, so the frame bind group stays
stable: `clusters` (`ClusterUniforms`, 48 B, uniform), `clusterLights` (`ClusterLightBlock`: a count and
`array<LightUniforms, 256>`, 20 496 B, read-only storage) and `clusterGrid` (`ClusterGridBlock`: 6 144
u32 of (offset, count) pairs, then the index list — 417 792 B, read-only storage). ≈ 428 KB resident
from the first frame, clustered or not. Per clustered frame only the used prefixes go up: all 24 KB of
offsets (any cluster's count can change) and the index list up to `stats.clusterIndices` — 43 KB for the
demo's 40-light rig.

**Why it is pixel-identical below the old cap.** Both light loops call the same `lightContribution()` in
`shaders/standard.ts` — one definition, two call sites, pinned by `tests/wgsl.test.ts` — and a fragment
outside a light's range adds exactly `+0.0` on the uniform path while the clustered path simply does not
list it. `check:browser` proves the result on real WebGPU: the PBR fixture's four lights give a
bit-identical frame with clustering on and off (0 px differ by even one luma level, same 18 passes), and
with the demo's 36-lamp rig (40 lights) the clustered frame is strictly brighter — 88 057 of the
921 600 px, none darker — while the uniform list truncates at 16 and reports `lightsDropped`. The demo's
**Clustered** and **+36 lamps** buttons drive both halves.

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
`technique` (`standard` / `unlit` / `depth` / `prepass` / `debug` / `post` / `sky` / `water` /
`ssao`), `colorFormat` (`null` for depth-only), `depthFormat` (`null` for post and SSAO),
`transparent` (blend + no depth write), `doubleSided`, `instanced`, `writeDepth`, `additive` (bloom
upsample) and `fragmentEntry` (post and SSAO entry points). Bind group layouts — eleven of them
(frame, shadow-pass frame, prepass frame, draw, material, blit, post, sky, water, SSAO estimate,
SSAO blur) — are created once and shared; `stats()` reports `{ pipelines, creates, cacheHits,
layouts }`. `prepass` compiles the standard module's vertex entries with no fragment stage (see §4a). The `sky` technique forces
`depthWriteEnabled: false` (its pass loads and stores the scene depth explicitly but never writes
it — see the WebKit note on `forge.sky` above) and binds one group:
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
`store` its depth rather than discard it (`forge.main` switches per frame). A pass that continues on
an earlier pass's depth — `forge.main` after `forge.prepass` — declares `depthLoadOp: "load"`; the
graph counts the load as a read, so the producer is never culled.

New WGSL uniform structs go in `uniforms.ts` and are generated, never hand-written; `npm run
check:wgsl` enforces the uniform layout rules WebKit applies. New shader modules are added to
`tools/wgsl-check.mjs` and `tests/wgsl.test.ts` (the sky module is the template).

## 9. Limitations (honest list)

* No per-object cascade assignment: a caster is drawn into every cascade whose light-space box it
  intersects, so a small object close to the camera is rendered up to N times. Cheap for the demo,
  not for a city.
* Only the first shadow-casting directional light casts; spot and point shadows are not implemented.
* The default 2048² × 3 `depth24plus` array is ≈ 48 MB; tests use `shadowMapSize: 256` because the
  mock device allocates texture storage eagerly.
* Only the SSAO chain aliases (see §2): frames without SSAO — the minimal/low profiles, orthographic
  cameras, scenes that turn it off — still alias nothing.
* The prepass depth has two consumers (SSAO, the soft-particle fade); no culling, transparency
  technique or post effect reads it yet (roadmap 13.1 / 13.5).
* Cutout, fading, transparent and water surfaces are not prepassed: no early-Z saving for them, and
  they neither receive nor cast SSAO. Orthographic cameras get the prepass but no SSAO (the bilateral
  key is `clip.w`).
* SSAO is screen-space and half resolution without temporal accumulation: occluders off screen or
  hidden behind nearer geometry do not count, detail below ~2 px is lost, the kernel is clamped to
  10 % of the frame height (close-ups get a smaller effective radius), and it scales ambient light
  only — a scene lit mostly by direct light shows little of it.
* Clustering is built on the CPU (§4b) and uploaded every frame — 3 072 clusters, an offset array and a
  flat index list. Moving the assignment into a compute pass is roadmap 13.4.
* Local lights are capped at 256 per frame (`MAX_CLUSTERED_LIGHTS`) and each cluster at 32
  (`MAX_LIGHTS_PER_CLUSTER`), where the least influential lose; `stats.lightsDropped` reports either
  case. The cluster buffers cost ≈ 428 KB of VRAM from the first frame whether or not a scene clusters.
* Orthographic cameras are never clustered — the grid's depth axis is view depth, which an orthographic
  projection does not put in `clip.w`, the same reason SSAO is perspective-only — so their local lights
  still go through the fixed 16-entry uniform list.
* Clustered lights cast no shadows: a local light's `shadowIndex` is always −1 in the cluster block
  (point and spot shadows are roadmap 13.9), as it already is in the uniform list.
* `renderScale` scales the HDR target only; the LDR path always renders at swapchain resolution.
* The graph builds one command buffer and submits it; there are no timestamp queries yet, so
  `renderTimeMs` in the HUD is CPU time.
