# Known issues and limitations

Kept current at the end of every phase. Each entry says what is missing or approximate and where
the honest detail lives; nothing here is hidden behind a green gate.

## Rendering (Phase 2)

* **Casters are drawn once per cascade they intersect.** There is per-cascade AABB culling but no
  per-object cascade assignment, so a near object costs up to N shadow draws. `stats.shadowsDrawn`
  makes it visible. (`docs/RENDERING.md` §9)
* **Only the first shadow-casting directional light casts.** Spot and point lights light the scene
  but do not shadow it.
* **Shadow atlas memory.** The default profile's 2048² × 3 `depth24plus` array is ≈ 48 MB. Lower
  profiles cap `shadowMapSize`; there is no adaptive resolution.
* **No aliasing happens in the default frame.** The graph's live-range aliasing is implemented and
  tested, but the current pass set has no two same-shaped transients with disjoint lifetimes, so
  `aliasedBytes` reads 0 in the HUD until a depth prepass / SSAO buffer exists.
* **`renderScale` applies to the HDR path only.** The LDR path always renders at swapchain size.
* **No GPU timestamps.** `renderTimeMs` is CPU encode time; pass timings are not measured.
* **Bloom and tone mapping are not compared against reference images.** The browser gate proves
  presence and direction (A/B luminance) and the pass structure; visual quality is an eyeball check
  on `tools/.browser-check.png`.
* **WebKit is not run.** Uniform layout strictness is enforced statically (`check:wgsl`,
  `tests/wgsl.test.ts`); no Safari build exists in the sandbox.

## Core (Phase 1)

* **Worker execution across threads has no test suite.** The scheduler and worker entry exist and
  typecheck; round-trips are not exercised.
* **Resource cache eviction is untested.** Texture/mesh registries compile; LRU behaviour under
  memory pressure is not covered.

## Documentation debt

`ARCHITECTURE.md` and `ROADMAP.md` describe the target design and refer to documents that do not
exist yet (`PERFORMANCE.md`, `ASSETS.md`, ADRs). Sections marked "As built" in `ARCHITECTURE.md` and
`docs/RENDERING.md` describe what is real today.
