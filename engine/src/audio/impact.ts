/**
 * Impact audio (Phase 20.8): collisions heard from the physics solver — original WebAudio modal
 * synthesis, no assets.
 *
 * {@link ImpactSoundAnalyzer} installs `PhysicsWorld.contactListener` and turns the reports into
 *  - **impacts**: a manifold whose approach speed before the solve passed `minImpactSpeed`, at most
 *    once per body pair per `cooldown`, with a 0..1 strength from the collision energy
 *    `½·m_reduced·v²` (log-scaled — a 2 kg box tapping and a 20 kg crate slammed into a truck are
 *    both audible and clearly different);
 *  - **scrapes**: pairs sliding in loaded contact (`slideSpeed` past `minScrapeSpeed` with a
 *    normal impulse), the loudest few kept per frame for looping friction voices.
 * Each body has an {@link ImpactMaterial} — from `materialOf(body)`, else {@link setImpactMaterial},
 * else from its shape (a heightfield is dirt) — and a size from its shape, so a small rock rings
 * higher than a boulder. Materials live in a WeakMap, not on the body, so body snapshots are
 * unchanged.
 *
 * {@link impactVoice} is the pure event → voice mapping (modal frequencies, decays, gains and a
 * contact transient), unit-tested without an AudioContext; {@link ImpactSoundscape} plays it with a
 * voice cap. Contacts arrive per fixed step; {@link ImpactSoundAnalyzer.update} closes the frame.
 */

import type { RigidBody } from "../physics/body.js";
import type { ContactReport, PhysicsWorld } from "../physics/world.js";

export type ImpactMaterial = "metal" | "wood" | "rock" | "plastic" | "glass" | "rubber" | "dirt" | "snow" | "ice";

export const IMPACT_MATERIALS: readonly ImpactMaterial[] = Object.freeze(["metal", "wood", "rock", "plastic", "glass", "rubber", "dirt", "snow", "ice"]);

/** How a material rings when struck. Mode frequencies are for a 0.5 m object; size scales them. */
export interface ImpactMaterialProfile {
  /** Modal frequencies (Hz) of a 0.5 m object. Empty: the material does not ring (dirt, snow). */
  modes: readonly number[];
  /** Decay (s) of the lowest mode; higher modes decay faster. */
  decay: number;
  /** 0..1: how much of the strike is a broadband click rather than ringing. */
  transient: number;
  /** Centre (Hz) of the contact transient / scrape noise. */
  noiseFrequency: number;
  noiseQ: number;
  /** Friction loudness when sliding. */
  scrape: number;
}

export const IMPACT_MATERIAL_SOUND: Readonly<Record<ImpactMaterial, Readonly<ImpactMaterialProfile>>> = Object.freeze({
  metal: { modes: [420, 1130, 2180, 3540], decay: 0.9, transient: 0.25, noiseFrequency: 3500, noiseQ: 2, scrape: 0.9 },
  wood: { modes: [180, 470, 960], decay: 0.12, transient: 0.45, noiseFrequency: 1100, noiseQ: 1.2, scrape: 0.5 },
  rock: { modes: [260, 690, 1500], decay: 0.07, transient: 0.65, noiseFrequency: 1800, noiseQ: 0.9, scrape: 0.7 },
  plastic: { modes: [330, 900, 1900], decay: 0.06, transient: 0.5, noiseFrequency: 2200, noiseQ: 1.4, scrape: 0.35 },
  glass: { modes: [1200, 3100, 5600], decay: 0.5, transient: 0.3, noiseFrequency: 5000, noiseQ: 2.5, scrape: 0.4 },
  rubber: { modes: [90], decay: 0.05, transient: 0.3, noiseFrequency: 400, noiseQ: 0.8, scrape: 0.2 },
  dirt: { modes: [], decay: 0, transient: 1, noiseFrequency: 350, noiseQ: 0.7, scrape: 0.45 },
  snow: { modes: [], decay: 0, transient: 1, noiseFrequency: 900, noiseQ: 0.6, scrape: 0.3 },
  ice: { modes: [900, 2300], decay: 0.15, transient: 0.6, noiseFrequency: 4200, noiseQ: 1.5, scrape: 0.25 },
});

export interface ImpactEvent {
  x: number;
  y: number;
  z: number;
  /** 0..1 loudness from the collision energy. */
  strength: number;
  /** Approach speed (m/s). */
  speed: number;
  /** Collision energy ½·m_reduced·v² (J). */
  energy: number;
  materialA: ImpactMaterial;
  materialB: ImpactMaterial;
  /** Characteristic size (m) of each body; Infinity for ground and planes. */
  sizeA: number;
  sizeB: number;
  bodyA: number;
  bodyB: number;
}

export interface ScrapeState {
  /** Body-pair key. */
  key: number;
  x: number;
  y: number;
  z: number;
  /** Slide speed (m/s). */
  speed: number;
  /** 0..1 loudness from the speed and the load. */
  level: number;
  materialA: ImpactMaterial;
  materialB: ImpactMaterial;
}

export interface ImpactSoundAnalyzerOptions {
  /** A body's material. Default: {@link setImpactMaterial}, else a guess from its shape. */
  materialOf?: (body: RigidBody) => ImpactMaterial | undefined;
  /** Approach speed (m/s) below which a contact is resting, not a hit. Default 0.6. */
  minImpactSpeed?: number;
  /** Seconds before the same pair can hit again (a box settling chatters otherwise). Default 0.08. */
  cooldown?: number;
  /** Impacts kept per frame, loudest first. Default 12. */
  maxEventsPerFrame?: number;
  /** Slide speed (m/s) a scrape needs. Default 0.3. */
  minScrapeSpeed?: number;
  /** Scrapes kept per frame, loudest first. Default 4. */
  maxScrapes?: number;
  /** Collision energy (J) that reads as full strength. Default 2000 (a 40 kg crate at 10 m/s). */
  fullEnergy?: number;
}

const MATERIALS = new WeakMap<RigidBody, ImpactMaterial>();

/** Tag a body with an impact material (kept outside the body, so snapshots do not change). */
export function setImpactMaterial(body: RigidBody, material: ImpactMaterial | undefined): void {
  if (material === undefined) MATERIALS.delete(body);
  else MATERIALS.set(body, material);
}

export function impactMaterial(body: RigidBody): ImpactMaterial | undefined {
  return MATERIALS.get(body);
}

/** Characteristic size (m): the shape's largest extent (sphere diameter, box's longest side, capsule tip to tip); Infinity for ground. */
export function impactSize(body: RigidBody): number {
  const shape = body.shape as unknown as { type: string; radius?: number; halfExtents?: { x: number; y: number; z: number }; halfHeight?: number };
  switch (shape.type) {
    case "sphere":
      return 2 * (shape.radius ?? 0.5);
    case "box": {
      const h = shape.halfExtents!;
      return 2 * Math.max(h.x, h.y, h.z);
    }
    case "capsule":
      return 2 * ((shape.halfHeight ?? 0.5) + (shape.radius ?? 0.5));
    case "cylinder":
      return 2 * Math.max(shape.radius ?? 0.5, shape.halfHeight ?? 0.5);
    default:
      return Infinity;
  }
}

function defaultMaterial(body: RigidBody): ImpactMaterial {
  const type = (body.shape as unknown as { type: string }).type;
  if (type === "heightfield" || type === "plane") return "dirt";
  return body.type === "static" ? "rock" : "wood";
}

function pairKey(a: number, b: number): number {
  return a < b ? a * 1_048_576 + b : b * 1_048_576 + a;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

interface PairScrape { key: number; x: number; y: number; z: number; speed: number; impulse: number; dt: number; a: RigidBody; b: RigidBody; seen: boolean }

/**
 * Turns a physics world's contact reports into impact events and scrape states. Call
 * {@link update} once per presented frame after the physics stepped; `events` and `scrapes` then
 * hold that frame's result.
 */
export class ImpactSoundAnalyzer {
  /** This frame's impacts, loudest first. */
  readonly events: ImpactEvent[] = [];
  /** This frame's scrapes, loudest first. */
  readonly scrapes: ScrapeState[] = [];
  /** Impacts dropped by the per-frame cap since construction. */
  dropped = 0;
  private readonly options: Required<Omit<ImpactSoundAnalyzerOptions, "materialOf">>;
  private readonly materialOf?: (body: RigidBody) => ImpactMaterial | undefined;
  private readonly pending: ImpactEvent[] = [];
  private readonly lastHit = new Map<number, number>();
  private readonly pairs = new Map<number, PairScrape>();
  private readonly listener = (r: ContactReport): void => this.onContact(r);
  private previous: ((report: ContactReport) => void) | null = null;
  private attached = false;

  constructor(readonly world: PhysicsWorld, options: ImpactSoundAnalyzerOptions = {}) {
    this.materialOf = options.materialOf;
    this.options = {
      minImpactSpeed: options.minImpactSpeed ?? 0.6,
      cooldown: options.cooldown ?? 0.08,
      maxEventsPerFrame: options.maxEventsPerFrame ?? 12,
      minScrapeSpeed: options.minScrapeSpeed ?? 0.3,
      maxScrapes: options.maxScrapes ?? 4,
      fullEnergy: options.fullEnergy ?? 2000,
    };
    this.attach();
  }

  /** Install the contact listener (chaining one that was already there). Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.previous = this.world.contactListener;
    const prev = this.previous;
    this.world.contactListener = prev ? (r) => { prev(r); this.listener(r); } : this.listener;
    this.attached = true;
  }

  /** Remove the listener, restoring the one it chained. */
  detach(): void {
    if (!this.attached) return;
    this.world.contactListener = this.previous;
    this.previous = null;
    this.attached = false;
  }

  materialFor(body: RigidBody): ImpactMaterial {
    return this.materialOf?.(body) ?? MATERIALS.get(body) ?? defaultMaterial(body);
  }

  /** Close the frame: publish the loudest impacts and scrapes collected since the last update. */
  update(): this {
    const o = this.options;
    this.events.length = 0;
    this.pending.sort((a, b) => b.strength - a.strength);
    const keep = Math.min(o.maxEventsPerFrame, this.pending.length);
    for (let i = 0; i < keep; i++) this.events.push(this.pending[i]!);
    this.dropped += this.pending.length - keep;
    this.pending.length = 0;

    this.scrapes.length = 0;
    for (const [key, p] of this.pairs) {
      if (!p.seen) {
        this.pairs.delete(key);
        continue;
      }
      p.seen = false;
      if (p.speed < o.minScrapeSpeed) continue;
      // Load: the impulse per second is the mean normal force; ~a body's weight reads as loaded.
      const force = p.impulse / Math.max(1e-6, p.dt);
      const weight = 9.81 * Math.max(1, Math.min(massOf(p.a), massOf(p.b)));
      const level = clamp01((p.speed - o.minScrapeSpeed) / 4) * clamp01(force / weight);
      if (level <= 0) continue;
      this.scrapes.push({ key, x: p.x, y: p.y, z: p.z, speed: p.speed, level, materialA: this.materialFor(p.a), materialB: this.materialFor(p.b) });
    }
    this.scrapes.sort((a, b) => b.level - a.level);
    if (this.scrapes.length > o.maxScrapes) this.scrapes.length = o.maxScrapes;
    return this;
  }

  dispose(): void {
    this.detach();
    this.pairs.clear();
    this.lastHit.clear();
  }

  private onContact(r: ContactReport): void {
    const a = r.bodyA, b = r.bodyB;
    const key = pairKey(a.id, b.id);
    const o = this.options;
    if (r.closingSpeed >= o.minImpactSpeed) {
      const t = this.world.time;
      const last = this.lastHit.get(key);
      if (last === undefined || t - last >= o.cooldown) {
        this.lastHit.set(key, t);
        const reduced = 1 / Math.max(1e-9, a.invMass + b.invMass);
        const energy = 0.5 * reduced * r.closingSpeed * r.closingSpeed;
        this.pending.push({
          x: r.x, y: r.y, z: r.z,
          strength: clamp01(Math.log1p(energy / 2) / Math.log1p(o.fullEnergy / 2)),
          speed: r.closingSpeed,
          energy,
          materialA: this.materialFor(a),
          materialB: this.materialFor(b),
          sizeA: impactSize(a),
          sizeB: impactSize(b),
          bodyA: a.id,
          bodyB: b.id,
        });
      }
    }
    // Several steps per frame: keep the fastest slide and the summed load.
    let p = this.pairs.get(key);
    if (!p) {
      p = { key, x: 0, y: 0, z: 0, speed: 0, impulse: 0, dt: 0, a, b, seen: false };
      this.pairs.set(key, p);
    }
    if (!p.seen) {
      p.speed = 0;
      p.impulse = 0;
      p.dt = 0;
      p.seen = true;
    }
    if (r.slideSpeed >= p.speed) {
      p.speed = r.slideSpeed;
      p.x = r.x;
      p.y = r.y;
      p.z = r.z;
    }
    p.impulse += r.impulse;
    p.dt += r.dt;
  }
}

function massOf(body: RigidBody): number {
  return body.invMass > 0 ? 1 / body.invMass : Infinity;
}

export interface ImpactMode {
  frequency: number;
  gain: number;
  decay: number;
}

export interface ImpactVoice {
  gain: number;
  /** Ringing modes of both bodies (ground does not ring). */
  modes: ImpactMode[];
  transientFrequency: number;
  transientQ: number;
  transientGain: number;
  /** Transient length (s): harder hits are shorter and brighter. */
  transientDecay: number;
}

/** Scale a 0.5 m object's modes to `size` (smaller rings higher), clamped to a hearable band. */
function modeFrequency(base: number, size: number): number {
  const s = Number.isFinite(size) ? Math.max(0.05, size) : 2;
  return Math.min(9000, Math.max(40, base * Math.sqrt(0.5 / s)));
}

/** Map an impact to the voice that plays it. Pure. */
export function impactVoice(event: ImpactEvent): ImpactVoice {
  const s = clamp01(event.strength);
  const modes: ImpactMode[] = [];
  const ring = (material: ImpactMaterial, size: number, share: number): void => {
    const p = IMPACT_MATERIAL_SOUND[material];
    p.modes.forEach((base, i) => {
      // Harder hits excite the upper modes more; each higher mode is quieter and shorter.
      const excite = Math.pow(0.55 + 0.45 * s, i);
      modes.push({ frequency: modeFrequency(base, size), gain: share * (1 - p.transient) * excite / (1 + i * 0.6), decay: p.decay / (1 + i * 0.8) * (0.6 + 0.4 * s) });
    });
  };
  const groundA = !Number.isFinite(event.sizeA), groundB = !Number.isFinite(event.sizeB);
  if (!groundA) ring(event.materialA, event.sizeA, groundB ? 1 : 0.5);
  if (!groundB) ring(event.materialB, event.sizeB, groundA ? 1 : 0.5);
  // The transient is the softer surface's: a crate on snow thuds, a crate on rock clacks.
  const pa = IMPACT_MATERIAL_SOUND[event.materialA], pb = IMPACT_MATERIAL_SOUND[event.materialB];
  const soft = pa.noiseFrequency <= pb.noiseFrequency ? pa : pb;
  const t = Math.max(pa.transient, pb.transient);
  return {
    gain: Math.min(1, 0.05 + 0.95 * s),
    modes,
    transientFrequency: soft.noiseFrequency * (0.7 + 0.6 * s),
    transientQ: soft.noiseQ,
    transientGain: t * (0.4 + 0.6 * s),
    transientDecay: 0.03 + 0.09 * (1 - s) + (soft.modes.length === 0 ? 0.06 : 0),
  };
}

export interface ScrapeVoice {
  gain: number;
  frequency: number;
  q: number;
}

/** Map a scrape to its looping friction voice. Pure. */
export function scrapeVoice(scrape: ScrapeState): ScrapeVoice {
  const pa = IMPACT_MATERIAL_SOUND[scrape.materialA], pb = IMPACT_MATERIAL_SOUND[scrape.materialB];
  const loud = pa.scrape >= pb.scrape ? pa : pb;
  return {
    gain: Math.min(0.8, clamp01(scrape.level) * Math.max(pa.scrape, pb.scrape)),
    frequency: Math.min(8000, loud.noiseFrequency * (0.6 + 0.15 * Math.min(6, scrape.speed))),
    q: loud.noiseQ,
  };
}

export interface ImpactSoundscapeOptions {
  volume?: number;
  /** Place each impact and scrape with an HRTF panner. Default true. */
  spatial?: boolean;
  /** One-shots allowed at once; more are skipped. Default 24. */
  maxVoices?: number;
  /** Looping scrape voices. Default 4. */
  scrapeVoices?: number;
  seed?: number;
}

/**
 * Plays impacts as modal one-shots (one decaying sine per mode plus a filtered noise transient)
 * and scrapes as looping band-passed noise. Browsers only start audio after a user gesture.
 */
export class ImpactSoundscape {
  readonly context: BaseAudioContext;
  readonly output: GainNode;
  private readonly noise: AudioBuffer;
  private readonly maxVoices: number;
  private readonly spatial: boolean;
  private readonly scrapeSlots: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; panner?: PannerNode }[] = [];
  private active = 0;
  private rng: number;
  private disposed = false;
  /** One-shots skipped by the voice cap. */
  skipped = 0;

  constructor(context: BaseAudioContext, destination: AudioNode = context.destination, options: ImpactSoundscapeOptions = {}) {
    this.context = context;
    this.maxVoices = Math.max(1, options.maxVoices ?? 24);
    this.spatial = options.spatial ?? true;
    this.rng = (options.seed ?? 0x1a9ac7) >>> 0 || 1;
    this.output = context.createGain();
    this.output.gain.value = options.volume ?? 0.8;
    this.output.connect(destination);
    this.noise = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate)), context.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = this.random() * 2 - 1;
    for (let i = 0; i < Math.max(0, options.scrapeVoices ?? 4); i++) {
      const src = context.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1000;
      const gain = context.createGain();
      gain.gain.value = 0;
      const panner = this.spatial ? this.createPanner() : undefined;
      src.connect(filter).connect(gain).connect(panner ?? this.output);
      panner?.connect(this.output);
      src.start(0, i * 0.17);
      this.scrapeSlots.push({ src, filter, gain, panner });
    }
  }

  /** Voices currently playing. */
  get activeVoices(): number {
    return this.active;
  }

  play(events: readonly ImpactEvent[]): void {
    if (this.disposed) return;
    for (const e of events) {
      if (this.active >= this.maxVoices) {
        this.skipped++;
        continue;
      }
      this.strike(e, impactVoice(e));
    }
  }

  /** Drive the looping scrape voices from this frame's scrapes (silent slots fade out). */
  setScrapes(scrapes: readonly ScrapeState[]): void {
    if (this.disposed) return;
    const t = this.context.currentTime;
    this.scrapeSlots.forEach((slot, i) => {
      const s = scrapes[i];
      if (!s) {
        slot.gain.gain.setTargetAtTime(0, t, 0.05);
        return;
      }
      const v = scrapeVoice(s);
      slot.gain.gain.setTargetAtTime(v.gain, t, 0.04);
      slot.filter.frequency.setTargetAtTime(v.frequency, t, 0.04);
      slot.filter.Q.setTargetAtTime(v.q, t, 0.04);
      if (slot.panner) {
        slot.panner.positionX.setTargetAtTime(s.x, t, 0.02);
        slot.panner.positionY.setTargetAtTime(s.y, t, 0.02);
        slot.panner.positionZ.setTargetAtTime(s.z, t, 0.02);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.scrapeSlots) {
      slot.src.stop();
      slot.src.disconnect();
      slot.panner?.disconnect();
    }
    this.output.disconnect();
  }

  private createPanner(): PannerNode {
    const p = this.context.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 3;
    p.rolloffFactor = 1;
    return p;
  }

  private random(): number {
    let s = this.rng;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rng = s >>> 0 || 1;
    return this.rng / 4294967296;
  }

  private strike(e: ImpactEvent, v: ImpactVoice): void {
    const ctx = this.context;
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = v.gain;
    let tail: AudioNode = bus;
    if (this.spatial) {
      const p = this.createPanner();
      p.positionX.value = e.x;
      p.positionY.value = e.y;
      p.positionZ.value = e.z;
      bus.connect(p);
      tail = p;
    }
    tail.connect(this.output);
    let pending = 0;
    const release = (): void => {
      if (--pending > 0) return;
      this.active--;
      bus.disconnect();
      if (tail !== bus) tail.disconnect();
    };
    for (const m of v.modes) {
      const o = ctx.createOscillator();
      o.type = "sine";
      // A little detune per strike so a pile of identical crates is not one note.
      o.frequency.value = m.frequency * (0.97 + 0.06 * this.random());
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(1e-4, m.gain), t);
      g.gain.exponentialRampToValueAtTime(1e-4, t + m.decay * 4);
      o.connect(g).connect(bus);
      o.onended = () => { g.disconnect(); release(); };
      o.start(t);
      o.stop(t + m.decay * 4 + 0.02);
      pending++;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = v.transientFrequency;
    filter.Q.value = v.transientQ;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(1e-4, v.transientGain), t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + v.transientDecay);
    src.connect(filter).connect(g).connect(bus);
    src.onended = () => { g.disconnect(); release(); };
    src.start(t, this.random() * Math.max(0, this.noise.duration - v.transientDecay - 0.05));
    src.stop(t + v.transientDecay + 0.02);
    pending++;
    this.active++;
  }
}
