# Forge-Engine

Browser-native, WebGPU-first 3D game and real-time simulation engine.

```sh
npm run setup          # install/verify Node, npm packages, headless Chromium (idempotent)
npm run verify         # typecheck + unit tests + WGSL checks
npm run check:browser  # real WebGPU render gate (headless Chromium + SwiftShader)
npm run demo           # Vite dev server for examples/
```

See `AGENTS.md` for working conventions, `ARCHITECTURE.md` for design, and `docs/VERIFICATION.md`
for what each check proves.
