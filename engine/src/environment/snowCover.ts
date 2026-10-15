/**
 * Per-object snow cover, melt and shedding (fe-38).
 *
 * {@link SnowCover} is a component: the snow lying on one object — its depth, how far down the
 * object's sides it reaches (`extent`, the angle from straight up), and its liquid-water content
 * (`wetness`). {@link SnowMeltSystem} steps every cover against the scene's sun, sky and weather
 * ({@link sampleMeltEnvironment}):
 *
 * - **Melt** from the point energy balance ({@link snowEnergyBalance}) at the cover's own sun
 *   incidence, with the substrate heating through a thin layer; meltwater runs off and drips onto a
 *   {@link GroundMoistureField} (puddles, mud) under the object.
 * - **Wetting**: melt raises the liquid-water content; a wet base lubricates the pack and lowers
 *   the angle it can hold ({@link criticalShedAngle}: ~55° dry, ~15° saturated, less on tight
 *   curvature where a thick layer overhangs).
 * - **Shedding**: on a sphere (curved) the band beyond the critical angle releases as clumps that
 *   *slide* over the surface (friction falls with wetness) and leave it where the normal force
 *   vanishes — the classic detachment angle; on a box/slab (flat) the whole sheet slides once the
 *   tilt passes the critical angle, and a wet cornice drops off the rim. Released snow becomes
 *   {@link SnowChunk}s that fly ballistically, land, and lie on the ground field as snow that keeps
 *   melting.
 *
 * Rendering is decoupled: a cover's `target` (any object with `setSnowCover`, e.g. a `Material`)
 * receives amount / snow line / wetness whenever they change.
 */

import { Vec3 } from "../math/vec.js";
import { clamp, smoothstep } from "../math/scalar.js";
import { Rng } from "../math/rng.js";
import { Component, registerComponent } from "../scene/components.js";
import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import type { Light } from "../scene/components/index.js";
import { Quat } from "../math/mat.js";
import { DEFAULT_SNOW_DENSITY, WATER_DENSITY, createMeltEnvironment, meltRate, sampleMeltEnvironment, snowAlbedo, snowEnergyBalance, substrateFlux, type MeltEnvironment } from "./snowMelt.js";
import type { GroundMoistureField } from "./moistureField.js";
import type { WeatherSystem } from "./weather.js";

const DEG = Math.PI / 180;
const GRAVITY = 9.81;

/** Shape of the snow-carrying surface, in the entity's local frame (y up). */
export type SnowShape =
  | { kind: "sphere"; radius: number; centerY?: number }
  | { kind: "box"; halfX: number; halfZ: number; topY: number };

/** Anything that can show a cover (a `Material` implements it). */
export interface SnowCoverTarget {
  setSnowCover(amount: number, snowLine: number, wetness: number): void;
}

export interface SnowCoverOptions {
  shape: SnowShape;
  /** Snow depth in metres. Default 0.06. */
  depth?: number;
  /** Sphere only: how far down from the top the snow reaches, degrees (clamped to the dry critical angle). Default 70. */
  extentDeg?: number;
  /** Albedo of the object under the snow (dark rock/paint melts its cover from below). Default 0.3. */
  substrateAlbedo?: number;
  /** Constant heat from the object, W/m² (engine bay, heated roof). Default 0. */
  substrateHeat?: number;
  target?: SnowCoverTarget | null;
}

export class SnowCover extends Component {
  static readonly typeName = "SnowCover";
  shape: SnowShape;
  depth: number;
  /** Radians from straight up that the cover reaches (sphere); a box covers its top face. */
  extent: number;
  /** 0..1 liquid-water content of the pack. */
  wetness = 0;
  substrateAlbedo: number;
  substrateHeat: number;
  target: SnowCoverTarget | null;
  /** Snow volume (m³) released by shedding so far, and meltwater (m³ of water) run off so far. */
  shedVolume = 0;
  meltwater = 0;
  /** Box: the rim cornice has dropped since the cover was (re)loaded. */
  corniceDropped = false;
  /** Box: the sheet has slid off. */
  sheetSlid = false;
  /** @internal last values pushed to the target. */
  pushed = [-1, -1, -1];

  constructor(options: SnowCoverOptions) {
    super();
    this.shape = options.shape;
    this.depth = options.depth ?? 0.06;
    this.substrateAlbedo = options.substrateAlbedo ?? 0.3;
    this.substrateHeat = options.substrateHeat ?? 0;
    this.target = options.target ?? null;
    const radius = this.shape.kind === "sphere" ? this.shape.radius : Infinity;
    const dry = criticalShedAngle(0, this.depth, radius);
    this.extent = this.shape.kind === "sphere" ? Math.min((options.extentDeg ?? 70) * DEG, dry) : 0;
  }

  /** Reload the cover (a fresh snowfall): depth, dry, sheet and cornice back on. */
  reload(depth: number, extentDeg = 70): void {
    this.depth = depth;
    this.wetness = 0;
    this.corniceDropped = false;
    this.sheetSlid = false;
    const radius = this.shape.kind === "sphere" ? this.shape.radius : Infinity;
    if (this.shape.kind === "sphere") this.extent = Math.min(extentDeg * DEG, criticalShedAngle(0, depth, radius));
  }

  /** Snow volume currently on the object (m³). */
  volume(up: { y: number } = { y: 1 }): number {
    if (this.depth <= 0) return 0;
    if (this.shape.kind === "sphere") {
      const r = this.shape.radius;
      return 2 * Math.PI * r * r * (1 - Math.cos(this.extent)) * this.depth;
    }
    void up;
    return this.sheetSlid ? 0 : 4 * this.shape.halfX * this.shape.halfZ * this.depth;
  }
}
registerComponent(SnowCover, { name: "SnowCover", allowMultiple: false });

/**
 * Steepest slope (radians) a pack can hold. Dry, cohesive snow sticks to ~55°; liquid water at the
 * base lubricates it down to ~15° (wet-snow avalanches release on 15–25°); on a tight curve a layer
 * thick against the radius overhangs and holds less.
 */
export function criticalShedAngle(wetness: number, depth: number, radius: number): number {
  const curvature = Number.isFinite(radius) && radius > 0 ? clamp(depth / radius, 0, 1) * 30 : 0;
  return clamp(55 - 40 * clamp(wetness, 0, 1) - curvature, 8, 70) * DEG;
}

/** Sliding friction of snow on a surface: ~0.3 dry, ~0.05 on a meltwater film. */
export function snowFriction(wetness: number): number {
  return 0.3 - 0.25 * clamp(wetness, 0, 1);
}

/**
 * The angle (from the top) at which a block sliding from rest at `theta0` over a sphere leaves it:
 * frictionless from the top it is the textbook cos θ = 2/3 (48.2°); integrated here with friction `mu`.
 */
export function sphereDetachAngle(theta0: number, mu: number, radius = 1): number {
  let theta = theta0;
  let omega = 0.05 / radius;
  const dt = 1 / 600;
  for (let i = 0; i < 60000; i++) {
    const normal = GRAVITY * Math.cos(theta) - radius * omega * omega;
    if (normal <= 0) return theta;
    const along = GRAVITY * Math.sin(theta) - mu * normal;
    omega = Math.max(0.02 / radius, omega + (along / radius) * dt);
    theta += omega * dt;
    if (theta > Math.PI / 2) return theta;
  }
  return theta;
}

/** Where a covered object is (world position and rotation; root entities). */
export interface SnowPose {
  readonly position: Vec3;
  readonly rotation: Quat;
}

/** A released piece of snow: sliding over its source, then flying, then landed. */
export interface SnowChunk {
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** m³ of snow. */
  volume: number;
  /** Visual radius (m). */
  size: number;
  /** "slide-sphere" | "slide-plane" | "fall". */
  phase: "slide-sphere" | "slide-plane" | "fall";
  /** Sphere slide state. */
  center?: Vec3;
  radius?: number;
  theta?: number;
  omega?: number;
  azimuth?: number;
  /** Plane slide state: unit downslope direction, normal, distance left to the edge, speed. */
  dir?: Vec3;
  normal?: Vec3;
  remaining?: number;
  speed?: number;
  mu: number;
  age: number;
}

export interface SnowMeltSystemOptions {
  name?: string;
  /** Weather to read temperature/wind/cover/rain from. Default: the scene's object named "weather". */
  weather?: WeatherSystem | null;
  /** Ground field meltwater drips onto and shed snow lands on. */
  field?: GroundMoistureField | null;
  /** Step the field as well (default true when a field is given). */
  stepField?: boolean;
  /** Simulated seconds per real second for melt/drying (shedding motion stays real-time). Default 1. */
  timeScale?: number;
  /** W/m² per unit of directional light intensity. Default 250. */
  irradiancePerUnit?: number;
  /** Ground height for chunks landing outside the field. Default the field's height, else 0. */
  groundAt?: (x: number, z: number) => number;
  /** Most chunks one shed event may release. Default 10. */
  maxChunksPerEvent?: number;
  /** Snow volume per chunk (m³). Default 0.004 (a 10 cm clump). */
  chunkVolume?: number;
  /** Called when a chunk lands. */
  onLand?: (chunk: SnowChunk) => void;
  seed?: number;
}

export class SnowMeltSystem extends SceneObject {
  readonly name: string;
  weather: WeatherSystem | null;
  field: GroundMoistureField | null;
  stepField: boolean;
  timeScale: number;
  irradiancePerUnit: number;
  maxChunksPerEvent: number;
  chunkVolume: number;
  onLand: ((chunk: SnowChunk) => void) | null;
  /** Live chunks (sliding or in flight). */
  readonly chunks: SnowChunk[] = [];
  /** Counters for diagnostics and gates. */
  shedEvents = 0;
  chunksReleased = 0;
  chunksLanded = 0;
  simulatedSeconds = 0;
  readonly environment: MeltEnvironment = createMeltEnvironment();
  private readonly groundAt: (x: number, z: number) => number;
  private readonly rng: Rng;
  private readonly lights: Light[] = [];
  private readonly up = new Vec3();
  private readonly pose: SnowPose = { position: new Vec3(), rotation: new Quat() };

  constructor(options: SnowMeltSystemOptions = {}) {
    super();
    this.name = options.name ?? "snowMelt";
    this.weather = options.weather ?? null;
    this.field = options.field ?? null;
    this.stepField = options.stepField ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.irradiancePerUnit = options.irradiancePerUnit ?? 250;
    this.maxChunksPerEvent = options.maxChunksPerEvent ?? 10;
    this.chunkVolume = options.chunkVolume ?? 0.004;
    this.onLand = options.onLand ?? null;
    this.rng = new Rng(options.seed ?? 0x5e0f);
    const field = this.field;
    this.groundAt = options.groundAt ?? ((x, z) => {
      const k = field ? field.indexAt(x, z) : -1;
      return k >= 0 ? field!.height[k]! : 0;
    });
  }

  override onAttach(scene: Scene): void {
    if (!this.weather) this.weather = (scene.object("weather") as WeatherSystem | undefined) ?? null;
  }

  override update(context: SystemContext, dt: number): void {
    const real = context.fixedSteps > 0 ? context.fixedSteps * context.fixedDt : dt;
    if (real > 0) this.advance(real);
  }

  /** Advance `realSeconds` of motion (chunks) and `realSeconds × timeScale` of melt. */
  advance(realSeconds: number): this {
    const scene = this.scene;
    if (!scene || !(realSeconds > 0)) return this;
    sampleMeltEnvironment(scene, this.weather, this.environment, { irradiancePerUnit: this.irradiancePerUnit }, this.lights);
    const simDt = realSeconds * this.timeScale;
    this.simulatedSeconds += simDt;
    // Melt in ≤ 60 s slices so wetness and shedding resolve smoothly at high time scales.
    const slices = Math.max(1, Math.ceil(simDt / 60));
    const slice = simDt / slices;
    for (let s = 0; s < slices; s++) {
      const covers = scene.world.store(SnowCover);
      for (let i = 0; i < covers.count; i++) {
        const cover = covers.valueAt(i);
        const id = scene.world.idForSlot(covers.slotAt(i));
        // Read the pose from transform storage (authoritative for both the Transform component and
        // the entity handle's setters).
        const slot = scene.world.transformSlot(id, false);
        if (slot <= 0) continue;
        scene.world.transforms.getPosition(slot, this.pose.position);
        scene.world.transforms.getRotation(slot, this.pose.rotation);
        this.stepCover(cover, this.pose, slice);
      }
      if (this.field && this.stepField) this.field.step(slice, this.environment);
    }
    this.stepChunks(realSeconds);
    return this;
  }

  /** Melt, wet and shed one cover over `dt` simulated seconds. */
  stepCover(cover: SnowCover, transform: SnowPose, dt: number): void {
    const env = this.environment;
    const up = transform.rotation.rotateVector(Vec3.up, this.up);
    if (cover.depth > 0) {
      const sun = env.sunDirection;
      let cos: number;
      let area: number;
      if (cover.shape.kind === "sphere") {
        // Mean incidence over the cap: the top's own plus the sun-facing flank the cap reaches.
        const sinSun = Math.sqrt(Math.max(0, 1 - sun.y * sun.y));
        cos = clamp(Math.max(0, sun.y) + 0.35 * sinSun * Math.sin(cover.extent), 0, 1);
        area = Math.PI * Math.pow(cover.shape.radius * Math.sin(Math.max(cover.extent, 0.3)), 2);
      } else {
        cos = Math.max(0, sun.x * up.x + sun.y * up.y + sun.z * up.z);
        area = cover.sheetSlid ? 0 : 4 * cover.shape.halfX * cover.shape.halfZ * Math.max(0.05, up.y);
      }
      const albedo = snowAlbedo(cover.wetness);
      const q = snowEnergyBalance(env, {
        cosIncidence: cos,
        albedo,
        substrateFlux: substrateFlux(env, cover.depth, cover.substrateAlbedo, cos) + cover.substrateHeat,
      });
      const melt = Math.min(cover.depth, meltRate(q) * dt);
      // Liquid water in the pack follows the melt flux: ~150 W/m² of melt energy saturates it within
      // ~15 min; without melt it drains and refreezes over ~30 min.
      const wetTarget = clamp(q / 150, 0, 1);
      const tau = wetTarget > cover.wetness ? 900 : 1800;
      cover.wetness = wetTarget + (cover.wetness - wetTarget) * Math.exp(-dt / tau);
      if (melt > 0) {
        cover.depth -= melt;
        const water = (melt * area * DEFAULT_SNOW_DENSITY) / WATER_DENSITY;
        cover.meltwater += water;
        this.drip(cover, transform, water);
      }
      if (cover.depth < 1e-4) cover.depth = 0;
      this.shed(cover, transform, up);
    }
    this.pushTarget(cover, up);
  }

  private drip(cover: SnowCover, transform: SnowPose, water: number): void {
    if (!this.field || water <= 0) return;
    const p = transform.position;
    // Water runs to the bottom of a sphere / the low edge of a slab and drips from there: spread it
    // over a few points so it pools rather than drilling one cell.
    const spread = cover.shape.kind === "sphere" ? cover.shape.radius * 0.5 : Math.max(cover.shape.halfX, cover.shape.halfZ);
    for (let i = 0; i < 4; i++) {
      const a = this.rng.nextFloat() * Math.PI * 2;
      const r = this.rng.nextFloat() * spread;
      this.field.addWater(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, water / 4);
    }
  }

  private shed(cover: SnowCover, transform: SnowPose, up: Vec3): void {
    const p = transform.position;
    if (cover.shape.kind === "sphere") {
      const r = cover.shape.radius;
      const critical = criticalShedAngle(cover.wetness, cover.depth, r);
      if (cover.extent <= critical + 1e-4) return;
      const band = 2 * Math.PI * r * r * (Math.cos(critical) - Math.cos(cover.extent));
      const volume = band * cover.depth;
      const lo = critical;
      const hi = cover.extent;
      cover.extent = critical;
      if (volume <= 0) return;
      cover.shedVolume += volume;
      this.shedEvents++;
      const count = clamp(Math.ceil(volume / this.chunkVolume), 1, this.maxChunksPerEvent);
      const center = new Vec3(p.x, p.y + (cover.shape.centerY ?? 0), p.z);
      const mu = snowFriction(cover.wetness);
      for (let i = 0; i < count; i++) {
        const theta = lo + (hi - lo) * this.rng.nextFloat();
        const azimuth = this.rng.nextFloat() * Math.PI * 2;
        const rr = r + cover.depth * 0.5;
        const chunk: SnowChunk = {
          position: new Vec3(),
          velocity: new Vec3(),
          volume: volume / count,
          size: Math.max(0.04, Math.cbrt((volume / count) * 0.75 / Math.PI)),
          phase: "slide-sphere",
          center,
          radius: rr,
          theta,
          omega: 0.15 / rr,
          azimuth,
          mu,
          age: 0,
        };
        placeOnSphere(chunk);
        this.chunks.push(chunk);
      }
      this.chunksReleased += count;
      return;
    }
    // Box / slab top.
    const shape = cover.shape;
    if (cover.sheetSlid || cover.depth <= 0) return;
    const tilt = Math.acos(clamp(up.y, -1, 1));
    const critical = criticalShedAngle(cover.wetness, cover.depth, Infinity);
    const mu = snowFriction(cover.wetness);
    const top = new Vec3(p.x + up.x * shape.topY, p.y + up.y * shape.topY, p.z + up.z * shape.topY);
    if (tilt > critical) {
      // The whole sheet lets go and slides down the tilt, breaking into slabs at the edge.
      const volume = 4 * shape.halfX * shape.halfZ * cover.depth;
      cover.sheetSlid = true;
      cover.shedVolume += volume;
      this.shedEvents++;
      const dir = new Vec3(-up.x * up.y, 1 - up.y * up.y, -up.z * up.y).scale(-1);
      const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
      dir.set(dir.x / dl, dir.y / dl, dir.z / dl);
      const side = new Vec3(up.y * dir.z - up.z * dir.y, up.z * dir.x - up.x * dir.z, up.x * dir.y - up.y * dir.x);
      const half = Math.max(shape.halfX, shape.halfZ);
      const count = clamp(Math.ceil(volume / this.chunkVolume), 2, this.maxChunksPerEvent);
      for (let i = 0; i < count; i++) {
        const u = (this.rng.nextFloat() * 2 - 1) * half * 0.9;
        const v = (this.rng.nextFloat() * 2 - 1) * half * 0.9;
        const pos = new Vec3(top.x + side.x * u + dir.x * v, top.y + side.y * u + dir.y * v + cover.depth * 0.5, top.z + side.z * u + dir.z * v);
        this.chunks.push({
          position: pos,
          velocity: new Vec3(),
          volume: volume / count,
          size: Math.max(0.05, Math.cbrt((volume / count) * 0.75 / Math.PI)),
          phase: "slide-plane",
          dir,
          normal: up.clone(),
          remaining: half - v,
          speed: 0,
          mu,
          age: 0,
        });
      }
      this.chunksReleased += count;
      cover.depth = 0;
      return;
    }
    if (!cover.corniceDropped && cover.wetness > 0.55 && cover.depth > 0.01) {
      // A wet rim overhang (≈ one depth wide all round) breaks off and drops.
      cover.corniceDropped = true;
      const rim = 2 * (shape.halfX + shape.halfZ) * 2 * cover.depth * cover.depth;
      cover.shedVolume += rim;
      this.shedEvents++;
      const count = clamp(Math.ceil(rim / this.chunkVolume), 2, this.maxChunksPerEvent);
      for (let i = 0; i < count; i++) {
        const edge = this.rng.nextInt(0, 3);
        const t = this.rng.nextFloat() * 2 - 1;
        const ox = edge === 0 ? shape.halfX : edge === 1 ? -shape.halfX : t * shape.halfX;
        const oz = edge === 2 ? shape.halfZ : edge === 3 ? -shape.halfZ : t * shape.halfZ;
        const out = new Vec3(edge === 0 ? 1 : edge === 1 ? -1 : 0, 0, edge === 2 ? 1 : edge === 3 ? -1 : 0);
        const local = new Vec3(ox + out.x * cover.depth, 0, oz + out.z * cover.depth);
        const world = transform.rotation.rotateVector(local, new Vec3());
        const vel = transform.rotation.rotateVector(out, new Vec3()).scale(0.4);
        this.chunks.push({
          position: new Vec3(top.x + world.x, top.y + world.y, top.z + world.z),
          velocity: vel,
          volume: rim / count,
          size: Math.max(0.04, Math.cbrt((rim / count) * 0.75 / Math.PI)),
          phase: "fall",
          mu,
          age: 0,
        });
      }
      this.chunksReleased += count;
    }
  }

  private pushTarget(cover: SnowCover, up: Vec3): void {
    const amount = smoothstep(0, 0.01, cover.depth) * (cover.shape.kind === "box" && cover.sheetSlid ? 0 : 1);
    const line = cover.shape.kind === "sphere" ? Math.cos(cover.extent) : up.y - 0.08;
    const wet = cover.wetness;
    const p = cover.pushed;
    if ((amount !== 0 || p[0] === 0) && Math.abs(p[0]! - amount) < 1e-3 && Math.abs(p[1]! - line) < 1e-3 && Math.abs(p[2]! - wet) < 1e-2) return;
    p[0] = amount;
    p[1] = line;
    p[2] = wet;
    cover.target?.setSnowCover(amount, line, wet);
  }

  /** Move chunks by `dt` real seconds: slide over the source, fly, land. */
  stepChunks(dt: number): void {
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      for (let i = this.chunks.length - 1; i >= 0; i--) {
        const c = this.chunks[i]!;
        c.age += h;
        if (c.phase === "slide-sphere") {
          const r = c.radius!;
          const normal = GRAVITY * Math.cos(c.theta!) - r * c.omega! * c.omega!;
          if (normal <= 0 || c.theta! > Math.PI * 0.75) {
            c.phase = "fall";
          } else {
            const along = GRAVITY * Math.sin(c.theta!) - c.mu * normal;
            c.omega = Math.max(0.3 / r, c.omega! + (along / r) * h);
            c.theta = c.theta! + c.omega * h;
            placeOnSphere(c);
            continue;
          }
        } else if (c.phase === "slide-plane") {
          const n = c.normal!;
          const sinT = Math.sqrt(Math.max(0, 1 - n.y * n.y));
          const a = GRAVITY * (sinT - c.mu * n.y);
          c.speed = Math.max(0.05, c.speed! + a * h);
          const step = c.speed * h;
          c.position.x += c.dir!.x * step;
          c.position.y += c.dir!.y * step;
          c.position.z += c.dir!.z * step;
          c.remaining = c.remaining! - step;
          c.velocity.set(c.dir!.x * c.speed, c.dir!.y * c.speed, c.dir!.z * c.speed);
          if (c.remaining <= 0) c.phase = "fall";
          continue;
        }
        // Ballistic with light air drag.
        c.velocity.y -= GRAVITY * h;
        const drag = Math.exp(-0.15 * h);
        c.velocity.x *= drag;
        c.velocity.z *= drag;
        c.position.x += c.velocity.x * h;
        c.position.y += c.velocity.y * h;
        c.position.z += c.velocity.z * h;
        const ground = this.groundAt(c.position.x, c.position.z);
        if (c.position.y - c.size <= ground || c.age > 20) {
          c.position.y = ground + c.size;
          this.chunks.splice(i, 1);
          this.chunksLanded++;
          this.field?.addSnow(c.position.x, c.position.z, c.volume);
          this.onLand?.(c);
        }
      }
    }
  }

  override stats(): Record<string, number> {
    return { chunks: this.chunks.length, shedEvents: this.shedEvents, released: this.chunksReleased, landed: this.chunksLanded };
  }
}

function placeOnSphere(c: SnowChunk): void {
  const r = c.radius!;
  const st = Math.sin(c.theta!);
  const ct = Math.cos(c.theta!);
  const ca = Math.cos(c.azimuth!);
  const sa = Math.sin(c.azimuth!);
  const center = c.center!;
  c.position.set(center.x + r * st * ca, center.y + r * ct, center.z + r * st * sa);
  // Tangential velocity along increasing theta.
  const v = r * c.omega!;
  c.velocity.set(v * ct * ca, -v * st, v * ct * sa);
}
