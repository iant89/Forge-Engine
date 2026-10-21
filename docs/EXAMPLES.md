# Forge 1.0 examples

The reviewed 1.0 examples import only from `@forge/engine`, avoid implementation paths, and are
included in the repository TypeScript gate. They are deliberately split into host-independent
factories so a game can unit-test scene and extension setup before it asks a browser for WebGPU.

## Run and review the examples

From the repository root:

```sh
npm run typecheck
npm run demo:build
```

`npm run typecheck` includes `examples/tsconfig.json` and therefore compiles the reviewed API files.
The Vite demo remains the visual end-to-end example; the files below are the small reference examples
that make the public contract easy to copy.

## Hello world scene

[`examples/src/api/hello-world.ts`](../examples/src/api/hello-world.ts) creates a `Scene`, a camera
entity, and a transformed player entity without requiring a GPU:

```ts
import { Camera, Scene, Vec3 } from "@forge/engine";

export function createHelloWorldScene(): Scene {
  const scene = new Scene({ name: "hello-world" });
  const camera = scene.createTransformedEntity("main-camera", new Vec3(0, 2, 6));
  camera.add(new Camera());
  scene.createTransformedEntity("player", new Vec3(0, 0, 0));
  return scene;
}
```

A browser host creates the engine, assigns this scene, and starts the loop:

```ts
import { Engine } from "@forge/engine";
import { createHelloWorldScene } from "./hello-world.js";

const engine = await Engine.create({ canvas, autostart: false });
engine.setScene(createHelloWorldScene());
engine.start();
```

## Complete extension pack

[`examples/src/api/extension-pack.ts`](../examples/src/api/extension-pack.ts) is the reviewed
runnable contract example. It registers one of every supported category:

- a gameplay system;
- a serializable component type;
- an asset importer;
- a terrain generator/stage;
- a material factory;
- a physics-shape factory;
- a debug visualizer;
- a developer-console command.

Install it once during startup:

```ts
import { ForgeExtensionRegistry, createDeveloperConsole } from "@forge/engine";
import { createExampleExtension } from "./extension-pack.js";

const registry = new ForgeExtensionRegistry();
const installed = registry.install(createExampleExtension());
const console = createDeveloperConsole();
// after the active scene is set:
const attachedSystems = registry.attachSystems(engine);
const attachedConsole = registry.attachConsole(console);

// On host shutdown, detach systems, console commands, and extension-owned catalog entries.
attachedConsole.dispose();
attachedSystems.dispose();
installed.dispose();
```

Component type ids are process-stable and are not reused when an extension token is disposed. The
other catalog registrations are removed by their disposable token. This is intentional: a loaded
scene must not reinterpret a component id after hot reload.

## Example review checklist

Every new example should:

1. import from the package root only;
2. compile under the repository's strict TypeScript configuration;
3. have no hidden DOM/WebGPU requirement unless it is explicitly a browser example;
4. show disposal and ownership for engine, system, event, and extension resources;
5. state whether behavior is stable, experimental, or host-specific;
6. be linked from this page and covered by a focused test or build gate.
