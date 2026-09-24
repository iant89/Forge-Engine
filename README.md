# Forge-Engine

Browser-native, WebGPU-first 3D game and real-time simulation engine.

```sh
npm run setup          # install/verify Node, npm packages, headless Chromium (idempotent)
npm run verify         # typecheck + unit tests + WGSL checks
npm run check:browser  # real WebGPU render gate (headless Chromium + SwiftShader)
npm run demo           # Vite dev server for examples/
```

See `AGENTS.md` for working conventions, `ARCHITECTURE.md` for design, `docs/RENDERING.md` for
what the renderer does today (render graph, HDR + bloom + tone mapping, cascaded shadow maps, the
analytic sky pass and fog), `docs/ENVIRONMENT.md` for the sun/sky/fog/day-night model, and
`docs/VERIFICATION.md` for what each check proves.

The demo (`npm run demo`) opens directly on **Mars Showcase**: a 6-wheeled Perseverance rover
(the public-domain NASA/JPL GLB) driving over streamed, cratered Mars terrain beneath a Mars sky, with
wind-blown and wheel-kick dust. Use `WASD` / arrow keys to drive and `Space` for the handbrake, `M`
to raise the camera mast, and `R` to unfold the front robotic arm — once out, jog its swing,
shoulder, elbow and turret with `F/H`, `T/G`, `I/K`, `J/L` or the two thumbsticks that appear above
the drive pad on touch layouts. The
scene selector still offers all nine demos: **PBR Showcase** (Phase 2: instanced material grid,
emissive bloom source, three shadow cascades, HDR / bloom / shadow / cascade-tint toggles in the
panel), **Cubes** (Phase 1), **Terrain** (Phase 4, beneath the Martian sky and dust haze), **Realistic
(Alpine)** (Phase 4), **Vehicle** (Phase 6: WASD on a pad that becomes a 12° ramp; see
`docs/VEHICLES.md`), **Particles** (Phase 7: a CPU fountain of a few hundred sprites; see
`docs/PARTICLES.md`), **Sky / Day-night** (Phase 8a: a June day at 47°N in six minutes — `[` `]`
scrub the clock, `T` pauses it, `M` swaps Earth for Mars), and **Weather / Water** (Phase 8b: storm
presets with rain, lightning, a Gerstner lake and an underwater dive). `?scene=pbr`, `?scene=terrain`,
`?scene=vehicle`, `?scene=particles`, `?scene=sky`, `?scene=weather` and `?scene=mars-showcase` open
scenes directly (`?scene=mars` is an alias for the Mars-flavoured Terrain demo).
