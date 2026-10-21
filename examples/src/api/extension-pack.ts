/**
 * Reviewed 1.0 API example: one extension pack with every supported registration category.
 *
 * A real game normally splits these registrations across files. This compact pack is intentionally
 * deterministic and has no DOM/WebGPU dependency, so it can be reviewed and run in Node tests.
 */
import {
  Component,
  Material,
  SphereShape,
  type DeveloperConsoleCommand,
  type ForgeExtension,
  type ForgeExtensionContext,
  type ISystem,
  type TerrainStage,
} from "@forge/engine";

class ExampleHealth extends Component {
  current = 100;
}

const exampleSystem = (): ISystem => ({
  name: "example-health",
  order: 200,
  enabled: true,
  update: ({ world }) => {
    for (const health of world.store(ExampleHealth).liveValues()) {
      if (health.current < 0) health.current = 0;
    }
  },
});

const exampleStage = (): TerrainStage => ({
  name: "example-flat-stage",
  process: (cell) => {
    cell.heights.fill(0);
  },
});

const exampleCommand: DeveloperConsoleCommand = {
  name: "example-health",
  description: "Describe the extension health component.",
  handler: () => "ExampleHealth is installed.",
};

/** Install once during application startup, before the host attaches systems to an Engine. */
export function createExampleExtension(): ForgeExtension {
  return {
    manifest: {
      id: "forge.example-pack",
      version: "1.0.0",
      apiVersion: "1.0",
      description: "A complete, dependency-free extension contract example.",
    },
    install(context: ForgeExtensionContext): void {
      context.registerSystem("health", () => exampleSystem());
      context.registerComponent(ExampleHealth, { name: "ExampleHealth", singleton: false });
      context.registerImporter({ kind: "example", import: (input) => input });
      context.registerTerrainGenerator("flat", () => exampleStage());
      context.registerMaterial("example", (options) => new Material(options));
      context.registerPhysicsShape("example-sphere", () => new SphereShape(0.5));
      context.registerDebugVisualizer({
        name: "example-health",
        inspect: (scene) => ({ scene: scene.name, component: "ExampleHealth" }),
      });
      context.registerConsoleCommand(exampleCommand);
    },
  };
}
