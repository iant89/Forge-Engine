# Forge-Engine

Browser-native, WebGPU-first 3D game and real-time simulation engine.

```sh
npm run setup          # install/verify Node, npm packages, headless Chromium (idempotent)
npm run verify         # typecheck + unit tests + WGSL checks
npm run check:browser  # real WebGPU render gate (headless Chromium + SwiftShader)
npm run demo           # Vite dev server for examples/
```

See `AGENTS.md` for working conventions, `ARCHITECTURE.md` for design, `docs/RENDERING.md` for
what the renderer does today (render graph, HDR + bloom + tone mapping, cascaded shadow maps), and
`docs/VERIFICATION.md` for what each check proves.

The demo (`npm run demo`) ships two scenes: **PBR Showcase** (Phase 2: instanced material grid,
emissive bloom source, three shadow cascades, HDR / bloom / shadow / cascade-tint toggles in the
panel) and **Cubes** (the Phase 1 spinning-cube scene).
