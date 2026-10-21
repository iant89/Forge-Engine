# @forge/engine

WebGPU-first 3D game and real-time simulation engine for the browser. This package is the Forge
Engine **1.0.0** release.

## Import

After linking the workspace package (or adding the packaged release as a dependency), import only the
root entry point:

```ts
import { Engine, Scene, Transform, VERSION } from "@forge/engine";

const canvas = document.querySelector("canvas");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("A canvas is required");
const engine = await Engine.create({ canvas, autostart: false });
const scene = new Scene({ name: `Forge ${VERSION} scene` });
const cameraRig = scene.createEntity("Camera rig");
cameraRig.add(new Transform()).setPosition(0, 2, -6);
engine.setScene(scene);
engine.start();
```

The package exposes one entry point: `@forge/engine`. It is the only supported entry point. Deep
paths are internal implementation details and are not package exports.

## API reference and examples

- [Complete root export reference](../docs/API-REFERENCE.md)
- [Reviewed runnable examples](../docs/EXAMPLES.md)
- [0.x to 1.0 migration guide](../docs/MIGRATION-1.0.md)
- [Semantic-versioning and release policy](../docs/VERSIONING.md)
- [Deprecation and removal policy](../docs/DEPRECATION.md)
- [Extension contract example](../examples/src/api/extension-pack.ts)

The reference inventory is generated from the reviewed `engine/api-surface.json` snapshot. The
emitted declaration files remain the normative signature source; behavioral guides and tests are the
normative behavior source.

## API stability

Top-level exports are classified as:

- **public** — approved for the 1.0 consumer contract;
- **experimental** — incomplete or opt-in and allowed to change before a later compatibility review;
- **deprecated** — retained temporarily for migration, with a documented replacement;
- **internal** — absent from the package root.

The currently experimental names are the Phase 25 WASM-physics state/memory seam. Forge does not yet
ship an executable WASM physics solver; JavaScript physics remains the production backend. Experimental
names are not covered by the ordinary 1.0 compatibility promise.

The source repository contains the deterministic `engine/api-surface.json` audit, the separately
reviewed `engine/api-approvals.json` ledger, and the review record in `docs/API-REVIEW.md`. Direct and
transitive declaration fingerprints detect parameter/member/type changes. Approval rows bind a named
review to exact hashes and become stale on contract drift; regenerating the surface cannot refresh
them. The release policy is in `docs/VERSIONING.md` and the deprecation window is in
`docs/DEPRECATION.md`.

## Requirements

- A browser with WebGPU for presented rendering.
- TypeScript 5.7+ is recommended for the shipped declarations.
- Node.js 20.11+ for repository tools and server-side/headless development.

Forge has no WebGL fallback.
