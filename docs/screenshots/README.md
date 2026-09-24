# Mars showcase — diagnostic screenshots

Captured headless (Chromium + SwiftShader, real WebGPU) against the Mars showcase demo while
building the loading screen and debug-bounds diagnostics. They document what each instrument
shows in the failure modes of an "invisible rover / invisible terrain" report.

| File | What it shows |
| --- | --- |
| `mars-showcase-loading.png` | The loading screen mid-fetch: spinner, `model: downloading …` line with the (indeterminate) progress bar, and the terrain streaming state (`220 chunks · 1.6 MB resident`). The placeholder rover and its auto bounds boxes sit blurred behind the overlay. |
| `mars-showcase-loaded.png` | Steady state after the overlay fades: the Perseverance GLB on the streamed terrain; HUD reports `GLB ok`. |
| `mars-showcase-load-failed.png` | The loading screen after an aborted GLB fetch: `model: FAILED — Failed to fetch` with **Retry model** and **Continue with placeholder** actions. |
| `mars-showcase-bounds-auto.png` | After skipping a failed load: the scene's *auto* debug bounds — yellow chassis footprint box and green wheel-hub boxes — marking where the model is supposed to sit while the placeholder drives. |
| `mars-showcase-bounds-renderer.png` | `Renderer.debugBounds` (toolbar **Bounds** button / `?bounds=1`): world-space AABBs of every visible renderable, cyan in view / magenta culled, drawn depth-test-free so they show through terrain — the long cyan streaks are the 128 m terrain-chunk boxes. |

Reproducing locally:

```sh
npm run demo            # open /?scene=mars-showcase
# loading screen appears automatically; fails show Retry / Continue
# bounds: Rendering panel → Bounds, or deep-link:
#   /?scene=mars-showcase&bounds=1
```
