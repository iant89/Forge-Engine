# Forge-Engine

Browser-native, WebGPU-first 3D game and real-time simulation engine.

```sh
npm run setup          # install/verify Node, npm packages, headless Chromium (idempotent)
npm run verify         # typecheck + unit tests + WGSL checks
npm test                 # selrun full suite, in tests/full.test.ts order
npm run test:affected    # select from working-tree changes; production via explicit @covers only
npm run test:affected -- --base origin/main  # select from origin/main...HEAD, ignoring worktree changes
npm run test:check       # validate suite manifests, all coverage claims, links, and count
npm run check:browser    # separate real-WebGPU gate (headless Chromium + SwiftShader)
npm run check:browser:mars-workers  # focused native-worker / Mars upload gate
npm run check:browser:terrain-layers # focused four-layer PBR pixels / showcase A/B
npm run check:browser:rescue # focused Alpine rescue mission / physics / weather smoke
npm run pr:checks -- 68 --watch --interval 15 # live, colorized pull-request check dashboard
npm run demo           # Vite dev server for examples/
```

See `AGENTS.md` for working conventions, `ARCHITECTURE.md` for design, `docs/RENDERING.md` for
what the renderer does today (render graph, HDR + bloom + tone mapping, cascaded shadow maps, the
depth prepass and SSAO, the analytic sky pass and fog), `docs/ENVIRONMENT.md` for the sun/sky/fog/day-night model,
`docs/MARS-TERRAIN.md` for the ported Mars generator (the same planet as the external
`mars-terrain-gen`), and `docs/VERIFICATION.md` for what each check proves.

The demo (`npm run demo`) opens directly on **Mars Showcase**: a 6-wheeled Perseverance rover
(the public-domain NASA/JPL GLB) on an electric drivetrain (`ElectricMotor` + 60:1
`ReductionDrive`, ≈6 km/h top speed with regenerative braking) driving over streamed, cratered Mars
terrain beneath a Mars sky, with wind-blown and wheel-kick dust. The showcase now uses the ported
`mars-terrain-gen` surface (seed 1337), starting on a gentle equatorial traverse. It runs **analytic-only**
without downloading an erosion cache; analytic cell generation uses the worker pool (with an inline
fallback), while mesh uploads/uncached ground queries stay on main. Its dust/rock/sand/crust weights
now blend four shared PBR texture-array layers (see `docs/MARS-TERRAIN.md`). Use `WASD` / arrow keys to drive
and `Space` for the handbrake, `M` to raise the camera mast, and `R` to unfold the front robotic
arm — once out, jog its swing, shoulder, elbow and turret with `F/H`, `T/G`, `I/K`, `J/L` or the
two thumbsticks that appear above the drive pad on touch layouts. About five seconds after the
model lands, the high-gain antenna unfurls by itself and tracks Earth for the life of the scene —
slew-limited gimbals compensate every rover move, and there is no stow control. The
scene selector also offers these demos: **PBR Showcase** (Phase 2: instanced material grid,
emissive bloom source, three shadow cascades, HDR / bloom / shadow / prepass / SSAO / cascade-tint
toggles in the panel), **Cubes** (Phase 1), **Terrain** (Phase 4, beneath the Martian sky and dust haze, with Phase 14's
deterministic rock and boulder populations streaming in per chunk — thousands of instanced rocks, zero entities per
rock), **Realistic
(Alpine)** (Phase 4), **Mars Generator (P10.9)** (the ported planet as a *site inspector*: free orbit camera, no rover, and the site from the URL — `?marssite=vallesRift`, or `?marssite=0,0` for the crater field where the four material layers actually mix), **Vehicle** (Phase 6: WASD on a pad that becomes a 12° ramp, `Space`
handbrake, `P` to latch the parking brake; see `docs/VEHICLES.md`), **Particles** (Phase 7: a CPU fountain of a few hundred sprites; see
`docs/PARTICLES.md`), **Sky / Day-night** (Phase 8a: a June day at 47°N in six minutes — `[` `]`
scrub the clock, `T` pauses it, `M` swaps Earth for Mars), **Weather / Water** (Phase 8b: storm
presets with rain, lightning, a Gerstner lake and an underwater dive), **Rover Course** (Perseverance
on an Earth-gravity obstacle track with cones, gates and knockable props), **Skinned Arm (P16.5)**
(a standalone GPU-skinning demo: four linked box segments bend around four joints in a travelling-wave
pose; it is not another Mars/rover scene), and **Alpine Search & Rescue: Whiteout Run** (a drivable
mountain rescue 4×4 mission: load medical supplies, visit three distress beacons, deliver the kit,
and return as snowfall and wind build; dynamic crates and roadside rocks use the shared terrain/vehicle
physics world). Direct links include `?scene=pbr`, `?scene=cubes`,
`?scene=terrain`, `?scene=realistic`, `?scene=mars-generator`, `?scene=vehicle`, `?scene=particles`,
`?scene=sky`, `?scene=weather`, `?scene=mars-showcase`, `?scene=rover-course`, `?scene=skinning`,
and `?scene=alpine-rescue` (`?scene=mars` is an alias for the Mars-flavoured Terrain demo,
`?scene=mars-port` for the generator inspector).
