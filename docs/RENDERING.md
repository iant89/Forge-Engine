# Rendering — as built (Phase 2, sky + fog from Phase 8a, depth prepass + SSAO + clustered lighting + object culling + async pipelines + GPU timing from Phase 13)

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
                                             forge.shadow.spot.<n> (optional, after cascades)
collectBatches()   (frustum cull, sort,      forge.prepass     depth24plus "depth" only (clear + store), no fragment stage
  instance merge — no allocation)            forge.hiz.0..3    depth → the pyramid (r32float, mip chain), ½, ¼, ... of the target
buildClusters()    (local lights into a      forge.objects.cull  bounds + pyramid → visibility words, 1 per batch (§4d)
  16x8x24 view grid; no pass — §4b)          forge.ssao        depth → ssao.raw   (rg16float, ½ res)
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
| `settings.shadow.enabled`, the first shadow-casting directional light, an intersecting `Renderable.castShadow` batch, `RendererOptions.shadows !== false` | one `forge.shadow.<i>` pass per active cascade, up to `min(4, settings.shadow.cascades, RendererOptions.shadowCascades)`. |
| `settings.shadow.enabled`, a valid `Light.kind = "spot"` with `castShadow`, and an intersecting caster | one `forge.shadow.spot.<i>` pass for each selected spot slot, up to four. The first four valid shadow-casting spot lights are supported; point shadows are not. |
| `settings.shadow.mapSize` capped by `RendererOptions.shadowMapSize` (floor 256) | common edge size of every cascade and spot layer in the shared depth array. `EngineConfig.shadowMapSize`/`shadowCascades` feed these options; all maps use the same per-frame resolution. |
| `settings.renderScale` (HDR only) | the HDR target and depth buffer are allocated at `round(size × scale)`; tonemap upsamples to the swapchain. |
| `settings.toneMapping` | `aces` / `filmic` / `reinhard` / `none`, applied in `forge.tonemap` (HDR) or in-shader (LDR). |
| `settings.skyEnabled` (default `true`; `setSky()` sets it, `setBackgroundColor()` clears it) and `RendererOptions.sky !== false`; `settings.sky.quality` capped by `RendererOptions.skyQuality` (`EngineConfig.skyQuality`: minimal/low → `low`, medium → `medium`, high/ultra → `high`) | adds `forge.sky` directly after `forge.main`: one fullscreen triangle emitted at z = 1 into the same colour target (`loadOp: "load"`), depth-tested `less-equal` against the scene depth, which the pass **loads explicitly** (`depthLoadOp: "load"`, `depthStoreOp: "store"`, pipeline `depthWriteEnabled: false`) so only pixels no geometry covered are shaded and there is no overdraw behind terrain. The spec's `depthReadOnly` attach implies the same load, but that implicit load is the one primitive no sandbox check can exercise — on iOS Safari it returned without the main pass's depth and the sky's fogged planet ground painted a flat beige disc over the whole scene — so the renderer uses the portable explicit spelling. `forge.main` stores its depth (instead of discarding it) only while this pass exists. Parameters come from `settings.sky` (+ a one-frame `setSkyOverride`), uploaded as `SkyUniforms` (128 B). Off: the clear colour is the background. |
| `settings.fog.mode` (`none` default, `linear`, `exp2`, `height`) | no pass; the standard shader blends every opaque/transparent fragment toward `fog.color` by the transmittance in `WGSL_FOG` (`fogParams` in `PerFrameUniforms`). The sky pass fogs its own planet ground in every mode and the sky itself in `height` mode only. |
| `settings.clusteredLighting` (default `true`) and `RendererOptions.clusteredLighting !== false` (`EngineConfig.clusteredLighting`: off on minimal/low), a perspective camera, at least one local light | adds `forge.lights.assign` — one compute pass, **first** in the frame — when the fill runs on the device (`RendererOptions.lightCulling`: `"auto"`/`"gpu"`; `"auto"` resolves to `"cpu"` on the mock), and **no pass** on the CPU fill. The local (point/spot) lights are indexed into a 16×8×24 view-space grid and the fragment stage walks only its own cluster's list (`perFrame.flags` bit 5), which lifts the frame's light cap from 16 to 256. Off — or on an orthographic camera — every light goes through the fixed 16-entry uniform list, as before. See §4b–4c. |
| `settings.shadow.debugCascades` | tints receivers red/green/blue/yellow by the cascade that shadowed them (flag bit 0 of `ShadowUniforms.flags`). |
| `settings.depthPrepass` (default `true`) and `RendererOptions.depthPrepass !== false` (`EngineConfig.depthPrepass`: off on minimal/low, on for medium/high/ultra), and at least one eligible batch | adds `forge.prepass` before `forge.main`: the eligible batches' depth, cleared and stored; `forge.main` then **loads** it (`depthLoadOp: "load"`) and draws those batches with depth writes off. See §4a. |
| `RendererOptions.objectCulling` (`"auto"` default / `"cpu"` / `"gpu"`) | `"gpu"` (and `"auto"` on a real device) adds `forge.objects.cull` between `forge.prepass` and the SSAO chain, plus the `forge.hiz.<n>` pyramid when occlusion is on; `"cpu"` (and `"auto"` on the mock) runs the twin and adds no pass. Either way the batches' visibility words are written before `forge.main` reads them. See §4d. |
| `RendererOptions.occlusionCulling !== false`, the prepass running, a perspective camera, and a render target the pyramid can shrink into | the cull pass also builds and tests against the HiZ pyramid (`forge.hiz.0..<n>`); off (or orthographic, or a target smaller than a few texels) it is frustum + distance only, and no `forge.hiz` pass exists. |
| `settings.ssao.enabled` (default `true`), `RendererOptions.ssao !== false` (`EngineConfig.ssao`: same profiles), the prepass running, a perspective camera, `radius > 0` and `intensity > 0` | adds `forge.ssao`, `forge.ssao.blur.h`, `forge.ssao.blur.v` between `forge.prepass` and `forge.main`, which reads the result (`perFrame.flags` bit 4). `radius` (1 m), `intensity` (1), `bias` (0.02 m), `samples` (12, clamped 1–32) are uploaded as `SsaoUniforms` (112 B). See §4a. |

A scene with no camera clears the swapchain in a single `forge.clear` pass and still counts as a
rendered frame, so the HUD keeps ticking while a scene loads.

`Renderer.stats` (also `engine.stats().render`) reports the frame that just ran: `drawCalls`,
`triangles`, `instances`, `batches`, `culled`, `cullTested`, `cullFrustum`, `cullDistance`, `cullOccluded`
(§4d; the device path reports them one frame late), `shadowsDrawn`, `shadowsCulled`, `shadowInstancesDrawn`, `shadowInstancesCulled`, `shadowCascades`, `spotShadowMaps`,
`hdr`, `bloomMips`, `sky`, `skySamples`, `depthPrepass`, `prepassDraws` (depth-only draws, not in
`drawCalls`, like `shadowsDrawn`), `ssao`, `passes`, `culledPasses`, `transientTextures`,
`physicalTextures`, `aliasedBytes`, `texturesCreated`, `clusteredLighting`, `lights` (every light in
the frame, global and local), `clusteredLights` (the local ones the grid carries), `clustersUsed`,
`clusterIndices`, `maxLightsPerCluster` (the largest list actually built) and `lightsDropped` (§4b).
The three SSAO fullscreen draws count in
`drawCalls` (as the post passes do) but not in `triangles`. `Renderer.passNames` (`engine.stats().renderPasses`) is the executed pass list in
order; the demo HUD prints a summary and `tools/browser-check.mjs` asserts on both.

### Async pipeline compilation (Phase 13.7)

On real devices, `Renderer` asks `PipelineFactory.getReady()` for each draw variant. A cache hit is
immediately usable; a miss starts one `createRenderPipelineAsync()` request per key and returns
`null` for that frame, so the render loop never waits for compilation. Call sites skip only the draws
whose pipelines are pending, while attachment clears/loads still run. The prepass path falls back to
a depth-writing forward variant if the prepass pipeline is still compiling (and uses that same
variant if the no-depth-write forward variant is not ready yet), avoiding a hole in the scene during
startup. `RendererOptions.asyncPipelines` can force either path; mock renderers default to synchronous
compilation to preserve deterministic command-recording tests. `PipelineFactory.get()` remains the
synchronous tooling API; `getAsync()` supports explicit prewarming and `settle()` is for host/test
code, not the render loop. `Renderer.stats.pipelinesPending` and `pipelineFailures` expose the number
of unique in-flight keys and latched async failures.

### GPU timing (Phase 13.8)

`EngineConfig.gpuTimestamps` opts into timestamp queries (on by default for high/ultra quality, off
for minimal/low/medium); timestamp-query remains an optional adapter feature. `RendererOptions.gpuTimestamps`
and `RenderGraphOptions.gpuTimestamps` are available to direct users. When enabled and supported,
the graph brackets render and compute passes with timestamp writes, resolves them into a rotating set
of three readback buffers, and calls `mapAsync()` without waiting in `execute()`. It records at most
256 passes per frame; `gpuTimingDroppedPasses` and `gpuTimingSkippedFrames` surface capacity and
readback-ring pressure. If the feature is unavailable or setup fails, `gpuTimingAvailable` is false
and rendering continues without timing.

The latest completed sample is exposed in `Renderer.stats` (and `engine.stats().render`) as
`gpuFrameTimeMs`, `gpuRenderTimeMs`, `gpuComputeTimeMs`, and `gpuPassTimes` (`{ name, kind, ms }`).
The frame duration spans the first timed pass start to the last timed pass end; render/compute values
sum the corresponding pass durations. Timestamp readback is asynchronous, so these are the latest
completed measurements, not CPU submission times. The renderer forwards per-pass samples to the
engine `Profiler`, which merges GPU time into the matching pass names.

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
`mock.passes`), `beginComputePass(label?)`, `texture(h)`, `view(h, desc?)` (memoised per frame, so a
pass may call it every frame), `size(h)` and `colorFormat(index)` for building pipelines against
whatever the attachment happens to be. Use the context's pass-begin methods for timestamp coverage;
raw `encoder.begin*Pass()` calls are not timed. Failure inside `execute()` propagates and the frame
is discarded; the next `execute()` requires a fresh `begin()`. `execute(callback?)` returns before the
optional GPU timing callback fires.

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
group 1 the same object/instance layout the main pass uses). During batch collection, each eligible
renderable's world AABB is tested against every cascade's light-space frustum and receives a
conservative bitmask. Adjacent instances with the same mask are retained as ranges inside the colour
batch; each shadow pass uses `firstInstance` to submit only ranges assigned to its map, without
splitting the main colour draw. `stats.shadowsCulled` counts batch/map pairs with no assigned
instances, while `shadowInstancesDrawn`/`shadowInstancesCulled` count per-map caster-instance work.
Transparent and overlay batches never cast.

Sampling (`standard.ts`): the cascade is picked by view depth against `cascadeSplits`, the receiver
is pushed along its normal by `normalBias` texels (normal-offset shadows, which remove acne on
low-poly surfaces without the peter-panning of a large constant bias), and coverage is a 3×3 PCF over
a comparison sampler on `texture_depth_2d_array`. The last 15 % of each cascade blends into the next
so the resolution step is not a visible line, and everything fades to lit between `fadeStart` and
`shadowDistance`. Everything the shader needs is in `ShadowUniforms` (656 B; directional matrices,
splits and texel sizes, spot matrices/parameters, counts and biases).

### Spotlight shadows (Phase 13.9)

Up to four valid shadow-casting spot lights are fitted per frame by `computeSpotShadow()`: the light's
travel direction and outer-cone cosine define a square perspective projection, with the near plane
kept close to the light and the far plane at `Light.range`. Cone cosines are clamped and ordered at
light upload, so even reversed user values yield a valid soft-edge interval. The renderer takes the
first four valid spots in scene order; `Light.castShadow = false`, a degenerate direction, a range at or below `1e-4` m or `settings.shadow.enabled = false` excludes a map. All cascade and spot maps share one
`depth24plus` 2d-array and the same frame resolution (`settings.shadow.mapSize` capped by
`RendererOptions.shadowMapSize`); per-light/adaptive resolution is not part of this step.

Directional cascades occupy array layers `[0, count)`, then spot slot `i` occupies `count + i` and
uses `LightUniforms.shadowIndex = i`. The same index survives both the fixed uniform light list and
the clustered-light storage block. Per-object AABB masks reserve bits 0–3 for cascades and bits 4–7
for spot slots, so a spot-only frame works without inventing a directional cascade. The renderer adds
`forge.shadow.spot.<i>` after any active cascade passes, fits each spot frustum independently, and
uses those masks to retain off-screen casters while avoiding draws into unrelated maps. Spot sampling
uses the corresponding matrix, per-light depth/normal bias and a 3×3 PCF; `Renderer.stats.spotShadowMaps`
reports the active spot-map prefix. Point-light, contact and adaptive-resolution shadows remain future
13.9 items.

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
there is nothing to cull, and they stay in the uniform `LightBlock`. The directional caster and any
selected spot light retain their `shadowIndex` in whichever block carries them. Clustering is a *data*
change and not a pass — the graph is identical with it on or off (§1) *on the CPU fill*; the device fill (§4c, the default away from the mock) adds the
`forge.lights.assign` compute pass — and it lifts the frame's light cap from `MAX_LIGHTS_PER_FRAME` = 16
to `MAX_CLUSTERED_LIGHTS` = 256 local lights.

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
`array<LightUniforms, 256>`, 20 496 B, read-only storage) and `clusterGrid` (`ClusterGridBlock`: one
count per cluster in `counts` — 3 072 u32 — then the fixed-stride index list `indices`,
`CLUSTER_COUNT × MAX_LIGHTS_PER_CLUSTER` = 98 304 u32; 405 504 B, read-only storage). ≈ 416 KB resident
from the first frame, clustered or not. Per clustered frame the CPU uploads the whole `counts` array
(12 KB: any cluster's count can change) and, on the CPU fill only, the index list's used prefix. The
device fill (§4c) uploads 4 B of ranges plus (key, influence) per light instead, and never the lists.

**Why it is pixel-identical below the old cap.** Both light loops call the same `lightContribution()` in
`shaders/standard.ts` — one definition, two call sites, pinned by `tests/wgsl.test.ts` — and a fragment
outside a light's range adds exactly `+0.0` on the uniform path while the clustered path simply does not
list it. `check:browser` proves the result on real WebGPU: the PBR fixture's four lights give a
bit-identical frame with clustering on and off (0 px differ by even one luma level, same passes), and
with the demo's 36-lamp rig (40 lights) the clustered frame is strictly brighter — every lamp the grid
lists adds light the truncated uniform list cannot, and **nothing gets darker** — while the uniform list
truncates at 16 and reports `lightsDropped`. The demo's **Clustered** and **+36 lamps** buttons drive
both halves.

## 4c. GPU light culling (Phase 13.4)

The cluster build (§4b) is three stages, and they do not scale the same way. `prepare` is O(lights): one
bounding sphere, the near/far/off-frame culls, one tile and slice extent per light. `count` is
O(lights × slices + clusters): a per-slice difference plane, so a light sweeping the whole grid costs
the same four corner writes as a light in one tile. The **fill** is O(coverage): every (cluster, light)
cell a light's ranges cover is considered and the lists written. `benchmarks/src/lights.bench.ts`
measures the three: the demo-shaped rig (256 lamps, ~30 clusters each) fills 7 749 list entries in
~0.5 ms, and a saturating rig (256 lamps, every cluster) fills the 98 304-entry grid — 3 072 clusters ×
the 32-entry cap — in ~75 ms, against ~0.1 ms for the same frames' counting pass. 75 ms is a whole
frame's budget on the CPU, and it is the case this phase exists for: the fill moves to a compute pass,
and `prepare` and `count` stay where they are.

**Why the fill and not the rest.** `count`'s output is needed *exactly and immediately*: the fragment
stage indexes its lists with those counts, `stats` reports the same numbers, and `lightsDropped` is a
correctness signal rather than a hint — reading them back from a device would cost a frame of lag or a
stall. The fill alone can be handed over: it writes only `indices`, whose *lengths* the CPU already
knows. `prepare` is O(lights) with no coverage term at all.

**Nothing is read back.** `clustersUsed`, `clusterIndices`, `maxLightsPerCluster` and `lightsDropped`
are functions of `counts` alone, so the CPU computes them before the dispatch is even recorded and the
GPU path reports the same numbers, for the same frame, with no staging buffer, no `mapAsync` and no
lag. `tests/frame.test.ts` pins that the two fills' `stats` are equal field for field (bar which half
ran), and `check:browser` re-checks it on a real device.

**The pass.** `forge.lights.assign` runs first in the frame — the shadow and prepass passes never read
the grid, but `forge.main`'s fragment stage does — one invocation per cluster in 12 workgroups of 256.
It reads the frame's packed ranges (`ClusterRangeBlock`: a light count and up to 256 (key, influence)
entries, 2 052 B) and the grid's own `counts`, and writes `indices`, at most `counts[c]` entries per
cluster: a wrong count trims a list rather than spilling into the next cluster's block. The shader is a
transcription of the CPU fill and not a variant of it — same light order, same eviction rank
(intensity × Rec.709 luma of the colour, ties keeping the earlier light), same re-sort afterwards.
`assignClustersOnCpu` in `rendering/lightCulling.ts` is that algorithm in TypeScript, and
`tests/lightCulling.test.ts` pins the shader's twin against `ClusterGrid.rasterize` byte for byte,
including the saturated lists where the eviction path runs.

**Packed ranges.** Each light's prepared tile/slice extents cross to the shader as one u32
(`RANGE_KEY_BITS`: 4+4 bits of tile X, 3+3 of tile Y, 5+5 of slice, one live bit), written by
`packRanges` and decoded by the shader's `covers()`. The layout lives in one place, so the packer and
the unpacker cannot drift; `tests/clusters.test.ts` checks that a key carries exactly the coverage the
CPU fill walks. WGSL needs the parentheses around a shift mixed with a comparison — `slice < (key >> 14u)
& 31u` is a Tint *parse* error ("mixing `<` and `&` requires parenthesis"), and it invalidates every
pipeline built from the module, not just that expression — so the generated decode is
`((key >> shift) & mask)u`, and `validateWgsl` now fails on that shape (`mixedOperatorIssues`, pinned by
`tests/wgsl.test.ts`). The browser gate was the only gate that could see it; now the CPU gates can too.

**Choosing a fill, and switching.** `RendererOptions.lightCulling` is `"auto"` (default), `"cpu"` or
`"gpu"`; `"auto"` resolves to `"cpu"` on the mock device (it records compute passes but executes no WGSL)
and to `"gpu"` everywhere else. `stats.clusterFill` names which half ran, and the demo's
`?lightculling=cpu|gpu` plus its HUD line drive it. Switching mid-run is safe — both fills write the same
counts and the same lists in the same order, so a frame filled on the CPU and the next filled on the GPU
describe the same grid — but switching to `"cpu"` **releases** the culler's device resources, and the
renderer has to drop its reference along with them. A `GpuLightCuller` that has been disposed returns
from `record()` without adding the pass, so keeping the released culler would leave every later frame
with *no* fill at all and shade its lights through whatever index blocks the last upload left on the
device — a grid describing another frame's lights. `Renderer.lightCulling` documents the trap,
`tests/frame.test.ts` pins the round trip, and `check:browser` asserts it where it happened: after the
fill goes `cpu` → `gpu`, `forge.lights.assign` must be back in the frame's pass list.

**What the gate proves on a real device.** `check:browser` runs the PBR fixture on the GPU fill and A/Bs
the two fills over one frozen scene: identical pictures (max luma diff 0.00, 0 px beyond one level),
identical grid stats, the pass present in the gpu arm and absent in the cpu arm. It then adds the 36-lamp
rig: the clustered frame is strictly brighter than the truncated uniform path and none of its pixels is
darker, `lightsDropped` is false with 39 local lights in the grid and true on the uniform list, and the
two fills still produce the same picture on the frame the device filled itself.

## 4d. GPU object culling (Phase 13.5)

Submitting a batch costs a `setBindGroup` and a `drawIndexed`; the batch's instances pay for their
vertices. Phase 13.5 removes the first two where the frame cannot see the batch, and it removes them
*on the device* so the decision scales with the batch count rather than with the frame's CPU budget.
`engine/src/rendering/objectCulling.ts` owns the whole mechanism; `Renderer` owns the batches, the
bounds array and the visibility buffer, and calls the culler between building them and recording the
frame.

**The contract: one word per batch.** `visibility[i]` is a `u32` — 0 draws, anything else is a
verdict (`CullReason`: frustum, distance, occluded). It is reset to zero every frame by one
`queue.writeBuffer`, written by the cull pass (or the twin), bound as group 1 binding 2 of the draw
layout, and read in the vertex stage as `batchVisibility[objectData.visibilityIndex]`. A culled batch
collapses its clip position to `vec4(0, 0, -1, 1)` — degenerate, so the rasteriser drops every
triangle without a discard or a branch in the fragment stage, and no per-instance work is needed. The
buffer is one word per *batch* and 8 KiB of bounds describe 8 192 batches (cap
`MAX_CULLED_BATCHES`); a frame past the cap simply leaves the extra batches untested, and untested
means visible, never wrongly culled.

**Three tests, one direction of error.** All of them are conservative by construction: they may keep
a batch that is invisible, never drop one that is visible.

* *Frustum.* The six planes come from the frame's own `viewProj`, taken as rows (the near plane is
  `row3 - row2` on a z-in-[0,1] projection, which is where the OpenGL-style `z + w` pair goes wrong).
  The shader keeps them unnormalized and compares `plane · centre + d` against `-|normal| · radius`, so
  the sphere test is exact without a square root.
* *Distance.* `Renderable.maxDistance` is a *draw* rule, not an upload rule: a batch is dropped once
  its bounding sphere no longer touches the limit (`distance - radius > limit`). Batches merge by
  geometry/material, so a merged batch keeps the **most permissive** member's limit — the CPU already
  decided each member belonged in the frame, and the device only gets to drop the whole batch. The
  frame's flags carry a distance bit only when some batch has a limit.
* *HiZ occlusion.* The prepass depth is reduced into a pyramid of *view-space metres* (level 0 is the
  2×2 max of `far·near / (far - ndc·(far - near))`, unwritten texels map to exactly `far`, i.e. an
  occluder of nothing), and a batch is dropped when every texel under its footprint is nearer than its
  own nearest point minus `CULL_EPSILON`. The footprint is the projection of the sphere's view-space
  box — a projective map sends lines to lines, so the box's image is the hull of its 8 corner images —
  padded by one pixel, and the level is chosen so its texels are at most a few pixels across
  (`ceil(log2(span)) - 2`, clamped). **The pixel row is the negated NDC y**: texel row 0 is the top of
  the image while NDC +y points up, and a row index taken straight from the NDC y tests the mirrored
  half of the screen — for a batch floating over nearer ground that half is filled with a *nearer*
  surface, so the batch is dropped and vanishes from the frame. That bug reached the real-WebGPU gate
  (`disabling occlusion culling changed 16 161 px`); the CPU twin, the shader text and the gate now
  pin the sign (`tests/objectCulling.test.ts`).

**The twin, and why it exists.** `cullBatchesOnCpu` is the same three tests in TypeScript, and the
shader is a transcription of it (same slop, pad, epsilon, plane order, level choice).
`RendererOptions.objectCulling` is `"auto"` (default), `"cpu"` or `"gpu"`; `"auto"` chooses the twin on
the mock device — which records and validates compute passes but executes no WGSL — because a
visibility buffer the pass never wrote would draw the frame's culled batches as though the culler had
said no. The twin has no depth buffer, so its occlusion bit is never set: HiZ is a device-only test,
and the CPU arm is frustum + distance. Both write the same buffer, so the switch changes who does the
arithmetic and no pixels.

**The frame.** The cull passes land between `forge.prepass` and the SSAO chain: before the prepass the
depth does not exist, and after `forge.main` a verdict would arrive a pass too late to be consumed.
`forge.hiz.0` reduces the prepass depth to level 0, `forge.hiz.<n>` reduces level n-1, and
`forge.objects.cull` dispatches one invocation per batch in ceil(batches / 64) workgroups. The level
count is *per-frame* state (`hizLevelsFrame`): the pyramid texture is sized by the target, not the
frame, so a frame the renderer did not ask to occlude must neither read a depth it did not write
(the graph refuses a pass that reads an unwritten texture) nor report levels.

**Counters, one frame late.** The pass `atomicAdd`s into `ObjectCullStatsBlock` (16 B, four
`atomic<u32>` — a plain `u32` will not take `atomicAdd`, and a buffer *type* ignoring this is how
`objects.cull` failed to compile on a real device while the mock accepted it), and the same command
buffer copies the block into a `MAP_READ` staging buffer. `poll()` maps it after the frame; the numbers
reach `stats.cullTested` / `cullFrustum` / `cullDistance` / `cullOccluded` on a later frame, because a
device-side count cannot be known on the CPU without either a stall or a frame of lag. The CPU arm
reports its own numbers immediately.

**Growth and lifetime.** The visibility buffer is `STORAGE | COPY_DST`, at least 256 B, and grows in
256-byte steps; growing retires the draw bind group, which binds its length through `minBindingSize`
(4). The culler owns its pipelines, bounds/stats buffers, pyramid and readbacks, and `dispose` releases
them; `Renderer.dispose` releases the culler. Switching `objectCulling` to `"cpu"` disposes the culler
and clears the reference — a disposed culler records nothing, so keeping it would leave later frames
with no pass at all and draw them through a stale buffer.

**What this does not do.** The batches and their instance data are still built and uploaded for every
renderable; culling here saves the *draw*, not the upload or the batch assembly. Compaction and
GPU-generated indirect draws are Phase 13.6, and they consume exactly this buffer. Culling is
per-batch, so one visible instance keeps its whole batch, and a camera that is neither perspective nor
free of the near plane simply skips the occlusion test.

## 4e. Indirect draws and compaction (Phase 13.6)

Phase 13.5 stops a culled batch from *shading*: its clip position collapses and the rasteriser drops
its triangles. It still costs a `setBindGroup` and a `drawIndexed`, and every instance still runs the
vertex stage. Phase 13.6 removes both: the cull pass writes the draw commands, `forge.main` reads them,
and a culled batch becomes a record with zero instances — a draw the device skips before any shading.

**One record per batch: 8 words, 32 bytes.** `cull.drawRecords` is `STORAGE | INDIRECT | COPY_DST`,
sized one record per batch and grown in steps (`DRAW_RECORD_WORDS` 8, `DRAW_RECORD_BYTES` 32, so every
slot offset is 16-aligned, which is what `drawIndexedIndirect` requires; the 32 bytes leave room for a
future `firstInstance` without moving a slot). The CPU seeds every record from the batch it came from:
words 0/1/2 are the index count, the instance count and the index-buffer start (`0` for a non-indexed
batch), and the pass owns word 1 and nothing else. That split is the point — the index window is the
frame's business and never changes, the instance count is the culler's verdict — and it makes the
record legal for both `drawIndexedIndirect` and `drawIndirect`: a non-indexed batch's word 0 is a
vertex count in the same slot.

**The pass writes the record from the verdict it already had.** `csCull` computes one
`cullReasonOf(box)`, writes `visibility[index]`, `atomicAdd`s the matching counter, and either writes
`drawRecords[index * 8 + 1] = box.max.w` (the batch's instance count, uploaded as the bounds entry's
`max.w`) or `= 0` plus `recordZeroed`. Nothing in the frame decides twice: the word the vertex stage
reads and the word the draw reads come from the same branch. The `CULL_FLAG_RECORDS` flag gates the
writes, so a caller that submits direct draws does not pay for a record it will not read; the twin
(`cullBatchesOnCpu` with `ObjectCullOutputs`) writes exactly the same words and is what the unit tests
compare against.

**Compaction.** The same invocation takes `slot = atomicAdd(&counts.visible, 1u)` and writes its batch
index into `cull.visibleBatches[slot]` — a dense list of the batches that survived, at most
`MAX_CULLED_BATCHES` entries, in the device's own order (the counters say how many are valid and
nothing about the order, because a compute dispatch has no order). It is the producer a compaction-
driven frame consumes; the record's slot is already the batch index, so a `firstInstance` rewrite is a
change to the *record*, not to the list. The pass's counters are exact: `visible = tested - frustum -
distance - occluded`, `recordZeroed = frustum + distance + occluded`, both published as
`stats.cullVisible` / `cullRecordZeroed` through the same one-frame-late readback.

**Batches past the cap.** The pass only touches `index < min(batchCount, MAX_CULLED_BATCHES)`; a frame
past the cap leaves the extra batches untested, which by the 13.5 rule means *visible*, so the renderer
pre-fills every slot with the batch's own instance count and an untested record keeps saying "draw".
The twin reproduces exactly that (it writes the slots it tested and nothing else, and the tests pin
that with sentinel-filled buffers).

**Two submission paths, one picture.** `Renderer.indirectDraws` (default on, `?indirectdraws=0|1` in
the demo, `setIndirectDraws`) picks between `drawIndexedIndirect` / `drawIndirect` at
`batch.cullIndex * DRAW_RECORD_BYTES` and one direct draw per batch with the visibility word doing the
work (13.5's path, kept as the A/B arm and the fallback). A direct-submission frame sets no
`CULL_FLAG_RECORDS`, so the pass leaves the record buffer untouched — nothing pays for a command
nobody reads. The shadow and prepass loops are untouched: they draw their own geometry with their own
culling and would need records of their own. The pointer is the whole
difference — the same batches, the same visibility words, the same pixels — which is what
`check:browser` asserts: `indirectDraws === batches` on one arm, `0` on the other, and zero pixels
between them.

**The mock reads the record.** `MockGPUDevice.drawIndexedIndirect` / `drawIndirect` parse the record
out of the buffer's bytes and log its fields, so a unit test sees what the device would run (including
a 20-byte indexed record whose instance count the cull pass zeroed) rather than what the renderer
believed it wrote. That is what closes the loop for `tests/objectCulling.test.ts` and
`tests/frame.test.ts`, which is why the indirect arm can be asserted without a GPU.

**What the gate proves on a real device.** `check:browser` freezes the PBR fixture and A/Bs the two
cullers: identical frames (max luma diff 0.00, 0 px beyond one level), `forge.objects.cull` in the gpu
arm's pass list and absent from the cpu arm's, and the counters either zero (the readback has not
landed) or the frame's own batch count. It then switches the HiZ stage off: the pyramid passes
disappear, the frame never gets darker, and it is identical — the assertion that catches a cull too
many.

**What the indirect gate proves on a real device.** The same fixture, one more A/B: with indirect
submission on, every `forge.main` draw is indirect (`indirectDraws === batches`) and the pass's
counters satisfy both identities; switch it off and the picture is unchanged to the pixel, with
`indirectDraws` back to `0` — the record words really are the commands the direct path would issue.
The arm then sets a 1 m draw distance over the fixture's renderables: a per-renderable limit the CPU
frame knows nothing about, so the batches it drops are the pass's own distance verdicts, and
`cullRecordZeroed` must equal the cull sum in a frame where `cullDistance > 0`.

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

* Shadow assignment is conservative per renderable, not a single-map heuristic: an object's AABB can
  intersect multiple cascade or spot frusta, in which case its assigned range is submitted to each
  corresponding map. Off-screen caster coverage is preserved, but overlapping maps can repeat vertex
  work; there is no per-map GPU compaction.
* Only the first shadow-casting directional light and up to four spot lights cast. Point-light,
  contact and adaptive-resolution shadows are not implemented yet.
* At 2048², one `depth24plus` layer costs about 16 MiB: three cascades alone are ≈48 MiB, three
  cascades plus four spots ≈112 MiB, and the hard four-cascade/four-spot maximum is ≈128 MiB. The
  4096² ultra profile scales that worst case to ≈512 MiB. All maps use the shared
  `settings.shadow.mapSize` resolution; tests use `shadowMapSize: 256` because the mock device
  allocates texture storage eagerly.
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
* The cluster *fill* runs on the device by default (§4c, `forge.lights.assign`), but `prepare` and
  `count` stay on the CPU: the counts are needed exactly and immediately (the fragment stage indexes
  with them, `stats` reports them), and the two stages are O(lights) and O(lights × slices + clusters)
  — they do not grow with how much of the grid the lights cover. The lists are still ~98 304 u32 of
  device buffer, resident whether or not a scene clusters.
* Local lights are capped at 256 per frame (`MAX_CLUSTERED_LIGHTS`) and each cluster at 32
  (`MAX_LIGHTS_PER_CLUSTER`), where the least influential lose; `stats.lightsDropped` reports either
  case. The cluster buffers cost ≈ 428 KB of VRAM from the first frame whether or not a scene clusters.
* Orthographic cameras are never clustered — the grid's depth axis is view depth, which an orthographic
  projection does not put in `clip.w`, the same reason SSAO is perspective-only — so their local lights
  still go through the fixed 16-entry uniform list.
* The cluster block preserves assigned spot `shadowIndex` values, but point lights and unselected
  spots still use −1. Only the first four valid shadow-casting spot lights receive maps; point-light,
  contact and adaptive-resolution shadows remain roadmap 13.9 work.
* `renderScale` scales the HDR target only; the LDR path always renders at swapchain resolution.
* The graph builds one command buffer and submits it. The engine-level `renderTimeMs` remains a CPU
  submission-side measurement; optional GPU timestamps are reported separately in `Renderer.stats`
  as `gpuFrameTimeMs`, `gpuRenderTimeMs`, `gpuComputeTimeMs` and `gpuPassTimes` (§1).
