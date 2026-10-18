/**
 * Lightning (Phase 8b): scheduled strikes, fractal bolts, and the flash that lights the scene.
 *
 * Strikes are a Poisson process in simulated time: the rate scales with the storm intensity (read
 * from the `WeatherSystem` named "weather" when one is attached, else the system's own
 * `stormOverride`), and every strike's position, energy and bolt shape comes from a seeded `Rng`
 * stream, so a seeded run reproduces its thunder to the arc. Each strike owns a bolt — a
 * midpoint-displaced polyline from cloud to ground — drawn as debug lines while the flash lives,
 * an independent point light whose intensity is the flash envelope, and a one-frame sky exposure boost pushed
 * through `RenderFrameContext.setSkyOverride`, so the clouds themselves flash.
 *
 * The envelope is a double stroke: a fast attack (`attack`, default 8 ms) and exponential decay
 * (`decay`, default 90 ms), plus an optional return stroke at `restrikeDelay` with
 * `restrikeStrength` of the energy.
 *
 * Phase 17.6 integration:
 *  - thunder is a *simulation event*: with a `listener`, every strike schedules its thunder for the
 *    moment sound from the nearest point of the channel reaches the listener (`thunderDelay`, speed
 *    of sound from the weather's air temperature), and `onThunder` fires on the simulated clock then —
 *    audio plays it (no delay arithmetic in the host), gameplay can react to it;
 *  - the strike rate is the storm intensity (weather `storm01`) × `rate`, a Poisson process;
 *  - with `strikeTarget`, the attachment point follows the terrain: the channel attaches to the
 *    highest ground or attractor (mast, tree, rod) within the striking distance of its leader
 *    (`strikingDistance`, the rolling-sphere radius), and ends at that point's height.
 * Nothing here touches the audio graph itself.
 */

import { captureState, restoreState, type StateRecord } from "../core/snapshot.js";
import { SceneObject, type Scene } from "../scene/scene.js";
import type { SystemContext } from "../scene/systems.js";
import { Light } from "../scene/components/index.js";
import { Vec3 } from "../math/vec.js";
import { clamp } from "../math/scalar.js";
import { Rng, hash1i } from "../math/rng.js";
import { WeatherSystem } from "./weather.js";

export interface LightningBolt {
  /** Polyline from the cloud (`points[0]`) to the ground (last point). */
  points: Vec3[];
  /** fe-34: side branches (each a polyline starting on the main channel); empty by default. */
  branches: Vec3[][];
  /** fe-34: true for an intra-cloud flash (lights the deck, no visible channel to the surface). */
  cloudOnly: boolean;
  /** RNG seed this bolt was grown from (re-grows identically). */
  seed: number;
}

export interface LightningStrike {
  id: number;
  /** Ground position of the strike (render-local XZ, `groundY` height). */
  position: Vec3;
  /** Energy 0.5..1.5 (scales the light and the sky flash). */
  energy: number;
  /** Simulated seconds since the strike started. */
  age: number;
  /** Seconds the flash (and bolt) lives. */
  duration: number;
  bolt: LightningBolt;
}

/** Speed of sound in air (m/s) at `temperatureC` (dry air, 331.3 + 0.606·T). */
export function speedOfSound(temperatureC = 20): number {
  return 331.3 + 0.606 * temperatureC;
}

/** Seconds for thunder to travel `distance` metres (the flash-to-bang gap, ≈ 3 s/km). */
export function thunderDelay(distance: number, temperatureC = 20): number {
  return Math.max(0, distance) / speedOfSound(temperatureC);
}

/**
 * Rolling-sphere striking distance (m) for a return-stroke peak current `peakKA` (IEEE 1243:
 * r = 10·I^0.65; 30 kA → ≈ 91 m). The leader attaches to the highest point it "sees" within it.
 */
export function strikingDistance(peakKA: number): number {
  return 10 * Math.pow(Math.max(1, peakKA), 0.65);
}

export interface StrikeTargetOptions {
  /** Surface height (terrain) at an XZ position. */
  heightAt: (x: number, z: number) => number;
  /** Tall attractors (masts, trees, rods): XZ position and top height. Checked before the ground. */
  attractors?: readonly { x: number; y: number; z: number }[] | (() => readonly { x: number; y: number; z: number }[]);
  /** Ground samples inside the striking distance. Default 24. */
  samples?: number;
  /** Peak current (kA) at strike energy 1 — sets the striking distance. Default 30. */
  peakCurrentKA?: number;
}

export interface ThunderEvent {
  strike: LightningStrike;
  /** Distance from the listener to the nearest point of the channel (m). */
  distance: number;
  /** Seconds between the flash and this event. */
  delay: number;
  /** Strike energy (louder/longer thunder). */
  energy: number;
}

/**
 * Pick where a leader descending toward `(x, z)` attaches: the highest point — terrain sample or
 * attractor top — within the striking distance, ties to the nearest. Deterministic for a seed.
 */
export function attachStrike(x: number, z: number, energy: number, seed: number, target: StrikeTargetOptions): { x: number; y: number; z: number } {
  const radius = strikingDistance((target.peakCurrentKA ?? 30) * Math.max(0.1, energy));
  let bx = x;
  let bz = z;
  let by = target.heightAt(x, z);
  const consider = (px: number, py: number, pz: number): void => {
    // A point at the edge of the sphere must stand taller to win: the leader is closer to it the
    // higher it reaches (height gain vs horizontal offset, rolling sphere tangent).
    const d = Math.hypot(px - x, pz - z);
    if (d > radius) return;
    const effective = py - (d * d) / (2 * radius);
    const bestD = Math.hypot(bx - x, bz - z);
    if (effective > by - (bestD * bestD) / (2 * radius) + 1e-6) {
      bx = px;
      by = py;
      bz = pz;
    }
  };
  const samples = Math.max(0, Math.floor(target.samples ?? 24));
  for (let i = 0; i < samples; i++) {
    // Stratified golden-angle disc, rotated per strike.
    const u = (hash1i(i, seed) >>> 8) / 16777216;
    const r = radius * Math.sqrt((i + u) / samples);
    const a = i * 2.399963229728653 + (seed % 6283) / 1000;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    consider(px, target.heightAt(px, pz), pz);
  }
  const attractors = typeof target.attractors === "function" ? target.attractors() : (target.attractors ?? []);
  for (const t of attractors) consider(t.x, t.y, t.z);
  return { x: bx, y: by, z: bz };
}

export interface FlashEnvelope {
  /** Attack time constant (seconds). */
  attack: number;
  /** Decay time constant (seconds). */
  decay: number;
  /** Delay of the return stroke (0 disables the second stroke). */
  restrikeDelay: number;
  /** Energy fraction of the return stroke. */
  restrikeStrength: number;
}

export const DEFAULT_FLASH_ENVELOPE: Readonly<FlashEnvelope> = Object.freeze({ attack: 0.008, decay: 0.09, restrikeDelay: 0.12, restrikeStrength: 0.45 });

/**
 * Flash brightness 0..~1 at `t` seconds after the strike: `(1 − e^(−t/a))·e^(−t/d)` plus the
 * return stroke. Zero at t = 0, peaks within a few attack constants, and is below 1 % after
 * `durationFor` (which the scheduler uses as the strike's lifetime).
 */
export function flashEnvelope(t: number, envelope: FlashEnvelope = DEFAULT_FLASH_ENVELOPE): number {
  if (!(t >= 0)) return 0;
  const main = (1 - Math.exp(-t / Math.max(1e-6, envelope.attack))) * Math.exp(-t / Math.max(1e-6, envelope.decay));
  if (!(envelope.restrikeDelay > 0) || t < envelope.restrikeDelay) return main;
  const tr = t - envelope.restrikeDelay;
  return main + envelope.restrikeStrength * (1 - Math.exp(-tr / Math.max(1e-6, envelope.attack))) * Math.exp(-tr / Math.max(1e-6, envelope.decay));
}

/** Seconds until the envelope (and the strike) has faded below 1 % of its energy. */
export function flashDuration(envelope: FlashEnvelope = DEFAULT_FLASH_ENVELOPE): number {
  const tail = envelope.restrikeDelay > 0 ? envelope.restrikeDelay : 0;
  return tail + envelope.decay * Math.log(100 * (1 + envelope.restrikeStrength));
}

/**
 * Grow a bolt from `start` (cloud) to `end` (ground) by midpoint displacement: `subdivisions`
 * bisections give `2^subdivisions + 1` points, and each midpoint is pushed off the segment by up
 * to `roughness` × the segment length along a deterministic perpendicular. `roughness = 0` is a
 * straight line. Pure function of its inputs — no stream state, so the order strikes are drawn in
 * cannot change a bolt.
 */
export function generateBoltPoints(start: Vec3, end: Vec3, seed: number, subdivisions: number, roughness: number, out: Vec3[] = []): Vec3[] {
  out.length = 0;
  out.push(start.clone(), end.clone());
  const sub = Math.max(0, Math.min(8, Math.floor(subdivisions)));
  for (let level = 0; level < sub; level++) {
    const step = out.length - 1;
    for (let i = step; i >= 1; i--) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const mid = new Vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      if (roughness > 0) {
        const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        // Two perpendiculars of the segment; the hash picks the offset in that plane.
        const dx = (b.x - a.x) / (segLen || 1);
        const dy = (b.y - a.y) / (segLen || 1);
        const dz = (b.z - a.z) / (segLen || 1);
        // Reference axis for the perpendicular basis: world up, or world X when the segment is
        // (near-)vertical — fe-34 fix: a vertical bolt (start straight above the strike, which
        // trigger() produces) made `seg × up` zero and the channel came out a straight rod.
        const vertical = Math.abs(dy) > 0.9;
        const ux = vertical ? 1 : 0;
        const uy = vertical ? 0 : 1;
        const uz = 0;
        let px = dy * uz - dz * uy;
        let py = dz * ux - dx * uz;
        let pz = dx * uy - dy * ux;
        const pl = Math.hypot(px, py, pz) || 1;
        px /= pl;
        py /= pl;
        pz /= pl;
        const qx = dy * pz - dz * py;
        const qy = dz * px - dx * pz;
        const qz = dx * py - dy * px;
        const h1 = (hash1i((seed ^ (i * 0x9e3779b9 + level * 0x85ebca6b)) | 0, 0xc0ffee) / 4294967296 - 0.5) * 2;
        const h2 = (hash1i((seed ^ (i * 0x27d4eb2f + level * 0x165667b1)) | 0, 0x5bd1e995) / 4294967296 - 0.5) * 2;
        const amp = roughness * segLen * 0.5;
        mid.x += (px * h1 + qx * h2) * amp;
        mid.y += (py * h1 + qy * h2) * amp;
        mid.z += (pz * h1 + qz * h2) * amp;
      }
      out.splice(i, 0, mid);
    }
  }
  return out;
}

/**
 * fe-34: side branches for a bolt — `count` shorter channels forking off the main polyline at
 * seeded points, angled down and away (deterministic in `seed`).
 */
export function lightningBranches(main: readonly Vec3[], seed: number, count: number, subdivisions: number, roughness: number): Vec3[][] {
  const out: Vec3[][] = [];
  if (count <= 0 || main.length < 4) return out;
  const rng = new Rng((seed ^ 0x5bd1e995) >>> 0 || 1);
  const top = main[0]!;
  const bottom = main[main.length - 1]!;
  const height = Math.max(1, top.y - bottom.y);
  for (let k = 0; k < count; k++) {
    const at = main[1 + Math.floor(rng.nextFloat() * (main.length * 0.6))]!;
    const angle = rng.nextFloat() * Math.PI * 2;
    const len = height * (0.12 + 0.22 * rng.nextFloat());
    const end = new Vec3(at.x + Math.cos(angle) * len * 0.7, Math.max(bottom.y, at.y - len), at.z + Math.sin(angle) * len * 0.7);
    out.push(generateBoltPoints(at.clone(), end, rng.nextU32(), Math.max(2, subdivisions - 2), roughness));
  }
  return out;
}

export interface LightningOptions {
  name?: string;
  /** Deterministic seed for strike scheduling and bolt shapes. Default 9001. */
  seed?: number;
  /** Strikes per second at full storm. Default 0.25 (one strike every 4 s in a storm). */
  rate?: number;
  /** Storm intensity when no `WeatherSystem` is attached. Default 0 (silent). */
  stormOverride?: number;
  /** Name of the weather system to read the storm from. Default "weather". */
  weatherName?: string;
  /** Strikes land in a disc of this radius around the origin. Default 400. */
  areaRadius?: number;
  /** Bolt start height (cloud base). Default 1200. */
  cloudHeight?: number;
  /** Ground height the bolts end at. Default 0. */
  groundY?: number;
  /** Bolt detail (2^subdivisions + 1 points). Default 5 (33 points). */
  subdivisions?: number;
  /** Bolt jaggedness 0..1. Default 0.35. */
  roughness?: number;
  /** Point-light intensity at flash = 1, energy = 1. Default 60. */
  flashLightIntensity?: number;
  /** Sky exposure added at flash = 1, energy = 1. Default 0.8. */
  skyFlashExposure?: number;
  envelope?: Partial<FlashEnvelope>;
  /** Called synchronously after a strike is created; audio/gameplay can react without polling. */
  onStrike?: (strike: LightningStrike) => void;
  /** fe-34: storm intensity 0..1 from any source (e.g. a `CycloneSystem`); overrides the weather lookup. */
  storm?: () => number;
  /** fe-34: centre of the strike disc (render-local XZ); default the origin. */
  center?: () => { x: number; z: number };
  /** fe-34: surface height under a strike (terrain or sea level), so bolts end on the ground or the water. */
  surfaceAt?: (x: number, z: number) => number;
  /** Phase 17.6: terrain-aware attachment (highest point within the striking distance). */
  strikeTarget?: StrikeTargetOptions;
  /** Phase 17.6: listener position (the camera); enables the delayed `onThunder` events. */
  listener?: () => { x: number; y: number; z: number };
  /** Phase 17.6: thunder reaching the listener, on the simulated clock. */
  onThunder?: (event: ThunderEvent) => void;
  /** fe-34: side branches per bolt. Default 0. */
  branches?: number;
  /** fe-34: fraction 0..1 of strikes that are intra-cloud flashes (no channel). Default 0. */
  cloudFlashFraction?: number;
  /** fe-34: bolt line colour (0xRRGGBBAA). Default 0x00e8ffff. */
  boltColor?: number;
  /** fe-34: bolt core radiance (emissive line intensity; the flash adds up to 7 on top). Default 5. */
  boltWidth?: number;
  /**
   * fe-34: bolt core thickness in screen pixels. Above 1 the channel is drawn as a ribbon of parallel
   * 1-px lines facing `viewer`, spaced one pixel apart at each segment's distance, so a strike kilometres
   * away still reads as a thick channel. Default 1 (a single line, the pre-fe-34 look).
   */
  boltPixels?: number;
  /** fe-34: glow halo either side of the core, in pixels (dimmer, bluer lines). Default 0. */
  boltGlowPixels?: number;
  /**
   * fe-34 v3: light the cloud deck from inside around the brightest live strike (intra-cloud
   * flashes especially): writes `clouds.flash*` each frame — a Gaussian glow of `radius` m whose
   * intensity is energy × envelope × `intensity`, flickering in pulses (`flickerHz` steps).
   */
  cloudGlow?: { radius?: number; intensity?: number; flickerHz?: number };
  /** fe-34: viewer position for the ribbon (render-local); required for `boltPixels` > 1. */
  viewer?: () => { x: number; y: number; z: number };
  /** fe-34: angle subtended by one pixel (rad). Default (π/3)/720 — a 60° fov on a 720-px-tall view. */
  pixelAngle?: number;
}

/**
 * fe-34 v3: pulsing flicker 0.25..1 for a flash `age` seconds old — held steps of 1/`hz` s with a
 * seeded level each, so in-cloud lightning stutters in pulses rather than fading smoothly.
 */
export function lightningFlicker(age: number, seed: number, hz = 18): number {
  const step = Math.floor(Math.max(0, age) * hz);
  const h = hash1i((seed * 0x9e3779b1 + step * 0x85ebca6b) | 0, 0x2545f491) / 4294967296;
  return 0.25 + 0.75 * h;
}

/**
 * fe-34: the screen-facing one-pixel step for a bolt segment a→b seen from `viewer`: a vector
 * perpendicular to both the segment and the line of sight, `|out| = distance × pixelAngle`.
 * Zero when the segment points straight at the viewer.
 */
export function lightningRibbonStep(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, viewer: { x: number; y: number; z: number }, pixelAngle: number, out = new Vec3()): Vec3 {
  const mx = (a.x + b.x) * 0.5 - viewer.x;
  const my = (a.y + b.y) * 0.5 - viewer.y;
  const mz = (a.z + b.z) * 0.5 - viewer.z;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  // perp = seg × view
  let px = dy * mz - dz * my;
  let py = dz * mx - dx * mz;
  let pz = dx * my - dy * mx;
  const pl = Math.hypot(px, py, pz);
  const dist = Math.hypot(mx, my, mz);
  if (pl < 1e-9) return out.set(0, 0, 0);
  const k = (dist * pixelAngle) / pl;
  px *= k;
  py *= k;
  pz *= k;
  return out.set(px, py, pz);
}

export class LightningSystem extends SceneObject {
  readonly name: string;
  readonly seed: number;
  rate: number;
  stormOverride: number;
  readonly weatherName: string;
  areaRadius: number;
  cloudHeight: number;
  groundY: number;
  subdivisions: number;
  roughness: number;
  flashLightIntensity: number;
  skyFlashExposure: number;
  readonly envelope: FlashEnvelope;
  private readonly options: LightningOptions;
  onStrike?: (strike: LightningStrike) => void;
  onThunder?: (event: ThunderEvent) => void;
  /** Thunder still travelling to the listener (`at` = simulated time it arrives). */
  readonly pendingThunder: { at: number; event: ThunderEvent }[] = [];
  /** Thunder events delivered since creation. */
  thunderCount = 0;
  /** Simulated seconds advanced (the thunder clock). */
  simulatedSeconds = 0;

  /** Live strikes (oldest first). */
  readonly strikes: LightningStrike[] = [];
  /** Total strikes since creation. */
  strikeCount = 0;
  /** Sum of energy × envelope over the live strikes (what the light and sky flash follow). */
  flashTotal = 0;
  private readonly ribbonStep = new Vec3();
  private readonly ribbonA = new Vec3();
  private readonly ribbonB = new Vec3();

  private readonly rng: Rng;
  private nextStrikeIn = 0;
  private nextId = 1;
  private readonly strikeLights = new Map<number, { entityId: number; light: Light }>();
  /** Last frame's bolt polylines (for tests that cannot read debug lines back). */
  readonly lastBolts: Vec3[][] = [];

  constructor(options: LightningOptions = {}) {
    super();
    this.name = options.name ?? "lightning";
    this.seed = options.seed ?? 9001;
    this.rate = options.rate ?? 0.25;
    this.stormOverride = options.stormOverride ?? 0;
    this.weatherName = options.weatherName ?? "weather";
    this.areaRadius = options.areaRadius ?? 400;
    this.cloudHeight = options.cloudHeight ?? 1200;
    this.groundY = options.groundY ?? 0;
    this.subdivisions = options.subdivisions ?? 5;
    this.roughness = options.roughness ?? 0.35;
    this.flashLightIntensity = options.flashLightIntensity ?? 60;
    this.skyFlashExposure = options.skyFlashExposure ?? 0.8;
    this.envelope = { ...DEFAULT_FLASH_ENVELOPE, ...options.envelope };
    this.onStrike = options.onStrike;
    this.onThunder = options.onThunder;
    this.options = options;
    this.rng = new Rng(this.seed === 0 ? 0x9e3779b9 : this.seed);
    this.nextStrikeIn = this.drawInterarrival(1);
  }

  /** fe-34: freeze strike ages and scheduling (screenshots / debugging); the flash holds. */
  paused = false;

  /** Current storm intensity: the `storm` callback, the weather system's, or the override. */
  stormIntensity(): number {
    if (this.options.storm) return clamp(this.options.storm(), 0, 1);
    const weather = this.scene?.object<WeatherSystem>(this.weatherName);
    if (weather) return clamp(weather.state.storm01, 0, 1);
    return clamp(this.stormOverride, 0, 1);
  }

  /**
   * Schedule a strike now (the demo's thunder key and the browser gate use this). `seekHighPoint`
   * (default: when no position is forced) lets `strikeTarget` move the attachment to a high point.
   */
  trigger(position?: Vec3, energy = 1, cloudOnly = false, seekHighPoint = position === undefined): LightningStrike {
    const c = this.options.center?.() ?? { x: 0, z: 0 };
    const px = position?.x ?? c.x + (this.rng.nextFloat() * 2 - 1) * this.areaRadius;
    const pz = position?.z ?? c.z + (this.rng.nextFloat() * 2 - 1) * this.areaRadius;
    const boltSeed = this.rng.nextU32();
    // An intra-cloud flash runs sideways inside the deck instead of down to the surface. A ground
    // strike attaches to the highest point its leader reaches (17.6) when a target is configured.
    const target = this.options.strikeTarget;
    const attach = !cloudOnly && target && seekHighPoint ? attachStrike(px, pz, energy, boltSeed, target) : null;
    const ax = attach?.x ?? px;
    const az = attach?.z ?? pz;
    const ground = attach ? attach.y : this.options.surfaceAt ? this.options.surfaceAt(px, pz) : target ? target.heightAt(px, pz) : this.groundY;
    const start = new Vec3(px, this.cloudHeight, pz);
    const end = cloudOnly ? new Vec3(px + this.cloudHeight * 0.6, this.cloudHeight * 0.95, pz) : new Vec3(ax, ground, az);
    const strike: LightningStrike = {
      id: this.nextId++,
      position: end.clone(),
      energy: clamp(energy, 0.1, 3),
      age: 0,
      duration: flashDuration(this.envelope),
      bolt: { points: generateBoltPoints(start, end, boltSeed, this.subdivisions, this.roughness), seed: boltSeed, branches: [], cloudOnly },
    };
    strike.bolt.branches = lightningBranches(strike.bolt.points, boltSeed, this.options.branches ?? 0, this.subdivisions, this.roughness);
    this.strikes.push(strike);
    if (this.scene) this.createStrikeLight(this.scene, strike);
    this.strikeCount++;
    this.scheduleThunder(strike);
    this.onStrike?.(strike);
    return strike;
  }

  /** Air temperature for the speed of sound: the weather's, else 15 °C. */
  private airTemperature(): number {
    const weather = this.scene?.object<WeatherSystem>(this.weatherName);
    return weather ? weather.state.temperatureC : 15;
  }

  private scheduleThunder(strike: LightningStrike): void {
    const listener = this.options.listener?.();
    if (!listener) return;
    let distance = Number.POSITIVE_INFINITY;
    for (const p of strike.bolt.points) distance = Math.min(distance, Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z));
    if (!Number.isFinite(distance)) distance = Math.hypot(strike.position.x - listener.x, strike.position.y - listener.y, strike.position.z - listener.z);
    const delay = thunderDelay(distance, this.airTemperature());
    const entry = { at: this.simulatedSeconds + delay, event: { strike, distance, delay, energy: strike.energy } };
    // Keep the queue in arrival order (a near strike can overtake a far one).
    let i = this.pendingThunder.length;
    while (i > 0 && this.pendingThunder[i - 1]!.at > entry.at) i--;
    this.pendingThunder.splice(i, 0, entry);
  }

  private deliverThunder(): void {
    while (this.pendingThunder.length > 0 && this.pendingThunder[0]!.at <= this.simulatedSeconds + 1e-9) {
      const { event } = this.pendingThunder.shift()!;
      this.thunderCount++;
      this.onThunder?.(event);
    }
  }

  /**
   * Phase 19.3: what decides future strikes — the strike RNG, the next-strike timer, the clock and
   * counters. Strikes already in flight and thunder still travelling are visual/audio transients and
   * are not in a snapshot (a restored storm starts with a clear sky and keeps its schedule).
   */
  override snapshotState(): StateRecord {
    return captureState(this, { skip: ["scene", "options", "pendingThunder", "strikes", "lastBolts"] });
  }

  override restoreSnapshotState(state: StateRecord): void {
    restoreState(this, state, this.name);
  }

  override onAttach(scene: Scene): void {
    for (const strike of this.strikes) this.createStrikeLight(scene, strike);
  }

  override onDetach(scene: Scene): void {
    for (const record of this.strikeLights.values()) {
      const facade = scene.world.facade(record.entityId as never);
      if (facade) scene.world.destroyEntity(facade.id);
    }
    this.strikeLights.clear();
    this.strikes.length = 0;
  }

  private createStrikeLight(scene: Scene, strike: LightningStrike): void {
    if (this.strikeLights.has(strike.id)) return;
    const entity = scene.createTransformedEntity(
      `${this.name}.flash.${strike.id}`,
      new Vec3(strike.position.x, (this.cloudHeight + this.groundY) / 2, strike.position.z),
    );
    const light = new Light();
    light.kind = "point";
    light.range = Math.max(500, this.areaRadius * 3);
    light.intensity = 0;
    light.setColor(0.75, 0.85, 1);
    scene.world.addComponent(entity.id, light);
    this.strikeLights.set(strike.id, { entityId: entity.id as number, light });
  }

  private destroyStrikeLight(strikeId: number): void {
    const record = this.strikeLights.get(strikeId);
    if (!record) return;
    const facade = this.scene?.world.facade(record.entityId as never);
    if (facade) this.scene!.world.destroyEntity(facade.id);
    this.strikeLights.delete(strikeId);
  }

  override update(context: SystemContext): void {
    const dt = context.fixedSteps * context.fixedDt;
    if (dt > 0) this.advance(dt);
    this.present(context);
  }

  /** Advance scheduling and strike ages (seconds of simulated time). */
  advance(seconds: number): void {
    if (!(seconds > 0) || !Number.isFinite(seconds) || this.paused) return;
    this.simulatedSeconds += seconds;
    const storm = this.stormIntensity();
    if (storm > 0 && this.rate > 0) {
      this.nextStrikeIn -= seconds;
      let guard = 0;
      while (this.nextStrikeIn <= 0 && guard++ < 64) {
        // Position and energy from the stream (in this order — the determinism test replays it).
        const angle = this.rng.nextFloat() * Math.PI * 2;
        const radius = Math.sqrt(this.rng.nextFloat()) * this.areaRadius;
        const energy = 0.5 + this.rng.nextFloat();
        const cloudOnly = (this.options.cloudFlashFraction ?? 0) > 0 ? this.rng.nextFloat() < (this.options.cloudFlashFraction ?? 0) : false;
        const c = this.options.center?.() ?? { x: 0, z: 0 };
        this.trigger(new Vec3(c.x + Math.cos(angle) * radius, this.groundY, c.z + Math.sin(angle) * radius), energy, cloudOnly, true);
        this.nextStrikeIn += this.drawInterarrival(storm);
      }
    }
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i]!;
      s.age += seconds;
      if (s.age >= s.duration) {
        this.destroyStrikeLight(s.id);
        this.strikes.splice(i, 1);
      }
    }
    this.flashTotal = 0;
    for (const s of this.strikes) this.flashTotal += s.energy * flashEnvelope(s.age, this.envelope);
    this.deliverThunder();
  }

  /** fe-34 v3: push the in-cloud glow of the brightest live strike into the scene's cloud deck. */
  private applyCloudGlow(): void {
    const g = this.options.cloudGlow;
    const scene = this.scene;
    if (!g || !scene) return;
    let best: LightningStrike | null = null;
    let bestF = 0;
    for (const s of this.strikes) {
      // Intra-cloud flashes glow fully; a ground strike lights its own patch of base less.
      const f = s.energy * flashEnvelope(s.age, this.envelope) * (s.bolt.cloudOnly ? 1 : 0.6);
      if (f > bestF) {
        bestF = f;
        best = s;
      }
    }
    if (!best || bestF < 0.01) {
      if (scene.settings.clouds.flashIntensity !== 0) scene.setClouds({ flashIntensity: 0 });
      return;
    }
    const flicker = lightningFlicker(best.age, best.id, g.flickerHz ?? 18);
    // Intra-cloud flashes run sideways: centre the glow mid-channel.
    const pts = best.bolt.points;
    const mid = pts[Math.floor(pts.length / 2)] ?? best.position;
    scene.setClouds({ flashX: mid.x, flashZ: mid.z, flashRadius: g.radius ?? 700, flashIntensity: bestF * flicker * (g.intensity ?? 6) });
  }

  /** Drive the light, the sky flash and the bolt lines for the current state. */
  present(context: SystemContext): void {
    // Recomputed here too: a strike triggered while `paused` (a held debug strike) must still flash.
    this.flashTotal = 0;
    // v3: with `cloudGlow`, an intra-cloud flash lights its own patch of deck, not the whole sky.
    const icWeight = this.options.cloudGlow ? 0 : 1;
    for (const s of this.strikes) this.flashTotal += s.energy * flashEnvelope(s.age, this.envelope) * (s.bolt.cloudOnly ? icWeight : 1);
    this.applyCloudGlow();
    for (const s of this.strikes) {
      const record = this.strikeLights.get(s.id);
      if (record) record.light.intensity = s.energy * flashEnvelope(s.age, this.envelope) * this.flashLightIntensity * (s.bolt.cloudOnly && this.options.cloudGlow ? 0.3 : 1);
    }
    if (this.flashTotal > 0.001) {
      context.render?.setSkyOverride({ exposure: 1 + this.flashTotal * this.skyFlashExposure });
      const render = context.render;
      if (render) {
        this.lastBolts.length = 0;
        for (const s of this.strikes) {
          const f = s.energy * flashEnvelope(s.age, this.envelope);
          if (f <= 0.01) continue;
          // v3: an intra-cloud flash has no visible channel when the deck glow shows it.
          if (s.bolt.cloudOnly && this.options.cloudGlow) continue;
          const color = this.options.boltColor ?? 0x00e8ffff;
          const width = this.options.boltWidth ?? 5;
          const viewer = this.options.viewer?.();
          const pixels = viewer ? Math.max(1, Math.round(this.options.boltPixels ?? 1)) : 1;
          const glow = viewer ? Math.max(0, Math.round(this.options.boltGlowPixels ?? 0)) : 0;
          const pixelAngle = this.options.pixelAngle ?? Math.PI / 3 / 720;
          // Glow: the bolt colour pushed toward blue-violet.
          const glowColor = ((color & 0xff000000) | 0x8090ff) >>> 0;
          const lines = [s.bolt.points, ...s.bolt.branches];
          for (let b = 0; b < lines.length; b++) {
            const pts = lines[b]!;
            this.lastBolts.push(pts);
            const w = b === 0 ? width + f * 7 : (width + f * 7) * 0.45;
            // Branches are thinner than the main channel.
            const core = b === 0 ? pixels : Math.max(1, Math.round(pixels * 0.5));
            const halo = b === 0 ? glow : Math.round(glow * 0.5);
            for (let i = 1; i < pts.length; i++) {
              const p0 = pts[i - 1]!;
              const p1 = pts[i]!;
              if (core === 1 && halo === 0) {
                render.drawEmissiveLine(p0, p1, color, w);
                continue;
              }
              const step = lightningRibbonStep(p0, p1, viewer!, pixelAngle, this.ribbonStep);
              const half = (core - 1) * 0.5;
              for (let k = -half - halo; k <= half + halo + 1e-6; k += 1) {
                const inCore = Math.abs(k) <= half + 1e-6;
                const edge = inCore ? 1 : 1 - (Math.abs(k) - half) / (halo + 1);
                this.ribbonA.set(p0.x + step.x * k, p0.y + step.y * k, p0.z + step.z * k);
                this.ribbonB.set(p1.x + step.x * k, p1.y + step.y * k, p1.z + step.z * k);
                render.drawEmissiveLine(this.ribbonA, this.ribbonB, inCore ? color : glowColor, inCore ? w : Math.max(0.5, w * 0.35 * edge));
              }
            }
          }
        }
      }
    } else {
      this.lastBolts.length = 0;
    }
  }

  /** Exponential interarrival at `rate × storm` (mean 1/(rate·storm) seconds). */
  private drawInterarrival(storm: number): number {
    const lambda = Math.max(1e-6, this.rate * Math.max(0, storm));
    return -Math.log(1 - this.rng.nextFloat()) / lambda;
  }

  override stats(): Record<string, number | string | boolean> {
    return {
      strikes: this.strikeCount,
      active: this.strikes.length,
      flash: Math.round(this.flashTotal * 1000) / 1000,
      storm: Math.round(this.stormIntensity() * 1000) / 1000,
    };
  }
}
