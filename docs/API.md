# Forge Engine public API

Forge Engine 1.0.0 is the first release covered by the consumer-facing API contract. The package root
contains **2,197** audited exports: **2,188 public**, **9 experimental**, and **0 deprecated**. All
2,188 public rows have exact approval entries and the declaration/contract audit is CI-gated. The approval ledger records 2,188/2,188 public candidates with zero pending.

This page explains the boundary and review mechanism. The [complete API reference](API-REFERENCE.md)
is the searchable export inventory; the emitted package declarations are the normative source for full
signatures.

## The package boundary

Application and tool code imports runtime symbols from the package root:

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

`engine/package.json` exports only `"."`. A path such as `@forge/engine/src/scene/world` or a
relative reach into `engine/src` is not public API, even if the source declaration uses TypeScript's
`export` keyword. Repository architecture gates reject those deep imports from editor, examples, and
tests.

## Stability labels

Every top-level package export has one of these classifications in `engine/api-surface.json`:

| Label | Meaning in 1.0 |
| --- | --- |
| `public` | Approved for the stable 1.0 consumer contract. |
| `experimental` | Opt-in, incomplete, or still gathering implementation evidence. It may change or disappear before a later compatibility review. Its declaration carries `@experimental` with a reason. |
| `deprecated` | Still exported during the documented migration window. Its declaration must carry `@deprecated` with an explanation and replacement. No top-level export is currently deprecated. |
| internal | Not exported from the package root. An `@internal` declaration leaking through `@forge/engine` fails the audit. |

An explicit `@public` tag is allowed but unnecessary: package-root exports default to `public`. Conflicting
labels and unexplained experimental/deprecated tags fail the gate.

The nine experimental exports are the Phase 25 WASM-physics seam:

- `PhysicsBackendKind`, `createPhysicsBackend`, `ForgeWasmPhysics`, and `ForgeWasmPhysicsOptions`;
- `WASM_PHYSICS_LAYOUT`, `WASM_PHYSICS_STATE_SCHEMA`, `WasmPhysicsMemory`, `WasmPhysicsMemoryOptions`, and `WasmPhysicsStateSnapshot`.

Those names expose a versioned memory/state contract, but there is no executable WASM solver yet. The
JavaScript physics implementation remains the production backend. Experimental rows are deliberately
outside the normal 1.0 compatibility promise.

## Extension contract

`ForgeExtensionRegistry` is the supported 1.0 host contract for systems, components, importers, terrain
generators, materials, physics shapes, debug visualizers, and console commands. An extension declares a
lowercase stable id, a semver version, and `apiVersion: "1.0"`; the host validates the manifest before
installation. Registration names are normalized and duplicate names fail rather than silently replacing
another extension. Catalog registrations, attached systems, and attached console commands return disposables. Component ids are
process-stable and are not reused when an extension token is disposed, so hot reload cannot reinterpret
saved component data.

```ts
import {
  ForgeExtensionRegistry,
  type ForgeExtension,
} from "@forge/engine";

const pack: ForgeExtension = {
  manifest: { id: "studio.gameplay", version: "1.0.0", apiVersion: "1.0" },
  install(context) {
    context.registerSystem("gameplay", () => ({
      name: "gameplay",
      order: 200,
      enabled: true,
      update: () => undefined,
    }));
    context.registerImporter({ kind: "game-save", import: (input) => input });
  },
};

const registry = new ForgeExtensionRegistry();
const installed = registry.install(pack);
// Set the scene first, then attach registered systems once for this Engine.
const attached = registry.attachSystems(engine);
```

The full registration example is [`docs/EXAMPLES.md`](EXAMPLES.md) and
[`examples/src/api/extension-pack.ts`](../examples/src/api/extension-pack.ts).

## Surface audit and approvals

The checked-in `engine/api-surface.json` uses schema `forge.api-surface/2` and is generated from
TypeScript's resolved module symbols and in-memory declaration emit, not from a regular expression over
export statements. Each row records the exported name, type/value kind, stability classification, a `declarationHash` of that symbol's body-free emitted declaration, and a `contractHash` covering engine-local declaration dependencies.

The direct hash detects parameter, return, overload, generic-constraint, class/interface member,
modifier, enum, tuple, and inferred exported-type drift. The transitive hash catches an unexported
helper type changing while a root function's own emitted line remains identical. Both exclude
implementation bodies, ordinary prose comments, and source paths.

The audit also validates that:

- `@forge/engine` has exactly one package export (`"."`);
- its JavaScript and type entry points are `dist/index.js` and `dist/index.d.ts`;
- the root package, engine package, exported `VERSION`, and snapshot version agree;
- no default or `@internal` export leaks into the root;
- names and fingerprints are unique, sorted, and canonical;
- stability tags are non-conflicting and explained where required.

`engine/api-approvals.json` uses schema `forge.api-approvals/1` and policy
`forge.api-approval-policy/2`. It is separate from the generated surface: `npm run api:update` can
record what TypeScript emits, but it cannot grant an approval or refresh a stale one. Each approved row
records its name, kind, direct hash, transitive hash, and named review batch. A declaration or stability
change therefore forces a human review rather than silently becoming a release contract.

Run the gates before changing the public barrel:

```sh
npm run api:check
npm run api:reference:check
```

A deliberate API change uses this loop:

```sh
# change source, tests, and consumer documentation first
npm run api:update
# review engine/api-surface.json, update api-approvals.json after human review
npm run api:reference
npm run api:check
npm run typecheck
npm run test
```

A generated row is not approval. Hashes identify affected contracts; reviewers inspect source
declarations, runtime behavior, serialization, shader/resource ABI, and the semver classification.

## Release and migration policy

The version source of truth, semver classification, release checklist, and package consistency rules
are in [VERSIONING.md](VERSIONING.md). The minimum deprecation window and removal process are in
[DEPRECATION.md](DEPRECATION.md). Consumers moving from the 0.x package should follow
[MIGRATION-1.0.md](MIGRATION-1.0.md). Reviewed runnable examples are listed in [EXAMPLES.md](EXAMPLES.md).

The API audit is a **change detector**, not a compatibility oracle. It does not prove runtime behavior,
performance, serialization compatibility, shader/buffer ABI compatibility, pixel identity across
hardware, or external ambient-library contracts. Those claims require the focused tests and browser
verification gates named by the subsystem documentation.
