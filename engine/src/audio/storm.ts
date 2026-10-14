/**
 * Storm soundscape (fe-34): original WebAudio synthesis of wind, rain, surf and thunder — no assets.
 *
 * Every voice is filtered noise from one shared seeded buffer:
 *  - wind: a band-pass roar whose centre rises with speed, plus a resonant "howl" band that whistles
 *    in gusts;
 *  - rain: high-passed hiss scaled by rain rate;
 *  - surf: low-passed rumble, swelling slowly like breaking sets;
 *  - thunder: `createThunderBuffer` cracks, delayed by distance (≈ 3 s/km).
 * {@link stormSoundLevels} is the pure mapping from the storm state to gains and frequencies
 * (unit-tested); {@link StormSoundscape} applies it with smoothed parameter ramps. Browsers only
 * start audio after a user gesture, so the host creates the context from a click.
 */

import { createThunderBuffer } from "./procedural.js";

export interface StormSoundInput {
  /** Wind speed (m/s) including gusts. */
  windSpeed: number;
  /** 0..1 gust strength. */
  gust: number;
  /** 0..1 rain intensity. */
  rain: number;
  /** 0..1 surf (wave energy at the shore). */
  surf: number;
}

export interface StormSoundLevels {
  windGain: number;
  windFrequency: number;
  howlGain: number;
  howlFrequency: number;
  rainGain: number;
  surfGain: number;
}

/** Map the storm state to voice gains (0..1) and filter frequencies (Hz). Pure. */
export function stormSoundLevels(input: StormSoundInput): StormSoundLevels {
  const w = Math.max(0, Math.min(1, input.windSpeed / 70));
  const g = Math.max(0, Math.min(1, input.gust));
  return {
    windGain: Math.min(1, 0.04 + 0.85 * Math.pow(w, 1.3) * (0.8 + 0.4 * g)),
    windFrequency: 180 + 900 * w + 300 * g,
    howlGain: Math.min(0.5, 0.45 * Math.pow(w, 2) * (0.3 + 0.7 * g)),
    howlFrequency: 420 + 900 * w + 500 * g,
    rainGain: Math.min(0.8, 0.75 * Math.max(0, Math.min(1, input.rain))),
    surfGain: Math.min(0.8, 0.12 + 0.6 * Math.max(0, Math.min(1, input.surf))),
  };
}

export class StormSoundscape {
  readonly context: AudioContext;
  readonly output: GainNode;
  private readonly wind: { gain: GainNode; filter: BiquadFilterNode };
  private readonly howl: { gain: GainNode; filter: BiquadFilterNode };
  private readonly rain: GainNode;
  private readonly surf: GainNode;
  private readonly surfLfo: OscillatorNode;
  private readonly sources: AudioBufferSourceNode[] = [];
  private thunderSeed = 1;

  constructor(context: AudioContext, destination: AudioNode = context.destination, volume = 0.7) {
    this.context = context;
    this.output = context.createGain();
    this.output.gain.value = volume;
    this.output.connect(destination);
    const noise = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    const data = noise.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }
    const voice = (type: BiquadFilterType, frequency: number, q: number, offset: number): { gain: GainNode; filter: BiquadFilterNode } => {
      const src = context.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = context.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.output);
      src.start(0, offset);
      this.sources.push(src);
      return { gain, filter };
    };
    this.wind = voice("bandpass", 400, 0.6, 0);
    this.howl = voice("bandpass", 700, 9, 1.1);
    this.rain = voice("highpass", 2500, 0.5, 2.3).gain;
    const surf = voice("lowpass", 260, 0.7, 3.1);
    this.surf = surf.gain;
    // Slow swell on the surf gain (sets breaking every ~9 s).
    this.surfLfo = context.createOscillator();
    this.surfLfo.frequency.value = 0.11;
    const depth = context.createGain();
    depth.gain.value = 0.25;
    this.surfLfo.connect(depth).connect(this.surf.gain);
    this.surfLfo.start();
  }

  /** Update the voices toward the storm state (smoothed over ~0.25 s). */
  set(input: StormSoundInput): void {
    const l = stormSoundLevels(input);
    const t = this.context.currentTime;
    const k = 0.25;
    this.wind.gain.gain.setTargetAtTime(l.windGain, t, k);
    this.wind.filter.frequency.setTargetAtTime(l.windFrequency, t, k);
    this.howl.gain.gain.setTargetAtTime(l.howlGain, t, k);
    this.howl.filter.frequency.setTargetAtTime(l.howlFrequency, t, k);
    this.rain.gain.setTargetAtTime(l.rainGain, t, k);
    this.surf.gain.setTargetAtTime(l.surfGain, t, k * 4);
  }

  /** A thunder clap `distance` metres away (delayed ≈ 3 s/km, quieter and duller far off). */
  thunder(distance: number, energy = 1): void {
    const ctx = this.context;
    const buffer = createThunderBuffer(ctx, { seed: this.thunderSeed++, energy, duration: 3 + Math.min(4, distance / 1500) });
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.max(300, 6000 - distance * 1.5);
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, 2.2 / (1 + distance / 600)) * energy;
    src.connect(lp).connect(gain).connect(this.output);
    src.start(ctx.currentTime + distance / 343);
  }

  /** Stop every voice (the context stays with the host). */
  dispose(): void {
    for (const s of this.sources) s.stop();
    this.surfLfo.stop();
    this.output.disconnect();
  }
}
