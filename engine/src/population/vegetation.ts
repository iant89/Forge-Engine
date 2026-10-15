/**
 * Vegetation field (fe-37b): instanced, LOD-switched, wind-swayed plants — the runtime half of the
 * procedural trees (`tree.ts`) and grass (`grass.ts`).
 *
 * Each *model* is a set of parts (geometry per LOD + one shared material, e.g. a tree's wood and
 * leaves); each *instance* is a placement (position, yaw, scale, tint) of a model. Instances become
 * plain `Renderable` entities sharing their model's geometry and material, so the renderer draws
 * every instance of a (geometry, material) pair as one instanced batch; the per-instance `tint`
 * gives each plant its own colour without breaking the batch.
 *
 * Every `refreshInterval` seconds the field walks the instances against the viewer: past
 * `maxDistance` an instance is hidden, inside `lodDistance` it takes the hi geometry, else the lo
 * one (density LOD for grass — the lo patch has a third of the blades). Visible instances inside
 * `swayDistance` are posed every frame by the engine's vegetation wind (`windSway`): the whole plant
 * leans about its root, downwind, with its own phase so a stand ripples instead of moving in step.
 *
 * Weather: {@link VegetationField.setSurface} puts the 17.4 wetness/snow on the field's materials as
 * per-object snow (`Material.setSnowCover`), with a low snow line so blades and leaf cards — which
 * face every way — still collect it.
 */

import { Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { Renderable, Transform } from "../scene/components/index.js";
import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import type { Geometry } from "../rendering/geometry.js";
import type { Material } from "../rendering/material.js";
import { createWindSwayPose, windSway, type WindSwayParams } from "./windSway.js";

export interface VegetationPart {
  hi: Geometry;
  /** Far geometry; omitted/null keeps `hi` at every distance. */
  lo?: Geometry | null;
  material: Material;
  castShadow?: boolean;
}

export interface VegetationModel {
  parts: VegetationPart[];
  /** Hi → lo switch distance (m). */
  lodDistance: number;
  /** Hidden beyond this (m); 0 = never hidden. */
  maxDistance: number;
  /** Wind response (lean, frequency). */
  sway?: WindSwayParams;
  /** Sway only inside this distance (m). Default `lodDistance`. */
  swayDistance?: number;
}

export interface VegetationFieldOptions {
  name?: string;
  models: VegetationModel[];
  /** Viewer position (the camera). */
  viewer: () => { x: number; y: number; z: number };
  /** Horizontal wind (m/s). */
  wind: () => { x: number; z: number };
  /** Seconds between LOD/visibility passes. Default 0.2. */
  refreshInterval?: number;
  /** Multiplies every model's distances (the tier knob). Default 1. */
  distanceScale?: number;
}

interface Instance {
  model: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  tint: number;
  phase: number;
  /** Entity id per part (created on attach). */
  entities: number[];
  /** -1 hidden, 0 hi, 1 lo. */
  state: number;
}

const UP = new Vec3(0, 1, 0);

export class VegetationField extends SceneObject {
  readonly name: string;
  readonly models: readonly VegetationModel[];
  distanceScale: number;
  refreshInterval: number;
  private readonly viewer: VegetationFieldOptions["viewer"];
  private readonly wind: VegetationFieldOptions["wind"];
  private readonly instances: Instance[] = [];
  private swaying: Instance[] = [];
  private sinceRefresh = Infinity;
  private time = 0;
  private readonly pose = createWindSwayPose();
  private readonly params: WindSwayParams = {};
  private readonly qYaw = new Quat();
  private readonly qTilt = new Quat();
  private readonly axis = new Vec3();
  private readonly counts = { hidden: 0, hi: 0, lo: 0, swaying: 0 };

  constructor(options: VegetationFieldOptions) {
    super();
    this.name = options.name ?? "vegetation";
    this.models = options.models;
    this.viewer = options.viewer;
    this.wind = options.wind;
    this.refreshInterval = options.refreshInterval ?? 0.2;
    this.distanceScale = options.distanceScale ?? 1;
  }

  /** Place an instance of model `model`. Returns its index. */
  add(model: number, x: number, y: number, z: number, yaw = 0, scale = 1, tint = 0): number {
    if (!this.models[model]) throw new RangeError(`VegetationField: no model ${model}`);
    const inst: Instance = { model, x, y, z, yaw, scale, tint, phase: (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % (Math.PI * 2), entities: [], state: -2 };
    this.instances.push(inst);
    if (this.scene) this.spawn(this.scene, inst);
    return this.instances.length - 1;
  }

  get count(): number {
    return this.instances.length;
  }

  /** Visibility counts from the last refresh (diagnostics / gates). */
  get stats_(): { hidden: number; hi: number; lo: number; swaying: number } {
    return { ...this.counts };
  }

  override stats(): Record<string, number> {
    return { instances: this.instances.length, ...this.counts };
  }

  /** Weather on the plants: 17.4 wetness and snow (0..1) onto every model material. */
  setSurface(wetness: number, snow: number): void {
    const seen = new Set<Material>();
    for (const m of this.models) {
      for (const p of m.parts) {
        if (seen.has(p.material)) continue;
        seen.add(p.material);
        // Snow line 0.2: anything not facing down holds a little (blades, cards face all ways).
        p.material.setSnowCover(Math.max(0, Math.min(1, snow)), 0.2, Math.max(0, Math.min(1, wetness)));
      }
    }
  }

  override onAttach(scene: Scene): void {
    for (const inst of this.instances) if (inst.entities.length === 0) this.spawn(scene, inst);
    this.sinceRefresh = Infinity;
  }

  override onDetach(scene: Scene): void {
    for (const inst of this.instances) {
      for (const id of inst.entities) scene.destroyEntity({ id });
      inst.entities.length = 0;
      inst.state = -2;
    }
    this.swaying = [];
  }

  private spawn(scene: Scene, inst: Instance): void {
    const model = this.models[inst.model]!;
    this.qYaw.setAxisAngle(UP, inst.yaw);
    for (let k = 0; k < model.parts.length; k++) {
      const part = model.parts[k]!;
      const e = scene.createTransformedEntity(`${this.name}-${inst.model}-${k}`, new Vec3(inst.x, inst.y, inst.z));
      const t = scene.world.getComponent(e.id, Transform)!;
      t.setRotation(this.qYaw);
      t.setScale(inst.scale);
      const r = new Renderable();
      r.geometry = part.hi;
      r.material = part.material;
      r.castShadow = part.castShadow ?? false;
      r.tint = inst.tint;
      r.visible = false;
      scene.world.addComponent(e.id, r);
      inst.entities.push(e.id);
    }
    inst.state = -1;
  }

  /** Re-evaluate LOD and visibility now (also runs on its own every `refreshInterval`). */
  refresh(): void {
    const scene = this.scene;
    if (!scene) return;
    const v = this.viewer();
    const swaying: Instance[] = [];
    let hidden = 0, hi = 0, lo = 0;
    for (const inst of this.instances) {
      const model = this.models[inst.model]!;
      const d = Math.hypot(inst.x - v.x, inst.y - v.y, inst.z - v.z);
      const max = model.maxDistance * this.distanceScale;
      const state = max > 0 && d > max ? -1 : d <= model.lodDistance * this.distanceScale ? 0 : 1;
      if (state === -1) hidden++;
      else if (state === 0) hi++;
      else lo++;
      if (state >= 0 && d <= (model.swayDistance ?? model.lodDistance) * this.distanceScale) swaying.push(inst);
      else if (inst.state >= 0 && state >= 0 && this.swaying.includes(inst)) this.pose_(scene, inst, 0, 0, 0); // leave it upright
      if (state === inst.state) continue;
      for (let k = 0; k < inst.entities.length; k++) {
        const r = scene.world.getComponent(inst.entities[k]!, Renderable);
        if (!r) continue;
        const part = model.parts[k]!;
        r.visible = state >= 0;
        if (state >= 0) r.geometry = state === 1 && part.lo ? part.lo : part.hi;
      }
      inst.state = state;
    }
    this.swaying = swaying;
    this.counts.hidden = hidden;
    this.counts.hi = hi;
    this.counts.lo = lo;
    this.counts.swaying = swaying.length;
  }

  private pose_(scene: Scene, inst: Instance, axisX: number, axisZ: number, bend: number): void {
    this.qYaw.setAxisAngle(UP, inst.yaw);
    if (bend !== 0) {
      this.axis.set(axisX, 0, axisZ);
      this.qTilt.setAxisAngle(this.axis, bend);
      this.qYaw.premultiply(this.qTilt);
    }
    for (const id of inst.entities) scene.world.getComponent(id, Transform)?.setRotation(this.qYaw);
  }

  override update(_context: SystemContext, dt: number): void {
    const scene = this.scene;
    if (!scene) return;
    this.time += dt;
    this.sinceRefresh += dt;
    if (this.sinceRefresh >= this.refreshInterval) {
      this.sinceRefresh = 0;
      this.refresh();
    }
    const w = this.wind();
    for (const inst of this.swaying) {
      const model = this.models[inst.model]!;
      const sp = this.params;
      sp.maxBend = model.sway?.maxBend;
      sp.halfBendWind = model.sway?.halfBendWind;
      sp.frequency = model.sway?.frequency;
      sp.stormWind = model.sway?.stormWind;
      sp.phase = inst.phase + (model.sway?.phase ?? 0);
      const p = windSway(w.x, w.z, this.time, sp, this.pose);
      // Leaf flutter adds a little fast motion on top of the lean.
      const bend = p.bend + p.flutter * 0.08;
      this.pose_(scene, inst, p.axisX, p.axisZ, bend);
    }
  }
}
