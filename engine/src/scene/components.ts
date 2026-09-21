/**
 * Component base + registry.
 *
 * A component is a plain object; its *storage* is per-type and owned by the world. The base class
 * keeps only what every subsystem needs:
 *  - `entity` (back-reference, validated through the world, never a raw pointer)
 *  - `enabled` (cheap per-component gate respected by systems)
 *  - lifecycle hooks (`onAttach`/`onDetach`) so components can subscribe to world events without
 *    leaking subscriptions (the world disposes the group on detach — this is the "never leak GPU
 *    resources across scene changes" requirement in the small).
 *
 * Registration is explicit (`registerComponent`) instead of reflection, so ids are stable across
 * builds — required for scene serialization and for worker-side decoding.
 */

import { UsageError } from "../core/errors.js";
import { DisposableGroup, type Disposable } from "../core/events.js";
import { ObjectStore, type ComponentStorage } from "./stores.js";
import { MAX_COMPONENT_TYPES, type EntityId } from "./entityId.js";

export abstract class Component {
  /** Set by the world on attach. 0 = not attached. */
  entity: EntityId = 0 as EntityId;
  enabled = true;
  /** Internal: the world's component store entry for fast removal. */
  /** @internal */
  _typeId = -1;
  /** @internal Subscriptions that must die with the component. */
  /** @internal */
  _disposables?: DisposableGroup;

  /** Called after the component is attached and its `entity` is valid. */
  onAttach?(_world: WorldLike): void;

  /** Called before detach; the entity is still valid here. */
  onDetach?(_world: WorldLike): void;

  /** Called whenever the entity's transform moved (world matrices fresh). */
  onTransformChanged?(_world: WorldLike): void;

  /** Called on visibility change (culling result). */
  onVisibilityChanged?(_visible: boolean, _world: WorldLike): void;

  /** Optional disposal (GPU handles, audio nodes). Always called on detach. */
  dispose?(): void;

  get disposables(): DisposableGroup {
    return (this._disposables ??= new DisposableGroup());
  }

  addDisposable(d: Disposable): void {
    this.disposables.add(d);
  }
}

/**
 * The slice of `EntityWorld` components talk to. Declared here (rather than importing `world.js`)
 * because the world imports this module — `EntityWorld` satisfies it structurally, and the compiler
 * checks that at the call sites.
 */
export interface WorldLike {
  readonly transforms: import("../math/transform.js").TransformStore;
  readonly generation: number;
  transformSlot(id: EntityId, create?: boolean): number;
  worldPosition(id: EntityId, out?: import("../math/vec.js").Vec3): import("../math/vec.js").Vec3;
  name(id: EntityId): string;
}

export interface ComponentTypeInfo {
  id: number;
  name: string;
  /** Constructor signature — used by the editor + scene loader to rebuild components. */
  create?: (data: Record<string, unknown>) => Component;
  store: ComponentStorage<Component>;
  /** Serialize to plain JSON-ish data (default: own enumerable fields, skipping objects). */
  serialize?: (c: Component) => Record<string, unknown>;
  deserialize?: (c: Component, data: Record<string, unknown>, ctx: DeserializationContext) => void;
  /** Editor metadata (which inspector group, whether it can be added more than once). */
  singleton?: boolean;
  editorGroup?: string;
  allowMultiple?: boolean;
}

export interface DeserializationContext {
  /** Resolve a named/typed asset reference (material, mesh, script). */
  resolveAsset?(kind: string, id: string): unknown;
  /** Register an async post-link step (e.g. bind a material handle once loaded). */
  defer?(fn: () => void | Promise<void>): void;
}

const registry: ComponentTypeInfo[] = [];
const byName = new Map<string, ComponentTypeInfo>();
const byConstructor = new Map<Function, ComponentTypeInfo>();
let dirty = 1;

export interface RegisterComponentOptions {
  name?: string;
  create?: (data: Record<string, unknown>) => Component;
  serialize?: (c: Component) => Record<string, unknown>;
  deserialize?: (c: Component, data: Record<string, unknown>, ctx: DeserializationContext) => void;
  /** Use a struct store with fixed float/int counts instead of an object store. */
  struct?: { floats: number; ints: number };
  singleton?: boolean;
  editorGroup?: string;
  /**
   * Allow the same component type more than once on a single entity. Off by default for
   * "one per entity" components (Transform, Camera, Vehicle); on for things like AudioSource.
   */
  allowMultiple?: boolean;
}

export function registerComponent<T extends Component>(ctor: new (...args: never[]) => T, options: RegisterComponentOptions = {}): ComponentTypeInfo {
  const name = options.name ?? ctor.name;
  if (byName.has(name)) throw new UsageError(`Component type name "${name}" is already registered`);
  if (byConstructor.has(ctor)) throw new UsageError(`Component ${name} is already registered`);
  if (registry.length >= MAX_COMPONENT_TYPES) {
    throw new UsageError(`Too many component types (${MAX_COMPONENT_TYPES} max). Group related state into one component.`);
  }
  const id = registry.length;
  const store = new ObjectStore<Component>(id, name) as unknown as ComponentStorage<Component>;
  const info: ComponentTypeInfo = {
    id,
    name,
    create: options.create,
    serialize: options.serialize,
    deserialize: options.deserialize,
    store,
    singleton: options.singleton,
    editorGroup: options.editorGroup ?? name,
    allowMultiple: options.allowMultiple ?? true,
  };
  registry.push(info);
  byName.set(name, info);
  byConstructor.set(ctor as unknown as Function, info);
  dirty++;
  return info;
}

export function componentInfo<T extends Component>(ctor: (new (...args: never[]) => T) | ComponentTypeInfo | string): ComponentTypeInfo {
  if (typeof ctor === "string") {
    const info = byName.get(ctor);
    if (!info) throw new UsageError(`Component "${ctor}" is not registered`);
    return info;
  }
  if ("store" in (ctor as ComponentTypeInfo)) return ctor as unknown as ComponentTypeInfo;
  const info = byConstructor.get(ctor as unknown as Function);
  if (!info) {
    const name = (ctor as unknown as { name?: string }).name ?? String(ctor);
    throw new UsageError(
      `Component "${name}" is not registered. Call registerComponent(${name}) (engine built-ins do this automatically).`,
    );
  }
  return info;
}

export function tryComponentInfo(ctor: Function): ComponentTypeInfo | undefined {
  return byConstructor.get(ctor);
}

export function allComponentTypes(): readonly ComponentTypeInfo[] {
  return registry;
}

export function componentTypeById(id: number): ComponentTypeInfo | undefined {
  return registry[id];
}

export function componentRegistryVersion(): number {
  return dirty;
}

/** Test hook: remove all registrations (used by the architecture tests only). */
export function resetComponentRegistry(): void {
  registry.length = 0;
  byName.clear();
  byConstructor.clear();
  dirty++;
}
