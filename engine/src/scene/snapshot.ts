/**
 * Scene snapshots (Phase 19.3): the mid-run simulation state of a whole scene, so a session can be
 * forked or rolled back and continue exactly as it would have.
 *
 * A snapshot is not a save (scene/serialization.ts). A save describes a scene to rebuild; a snapshot
 * restores state into **the same scene, or one built the same way**: the same entities in the same
 * order, the same systems, the same scene objects. It holds:
 *
 *  - every live entity's local transform (simulations such as physics write them);
 *  - the scene settings and the world's surface grip — weather and day/night rewrite fog, sky,
 *    clouds and grip as they run, and the systems read them back next step;
 *  - each world system's `snapshotState()` (the physics world, …), or, for a fixed-step system
 *    without one, its step count;
 *  - each component's registered `snapshot` (vehicles, …);
 *  - each scene object's `snapshotState()` (weather, day/night, lightning schedule, …).
 *
 * Restoring checks the structure first — entity count and names, every recorded system, component and
 * object present — and throws before changing anything if it does not match. Everything in it is
 * JSON-safe and exact through `JSON.stringify` (core/snapshot.ts), and `hashSceneSnapshot` reduces it
 * to a 32-bit hash: run the same inputs from the same snapshot and the hashes agree.
 *
 * Not included: the engine clock (the caller drives the fixed steps), script timers, coroutines and
 * event subscriptions (closures), and transient visuals (strikes in flight, particles).
 */

import { UsageError } from "../core/errors.js";
import { captureState, decodeNumber, encodeNumber, hashState, restoreState, type StateRecord, type StateValue } from "../core/snapshot.js";
import { Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { tryComponentInfo } from "./components.js";
import { setWorldSurfaceGrip, worldSurfaceGrip } from "./surfaceGrip.js";
import type { Scene } from "./scene.js";

export const SCENE_SNAPSHOT_FORMAT = "forge.snapshot";
export const SCENE_SNAPSHOT_VERSION = 1;

export interface SceneSnapshot {
  format: typeof SCENE_SNAPSHOT_FORMAT;
  version: typeof SCENE_SNAPSHOT_VERSION;
  /** Entity names in live order — the structure a restore must match. */
  entities: string[];
  /** Local TRS per entity (position xyz, rotation xyzw, scale xyz), null without a transform. */
  transforms: (StateValue[] | null)[];
  /** `scene.exportSettings()`, number-exact. */
  settings: StateRecord;
  /** The world's uniform surface grip (`setWorldSurfaceGrip`), or null when unset. */
  surfaceGrip: StateValue;
  systems: Record<string, StateRecord>;
  components: { entity: number; type: string; state: StateRecord }[];
  objects: Record<string, StateRecord>;
}

const scratchPos = new Vec3();
const scratchRot = new Quat();
const scratchScale = new Vec3();
const scratchTRS = { position: scratchPos, rotation: scratchRot, scale: scratchScale };

export function captureSceneSnapshot(scene: Scene): SceneSnapshot {
  const world = scene.world;
  const ids = world.liveEntityIds();
  const transforms: (StateValue[] | null)[] = [];
  const components: SceneSnapshot["components"] = [];
  ids.forEach((id, index) => {
    if (world.hasTransform(id)) {
      world.transforms.writeTRS(world.transformSlot(id), scratchTRS as never);
      const p = scratchPos;
      const r = scratchRot;
      const s = scratchScale;
      transforms.push([p.x, p.y, p.z, r.x, r.y, r.z, r.w, s.x, s.y, s.z].map(encodeNumber));
    } else {
      transforms.push(null);
    }
    for (const c of world.facade(id)!.components) {
      const info = tryComponentInfo(c.constructor);
      if (info?.snapshot) components.push({ entity: index, type: info.name, state: info.snapshot(c) });
    }
  });
  const systems: Record<string, StateRecord> = {};
  for (const system of world.systems) {
    if (system.snapshotState) systems[system.name] = system.snapshotState();
    else if (typeof (system as { stepsExecuted?: unknown }).stepsExecuted === "number") {
      systems[system.name] = { stepsExecuted: (system as unknown as { stepsExecuted: number }).stepsExecuted };
    }
  }
  const objects: Record<string, StateRecord> = {};
  for (const o of scene.objects) {
    const state = o.snapshotState?.();
    if (state) objects[o.name] = state;
  }
  return {
    format: SCENE_SNAPSHOT_FORMAT,
    version: SCENE_SNAPSHOT_VERSION,
    entities: ids.map((id) => world.name(id)),
    transforms,
    settings: captureState(scene.exportSettings()),
    surfaceGrip: ((g) => (g === undefined ? null : encodeNumber(g)))(worldSurfaceGrip(world)),
    systems,
    components,
    objects,
  };
}

/** Restore a `captureSceneSnapshot` into the same scene (or one built the same way). */
export function restoreSceneSnapshot(scene: Scene, input: unknown): void {
  const snap = input as SceneSnapshot;
  if (!snap || typeof snap !== "object" || snap.format !== SCENE_SNAPSHOT_FORMAT) throw new UsageError("Scene snapshot: not a forge.snapshot document");
  if (snap.version !== SCENE_SNAPSHOT_VERSION) throw new UsageError(`Scene snapshot: version ${String(snap.version)} is not ${SCENE_SNAPSHOT_VERSION}`);
  const world = scene.world;
  const ids = world.liveEntityIds();

  // Check the whole structure before touching anything.
  if (ids.length !== snap.entities.length || ids.some((id, i) => world.name(id) !== snap.entities[i])) {
    throw new UsageError(`Scene snapshot: the scene's ${ids.length} entities do not match the snapshot's ${snap.entities.length} (by count and name, in order)`);
  }
  const systemsByName = new Map(world.systems.map((s) => [s.name, s]));
  for (const name of Object.keys(snap.systems)) {
    if (!systemsByName.has(name)) throw new UsageError(`Scene snapshot: system "${name}" is not in this scene`);
  }
  const componentTargets = snap.components.map((entry) => {
    const id = ids[entry.entity];
    const c = id === undefined ? undefined : world.facade(id)!.components.find((x) => tryComponentInfo(x.constructor)?.name === entry.type);
    const info = c ? tryComponentInfo(c.constructor) : undefined;
    if (!c || !info?.restoreSnapshot) throw new UsageError(`Scene snapshot: entity ${entry.entity} has no restorable ${entry.type}`);
    return { c, info, state: entry.state };
  });
  for (const name of Object.keys(snap.objects)) {
    const o = scene.object(name);
    if (!o?.restoreSnapshotState) throw new UsageError(`Scene snapshot: scene object "${name}" is missing or cannot restore`);
  }

  const settings = scene.exportSettings();
  restoreState(settings, snap.settings, "settings");
  scene.importSettings(settings);
  setWorldSurfaceGrip(world, snap.surfaceGrip === null ? undefined : decodeNumber(snap.surfaceGrip));
  snap.transforms.forEach((trs, i) => {
    if (!trs) return;
    const v = trs.map((x) => decodeNumber(x) ?? 0);
    scratchPos.set(v[0]!, v[1]!, v[2]!);
    scratchRot.set(v[3]!, v[4]!, v[5]!, v[6]!);
    scratchScale.set(v[7]!, v[8]!, v[9]!);
    const id = ids[i]!;
    world.transforms.setLocalTRS(world.transformSlot(id, true), scratchPos, scratchRot, scratchScale);
    const t = world.facade(id)!.components.find((x) => tryComponentInfo(x.constructor)?.name === "Transform") as
      | { position: Vec3; rotation: Quat; scale: Vec3 }
      | undefined;
    if (t) {
      t.position.copyFrom(scratchPos);
      t.rotation.copyFrom(scratchRot);
      t.scale.copyFrom(scratchScale);
    }
  });
  for (const [name, state] of Object.entries(snap.systems)) {
    const system = systemsByName.get(name)!;
    if (system.restoreSnapshotState) system.restoreSnapshotState(state);
    else if (typeof state["stepsExecuted"] === "number") (system as unknown as { stepsExecuted: number }).stepsExecuted = state["stepsExecuted"];
  }
  for (const { c, info, state } of componentTargets) info.restoreSnapshot!(c, state);
  for (const [name, state] of Object.entries(snap.objects)) scene.object(name)!.restoreSnapshotState!(state);
}

/** 32-bit FNV-1a of the snapshot's canonical JSON (see `hashState`). */
export function hashSceneSnapshot(snap: SceneSnapshot): string {
  return hashState(snap as unknown as StateValue);
}
