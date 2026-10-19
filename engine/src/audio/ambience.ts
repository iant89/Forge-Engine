/**
 * Environmental and weather audio (Phase 20.5, 20.6): the world's ambience heard from its simulation
 * state — original WebAudio synthesis, no assets.
 *
 * {@link AmbienceInput} is plain data: the weather (wind speed, direction and gustiness, rain and
 * snowfall rates, storm), what it left on the ground (wetness, puddles, snow cover), the sun's
 * elevation and the air temperature, and where the listener is (facing, underwater, how enclosed,
 * how reflective the surroundings are, how close the surf). `environment/soundInput.ts` builds it
 * from a `WeatherState` and `SurfaceWeatherState`; audio does not import the environment.
 *
 * {@link ambienceLevels} is the pure mapping, unit-tested without an AudioContext:
 *  - **wind** (20.6): roar and gust howl rising with speed and gustiness, panned toward the side the
 *    wind comes from relative to the listener's facing;
 *  - **rain** (20.6): liquid rain only (snowfall is near-silent); brighter and louder on wet ground and
 *    standing water (splashes), duller on snow cover; under a roof it becomes a low drumming instead;
 *  - **snow cover** absorbs: the whole outdoor bed loses its highs and some level;
 *  - **surf** from shore proximity × storm;
 *  - **birds** (20.5): activity from the sun's elevation with a dawn chorus, silenced by rain, wind
 *    and cold;
 *  - **insects** (20.5): crickets at night in warm air, chirping at a rate from the temperature
 *    (Dolbear's law: chirps/min ≈ 7·T°C + 30);
 *  - **listener context**: underwater muffles everything to a low rumble; enclosure low-passes the
 *    outdoor bed and adds roof drumming; reflectivity and enclosure set the reverb
 *    ({@link environmentReverb}).
 * {@link EnvironmentSoundscape} applies it with smoothed ramps; birds are one-shot chirp phrases
 * scheduled stochastically (seeded) around the listener, crickets a pulsed tone. Its `reverb` is an
 * `AudioEffect` to add to a bus rack (e.g. `audio.bus("sfx").add(scape.reverb)`) so impacts and
 * engines ring like the place they are in.
 */

import { ConvolutionReverb } from "./effects.js";

export interface AmbienceInput {
  /** Mean wind speed (m/s). */
  windSpeed: number;
  /** Direction the wind blows toward, radians clockwise from north (+Z): `WeatherState.windDirection`. */
  windDirection: number;
  /** 0..1 gustiness. */
  gust: number;
  /** 0..1 liquid rain rate. */
  rain: number;
  /** 0..1 snowfall rate. */
  snowfall: number;
  /** 0..1 storm intensity. */
  storm: number;
  /** 0..1 ground film wetness. */
  wetness: number;
  /** 0..1 standing water. */
  puddles: number;
  /** 0..1 snow cover. */
  snowCover: number;
  /** Sun elevation (degrees). */
  sunElevationDeg: number;
  /** Air temperature (°C). */
  temperatureC: number;
  /** Listener facing: yaw in radians (0 faces +Z, positive turns toward +X, as `Vehicle.yaw`). */
  listenerYaw: number;
  /** The listener's ears are below the water. */
  underwater: boolean;
  /** 0 open air … 1 fully indoors. */
  enclosure: number;
  /** 0 open field … 1 canyon / city street: how much the surroundings reflect. */
  reflectivity: number;
  /** 0..1 surf at the listener (shore proximity × waves). */
  surf: number;
}

export function createAmbienceInput(overrides: Partial<AmbienceInput> = {}): AmbienceInput {
  return {
    windSpeed: 2, windDirection: 0, gust: 0.2, rain: 0, snowfall: 0, storm: 0, wetness: 0, puddles: 0, snowCover: 0,
    sunElevationDeg: 30, temperatureC: 15, listenerYaw: 0, underwater: false, enclosure: 0, reflectivity: 0.1, surf: 0,
    ...overrides,
  };
}

export interface AmbienceLevels {
  windGain: number;
  windFrequency: number;
  howlGain: number;
  howlFrequency: number;
  /** −1 left … 1 right: the side the wind comes from. */
  windPan: number;
  rainGain: number;
  /** Band-pass centre of the rain hiss (splashes on water are brighter). */
  rainFrequency: number;
  /** Roof drumming (enclosed listener under rain). */
  roofGain: number;
  surfGain: number;
  /** Bird phrases per second. */
  birdRate: number;
  birdGain: number;
  insectGain: number;
  /** Cricket chirps per second (from temperature). */
  insectChirpRate: number;
  /** Low-pass on the outdoor bed (Hz): snow absorption, enclosure, water. */
  outdoorCutoff: number;
  /** Level of the outdoor bed (0..1). */
  outdoorGain: number;
  /** Underwater rumble (0..1). */
  underwaterGain: number;
  reverbDecay: number;
  reverbMix: number;
}

export function createAmbienceLevels(): AmbienceLevels {
  return {
    windGain: 0, windFrequency: 0, howlGain: 0, howlFrequency: 0, windPan: 0, rainGain: 0, rainFrequency: 0, roofGain: 0, surfGain: 0,
    birdRate: 0, birdGain: 0, insectGain: 0, insectChirpRate: 0, outdoorCutoff: 0, outdoorGain: 0, underwaterGain: 0, reverbDecay: 0, reverbMix: 0,
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * Bird activity 0..1 from the sun's elevation: none at night, rising through civil dawn, a chorus
 * peak a few degrees above the horizon, settling to a steady daytime level.
 */
export function birdActivity(sunElevationDeg: number): number {
  const day = smoothstep(-8, 0, sunElevationDeg);
  const chorus = Math.exp(-(((sunElevationDeg - 4) / 6) ** 2));
  return clamp01(day * (0.55 + 0.45 * chorus));
}

/** Cricket chirps per second at `temperatureC` (Dolbear: ≈ (7·T + 30) per minute), 0 below ~8 °C. */
export function cricketChirpRate(temperatureC: number): number {
  if (temperatureC < 8) return 0;
  return (7 * temperatureC + 30) / 60;
}

/** Reverb decay (s) and wet mix for the surroundings: open air is short and dry, a canyon long. */
export function environmentReverb(reflectivity: number, enclosure: number): { decay: number; mix: number } {
  const r = clamp01(reflectivity), e = clamp01(enclosure);
  return { decay: 0.3 + 1.6 * r + 0.8 * e, mix: Math.min(0.5, 0.05 + 0.3 * r + 0.15 * e) };
}

/** Map the environment to ambience voice levels. Pure. */
export function ambienceLevels(input: AmbienceInput, out: AmbienceLevels = createAmbienceLevels()): AmbienceLevels {
  const w = clamp01(input.windSpeed / 70);
  const g = clamp01(input.gust);
  const enclosed = clamp01(input.enclosure);
  const snowCover = clamp01(input.snowCover);
  const rain = clamp01(input.rain);

  out.windGain = Math.min(1, 0.04 + 0.85 * Math.pow(w, 1.3) * (0.8 + 0.4 * g));
  out.windFrequency = 180 + 900 * w + 300 * g;
  out.howlGain = Math.min(0.5, 0.45 * w * w * (0.3 + 0.7 * g));
  out.howlFrequency = 420 + 900 * w + 500 * g;
  // The wind comes FROM −(sin d, cos d); the listener's right is (cos yaw, −sin yaw) in XZ.
  const fromX = -Math.sin(input.windDirection), fromZ = -Math.cos(input.windDirection);
  out.windPan = Math.max(-1, Math.min(1, fromX * Math.cos(input.listenerYaw) - fromZ * Math.sin(input.listenerYaw))) * 0.7;

  // Rain: water on the ground splashes brighter; snow cover swallows the highs.
  const splash = clamp01(0.5 * input.wetness + input.puddles);
  out.rainGain = Math.min(0.8, rain * (0.55 + 0.25 * splash) * (1 - 0.5 * snowCover)) * (1 - 0.7 * enclosed);
  out.rainFrequency = (2200 + 1800 * splash) * (1 - 0.4 * snowCover);
  out.roofGain = Math.min(0.7, rain * 0.7 * enclosed);
  out.surfGain = Math.min(0.8, clamp01(input.surf) * (0.3 + 0.5 * clamp01(input.storm)));

  // Life: birds by day (not in rain, gales or frost), crickets on warm nights.
  const calm = (1 - smoothstep(0.1, 0.5, rain)) * (1 - smoothstep(8, 18, input.windSpeed));
  const birdsLive = birdActivity(input.sunElevationDeg) * calm * smoothstep(-5, 3, input.temperatureC);
  out.birdRate = 1.2 * birdsLive;
  out.birdGain = 0.35 * birdsLive;
  const night = 1 - smoothstep(-6, 2, input.sunElevationDeg);
  const chirps = cricketChirpRate(input.temperatureC);
  out.insectChirpRate = chirps;
  out.insectGain = chirps > 0 ? 0.12 * night * calm * smoothstep(8, 16, input.temperatureC) : 0;

  // What the listener's surroundings do to the whole outdoor bed.
  let cutoff = 18_000 * (1 - 0.65 * snowCover) * (1 - 0.95 * enclosed);
  let gain = (1 - 0.3 * snowCover) * (1 - 0.6 * enclosed);
  out.underwaterGain = 0;
  if (input.underwater) {
    cutoff = 350;
    gain *= 0.35;
    out.underwaterGain = 0.4;
    out.birdGain = 0;
    out.insectGain = 0;
    out.roofGain = 0;
  }
  out.outdoorCutoff = Math.max(200, cutoff);
  out.outdoorGain = gain;
  const reverb = environmentReverb(input.reflectivity, enclosed);
  out.reverbDecay = reverb.decay;
  out.reverbMix = input.underwater ? 0.5 : reverb.mix;
  return out;
}

/** A procedural impulse response: decaying stereo noise with a short pre-delay. Deterministic per seed. */
export function createReverbImpulse(context: BaseAudioContext, decay: number, seed = 0x2e7e7b): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * Math.max(0.05, decay)));
  const buffer = context.createBuffer(2, length, rate);
  let s = seed >>> 0 || 1;
  const pre = Math.floor(rate * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const white = ((s >>> 0) / 4294967296) * 2 - 1;
      // −60 dB at `decay`: exp(−6.9 t / decay).
      data[i] = i < pre ? 0 : white * Math.exp((-6.9 * (i - pre)) / (rate * decay));
    }
  }
  return buffer;
}

export interface EnvironmentSoundscapeOptions {
  volume?: number;
  /** Parameter smoothing (s). Default 0.4 — weather changes slowly. */
  smoothing?: number;
  seed?: number;
  /** Reverb decays are quantised to this step (s) so the impulse is rebuilt rarely. Default 0.25. */
  reverbStep?: number;
}

type Voice = { gain: GainNode; filter: BiquadFilterNode };

/**
 * The ambience graph: an outdoor bed (wind roar + howl through a stereo panner, rain, surf, birds,
 * insects) behind one low-pass and gain — what snow, walls and water do to the outside — plus roof
 * drumming and an underwater rumble that bypass it. Birds are chirp phrases at random points around
 * the listener; crickets an amplitude-pulsed tone whose pulse rate is the chirp rate.
 */
export class EnvironmentSoundscape {
  readonly context: BaseAudioContext;
  readonly output: GainNode;
  readonly levels: AmbienceLevels = createAmbienceLevels();
  /** Add to a bus rack so other sounds take on the place's reverb. */
  readonly reverb: ConvolutionReverb;
  /** Bird phrases played since construction. */
  birdsPlayed = 0;
  private readonly options: EnvironmentSoundscapeOptions;
  private readonly noise: AudioBuffer;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly outdoor: { gain: GainNode; filter: BiquadFilterNode };
  private readonly wind: Voice;
  private readonly howl: Voice;
  private readonly windPanner: StereoPannerNode;
  private readonly rain: Voice;
  private readonly roof: Voice;
  private readonly surf: Voice;
  private readonly underwater: Voice;
  private readonly birdBus: GainNode;
  private readonly insectGain: GainNode;
  private readonly insectPulse: OscillatorNode;
  private reverbDecay = -1;
  private birdDebt = 0;
  private rng: number;
  private disposed = false;

  constructor(context: BaseAudioContext, destination: AudioNode = context.destination, options: EnvironmentSoundscapeOptions = {}) {
    this.context = context;
    this.options = options;
    this.rng = (options.seed ?? 0xa7b1e) >>> 0 || 1;
    this.output = context.createGain();
    this.output.gain.value = options.volume ?? 0.6;
    this.output.connect(destination);
    this.reverb = new ConvolutionReverb(context, undefined, 0.1);

    this.noise = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * 3)), context.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = this.random() * 2 - 1;

    const outdoorFilter = context.createBiquadFilter();
    outdoorFilter.type = "lowpass";
    outdoorFilter.frequency.value = 18_000;
    const outdoorGain = context.createGain();
    outdoorFilter.connect(outdoorGain).connect(this.output);
    this.outdoor = { gain: outdoorGain, filter: outdoorFilter };

    let offset = 0;
    const voice = (type: BiquadFilterType, frequency: number, q: number, into: AudioNode): Voice => {
      const src = context.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = context.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(into);
      src.start(0, (offset += 0.37));
      this.sources.push(src);
      return { gain, filter };
    };
    this.windPanner = context.createStereoPanner();
    this.windPanner.connect(outdoorFilter);
    this.wind = voice("bandpass", 400, 0.6, this.windPanner);
    this.howl = voice("bandpass", 700, 9, this.windPanner);
    this.rain = voice("bandpass", 2500, 0.6, outdoorFilter);
    this.surf = voice("lowpass", 260, 0.7, outdoorFilter);
    this.roof = voice("lowpass", 180, 1.5, this.output);
    this.underwater = voice("lowpass", 120, 1, this.output);

    this.birdBus = context.createGain();
    this.birdBus.connect(outdoorFilter);

    // Crickets: a 4.6 kHz tone gated by a square pulse at the chirp rate.
    const tone = context.createOscillator();
    tone.type = "sine";
    tone.frequency.value = 4600;
    const gate = context.createGain();
    gate.gain.value = 0;
    this.insectPulse = context.createOscillator();
    this.insectPulse.type = "square";
    this.insectPulse.frequency.value = 1;
    const depth = context.createGain();
    depth.gain.value = 0.5;
    this.insectPulse.connect(depth).connect(gate.gain);
    this.insectGain = context.createGain();
    this.insectGain.gain.value = 0;
    tone.connect(gate).connect(this.insectGain).connect(outdoorFilter);
    tone.start();
    this.insectPulse.start();
    this.sources.push(tone, this.insectPulse);
  }

  /** Apply one frame of the environment (`dt` paces the bird phrases). Returns the levels. */
  update(input: AmbienceInput, dt: number): AmbienceLevels {
    if (this.disposed) return this.levels;
    const l = ambienceLevels(input, this.levels);
    const t = this.context.currentTime;
    const k = this.options.smoothing ?? 0.4;
    this.wind.gain.gain.setTargetAtTime(l.windGain, t, k);
    this.wind.filter.frequency.setTargetAtTime(l.windFrequency, t, k);
    this.howl.gain.gain.setTargetAtTime(l.howlGain, t, k);
    this.howl.filter.frequency.setTargetAtTime(l.howlFrequency, t, k);
    this.windPanner.pan.setTargetAtTime(l.windPan, t, k);
    this.rain.gain.gain.setTargetAtTime(l.rainGain, t, k);
    this.rain.filter.frequency.setTargetAtTime(l.rainFrequency, t, k);
    this.roof.gain.gain.setTargetAtTime(l.roofGain, t, k);
    this.surf.gain.gain.setTargetAtTime(l.surfGain, t, k * 3);
    this.underwater.gain.gain.setTargetAtTime(l.underwaterGain, t, 0.1);
    this.outdoor.filter.frequency.setTargetAtTime(l.outdoorCutoff, t, input.underwater ? 0.05 : k);
    this.outdoor.gain.gain.setTargetAtTime(l.outdoorGain, t, input.underwater ? 0.05 : k);
    this.insectGain.gain.setTargetAtTime(l.insectGain, t, k);
    this.insectPulse.frequency.setTargetAtTime(Math.max(0.1, l.insectChirpRate), t, k);
    this.updateReverb(l);
    // Birds: phrases at `birdRate` per second on average; each waits a random fraction of a phrase
    // interval, so a steady rate does not tick like a metronome.
    this.birdDebt += l.birdRate * Math.max(0, Math.min(1, dt));
    while (this.birdDebt >= 1) {
      this.birdDebt -= 0.5 + this.random();
      this.birdPhrase(l.birdGain);
    }
    return l;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sources) {
      s.stop();
      s.disconnect();
    }
    this.reverb.dispose();
    this.output.disconnect();
  }

  private updateReverb(l: AmbienceLevels): void {
    const step = this.options.reverbStep ?? 0.25;
    const decay = Math.max(step, Math.round(l.reverbDecay / step) * step);
    if (decay !== this.reverbDecay) {
      this.reverbDecay = decay;
      this.reverb.setImpulse(createReverbImpulse(this.context, decay));
    }
    this.reverb.setMix(l.reverbMix);
  }

  private random(): number {
    let s = this.rng;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rng = s >>> 0 || 1;
    return this.rng / 4294967296;
  }

  /** 2–5 quick frequency-swept notes from one bird, panned somewhere around the listener. */
  private birdPhrase(level: number): void {
    if (level <= 0) return;
    const ctx = this.context;
    const notes = 2 + Math.floor(this.random() * 4);
    const base = 2600 + this.random() * 2400;
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.random() * 1.6 - 0.8;
    const bus = ctx.createGain();
    bus.gain.value = level * (0.4 + 0.6 * this.random());
    bus.connect(pan).connect(this.birdBus);
    let t = ctx.currentTime + this.random() * 0.2;
    let pending = notes;
    for (let i = 0; i < notes; i++) {
      const dur = 0.05 + this.random() * 0.08;
      const o = ctx.createOscillator();
      o.type = "sine";
      const f0 = base * (0.85 + 0.3 * this.random());
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (0.7 + 0.8 * this.random()), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(1e-4, t);
      g.gain.exponentialRampToValueAtTime(1, t + dur * 0.2);
      g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
      o.connect(g).connect(bus);
      o.onended = () => {
        g.disconnect();
        if (--pending === 0) {
          bus.disconnect();
          pan.disconnect();
        }
      };
      o.start(t);
      o.stop(t + dur + 0.01);
      t += dur + 0.03 + this.random() * 0.06;
    }
    this.birdsPlayed++;
  }
}
