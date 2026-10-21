# @forge/engine

WebGPU-first 3D game and real-time simulation engine for the browser.

> Forge is currently `0.1.x`. Phase 27.1's public API audit is complete: the root export surface is
> machine-pinned through direct/transitive declaration fingerprints, all 2,171 public candidates
> have exact approvals across 22 subsystem reviews, and nine exports remain experimental. Complete
> reference documentation/examples, migration/versioning/deprecation policy, the extension contract,
> and the `1.0.0` release remain later Phase 27 work.

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

The source repository contains the deterministic `engine/api-surface.json` audit, the separately
reviewed `engine/api-approvals.json` ledger, the review record in `docs/API-REVIEW.md`, and the full
policy in `docs/API.md`. Direct and transitive declaration fingerprints detect
parameter/member/type changes. Approval rows bind a named human review to exact hashes and become
stale on contract drift; regenerating the surface cannot refresh them. Policy v2 requires all public
exports to stay approved, while focused suites supply runtime evidence. The gate detects drift and
enforces recorded decisions; it does not infer compatibility from hashes or replace the remaining
Phase 27 documentation and policy work.

## Requirements

- A browser with WebGPU for presented rendering.
- TypeScript 5.7+ is recommended for the shipped declarations.
- Node.js 20.11+ for repository tools and server-side/headless development.

Forge has no WebGL fallback.
