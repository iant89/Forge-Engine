/**
 * @suite core:extensions
 * @group unit
 * @covers engine/src/extensions.ts
 * @covers engine/src/index.ts
 * @desc Forge 1.0 extension manifest, registration, lookup, snapshot, and disposal contract
 */

export const suite = {
  name: "core:extensions",
  group: "unit",
  covers: ["engine/src/extensions.ts", "engine/src/index.ts"],
  desc: "Forge 1.0 extension manifest, registration, lookup, snapshot, and disposal contract",
};

import assert from "node:assert/strict";
import {
  Component,
  DeveloperConsole,
  ForgeExtensionRegistry,
  Material,
  SphereShape,
  type DeveloperConsoleCommand,
  type ForgeExtensionContext,
  type ISystem,
  type TerrainStage,
} from "@forge/engine";
import { finish, test } from "selrun";

class ForgeContractProbeComponent extends Component {}

const probeSystem = (): ISystem => ({
  name: "probe-system",
  order: 200,
  enabled: true,
  update: () => undefined,
});

const probeStage = (): TerrainStage => ({
  name: "probe-stage",
  process: () => undefined,
});

const probeCommand: DeveloperConsoleCommand = {
  name: "probe",
  description: "Probe the extension contract.",
  handler: () => "ok",
};

test("installs, catalogs, looks up, snapshots, and disposes every supported extension category", () => {
  const registry = new ForgeExtensionRegistry();
  const extension = {
    manifest: {
      id: "example.contract",
      version: "1.0.0",
      apiVersion: "1.0" as const,
    },
    install(context: ForgeExtensionContext) {
      context.registerSystem("Probe-System", () => probeSystem());
      context.registerComponent(ForgeContractProbeComponent, { name: "ForgeContractProbe" });
      context.registerImporter({ kind: "JSON", import: (input) => input });
      context.registerTerrainGenerator("Probe-Terrain", () => probeStage());
      context.registerMaterial("Probe-Material", (options) => new Material(options));
      context.registerPhysicsShape("Probe-Shape", () => new SphereShape(1));
      context.registerDebugVisualizer({ name: "Probe-Visualizer", inspect: () => ({ ok: true }) });
      context.registerConsoleCommand(probeCommand);
    },
  };

  const installed = registry.install(extension);
  assert.equal(registry.apiVersion, "1.0");
  assert.equal(registry.importer("json")?.kind, "JSON");
  assert.equal(registry.terrainGenerator("probe-terrain")?.()?.name, "probe-stage");
  assert.equal(registry.material("probe-material")?.({ label: "from-extension" }).label, "from-extension");
  assert.equal(registry.physicsShape("probe-shape")?.()?.type, "sphere");
  assert.equal(registry.debugVisualizer("probe-visualizer")?.name, "Probe-Visualizer");
  assert.equal(registry.consoleCommand("probe"), probeCommand);
  const console = new DeveloperConsole();
  const attachedConsole = registry.attachConsole(console);
  assert.equal(console.execute("probe").ok, true);

  const snapshot = registry.snapshot();
  assert.deepEqual(snapshot.extensions.map(({ id, version, apiVersion }) => ({ id, version, apiVersion })), [
    { id: "example.contract", version: "1.0.0", apiVersion: "1.0" },
  ]);
  assert.deepEqual(
    snapshot.registrations.map(({ category, name }) => `${category}:${name}`),
    [
      "component:forgecontractprobe",
      "console-command:probe",
      "debug-visualizer:probe-visualizer",
      "importer:json",
      "material:probe-material",
      "physics-shape:probe-shape",
      "system:probe-system",
      "terrain-generator:probe-terrain",
    ],
  );

  attachedConsole.dispose();
  assert.equal(console.execute("probe").ok, false);
  installed.dispose();
  assert.equal(registry.snapshot().extensions.length, 0);
  assert.equal(registry.snapshot().registrations.length, 0);
});

test("rejects incompatible manifests and duplicate registration names", () => {
  const registry = new ForgeExtensionRegistry();
  assert.throws(() => registry.install({
    manifest: { id: "Bad ID", version: "1.0.0", apiVersion: "1.0" },
    install: () => undefined,
  }), /invalid Forge extension id/);
  assert.throws(() => registry.install({
    manifest: { id: "example.old", version: "1.0.0", apiVersion: "0.9" as never },
    install: () => undefined,
  }), /targets API/);

  const installed = registry.install({
    manifest: { id: "example.duplicate", version: "1.0.0", apiVersion: "1.0" },
    install: (context) => {
      context.registerSystem("same", () => probeSystem());
      assert.throws(() => context.registerSystem(" SAME ", () => probeSystem()), /already registered/);
    },
  });
  installed.dispose();
});

await finish();
