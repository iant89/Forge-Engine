/**
 * Particle audio (Phase 20.8): a particle effect heard from its simulation state — original WebAudio
 * synthesis, no assets.
 *
 * {@link ParticleSoundAnalyzer} reads a CPU `ParticleSimulation` (the reference simulation; the
 * state buffer is on the CPU) after it stepped:
 *  - **births** this frame (`emitted` delta) — a frame with at least `burstBirths` births is a
 *    `burst` event (an explosion of sparks, a spray of chips);
 *  - **flow**: alive count and mean speed — the continuous hiss of a fountain, sparks or dust;
 *  - **ground hits**: particles that crossed the ground (`groundAt(x, z)`, or a flat `groundY`)
 *    downward since the last frame, with their count, mean impact speed and centroid — the patter of
 *    falling debris. The simulation has no particle collisions, so a crossing is the hit; a particle
 *    born this frame is not one.
 * {@link particleSoundLevels} is the pure mapping per {@link ParticleSoundKind};
 * {@link ParticleSoundscape} plays the hiss as a loop, the hits as short grains spread across the
 * frame and bursts as one-shots. Reading the state never changes the simulation.
 */

import { setPannerPosition } from "./spatial.js";
import { FLAG_ALIVE, PARTICLE_FLOATS, P_AGE, P_FLAGS, P_VX, P_VY, P_VZ, P_X, P_Y, P_Z } from "../particles/layout.js";

/** What the particles are: sets the colour of every voice. */
export type ParticleSoundKind = "sparks" | "debris" | "spray" | "dust";

export interface ParticleSoundProfile {
  /** Band-pass centre (Hz) and Q of the continuous flow hiss. */
  hissFrequency: number;
  hissQ: number;
  /** Flow loudness per (alive / reference) at the reference speed. */
  hiss: number;
  /** Grain (hit) band centre (Hz), Q and length (s). */
  grainFrequency: number;
  grainQ: number;
  grainDecay: number;
  /** Hit loudness. */
  patter: number;
  /** Burst loudness. */
  burst: number;
  /** Speed (m/s) at which the hiss reaches its brightest. */
  referenceSpeed: number;
}

export const PARTICLE_SOUND: Readonly<Record<ParticleSoundKind, Readonly<ParticleSoundProfile>>> = Object.freeze({
  sparks: { hissFrequency: 5200, hissQ: 0.9, hiss: 0.5, grainFrequency: 6500, grainQ: 3, grainDecay: 0.012, patter: 0.35, burst: 0.8, referenceSpeed: 12 },
  debris: { hissFrequency: 700, hissQ: 0.6, hiss: 0.15, grainFrequency: 1600, grainQ: 1.6, grainDecay: 0.035, patter: 0.8, burst: 0.6, referenceSpeed: 8 },
  spray: { hissFrequency: 3000, hissQ: 0.5, hiss: 0.7, grainFrequency: 2400, grainQ: 1.1, grainDecay: 0.02, patter: 0.45, burst: 0.5, referenceSpeed: 8 },
  dust: { hissFrequency: 1200, hissQ: 0.4, hiss: 0.35, grainFrequency: 900, grainQ: 0.8, grainDecay: 0.03, patter: 0.1, burst: 0.4, referenceSpeed: 5 },
});

/** What the analyzer reads: `ParticleSimulation` satisfies it. */
export interface ParticleSoundSource {
  readonly capacity: number;
  readonly state: Float32Array;
  readonly emitted: number;
}

export interface ParticleSoundState {
  kind: ParticleSoundKind;
  births: number;
  /** Births per second this frame. */
  birthRate: number;
  alive: number;
  /** Mean speed of the alive particles (m/s). */
  meanSpeed: number;
  /** Mean position of the alive particles (for placing the hiss). */
  x: number;
  y: number;
  z: number;
  /** Ground crossings this frame. */
  hits: number;
  /** Mean downward speed at the crossings (m/s). */
  hitSpeed: number;
  hitX: number;
  hitY: number;
  hitZ: number;
  /** Births this frame reached `burstBirths`. */
  burst: boolean;
}

export interface ParticleSoundAnalyzerOptions {
  kind?: ParticleSoundKind;
  /** Ground height under (x, z). Default: flat at `groundY`. */
  groundAt?: (x: number, z: number) => number;
  /** Flat ground height when `groundAt` is not given. Default 0. */
  groundY?: number;
  /** Births in one frame that make a burst. Default 24. */
  burstBirths?: number;
}

export class ParticleSoundAnalyzer {
  readonly state: ParticleSoundState;
  private readonly groundAt?: (x: number, z: number) => number;
  private readonly groundY: number;
  private readonly burstBirths: number;
  /** Per slot: height above the ground at the last update (NaN: not alive then). */
  private readonly prevAbove: Float32Array;
  private prevEmitted: number;

  constructor(readonly source: ParticleSoundSource, options: ParticleSoundAnalyzerOptions = {}) {
    this.groundAt = options.groundAt;
    this.groundY = options.groundY ?? 0;
    this.burstBirths = Math.max(1, options.burstBirths ?? 24);
    this.prevAbove = new Float32Array(source.capacity).fill(NaN);
    this.prevEmitted = source.emitted;
    this.state = { kind: options.kind ?? "debris", births: 0, birthRate: 0, alive: 0, meanSpeed: 0, x: 0, y: 0, z: 0, hits: 0, hitSpeed: 0, hitX: 0, hitY: 0, hitZ: 0, burst: false };
  }

  update(dt: number): ParticleSoundState {
    const src = this.source;
    const s = this.state;
    const data = src.state;
    const frame = dt > 1e-6 ? dt : 1 / 60;
    s.births = Math.max(0, src.emitted - this.prevEmitted);
    this.prevEmitted = src.emitted;
    s.birthRate = s.births / frame;
    s.burst = s.births >= this.burstBirths;
    let alive = 0, speed = 0, x = 0, y = 0, z = 0;
    let hits = 0, hitSpeed = 0, hx = 0, hy = 0, hz = 0;
    for (let i = 0; i < src.capacity; i++) {
      const o = i * PARTICLE_FLOATS;
      if ((data[o + P_FLAGS]! & FLAG_ALIVE) === 0) {
        this.prevAbove[i] = NaN;
        continue;
      }
      const px = data[o + P_X]!, py = data[o + P_Y]!, pz = data[o + P_Z]!;
      const vx = data[o + P_VX]!, vy = data[o + P_VY]!, vz = data[o + P_VZ]!;
      alive++;
      speed += Math.sqrt(vx * vx + vy * vy + vz * vz);
      x += px;
      y += py;
      z += pz;
      const above = py - (this.groundAt ? this.groundAt(px, pz) : this.groundY);
      const prev = this.prevAbove[i]!;
      // A slot reborn since the last update (its age is younger than the frame) has no history.
      const fresh = data[o + P_AGE]! < frame - 1e-6;
      if (!fresh && prev > 0 && above <= 0 && vy < 0) {
        hits++;
        hitSpeed -= vy;
        hx += px;
        hy += py - above;
        hz += pz;
      }
      this.prevAbove[i] = above;
    }
    s.alive = alive;
    s.meanSpeed = alive > 0 ? speed / alive : 0;
    s.x = alive > 0 ? x / alive : 0;
    s.y = alive > 0 ? y / alive : 0;
    s.z = alive > 0 ? z / alive : 0;
    s.hits = hits;
    s.hitSpeed = hits > 0 ? hitSpeed / hits : 0;
    s.hitX = hits > 0 ? hx / hits : 0;
    s.hitY = hits > 0 ? hy / hits : 0;
    s.hitZ = hits > 0 ? hz / hits : 0;
    return s;
  }
}

export interface ParticleSoundLevels {
  hissGain: number;
  hissFrequency: number;
  hissQ: number;
  /** Grains to play this frame (hits, capped). */
  grains: number;
  grainGain: number;
  grainFrequency: number;
  grainQ: number;
  grainDecay: number;
  burstGain: number;
}

export interface ParticleSoundLevelOptions {
  /** Alive count that reads as a full flow. Default 400. */
  referenceAlive?: number;
  /** Grains per frame at most. Default 12. */
  maxGrains?: number;
}

export function createParticleSoundLevels(): ParticleSoundLevels {
  return { hissGain: 0, hissFrequency: 0, hissQ: 1, grains: 0, grainGain: 0, grainFrequency: 0, grainQ: 1, grainDecay: 0, burstGain: 0 };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Map a particle sound state to voice levels. Pure. */
export function particleSoundLevels(state: ParticleSoundState, options: ParticleSoundLevelOptions = {}, out: ParticleSoundLevels = createParticleSoundLevels()): ParticleSoundLevels {
  const p = PARTICLE_SOUND[state.kind];
  const flow = clamp01(Math.sqrt(state.alive / Math.max(1, options.referenceAlive ?? 400)));
  const pace = clamp01(state.meanSpeed / p.referenceSpeed);
  out.hissGain = Math.min(0.8, p.hiss * flow * (0.25 + 0.75 * pace));
  out.hissFrequency = p.hissFrequency * (0.6 + 0.6 * pace);
  out.hissQ = p.hissQ;
  out.grains = Math.min(Math.max(0, options.maxGrains ?? 12), state.hits);
  // Faster falls hit harder and brighter.
  const impact = clamp01(state.hitSpeed / 10);
  out.grainGain = state.hits > 0 ? Math.min(0.8, p.patter * (0.2 + 0.8 * impact)) : 0;
  out.grainFrequency = p.grainFrequency * (0.8 + 0.4 * impact);
  out.grainQ = p.grainQ;
  out.grainDecay = p.grainDecay;
  out.burstGain = state.burst ? Math.min(1, p.burst * (0.4 + 0.6 * clamp01(state.births / 200))) : 0;
  return out;
}

export interface ParticleSoundscapeOptions extends ParticleSoundLevelOptions {
  volume?: number;
  /** Place the hiss at the particles' centroid and grains at the hits (HRTF). Default true. */
  spatial?: boolean;
  seed?: number;
}

/** Hiss loop + hit grains + burst one-shots for one particle effect. */
export class ParticleSoundscape {
  readonly context: BaseAudioContext;
  readonly output: GainNode;
  readonly levels: ParticleSoundLevels = createParticleSoundLevels();
  private readonly hit = { x: 0, y: 0, z: 0 };
  private readonly options: ParticleSoundscapeOptions;
  private readonly noise: AudioBuffer;
  private readonly hissSource: AudioBufferSourceNode;
  private readonly hissFilter: BiquadFilterNode;
  private readonly hissGain: GainNode;
  private readonly hissPanner?: PannerNode;
  private readonly grainPanner?: PannerNode;
  private readonly grainBus: GainNode;
  private rng: number;
  private disposed = false;

  constructor(context: BaseAudioContext, destination: AudioNode = context.destination, options: ParticleSoundscapeOptions = {}) {
    this.context = context;
    this.options = options;
    this.rng = (options.seed ?? 0x9a27) >>> 0 || 1;
    this.output = context.createGain();
    this.output.gain.value = options.volume ?? 0.7;
    this.output.connect(destination);
    this.noise = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate)), context.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = this.random() * 2 - 1;
    const spatial = options.spatial ?? true;
    const panner = (): PannerNode => {
      const p = context.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = 3;
      p.connect(this.output);
      return p;
    };
    this.hissPanner = spatial ? panner() : undefined;
    this.grainPanner = spatial ? panner() : undefined;
    this.hissSource = context.createBufferSource();
    this.hissSource.buffer = this.noise;
    this.hissSource.loop = true;
    this.hissFilter = context.createBiquadFilter();
    this.hissFilter.type = "bandpass";
    this.hissGain = context.createGain();
    this.hissGain.gain.value = 0;
    this.hissSource.connect(this.hissFilter).connect(this.hissGain).connect(this.hissPanner ?? this.output);
    this.hissSource.start();
    this.grainBus = context.createGain();
    this.grainBus.connect(this.grainPanner ?? this.output);
  }

  /** Apply one frame's state (`dt` spreads the grains over the frame). Returns the levels. */
  set(state: ParticleSoundState, dt: number): ParticleSoundLevels {
    if (this.disposed) return this.levels;
    const l = particleSoundLevels(state, this.options, this.levels);
    const ctx = this.context;
    const t = ctx.currentTime;
    this.hissGain.gain.setTargetAtTime(l.hissGain, t, 0.08);
    this.hissFilter.frequency.setTargetAtTime(l.hissFrequency, t, 0.08);
    this.hissFilter.Q.setTargetAtTime(l.hissQ, t, 0.08);
    if (this.hissPanner && state.alive > 0) {
      setPannerPosition(this.hissPanner, state, t, 0.05);
    }
    if (l.grains > 0 && this.grainPanner) {
      this.hit.x = state.hitX;
      this.hit.y = state.hitY;
      this.hit.z = state.hitZ;
      setPannerPosition(this.grainPanner, this.hit, t);
    }
    const span = Math.max(0, Math.min(0.1, dt));
    for (let i = 0; i < l.grains; i++) {
      this.grain(t + this.random() * span, l.grainFrequency * (0.85 + 0.3 * this.random()), l.grainQ, l.grainDecay, l.grainGain * (0.6 + 0.4 * this.random()));
    }
    if (l.burstGain > 0) {
      const p = PARTICLE_SOUND[state.kind];
      this.grain(t, p.hissFrequency * 0.5, 0.5, 0.35, l.burstGain);
    }
    return l;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hissSource.stop();
    this.hissSource.disconnect();
    this.grainBus.disconnect();
    this.hissPanner?.disconnect();
    this.grainPanner?.disconnect();
    this.output.disconnect();
  }

  private random(): number {
    let s = this.rng;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rng = s >>> 0 || 1;
    return this.rng / 4294967296;
  }

  private grain(at: number, frequency: number, q: number, decay: number, level: number): void {
    const ctx = this.context;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(1e-4, level), at);
    g.gain.exponentialRampToValueAtTime(1e-4, at + decay);
    src.connect(filter).connect(g).connect(this.grainBus);
    src.onended = () => g.disconnect();
    src.start(at, this.random() * Math.max(0, this.noise.duration - decay - 0.05));
    src.stop(at + decay + 0.02);
  }
}
