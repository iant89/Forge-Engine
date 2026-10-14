/**
 * fe-28: a short ORIGINAL disco-style victory jingle, synthesized live with WebAudio.
 *
 * Written for this project (not derived from any existing song): 8 bars of 4/4 at 128 bpm
 * (exactly 15 s, the finale clip), an I–vi–IV–V progression in C with a four-on-the-floor kick,
 * off-beat open hats, an octave-jumping bass, chord stabs on the off-beats of 2 and 4 and a
 * syncopated lead line, closing on a held C major chord.
 *
 * Autoplay rules: browsers only let an AudioContext run after a user gesture, so the context is
 * created/resumed from {@link DiscoJingle.unlock} (wire it to keydown/pointerdown). `play()` is a
 * silent no-op when locked, muted, or when WebAudio is unavailable (Node, old browsers).
 */

export const JINGLE_BPM = 128;
export const JINGLE_BARS = 8;
export const JINGLE_BEAT = 60 / JINGLE_BPM;
export const JINGLE_DURATION = JINGLE_BARS * 4 * JINGLE_BEAT;

export type JingleVoice = "kick" | "hat" | "bass" | "stab" | "lead";

export interface JingleNote {
  /** Start (s from the top). */
  t: number;
  /** Length (s). */
  dur: number;
  voice: JingleVoice;
  /** Hz (0 for unpitched voices). */
  freq: number;
  gain: number;
}

/** MIDI note → Hz. */
export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Chord per bar as MIDI roots/triads: C, Am, F, G, C, Am, F, G→C. */
export const JINGLE_CHORDS: readonly (readonly number[])[] = [
  [60, 64, 67], // C
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [55, 59, 62], // G
  [60, 64, 67],
  [57, 60, 64],
  [53, 57, 60],
  [55, 59, 62],
];

/** Lead rhythm per bar in eighths: chord-tone index (0 root, 1 third, 2 fifth, 3 octave) or −1 rest. */
const LEAD_A = [1, -1, 2, 3, -1, 2, 1, 2];
const LEAD_B = [3, 2, -1, 1, 2, -1, 3, -1];

/** The full score, sorted by time; every note ends by {@link JINGLE_DURATION}. */
export function discoJingleScore(): JingleNote[] {
  const notes: JingleNote[] = [];
  const b = JINGLE_BEAT;
  const e = b / 2;
  for (let bar = 0; bar < JINGLE_BARS; bar++) {
    const t0 = bar * 4 * b;
    const last = bar === JINGLE_BARS - 1;
    const chord = JINGLE_CHORDS[bar]!;
    for (let beat = 0; beat < 4; beat++) {
      const tb = t0 + beat * b;
      // Last two beats resolve to a held C major hit.
      if (last && beat >= 2) break;
      notes.push({ t: tb, dur: 0.22, voice: "kick", freq: 0, gain: 0.9 });
      notes.push({ t: tb + e, dur: 0.12, voice: "hat", freq: 0, gain: 0.25 });
      // Octave bass: root on the beat, root an octave up on the off-beat.
      notes.push({ t: tb, dur: e * 0.9, voice: "bass", freq: midiHz(chord[0]! - 24), gain: 0.5 });
      notes.push({ t: tb + e, dur: e * 0.8, voice: "bass", freq: midiHz(chord[0]! - 12), gain: 0.4 });
      if (beat === 1 || beat === 3) for (const m of chord) notes.push({ t: tb + e, dur: e * 0.7, voice: "stab", freq: midiHz(m), gain: 0.12 });
    }
    const lead = bar % 2 === 0 ? LEAD_A : LEAD_B;
    for (let k = 0; k < (last ? 4 : 8); k++) {
      const idx = lead[k]!;
      if (idx < 0) continue;
      const m = idx === 3 ? chord[0]! + 12 : chord[idx]!;
      notes.push({ t: t0 + k * e, dur: e * 0.85, voice: "lead", freq: midiHz(m + 12), gain: 0.14 });
    }
    if (last) {
      const tEnd = t0 + 2 * b;
      const hold = JINGLE_DURATION - tEnd - 0.02;
      notes.push({ t: tEnd, dur: 0.3, voice: "kick", freq: 0, gain: 1 });
      notes.push({ t: tEnd, dur: hold, voice: "bass", freq: midiHz(36), gain: 0.5 });
      for (const m of [60, 64, 67, 72]) notes.push({ t: tEnd, dur: hold, voice: "stab", freq: midiHz(m), gain: 0.1 });
      notes.push({ t: tEnd, dur: hold, voice: "lead", freq: midiHz(84), gain: 0.12 });
    }
  }
  return notes.sort((a, c) => a.t - c.t);
}

type Ctx = AudioContext;

export interface DiscoJingleOptions {
  muted?: boolean;
  /** Override the context factory (tests); default `new AudioContext()` when available. */
  createContext?: () => Ctx | null;
}

/** Plays {@link discoJingleScore} once per `play()`, honouring mute and the autoplay gate. */
export class DiscoJingle {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private endsAt = 0;
  private _muted: boolean;
  private readonly factory: () => Ctx | null;

  constructor(options: DiscoJingleOptions = {}) {
    this._muted = options.muted ?? false;
    this.factory = options.createContext ?? (() => {
      const C = (globalThis as { AudioContext?: new () => Ctx }).AudioContext;
      return C ? new C() : null;
    });
  }

  /** Call from a user gesture: creates or resumes the context (browsers block it otherwise). */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = this.factory();
      } catch {
        this.ctx = null;
      }
      if (!this.ctx) return;
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : 0.6;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(value: boolean) {
    this._muted = value;
    if (this.master && this.ctx) this.master.gain.setValueAtTime(value ? 0 : 0.6, this.ctx.currentTime);
    if (value) this.stop();
  }

  get playing(): boolean {
    return this.ctx !== null && this.sources.length > 0 && this.ctx.currentTime < this.endsAt;
  }

  /** Start the jingle now. Returns false (and plays nothing) when muted, locked or unavailable. */
  play(): boolean {
    const ctx = this.ctx;
    if (this._muted || !ctx || !this.master || ctx.state !== "running") return false;
    this.stop();
    const t0 = ctx.currentTime + 0.05;
    for (const n of discoJingleScore()) this.voice(ctx, n, t0 + n.t);
    this.endsAt = t0 + JINGLE_DURATION;
    return true;
  }

  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources = [];
    this.endsAt = 0;
  }

  dispose(): void {
    this.stop();
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }

  private envelope(ctx: Ctx, at: number, dur: number, peak: number, attack = 0.005): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, peak * 0.3), at + Math.max(attack * 2, dur * 0.7));
    g.gain.linearRampToValueAtTime(0, at + dur);
    g.connect(this.master!);
    return g;
  }

  private track(node: AudioScheduledSourceNode, at: number, dur: number): void {
    node.start(at);
    node.stop(at + dur + 0.05);
    this.sources.push(node);
    node.onended = () => {
      const i = this.sources.indexOf(node);
      if (i >= 0) this.sources.splice(i, 1);
    };
  }

  private voice(ctx: Ctx, n: JingleNote, at: number): void {
    if (n.voice === "kick") {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(150, at);
      osc.frequency.exponentialRampToValueAtTime(45, at + n.dur * 0.8);
      osc.connect(this.envelope(ctx, at, n.dur, n.gain, 0.002));
      this.track(osc, at, n.dur);
      return;
    }
    if (n.voice === "hat") {
      if (!this.noise) {
        this.noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        let seed = 12345;
        for (let i = 0; i < d.length; i++) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          d[i] = (seed / 0xffffffff) * 2 - 1;
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 7000;
      src.connect(hp);
      hp.connect(this.envelope(ctx, at, n.dur, n.gain, 0.001));
      this.track(src, at, n.dur);
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = n.voice === "bass" ? "sawtooth" : n.voice === "lead" ? "square" : "sawtooth";
    osc.frequency.setValueAtTime(n.freq, at);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = n.voice === "bass" ? 700 : n.voice === "lead" ? 3200 : 2200;
    osc.connect(lp);
    lp.connect(this.envelope(ctx, at, n.dur, n.gain, n.voice === "stab" ? 0.004 : 0.01));
    this.track(osc, at, n.dur);
  }
}
