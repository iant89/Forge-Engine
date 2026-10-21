/**
 * Forge 1.0 extension contract.
 *
 * Extensions are explicit, named registrations. They never patch engine internals or depend on
 * package subpaths. The registry owns catalogs and lifecycle tokens; the host decides when to attach
 * registered systems to an active Engine and how to consume importers, terrain generators, materials,
 * physics shapes and visualizers. Component registration follows the engine's process-lifetime rule:
 * component type ids are stable for a process and are not removed during an extension uninstall.
 */

import { DisposableGroup, type Disposable } from "./core/events.js";
import type { DeveloperConsole, DeveloperConsoleCommand } from "./debug/console.js";
import type { Engine } from "./core/engine.js";
import { registerComponent, type Component, type ComponentTypeInfo, type RegisterComponentOptions } from "./scene/components.js";
import type { Scene } from "./scene/scene.js";
import type { ISystem } from "./scene/systems.js";
import type { Material, MaterialOptions } from "./rendering/material.js";
import type { Shape } from "./physics/shapes.js";
import type { TerrainStage } from "./terrain/generators.js";

/** The compatibility contract extensions target. */
export const FORGE_EXTENSION_API_VERSION = "1.0" as const;

export type ForgeExtensionCategory =
  | "system"
  | "component"
  | "importer"
  | "terrain-generator"
  | "material"
  | "physics-shape"
  | "debug-visualizer"
  | "console-command";

export interface ForgeExtensionManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: typeof FORGE_EXTENSION_API_VERSION;
  readonly description?: string;
}

export interface ForgeExtension {
  readonly manifest: ForgeExtensionManifest;
  install(context: ForgeExtensionContext): void | Disposable | (() => void);
}

export interface ForgeExtensionRuntimeContext {
  readonly engine: Engine;
  readonly scene: Scene;
}

export interface ForgeExtensionImportContext {
  readonly kind: string;
  readonly signal?: AbortSignal;
  readonly reportProgress?: (fraction: number, note?: string) => void;
}

export interface ForgeExtensionImporter {
  readonly kind: string;
  import(input: unknown, context: ForgeExtensionImportContext): unknown | Promise<unknown>;
}

export type ForgeExtensionSystemFactory = (context: ForgeExtensionRuntimeContext) => ISystem;
export type ForgeExtensionTerrainGeneratorFactory = (options?: Readonly<Record<string, unknown>>) => TerrainStage;
export type ForgeExtensionMaterialFactory = (options?: MaterialOptions) => Material;
export type ForgeExtensionPhysicsShapeFactory = (options?: unknown) => Shape;

export interface ForgeExtensionDebugVisualizer {
  readonly name: string;
  inspect(scene: Scene, options?: Readonly<Record<string, unknown>>): unknown;
  draw?(scene: Scene, target: unknown): void;
}

export interface ForgeExtensionRegistration {
  readonly category: ForgeExtensionCategory;
  readonly name: string;
  readonly extensionId: string;
}

export interface ForgeExtensionRegistrySnapshot {
  readonly apiVersion: typeof FORGE_EXTENSION_API_VERSION;
  readonly extensions: readonly ForgeExtensionManifest[];
  readonly registrations: readonly ForgeExtensionRegistration[];
}

export interface ForgeExtensionContext {
  readonly apiVersion: typeof FORGE_EXTENSION_API_VERSION;
  registerSystem(name: string, factory: ForgeExtensionSystemFactory): Disposable;
  registerComponent<T extends Component>(ctor: new (...args: never[]) => T, options?: RegisterComponentOptions): ComponentTypeInfo;
  registerImporter(importer: ForgeExtensionImporter): Disposable;
  registerTerrainGenerator(name: string, factory: ForgeExtensionTerrainGeneratorFactory): Disposable;
  registerMaterial(name: string, factory: ForgeExtensionMaterialFactory): Disposable;
  registerPhysicsShape(name: string, factory: ForgeExtensionPhysicsShapeFactory): Disposable;
  registerDebugVisualizer(visualizer: ForgeExtensionDebugVisualizer): Disposable;
  registerConsoleCommand(command: DeveloperConsoleCommand): Disposable;
}

/**
 * Host-side registry for supported 1.0 extensions. The registry is deliberately independent of
 * Engine construction so tools can inspect an extension pack before creating a renderer.
 */
export class ForgeExtensionRegistry {
  readonly apiVersion = FORGE_EXTENSION_API_VERSION;
  private readonly extensions = new Map<string, ForgeExtensionManifest>();
  private readonly systems = new Map<string, { extensionId: string; factory: ForgeExtensionSystemFactory }>();
  private readonly importers = new Map<string, { extensionId: string; importer: ForgeExtensionImporter }>();
  private readonly terrainGenerators = new Map<string, { extensionId: string; factory: ForgeExtensionTerrainGeneratorFactory }>();
  private readonly materials = new Map<string, { extensionId: string; factory: ForgeExtensionMaterialFactory }>();
  private readonly physicsShapes = new Map<string, { extensionId: string; factory: ForgeExtensionPhysicsShapeFactory }>();
  private readonly visualizers = new Map<string, { extensionId: string; visualizer: ForgeExtensionDebugVisualizer }>();
  private readonly commands = new Map<string, { extensionId: string; command: DeveloperConsoleCommand }>();
  private readonly components = new Map<string, { extensionId: string; info: ComponentTypeInfo }>();

  /** Install one extension and return a token that removes its catalog registrations. */
  install(extension: ForgeExtension): Disposable {
    validateManifest(extension.manifest);
    if (this.extensions.has(extension.manifest.id)) throw new Error(`Forge extension "${extension.manifest.id}" is already installed`);
    this.extensions.set(extension.manifest.id, { ...extension.manifest });
    const registrations = new DisposableGroup();
    const context = this.contextFor(extension.manifest.id, registrations);
    try {
      const cleanup = extension.install(context);
      if (cleanup) registrations.add(typeof cleanup === "function" ? { dispose: cleanup } : cleanup);
    } catch (error) {
      registrations.dispose();
      this.extensions.delete(extension.manifest.id);
      throw error;
    }
    return {
      dispose: () => {
        registrations.dispose();
        this.extensions.delete(extension.manifest.id);
      },
    };
  }

  /** Attach every registered extension system to the engine's active scene. */
  attachSystems(engine: Engine): Disposable {
    const scene = engine.currentScene;
    if (!scene) throw new Error("ForgeExtensionRegistry.attachSystems requires an active Engine scene");
    const attached = new DisposableGroup();
    try {
      for (const { factory } of this.systems.values()) {
        attached.add(engine.registerSystem(factory({ engine, scene })));
      }
    } catch (error) {
      attached.dispose();
      throw error;
    }
    return attached;
  }

  /** Register all extension console commands with a host console and return one cleanup token. */
  attachConsole(console: DeveloperConsole): Disposable {
    const attached = new DisposableGroup();
    try {
      for (const { command } of this.commands.values()) {
        attached.add({ dispose: console.register(command) });
      }
    } catch (error) {
      attached.dispose();
      throw error;
    }
    return attached;
  }

  importer(kind: string): ForgeExtensionImporter | undefined {
    return this.importers.get(normalizeName(kind))?.importer;
  }

  terrainGenerator(name: string): ForgeExtensionTerrainGeneratorFactory | undefined {
    return this.terrainGenerators.get(normalizeName(name))?.factory;
  }

  material(name: string): ForgeExtensionMaterialFactory | undefined {
    return this.materials.get(normalizeName(name))?.factory;
  }

  physicsShape(name: string): ForgeExtensionPhysicsShapeFactory | undefined {
    return this.physicsShapes.get(normalizeName(name))?.factory;
  }

  debugVisualizer(name: string): ForgeExtensionDebugVisualizer | undefined {
    return this.visualizers.get(normalizeName(name))?.visualizer;
  }

  consoleCommand(name: string): DeveloperConsoleCommand | undefined {
    return this.commands.get(normalizeName(name))?.command;
  }

  /** Detached metadata suitable for an editor or diagnostics panel. */
  snapshot(): ForgeExtensionRegistrySnapshot {
    const registrations: ForgeExtensionRegistration[] = [];
    const add = (category: ForgeExtensionCategory, name: string, extensionId: string): void => {
      registrations.push({ category, name, extensionId });
    };
    for (const [name, entry] of this.components) add("component", name, entry.extensionId);
    for (const [name, entry] of this.systems) add("system", name, entry.extensionId);
    for (const [name, entry] of this.importers) add("importer", name, entry.extensionId);
    for (const [name, entry] of this.terrainGenerators) add("terrain-generator", name, entry.extensionId);
    for (const [name, entry] of this.materials) add("material", name, entry.extensionId);
    for (const [name, entry] of this.physicsShapes) add("physics-shape", name, entry.extensionId);
    for (const [name, entry] of this.visualizers) add("debug-visualizer", name, entry.extensionId);
    for (const [name, entry] of this.commands) add("console-command", name, entry.extensionId);
    registrations.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return {
      apiVersion: this.apiVersion,
      extensions: [...this.extensions.values()].map((manifest) => ({ ...manifest })),
      registrations,
    };
  }

  private contextFor(extensionId: string, registrations: DisposableGroup): ForgeExtensionContext {
    return {
      apiVersion: this.apiVersion,
      registerSystem: (name, factory) => this.add(this.systems, name, { extensionId, factory }, "system", registrations),
      registerComponent: (ctor, options = {}) => {
        const info = registerComponent(ctor, options);
        if (this.components.has(normalizeName(info.name))) throw new Error(`Forge component "${info.name}" is already registered in this extension registry`);
        this.components.set(normalizeName(info.name), { extensionId, info });
        registrations.add({ dispose: () => this.components.delete(normalizeName(info.name)) });
        return info;
      },
      registerImporter: (importer) => this.add(this.importers, importer.kind, { extensionId, importer }, "importer", registrations),
      registerTerrainGenerator: (name, factory) => this.add(this.terrainGenerators, name, { extensionId, factory }, "terrain-generator", registrations),
      registerMaterial: (name, factory) => this.add(this.materials, name, { extensionId, factory }, "material", registrations),
      registerPhysicsShape: (name, factory) => this.add(this.physicsShapes, name, { extensionId, factory }, "physics-shape", registrations),
      registerDebugVisualizer: (visualizer) => {
        if (typeof visualizer.inspect !== "function") throw new Error(`debug visualizer "${visualizer.name}" needs an inspect function`);
        return this.add(this.visualizers, visualizer.name, { extensionId, visualizer }, "debug-visualizer", registrations);
      },
      registerConsoleCommand: (command) => {
        validateConsoleCommand(command);
        return this.add(this.commands, command.name, { extensionId, command }, "console-command", registrations);
      },
    };
  }

  private add<T extends { extensionId: string }>(
    target: Map<string, T>,
    name: string,
    value: T,
    category: ForgeExtensionCategory,
    registrations: DisposableGroup,
  ): Disposable {
    const key = normalizeName(name);
    if (!key) throw new Error(`${category} registration requires a non-empty name`);
    if (target.has(key)) throw new Error(`${category} "${name}" is already registered`);
    target.set(key, value);
    const token = { dispose: () => {
      if (target.get(key) === value) target.delete(key);
    } };
    registrations.add(token);
    return token;
  }
}

function validateManifest(manifest: ForgeExtensionManifest): void {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(manifest.id)) throw new Error(`invalid Forge extension id "${manifest.id}"`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error(`invalid Forge extension version "${manifest.version}"`);
  if (manifest.apiVersion !== FORGE_EXTENSION_API_VERSION) throw new Error(`Forge extension "${manifest.id}" targets API ${manifest.apiVersion}, expected ${FORGE_EXTENSION_API_VERSION}`);
}

function validateConsoleCommand(command: DeveloperConsoleCommand): void {
  const name = command.name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error(`invalid console command name "${command.name}"`);
  if (!command.description.trim()) throw new Error(`console command "${name}" needs a description`);
  if (typeof command.handler !== "function") throw new Error(`console command "${name}" needs a handler`);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
