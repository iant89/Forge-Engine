# Forge Engine public API

Phase 27 is the API-stabilization phase. Forge is still version `0.1.0`; this document and the
machine-readable surface snapshot establish the audit boundary, but they do **not** claim that the
entire 1.0 review, documentation set, migration guide, extension API, or compatibility policy is
finished.

## The package boundary

Application and tool code imports runtime symbols from the package root:

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

`engine/package.json` exports only `"."`. A path such as `@forge/engine/src/scene/world` or a relative
reach into `engine/src` is not public API, even if the source declaration itself uses TypeScript's
`export` keyword. Repository architecture gates independently reject those deep imports from the
editor, examples, and tests.

The public barrel is `engine/src/index.ts`. It currently resolves to **2,180 named exports**:
2,171 public candidates, 9 experimental exports, and no deprecated top-level exports. That is a
large pre-1.0 surface. The Phase 27 audit freezes its current shape so it can be reduced or approved
intentionally rather than drifting accidentally.

## Stability labels

Every top-level package export has one of these classifications in `engine/api-surface.json`:

| Label | Meaning during the 0.x audit |
| --- | --- |
| `public` | Intentionally reachable from `@forge/engine` and a candidate for the supported 1.0 API. It is not yet a promise that its member signatures have completed the Phase 27 review. |
| `experimental` | Opt-in, incomplete, or still gathering implementation evidence. It may change or disappear before 1.0. Its declaration carries `@experimental` with a reason. |
| `deprecated` | Still exported for migration. Its declaration must carry `@deprecated` with an explanation and should name the replacement. No top-level export is in this category today. |
| internal | Not exported from the package root. An `@internal` declaration leaking through `@forge/engine` fails the audit rather than appearing in the snapshot. |

An explicit `@public` tag is allowed but unnecessary: package-root exports default to `public`.
Conflicting labels fail the gate. `@experimental` and `@deprecated` tags without explanatory text
also fail.

The nine experimental exports are the Phase 25 WASM-physics seam:

- `PhysicsBackendKind`, `createPhysicsBackend`, `ForgeWasmPhysics`, and
  `ForgeWasmPhysicsOptions`;
- `WASM_PHYSICS_LAYOUT`, `WASM_PHYSICS_STATE_SCHEMA`, `WasmPhysicsMemory`,
  `WasmPhysicsMemoryOptions`, and `WasmPhysicsStateSnapshot`.

Those names expose a versioned memory/state contract, but there is no executable WASM solver yet.
The JavaScript physics implementation remains the production backend.

## Surface audit

The checked-in `engine/api-surface.json` is generated from TypeScript's resolved module symbols, not
from a regular expression over export statements. Each row records:

- the exported name;
- whether consumers receive a type, a runtime value, or both;
- its public/experimental/deprecated classification.

The snapshot deliberately omits declaration order and implementation file paths, so internal moves
do not look like API changes. It also validates that:

- `@forge/engine` has exactly one package export (`"."`);
- its JavaScript and type entry points are `dist/index.js` and `dist/index.d.ts`;
- the root package, engine package, and exported `VERSION` agree;
- no default or `@internal` export leaks into the root;
- names are unique and deterministically sorted;
- stability tags are non-conflicting and explained where required.

Run the gate before committing any public-barrel change:

```sh
npm run api:check
```

A deliberate API change uses this review loop:

```sh
# 1. Change engine/src/index.ts or an exported declaration.
# 2. Add the right JSDoc stability label and update API/migration documentation.
npm run api:update
# 3. Review engine/api-surface.json as an API diff, then run all ordinary gates.
npm run api:check
npm run verify
```

`api:update` is not an approval mechanism. It only writes the current resolved surface; reviewers
must decide whether an addition, removal, rename, kind change, or stability change is appropriate.
CI runs `api:check` and rejects an unreviewed snapshot drift.

## What the first audit does not prove

This initial snapshot catches top-level name, type/value-kind, package-boundary, and stability-label
changes. It does **not** yet compare function parameters, class members, generic constraints, enum
values, object mutability, runtime behavior, serialization schemas, or WebGPU shader/layout ABIs.
A name can therefore remain in the snapshot while receiving a breaking signature change. Closing
Phase 27.1 requires per-symbol review and a declaration-level compatibility check rather than merely
retaining this baseline.

Phase 27.2–27.7 also remain open: comprehensive symbol documentation and examples, a migration
guide, final semantic-versioning and deprecation windows, and a supported extension API for systems,
components, importers, terrain generators, materials, physics shapes, debug visualizers, and console
commands. Existing subsystem-specific registration hooks are not yet one coherent 1.0 extension
contract.
