# Migrating from Forge Engine 0.x to 1.0

Forge 1.0 is the first release with a stable consumer contract. The 0.x package was useful for
building and validating the engine, but it did not promise that every approved candidate would remain
compatible. Read this guide before changing the dependency version.

## 1. Update the dependency and verify the version

```sh
npm install @forge/engine@^1.0.0
```

At runtime, check the package root rather than a deep source path:

```ts
import { VERSION } from "@forge/engine";
console.info(`Forge Engine ${VERSION}`); // 1.x.y
```

The repository release has one version of truth. Do not hand-copy a version into application logic;
use `VERSION` when an application needs to display it.

## 2. Keep imports at the package root

Supported:

```ts
import { Engine, Scene, Transform, Vec3 } from "@forge/engine";
```

Not supported in 1.0:

```ts
// Do not depend on implementation paths.
import { Scene } from "@forge/engine/scene/scene.js";
import { Transform } from "../../engine/src/scene/components/index.js";
```

The root-only boundary is deliberate. If a symbol is missing from the root, open an API request
rather than reaching into `src`.

## 3. Use the 1.0 scene/engine startup shape

A minimal browser host remains small and explicit:

```ts
import { Engine, Scene, Transform, Vec3 } from "@forge/engine";

const canvas = document.querySelector("canvas");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("A canvas is required");

const engine = await Engine.create({ canvas, autostart: false });
const scene = new Scene({ name: "game" });
scene.createTransformedEntity("player", new Vec3(0, 0, 0));
engine.setScene(scene);
engine.start();
```

Do not construct a renderer or reach into `engine.servicesRef`; those are host-owned/internal seams.
Headless tools can construct and inspect `Scene` without creating a WebGPU device.

## 4. Audit application types and behavior

The Phase 27.1 audit approved the existing root names, but the 1.0 contract also covers documented
behavior. Search the application for these high-risk 0.x assumptions:

| 0.x assumption | 1.0 action |
| --- | --- |
| Importing a deep source path | Replace it with a root export or request a public API addition. |
| Treating inferred/internal members as public | Use the emitted root declarations only. |
| Assuming WASM physics is a production solver | Keep the JavaScript backend, or opt into the explicitly experimental WASM state/memory seam. |
| Registering a component repeatedly during hot reload | Install registrations once per process, or isolate a new registry/test process. Component ids are process-stable. |
| Reusing a console command name silently | Resolve the name conflict; 1.0 registration rejects duplicate names. |
| Assuming an extension can remove a component type | Treat component registration as process-lifetime. Other extension catalog entries have disposable registrations. |
| Treating a scene save as a construction script | Follow the serialization documentation and provide the same registered component types when loading. |
| Relying on pixel identity across all GPUs | Use the documented rendering tolerances and the supported WebGPU/browser matrix. |

## 5. Adopt the extension contract (optional)

Extensions are installed through a named manifest and the public `ForgeExtensionRegistry`. This is
the supported way to ship systems, components, importers, terrain stages, materials, physics shapes,
debug visualizers, and console commands:

```ts
import {
  ForgeExtensionRegistry,
  type ForgeExtension,
} from "@forge/engine";

const extension: ForgeExtension = {
  manifest: { id: "studio.gameplay", version: "1.0.0", apiVersion: "1.0" },
  install(context) {
    context.registerImporter({ kind: "game-save", import: (input) => input });
    context.registerConsoleCommand({
      name: "game-version",
      description: "Print the game version.",
      handler: () => "1.0",
    });
  },
};

const extensions = new ForgeExtensionRegistry();
extensions.install(extension);
```

Use `docs/EXAMPLES.md` and `examples/src/api/extension-pack.ts` for a complete pack. The host attaches
registered systems to the active engine once the scene is set:

```ts
const systems = extensions.attachSystems(engine);
// Keep `systems` and dispose it before replacing the engine/scene host.
```

An extension id is lowercase and stable, its version is semver, and its `apiVersion` must equal the
host's `FORGE_EXTENSION_API_VERSION`.

## 6. Handle 0.x data and release policy

1. Back up saved scenes/replays before upgrading.
2. Load one representative save and replay under 1.0 in a staging build.
3. If a serializer reports a warning, migrate the data before writing it with 1.0.
4. Pin the major version in a game release and upgrade through the release notes, not by copying
   internal source files.
5. Keep a rollback build that can read the previous save format until the migration is confirmed.

The 1.0 semver, release, and deprecation rules are in [VERSIONING.md](VERSIONING.md) and
[DEPRECATION.md](DEPRECATION.md). No stable top-level export is deprecated in the initial release;
changes from 0.x that require action are listed here rather than hidden behind warnings.

## Compatibility boundary

The following remain outside the normal stable promise until the API record says otherwise:

- deep imports and unexported implementation classes;
- the nine exports classified as experimental in `engine/api-surface.json`;
- undocumented shader bindings, renderer internals, and private engine services;
- unsupported browser/device behavior and assets outside the documented import formats.

If a migration requires one of these, file a public API issue with the use case and desired
invariant. Do not make the internal path part of your game's long-term contract.
