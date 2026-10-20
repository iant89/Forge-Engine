# @forge/engine

WebGPU-first 3D game and real-time simulation engine for the browser.

> Forge is currently `0.1.x`. Phase 27 has started the API 1.0 audit; the root export surface is
> machine-pinned through direct/transitive declaration fingerprints, but compatibility decisions,
> complete reference documentation, migration policy, and the 1.0 extension contract are not finished.

## Import

After linking the workspace package (or adding a packaged release as a dependency), import only the
root entry point:

```ts
import { Engine, Scene, Transform, VERSION } from "@forge/engine";

const canvas = document.querySelector("canvas")!;
const engine = await Engine.create({ canvas, autostart: false });
const scene = new Scene({ name: `Forge ${VERSION} scene` });
const cameraRig = scene.createEntity("Camera rig");
cameraRig.add(new Transform()).setPosition(0, 2, -6);
engine.setScene(scene);
engine.start();
```

The package exposes one entry point: `@forge/engine`. Deep paths are internal implementation details
and are not package exports.

## API stability

Top-level exports are classified as:

- **public** — supported 1.0 candidates during the pre-1.0 audit;
- **experimental** — incomplete or opt-in and allowed to change before 1.0;
- **deprecated** — retained temporarily for migration, with a documented replacement;
- **internal** — absent from the package root.

The currently experimental names are the Phase 25 WASM-physics state/memory seam. Forge does not yet
ship an executable WASM physics solver; JavaScript physics remains the production backend.

The source repository contains the deterministic `engine/api-surface.json` audit and the full policy
in `docs/API.md`. Direct and transitive declaration fingerprints now detect parameter/member/type
changes, but a detected declaration is still only a 1.0 candidate: the gate does not decide whether a
change is compatible or prove runtime semantics, and per-symbol approval remains open.

## Requirements

- A browser with WebGPU for presented rendering.
- TypeScript 5.7+ is recommended for the shipped declarations.
- Node.js 20.11+ for repository tools and server-side/headless development.

Forge has no WebGL fallback.
