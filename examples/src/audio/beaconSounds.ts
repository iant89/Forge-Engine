/**
 * Beacon Defense sound — every effect synthesized from numbers, no audio assets.
 *
 * Two layers, so the DSP is testable without a sound card:
 *
 *  - {@link renderBeaconSound} is pure: a sound name and a sample rate in, mono PCM out. It is
 *    deterministic (a seeded PRNG, no `Math.random`, no clocks), so a test can assert a shot is short
 *    and bright and a game over is long and descending without touching WebAudio.
 *  - {@link BeaconSoundscape} is the browser half: it turns those samples into `AudioBuffer`s once,
 *    plays them through the engine's `AudioSystem` on the `sfx` bus, positions the ones that happen
 *    somewhere in the arena, and rate-limits per sound so a multishot volley cannot stack twelve
 *    identical explosions into clipping.
 *
 * Autoplay policy is the scene's problem, not this module's: the soundscape is only constructed after
 * a user gesture, and every method is a no-op when the context is suspended or closed.
 */

import type { AudioSystem } from "@forge/engine";

export type BeaconSound =
  | "shot"
  | "cannon"
  | "hit"
  | "explodeSmall"
  | "explodeBig"
  | "beaconHit"
  | "repair"
  | "emp"
  | "overcharge"
  | "waveStart"
  | "waveClear"
  | "purchase"
  | "refuse"
  | "gameOver"
  | "victory";

export interface BeaconSoundSpec {
  /** Seconds of PCM. */
  readonly duration: number;
  /** Default mix level (0..1). */
  readonly gain: number;
  /** Minimum seconds between two plays of this sound (voice protection). */
  readonly minInterval: number;
  readonly label: string;
}

export const BEACON_SOUNDS: Readonly<Record<BeaconSound, BeaconSoundSpec>> = Object.freeze({
  shot: { duration: 0.09, gain: 0.3, minInterval: 0.03, label: "turret servo shot" },
  cannon: { duration: 0.17, gain: 0.42, minInterval: 0.05, label: "manual cannon" },
  hit: { duration: 0.05, gain: 0.16, minInterval: 0.02, label: "round strikes armour" },
  explodeSmall: { duration: 0.34, gain: 0.4, minInterval: 0.04, label: "light drone breaks up" },
  explodeBig: { duration: 0.62, gain: 0.55, minInterval: 0.07, label: "heavy drone detonates" },
  beaconHit: { duration: 0.32, gain: 0.5, minInterval: 0.08, label: "beacon takes a hit" },
  repair: { duration: 0.4, gain: 0.34, minInterval: 0.2, label: "field repair" },
  emp: { duration: 0.55, gain: 0.44, minInterval: 0.3, label: "EMP pulse" },
  overcharge: { duration: 0.45, gain: 0.4, minInterval: 0.3, label: "overcharge spooling" },
  waveStart: { duration: 0.5, gain: 0.34, minInterval: 0.3, label: "wave inbound" },
  waveClear: { duration: 0.45, gain: 0.32, minInterval: 0.3, label: "wave cleared" },
  purchase: { duration: 0.13, gain: 0.3, minInterval: 0.06, label: "upgrade installed" },
  refuse: { duration: 0.16, gain: 0.26, minInterval: 0.12, label: "cannot afford / on cooldown" },
  gameOver: { duration: 1.2, gain: 0.5, minInterval: 1, label: "beacon lost" },
  victory: { duration: 1.5, gain: 0.5, minInterval: 1, label: "run held" },
});

export const BEACON_SOUND_NAMES: readonly BeaconSound[] = Object.freeze(Object.keys(BEACON_SOUNDS) as BeaconSound[]);

/** A tiny deterministic PRNG (mulberry32): the same sound renders to the same samples everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

/** Exponential decay from 1 to ~0 over `duration`, with a linear attack of `attack` seconds. */
function envelope(t: number, duration: number, attack: number): number {
  if (t <= 0) return 0;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  return a * Math.exp((-4 * t) / duration);
}

/** One damped tone, optionally swept from `f0` to `f1` (exponential in frequency, as ears expect). */
function tone(out: Float32Array, sampleRate: number, f0: number, f1: number, gain: number, attack: number, harmonics = 1): void {
  const duration = out.length / sampleRate;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const k = duration > 0 ? t / duration : 0;
    const f = f0 * Math.pow(f1 / Math.max(1e-3, f0), k);
    phase += (TAU * f) / sampleRate;
    let s = Math.sin(phase);
    if (harmonics > 1) s += 0.4 * Math.sin(2 * phase) + (harmonics > 2 ? 0.2 * Math.sin(3 * phase) : 0);
    out[i]! += gain * envelope(t, duration, attack) * s;
  }
}

/** Filtered noise: white noise through a one-pole lowpass, decaying over the buffer. */
function noise(out: Float32Array, sampleRate: number, gain: number, cutoff: number, attack: number, seed: number): void {
  const duration = out.length / sampleRate;
  const rnd = prng(seed);
  const rc = 1 / Math.max(1, cutoff);
  const alpha = (1 / sampleRate) / (rc + 1 / sampleRate);
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const white = rnd() * 2 - 1;
    low += alpha * (white - low);
    out[i]! += gain * envelope(t, duration, attack) * low * 3;
  }
}

/** Add a short rhythmic figure (a chime, an arpeggio) from MIDI note numbers. */
function figure(out: Float32Array, sampleRate: number, notes: readonly number[], noteSeconds: number, gain: number, harmonics = 1): void {
  const step = Math.max(1, Math.floor(noteSeconds * sampleRate));
  for (let n = 0; n < notes.length; n++) {
    const midi = notes[n]!;
    if (midi <= 0) continue;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const start = n * step;
    const length = Math.min(out.length - start, Math.floor(noteSeconds * 1.7 * sampleRate));
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      phase += (TAU * f) / sampleRate;
      let s = Math.sin(phase);
      if (harmonics > 1) s += 0.3 * Math.sin(2 * phase);
      if (harmonics > 2) s += 0.15 * Math.sin(3 * phase);
      out[start + i]! += gain * envelope(t, noteSeconds * 1.6, 0.008) * s;
    }
  }
}

/**
 * Render one effect to mono PCM in −1..1. Pure and deterministic: same name and sample rate, same
 * samples. This is the function the tests assert on.
 */
export function renderBeaconSound(name: BeaconSound, sampleRate = 48000): Float32Array {
  const spec = BEACON_SOUNDS[name];
  const out = new Float32Array(Math.max(1, Math.round(spec.duration * sampleRate)));
  switch (name) {
    case "shot":
      // A servo snap: a bright descending zip over a very short noise crack.
      tone(out, sampleRate, 1180, 380, 0.5, 0.002);
      noise(out, sampleRate, 0.3, 4200, 0.001, 11);
      break;
    case "cannon":
      // The player's weapon is heavier: a low thump under the crack, and a longer tail.
      tone(out, sampleRate, 240, 68, 0.75, 0.003);
      tone(out, sampleRate, 900, 300, 0.3, 0.002);
      noise(out, sampleRate, 0.5, 2600, 0.002, 23);
      break;
    case "hit":
      tone(out, sampleRate, 2400, 1500, 0.3, 0.001);
      noise(out, sampleRate, 0.22, 6000, 0.001, 31);
      break;
    case "explodeSmall":
      noise(out, sampleRate, 0.85, 1500, 0.004, 41);
      tone(out, sampleRate, 120, 44, 0.5, 0.006);
      break;
    case "explodeBig":
      noise(out, sampleRate, 1.0, 900, 0.006, 53);
      tone(out, sampleRate, 88, 30, 0.85, 0.01);
      tone(out, sampleRate, 190, 60, 0.3, 0.008, 2);
      break;
    case "beaconHit":
      // An alarm: two tones a fourth apart, over the impact.
      figure(out, sampleRate, [76, 71], 0.12, 0.5, 2);
      tone(out, sampleRate, 96, 48, 0.6, 0.004);
      noise(out, sampleRate, 0.4, 1200, 0.003, 67);
      break;
    case "repair":
      figure(out, sampleRate, [72, 76, 79], 0.11, 0.42, 2);
      break;
    case "emp": {
      // A whoosh that rises and collapses, with a crackle of static on top.
      const duration = spec.duration;
      let phase = 0;
      const rnd = prng(71);
      for (let i = 0; i < out.length; i++) {
        const t = i / sampleRate;
        const k = t / duration;
        const f = 180 + 900 * Math.sin(Math.PI * k);
        phase += (TAU * f) / sampleRate;
        const swell = Math.sin(Math.PI * k);
        out[i]! += 0.42 * swell * Math.sin(phase) + 0.3 * swell * (rnd() * 2 - 1) * (k > 0.55 ? 1 - k : 1);
      }
      break;
    }
    case "overcharge": {
      // A spooling rise: a fifth that climbs, with a little vibrato at the top.
      const duration = spec.duration;
      let phase = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sampleRate;
        const k = t / duration;
        const f = (220 + 660 * k) * (1 + 0.02 * Math.sin(TAU * 9 * t) * k);
        phase += (TAU * f) / sampleRate;
        out[i]! += 0.4 * envelope(t, duration, 0.05) * (Math.sin(phase) + 0.35 * Math.sin(2 * phase));
      }
      break;
    }
    case "waveStart":
      figure(out, sampleRate, [67, 74], 0.16, 0.45, 2);
      noise(out, sampleRate, 0.12, 900, 0.02, 83);
      break;
    case "waveClear":
      figure(out, sampleRate, [72, 79], 0.15, 0.42, 2);
      break;
    case "purchase":
      figure(out, sampleRate, [81, 88], 0.05, 0.4, 1);
      break;
    case "refuse":
      // A dry buzz: a low square-ish pair, no sparkle.
      figure(out, sampleRate, [55, 51], 0.07, 0.4, 3);
      break;
    case "gameOver":
      figure(out, sampleRate, [67, 63, 60, 55], 0.26, 0.46, 2);
      tone(out, sampleRate, 70, 40, 0.35, 0.05);
      break;
    case "victory":
      figure(out, sampleRate, [72, 76, 79, 84, 88], 0.2, 0.42, 3);
      break;
  }
  // Normalise to the spec's gain with a little headroom, so nothing clips when two sounds overlap.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 1e-6) {
    const scale = (0.92 * spec.gain) / peak;
    for (let i = 0; i < out.length; i++) out[i]! *= scale;
  }
  return out;
}

/** Rough spectral centroid in Hz, so a test can assert "the cannon is lower than the servo shot". */
export function spectralCentroid(pcm: Float32Array, sampleRate = 48000): number {
  let weighted = 0;
  let total = 0;
  // A cheap DFT over a Hann window: enough bins to compare two sounds, far cheaper than an FFT.
  const bins = 96;
  const window = Math.min(pcm.length, 4096);
  for (let b = 1; b <= bins; b++) {
    const f = (b * sampleRate) / (2 * window);
    let re = 0;
    let im = 0;
    for (let i = 0; i < window; i++) {
      const w = 0.5 - 0.5 * Math.cos((TAU * i) / Math.max(1, window - 1));
      const s = pcm[i]! * w;
      const a = (TAU * f * i) / sampleRate;
      re += s * Math.cos(a);
      im -= s * Math.sin(a);
    }
    const mag = Math.hypot(re, im);
    weighted += f * mag;
    total += mag;
  }
  return total > 1e-9 ? weighted / total : 0;
}

export interface BeaconSoundscapeOptions {
  /** Master level for the game's effects. */
  volume?: number;
  /** Position the listener (the camera) so spatial one-shots pan correctly. */
  spatial?: boolean;
}

/**
 * The browser half: buffers built once from {@link renderBeaconSound}, played through the engine's
 * `AudioSystem`. Every method is safe to call with a suspended, closed or missing context.
 */
export class BeaconSoundscape {
  private readonly buffers = new Map<BeaconSound, AudioBuffer>();
  private readonly lastPlay = new Map<BeaconSound, number>();
  readonly volume: number;
  readonly spatial: boolean;
  private disposed = false;

  constructor(
    private readonly system: AudioSystem,
    private readonly context: BaseAudioContext,
    options: BeaconSoundscapeOptions = {},
  ) {
    this.volume = options.volume ?? 0.8;
    this.spatial = options.spatial ?? true;
  }

  /** The buffer for `name`, rendered and cached on first use. */
  buffer(name: BeaconSound): AudioBuffer | null {
    const cached = this.buffers.get(name);
    if (cached) return cached;
    if (this.disposed || typeof this.context.createBuffer !== "function") return null;
    const sampleRate = this.context.sampleRate > 0 ? this.context.sampleRate : 48000;
    const pcm = renderBeaconSound(name, sampleRate);
    const buffer = this.context.createBuffer(1, pcm.length, sampleRate);
    // `getChannelData().set()` rather than `copyToChannel`: the DOM lib types the latter as
    // Float32Array<ArrayBuffer>, which a plain returned Float32Array is not assignable to.
    buffer.getChannelData(0).set(pcm);
    this.buffers.set(name, buffer);
    return buffer;
  }

  /**
   * Play one effect. `at` positions it in the arena (when spatial); `rate` detunes it, which the scene
   * uses to keep a volley of identical shots from phasing into a buzz.
   */
  play(name: BeaconSound, options: { volume?: number; at?: { x: number; y: number; z: number }; rate?: number } = {}): boolean {
    if (this.disposed || this.context.state === "closed") return false;
    const spec = BEACON_SOUNDS[name];
    const now = this.context.currentTime;
    const last = this.lastPlay.get(name);
    if (last !== undefined && now - last < spec.minInterval) return false;
    const buffer = this.buffer(name);
    if (!buffer) return false;
    this.lastPlay.set(name, now);
    this.system.play(buffer, {
      bus: "sfx",
      volume: (options.volume ?? 1) * this.volume,
      playbackRate: options.rate ?? 1,
      spatial: this.spatial && options.at !== undefined,
      position: options.at,
      maxDistance: 120,
      refDistance: 6,
      rolloffFactor: 0.9,
    });
    return true;
  }

  /** Move the listener (the camera) so the spatial one-shots pan and fall off correctly. */
  setListener(position: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }): void {
    if (this.disposed || this.context.state === "closed") return;
    this.system.setListener({ position, forward, up: { x: 0, y: 1, z: 0 } });
  }

  get sounds(): number {
    return this.buffers.size;
  }

  secondsOfAudio(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.duration;
    return total;
  }

  dispose(): void {
    this.disposed = true;
    this.buffers.clear();
    this.lastPlay.clear();
  }
}
