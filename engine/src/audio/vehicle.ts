/**
 * Vehicle audio (Phase 20.7): engine, gearbox, tyre, suspension and terrain sound driven by the
 * vehicle simulation — original WebAudio synthesis, no assets and no scripted cues.
 *
 * Three layers, each usable on its own:
 *  - {@link VehicleSoundAnalyzer} reads a `Vehicle` after it stepped and fills a
 *    {@link VehicleSoundState}: engine RPM (and its idle→redline fraction), throttle, **load** (the
 *    torque the driven tyres put on the road as a fraction of peak engine torque — high pulling up
 *    a hill, zero revving in neutral or with the clutch open), overrun, gear and the open clutch,
 *    per-wheel tyre slip (combined slip relative to the Pacejka peak, so a tyre squeals where it
 *    actually saturates) and sliding speed, the terrain under each wheel, and one-shot events: gear
 *    shifts, suspension impacts, bottoming out and landings. It only *reads* the vehicle, so a
 *    simulation hashes identically with or without audio attached.
 *  - {@link vehicleSoundLevels} is the pure mapping from that state to voice gains (0..1) and
 *    frequencies (Hz), unit-tested without an AudioContext.
 *  - {@link VehicleSoundscape} applies the levels to a fixed voice graph with smoothed ramps and
 *    plays the events as one-shots. {@link VehicleAudio} wires the three to one vehicle.
 *
 * Terrain is a classifier `(x, z) => VehicleSoundSurface` with the same shape as
 * `TireTrackLayer.followVehicle`'s, so a scene that already says what the ground is for tyre tracks
 * reuses it; {@link VEHICLE_SURFACE_SOUND} is the acoustic profile of each surface. Audio runs
 * per presented frame, not per fixed step, and is not part of the deterministic simulation.
 */

import { pacejkaPeakSlip } from "../vehicles/pacejka.js";
import type { Vehicle } from "../vehicles/vehicle.js";

export type VehicleSoundSurface = "asphalt" | "gravel" | "dirt" | "grass" | "mud" | "snow" | "sand" | "water";

export const VEHICLE_SOUND_SURFACES: readonly VehicleSoundSurface[] = Object.freeze(["asphalt", "gravel", "dirt", "grass", "mud", "snow", "sand", "water"]);

/** How a surface sounds under a rolling tyre. Gains are relative (0..1+), frequencies in Hz. */
export interface SurfaceSoundProfile {
  /** Broadband tyre roar from rolling. */
  roar: number;
  /** Low-pass cutoff of the roar at 0 speed; it opens with speed. */
  roarCutoff: number;
  /** Stones/crust breaking under the tread (gravel, snow, sand). */
  crunch: number;
  crunchFrequency: number;
  /** Wet low slosh (mud, standing water). */
  slosh: number;
  /** How much a saturated tyre squeals here (rubber on asphalt squeals; on gravel it scrabbles). */
  squeal: number;
}

export const VEHICLE_SURFACE_SOUND: Readonly<Record<VehicleSoundSurface, Readonly<SurfaceSoundProfile>>> = Object.freeze({
  asphalt: { roar: 1, roarCutoff: 900, crunch: 0, crunchFrequency: 3000, slosh: 0, squeal: 1 },
  gravel: { roar: 0.6, roarCutoff: 600, crunch: 1, crunchFrequency: 3200, slosh: 0, squeal: 0.15 },
  dirt: { roar: 0.55, roarCutoff: 450, crunch: 0.35, crunchFrequency: 1800, slosh: 0, squeal: 0.1 },
  grass: { roar: 0.35, roarCutoff: 350, crunch: 0.15, crunchFrequency: 1400, slosh: 0, squeal: 0.05 },
  mud: { roar: 0.3, roarCutoff: 300, crunch: 0.05, crunchFrequency: 900, slosh: 1, squeal: 0.02 },
  snow: { roar: 0.35, roarCutoff: 500, crunch: 0.7, crunchFrequency: 1300, slosh: 0, squeal: 0.2 },
  sand: { roar: 0.45, roarCutoff: 500, crunch: 0.5, crunchFrequency: 2200, slosh: 0, squeal: 0.05 },
  water: { roar: 0.2, roarCutoff: 300, crunch: 0, crunchFrequency: 1000, slosh: 1, squeal: 0 },
});

export type VehicleSurfaceClassifier = (x: number, z: number) => VehicleSoundSurface;

export interface VehicleSoundWheel {
  inContact: boolean;
  surface: VehicleSoundSurface;
  /** 0..1: how far past the grip peak the tyre is, scaled by its share of the load. */
  slip: number;
  /** Contact-patch sliding speed (m/s): longitudinal spin/lock plus lateral scrub. */
  slideSpeed: number;
  /** Suspension compression speed over the last frame (m/s, positive = compressing). */
  compressionRate: number;
}

export interface VehicleSoundState {
  powertrain: "combustion" | "electric";
  rpm: number;
  /** 0 at idle (or rest for a motor), 1 at the redline. */
  rpmNorm: number;
  throttle: number;
  /** 0..1 torque the driven tyres transmit, as a fraction of peak engine torque. */
  load: number;
  /** 0..1 lift-off in gear above idle (the engine is being driven by the wheels). */
  overrun: number;
  gear: number;
  /** The clutch is open for a shift (no torque path). */
  shifting: boolean;
  /** Chassis ground speed (m/s). */
  speed: number;
  airborne: boolean;
  /** Largest per-wheel slip (0..1). */
  slip: number;
  /** Largest per-wheel sliding speed (m/s). */
  slideSpeed: number;
  /** Fraction of the wheels in contact on each surface (sums to the contact fraction, 0 airborne). */
  surface: Record<VehicleSoundSurface, number>;
  wheels: VehicleSoundWheel[];
}

export type VehicleSoundEventKind = "shift" | "impact" | "bottomOut" | "landing";

export interface VehicleSoundEvent {
  kind: VehicleSoundEventKind;
  /** Wheel index, or -1 for a shift. */
  wheel: number;
  /** 0..1 loudness. */
  strength: number;
  surface: VehicleSoundSurface;
  /** Gears either side of a shift (0 otherwise). */
  from: number;
  to: number;
}

export interface VehicleSoundAnalyzerOptions {
  /** Terrain under a contact point. Default: everything is asphalt. */
  surfaceAt?: VehicleSurfaceClassifier;
  /** Override the powertrain detection (an `ElectricMotor` — no idle, a regen torque — is electric). */
  powertrain?: "combustion" | "electric";
  /** Suspension compression speed (m/s) that counts as an impact. Default 0.9. */
  impactRate?: number;
  /** Airborne time (s) before touching down counts as a landing. Default 0.18. */
  landingAirtime?: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function emptySurfaceWeights(): Record<VehicleSoundSurface, number> {
  return { asphalt: 0, gravel: 0, dirt: 0, grass: 0, mud: 0, snow: 0, sand: 0, water: 0 };
}

/**
 * Reads a vehicle into a {@link VehicleSoundState} and collects one-shot events. Call
 * {@link update} once per presented frame after the vehicle stepped; it allocates nothing on a
 * frame without events.
 */
export class VehicleSoundAnalyzer {
  readonly state: VehicleSoundState;
  /** Events detected by the last `update` (cleared at the start of each one). */
  readonly events: VehicleSoundEvent[] = [];
  surfaceAt: VehicleSurfaceClassifier;
  private readonly impactRate: number;
  private readonly landingAirtime: number;
  private readonly kappaPeak: number;
  private readonly tanAlphaPeak: number;
  private readonly staticLoad: number;
  private readonly prevCompression: number[];
  private readonly armed: boolean[];
  private readonly airtime: number[];
  private prevGear: number;
  private prevShiftCount: number;
  private prevVy = 0;
  private started = false;

  constructor(readonly vehicle: Vehicle, options: VehicleSoundAnalyzerOptions = {}) {
    const c = vehicle.config;
    this.surfaceAt = options.surfaceAt ?? (() => "asphalt");
    this.impactRate = options.impactRate ?? 0.9;
    this.landingAirtime = options.landingAirtime ?? 0.18;
    this.kappaPeak = pacejkaPeakSlip(c.longitudinal);
    this.tanAlphaPeak = Math.tan(pacejkaPeakSlip(c.lateral));
    this.staticLoad = (c.mass * c.gravity) / Math.max(1, vehicle.wheels.length);
    const electric = options.powertrain
      ? options.powertrain === "electric"
      : c.engine.idleRpm <= 0 && typeof (c.engine as { regenTorque?: unknown }).regenTorque === "number";
    const n = vehicle.wheels.length;
    this.prevCompression = new Array<number>(n).fill(0);
    this.armed = new Array<boolean>(n).fill(true);
    this.airtime = new Array<number>(n).fill(0);
    this.prevGear = vehicle.gear;
    this.prevShiftCount = c.transmission.shiftCount;
    this.state = {
      powertrain: electric ? "electric" : "combustion",
      rpm: 0,
      rpmNorm: 0,
      throttle: 0,
      load: 0,
      overrun: 0,
      gear: vehicle.gear,
      shifting: false,
      speed: 0,
      airborne: false,
      slip: 0,
      slideSpeed: 0,
      surface: emptySurfaceWeights(),
      wheels: vehicle.wheels.map(() => ({ inContact: false, surface: "asphalt" as VehicleSoundSurface, slip: 0, slideSpeed: 0, compressionRate: 0 })),
    };
  }

  update(dt: number): VehicleSoundState {
    const v = this.vehicle;
    const c = v.config;
    const s = this.state;
    const tr = c.transmission;
    const eng = c.engine;
    this.events.length = 0;
    const frame = dt > 1e-6 ? dt : 1 / 60;

    s.rpm = v.rpm;
    s.rpmNorm = clamp01((v.rpm - eng.idleRpm) / Math.max(1, eng.redlineRpm - eng.idleRpm));
    s.throttle = clamp01(v.input.throttle);
    s.gear = v.gear;
    s.shifting = tr.shifting;
    s.speed = v.speed;
    s.airborne = v.airborne;

    const ratio = tr.ratio;
    let transmitted = 0;
    const weights = s.surface;
    for (const k of VEHICLE_SOUND_SURFACES) weights[k] = 0;
    let maxSlip = 0;
    let maxSlide = 0;
    const n = v.wheels.length;
    for (let i = 0; i < n; i++) {
      const w = v.wheels[i]!;
      const out = s.wheels[i]!;
      const contact = w.inContact && !w.disabled;
      out.inContact = contact;
      out.compressionRate = this.started ? (w.compression - this.prevCompression[i]!) / frame : 0;
      // The last substep's rate catches a hit a frame-long difference averages away.
      if (Math.abs(w.compressionRate) > Math.abs(out.compressionRate)) out.compressionRate = w.compressionRate;
      if (!contact) {
        out.slip = 0;
        out.slideSpeed = 0;
        this.airtime[i] = this.airtime[i]! + frame;
        this.prevCompression[i] = w.compression;
        continue;
      }
      out.surface = this.surfaceAt(w.contactX, w.contactZ);
      weights[out.surface] += 1 / n;
      if (w.driven) transmitted += w.longForce * c.wheelRadius;
      const heading = v.yaw + w.steerAngle;
      const vLong = v.velocity.x * Math.sin(heading) + v.velocity.z * Math.cos(heading);
      const ref = Math.max(Math.abs(vLong), c.slipReference);
      const tanA = Math.tan(w.alpha);
      out.slideSpeed = ref * Math.hypot(w.kappa, tanA);
      const combined = Math.hypot(w.kappa / this.kappaPeak, tanA / this.tanAlphaPeak);
      const loadShare = Math.min(1.5, w.normalLoad / this.staticLoad);
      // Grip is still rising below ~0.7 of the peak: no squeal until the tread starts to let go.
      out.slip = clamp01(((combined - 0.7) / 1.3) * loadShare) * clamp01(out.slideSpeed / 0.6);
      if (out.slip > maxSlip) maxSlip = out.slip;
      if (out.slideSpeed > maxSlide) maxSlide = out.slideSpeed;
      this.detectSuspension(i, w.compression, out, frame);
      this.airtime[i] = 0;
      this.prevCompression[i] = w.compression;
    }
    s.slip = maxSlip;
    s.slideSpeed = maxSlide;
    // Tyre force on the driven wheels includes braking and scrub; the engine can only be loaded
    // by as much torque as it is delivering, so a slide at closed throttle is not "load".
    const crank = transmitted / (Math.abs(ratio) * c.efficiency);
    s.load = ratio !== 0 ? clamp01(Math.min(crank, eng.deliveredTorque(0)) / Math.max(1e-6, eng.peakTorque)) : 0;
    s.overrun = ratio !== 0 && s.throttle < 0.05 && s.powertrain === "combustion" ? clamp01((v.rpm - eng.idleRpm * 1.2) / Math.max(1, eng.redlineRpm - eng.idleRpm)) : 0;

    if (this.started && (tr.shiftCount !== this.prevShiftCount || v.gear !== this.prevGear)) {
      this.events.push({ kind: "shift", wheel: -1, strength: 0.4 + 0.6 * s.throttle, surface: "asphalt", from: this.prevGear, to: v.gear });
    }
    this.prevGear = v.gear;
    this.prevShiftCount = tr.shiftCount;
    this.prevVy = v.velocity.y;
    this.started = true;
    return s;
  }

  private detectSuspension(i: number, compression: number, out: VehicleSoundWheel, frame: number): void {
    const c = this.vehicle.config;
    const rate = out.compressionRate;
    const air = this.airtime[i]!;
    if (this.started && air >= this.landingAirtime) {
      // Touching down: the faster the fall (or the harder the spring hit), the louder.
      const fall = Math.max(Math.max(0, -this.prevVy), rate);
      this.events.push({ kind: "landing", wheel: i, strength: clamp01(fall / 6), surface: out.surface, from: 0, to: 0 });
      this.armed[i] = false;
      return;
    }
    if (this.started && compression >= c.suspensionTravel * 0.98 && this.prevCompression[i]! < c.suspensionTravel * 0.98 && rate > 0.3) {
      this.events.push({ kind: "bottomOut", wheel: i, strength: clamp01(rate / 3), surface: out.surface, from: 0, to: 0 });
      this.armed[i] = false;
      return;
    }
    if (this.armed[i] && this.started && air < frame * 0.5 + 1e-9 && rate >= this.impactRate) {
      this.events.push({ kind: "impact", wheel: i, strength: clamp01((rate - this.impactRate * 0.5) / 3), surface: out.surface, from: 0, to: 0 });
      this.armed[i] = false;
    } else if (rate < this.impactRate * 0.4) {
      this.armed[i] = true;
    }
  }
}

export interface VehicleSoundLevels {
  /** Firing frequency (Hz): rpm / 60 × cylinders / 2. */
  engineFrequency: number;
  engineGain: number;
  /** Low-pass cutoff on the engine harmonics: load and revs open it up. */
  engineBrightness: number;
  /** Combustion grit (noise) under load. */
  engineRoughness: number;
  intakeGain: number;
  intakeFrequency: number;
  /** Lift-off burble. */
  overrunGain: number;
  /** Electric-motor whine, or reverse-gear whine for a combustion car. */
  whineFrequency: number;
  whineGain: number;
  roarGain: number;
  roarCutoff: number;
  crunchGain: number;
  crunchFrequency: number;
  sloshGain: number;
  squealGain: number;
  squealFrequency: number;
  windGain: number;
}

export interface VehicleSoundLevelOptions {
  /** Cylinder count of a four-stroke engine (sets the firing order frequency). Default 4. */
  cylinders?: number;
  /** Electric motor whine: Hz per motor rev/s (pole pairs × slot harmonics). Default 14. */
  whineOrder?: number;
}

export function createVehicleSoundLevels(): VehicleSoundLevels {
  return {
    engineFrequency: 0, engineGain: 0, engineBrightness: 0, engineRoughness: 0, intakeGain: 0, intakeFrequency: 0, overrunGain: 0,
    whineFrequency: 0, whineGain: 0, roarGain: 0, roarCutoff: 0, crunchGain: 0, crunchFrequency: 0, sloshGain: 0, squealGain: 0, squealFrequency: 0, windGain: 0,
  };
}

/** Map a vehicle sound state to voice gains (0..1) and frequencies (Hz). Pure. */
export function vehicleSoundLevels(state: VehicleSoundState, options: VehicleSoundLevelOptions = {}, out: VehicleSoundLevels = createVehicleSoundLevels()): VehicleSoundLevels {
  const cylinders = Math.max(1, options.cylinders ?? 4);
  const rps = Math.max(0, state.rpm) / 60;
  const throttle = clamp01(state.throttle);
  const load = clamp01(state.load);
  const r = clamp01(state.rpmNorm);
  const clutch = state.shifting ? 0.55 : 1;
  if (state.powertrain === "electric") {
    out.engineFrequency = 0;
    out.engineGain = 0;
    out.engineBrightness = 0;
    out.engineRoughness = 0;
    out.intakeGain = 0;
    out.intakeFrequency = 0;
    out.overrunGain = 0;
    out.whineFrequency = rps * (options.whineOrder ?? 14);
    out.whineGain = rps > 0.5 ? Math.min(0.6, (0.06 + 0.3 * load + 0.08 * throttle) * (0.4 + 0.6 * r)) : 0;
  } else {
    out.engineFrequency = (rps * cylinders) / 2;
    out.engineGain = Math.min(1, 0.18 + 0.32 * throttle + 0.38 * load + 0.12 * r) * clutch;
    out.engineBrightness = 250 + 1800 * load + 900 * throttle + 2200 * r;
    out.engineRoughness = Math.min(0.5, 0.03 + 0.3 * load * throttle) * clutch;
    out.intakeGain = throttle * (0.05 + 0.25 * r);
    out.intakeFrequency = 300 + 1600 * r;
    out.overrunGain = 0.3 * clamp01(state.overrun);
    out.whineFrequency = rps * 9;
    out.whineGain = state.gear < 0 ? Math.min(0.15, 0.03 * state.speed) : 0;
  }

  // Ground: each surface contributes by the share of wheels on it.
  const v = Math.min(1, Math.max(0, state.speed) / 30);
  let contact = 0, roar = 0, cutoff = 0, crunch = 0, crunchF = 0, slosh = 0;
  for (const k of VEHICLE_SOUND_SURFACES) {
    const w = state.surface[k];
    if (!(w > 0)) continue;
    const p = VEHICLE_SURFACE_SOUND[k];
    contact += w;
    roar += w * p.roar;
    cutoff += w * p.roarCutoff;
    crunch += w * p.crunch;
    crunchF += w * p.crunchFrequency;
    slosh += w * p.slosh;
  }
  const slip = clamp01(state.slip);
  out.roarGain = Math.min(0.8, 0.5 * roar * Math.pow(v, 1.2));
  out.roarCutoff = contact > 0 ? (cutoff / contact) * (0.6 + 0.8 * v) : 400;
  out.crunchGain = Math.min(0.8, crunch * (0.6 * Math.pow(v, 0.7) + 0.5 * slip));
  out.crunchFrequency = contact > 0 ? crunchF / contact : 2000;
  out.sloshGain = Math.min(0.8, slosh * (0.5 * Math.pow(v, 0.6) + 0.4 * slip));

  // Squeal belongs to the wheel that slides, on the surface under it.
  let squeal = 0;
  for (const w of state.wheels) {
    if (!w.inContact) continue;
    const s = w.slip * VEHICLE_SURFACE_SOUND[w.surface].squeal;
    if (s > squeal) squeal = s;
  }
  out.squealGain = Math.min(0.8, 0.8 * Math.pow(squeal, 1.5));
  out.squealFrequency = Math.min(2200, 650 + 550 * slip + 6 * Math.max(0, state.slideSpeed));
  out.windGain = Math.min(0.6, 0.6 * Math.pow(Math.max(0, state.speed) / 45, 2));
  return out;
}

export interface VehicleSoundscapeOptions extends VehicleSoundLevelOptions {
  /** Output gain. Default 0.6. */
  volume?: number;
  /** Place the vehicle in 3D with a PannerNode (HRTF). Default false: a cockpit mix. */
  spatial?: boolean;
  /** Parameter smoothing time constant (s). Default 0.05. */
  smoothing?: number;
  /** Seed of the shared noise buffer and the one-shot variation. */
  seed?: number;
}

type Voice = { gain: GainNode; filter: BiquadFilterNode };

/**
 * The voice graph: engine harmonics (sawtooth at the firing frequency, a half-order sine for the
 * uneven-firing rumble, a square at twice it) through a load-driven low-pass; combustion grit and
 * intake as band-passed noise; lift-off burble; a whine oscillator; tyre roar, crunch, slosh and
 * squeal as filtered noise; wind. Events play as short one-shots (a pitch-dropping thump plus a
 * surface burst for suspension hits, a clunk for a shift). Browsers only start audio after a user
 * gesture, so the host creates (or resumes) the context from one.
 */
export class VehicleSoundscape {
  readonly context: BaseAudioContext;
  readonly output: GainNode;
  readonly panner?: PannerNode;
  readonly levels: VehicleSoundLevels = createVehicleSoundLevels();
  private readonly options: VehicleSoundscapeOptions;
  private readonly noise: AudioBuffer;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly oscillators: { fundamental: OscillatorNode; sub: OscillatorNode; second: OscillatorNode; whine: OscillatorNode };
  private readonly engineGain: GainNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly whineGain: GainNode;
  private readonly grit: Voice;
  private readonly intake: Voice;
  private readonly overrun: Voice;
  private readonly roar: Voice;
  private readonly crunch: Voice;
  private readonly slosh: Voice;
  private readonly squeal: Voice;
  private readonly wind: Voice;
  private rng: number;
  private disposed = false;

  constructor(context: BaseAudioContext, destination: AudioNode = context.destination, options: VehicleSoundscapeOptions = {}) {
    this.context = context;
    this.options = options;
    this.rng = (options.seed ?? 0x5eed1e) >>> 0 || 1;
    this.output = context.createGain();
    this.output.gain.value = options.volume ?? 0.6;
    if (options.spatial) {
      const p = context.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = 4;
      p.rolloffFactor = 1;
      this.output.connect(p).connect(destination);
      this.panner = p;
    } else {
      this.output.connect(destination);
    }
    this.noise = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * 2)), context.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = (this.rng ^ 0x2545f491) >>> 0 || 1;
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }

    // Engine harmonics → low-pass → gain.
    this.engineFilter = context.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 1.2;
    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.output);
    const osc = (type: OscillatorType, level: number, destinationNode: AudioNode): OscillatorNode => {
      const o = context.createOscillator();
      o.type = type;
      o.frequency.value = 30;
      const g = context.createGain();
      g.gain.value = level;
      o.connect(g).connect(destinationNode);
      o.start();
      this.sources.push(o);
      return o;
    };
    this.whineGain = context.createGain();
    this.whineGain.gain.value = 0;
    this.whineGain.connect(this.output);
    this.oscillators = {
      fundamental: osc("sawtooth", 0.55, this.engineFilter),
      sub: osc("sine", 0.5, this.engineFilter),
      second: osc("square", 0.18, this.engineFilter),
      whine: osc("sine", 1, this.whineGain),
    };

    let offset = 0;
    const voice = (type: BiquadFilterType, frequency: number, q: number): Voice => {
      const src = context.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = context.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.output);
      src.start(0, (offset += 0.23));
      this.sources.push(src);
      return { gain, filter };
    };
    this.grit = voice("bandpass", 900, 0.8);
    this.intake = voice("bandpass", 600, 1.4);
    this.overrun = voice("bandpass", 220, 2.5);
    this.roar = voice("lowpass", 500, 0.7);
    this.crunch = voice("bandpass", 2500, 0.9);
    this.slosh = voice("lowpass", 350, 4);
    this.squeal = voice("bandpass", 900, 22);
    this.wind = voice("bandpass", 500, 0.5);
  }

  /** Move the spatial voice (no-op for a cockpit mix). */
  setPosition(x: number, y: number, z: number): void {
    const p = this.panner;
    if (!p) return;
    const t = this.context.currentTime;
    p.positionX.setTargetAtTime(x, t, 0.02);
    p.positionY.setTargetAtTime(y, t, 0.02);
    p.positionZ.setTargetAtTime(z, t, 0.02);
  }

  /** Ramp every voice toward the state's levels; returns the levels it applied. */
  set(state: VehicleSoundState): VehicleSoundLevels {
    if (this.disposed) return this.levels;
    const l = vehicleSoundLevels(state, this.options, this.levels);
    const t = this.context.currentTime;
    const k = this.options.smoothing ?? 0.05;
    const f = Math.max(1, l.engineFrequency);
    this.oscillators.fundamental.frequency.setTargetAtTime(f, t, k * 0.5);
    this.oscillators.sub.frequency.setTargetAtTime(f * 0.5, t, k * 0.5);
    this.oscillators.second.frequency.setTargetAtTime(f * 2, t, k * 0.5);
    this.oscillators.whine.frequency.setTargetAtTime(Math.max(1, l.whineFrequency), t, k * 0.5);
    this.engineGain.gain.setTargetAtTime(l.engineGain, t, k);
    this.engineFilter.frequency.setTargetAtTime(l.engineBrightness || 400, t, k);
    this.whineGain.gain.setTargetAtTime(l.whineGain, t, k);
    this.grit.gain.gain.setTargetAtTime(l.engineRoughness, t, k);
    this.grit.filter.frequency.setTargetAtTime(Math.max(200, f * 6), t, k);
    this.intake.gain.gain.setTargetAtTime(l.intakeGain, t, k);
    this.intake.filter.frequency.setTargetAtTime(l.intakeFrequency || 600, t, k);
    // Burble flickers: a fresh random level each update while lifting off.
    this.overrun.gain.gain.setTargetAtTime(l.overrunGain * (0.3 + 0.7 * this.random()), t, 0.015);
    this.roar.gain.gain.setTargetAtTime(l.roarGain, t, k);
    this.roar.filter.frequency.setTargetAtTime(l.roarCutoff, t, k);
    this.crunch.gain.gain.setTargetAtTime(l.crunchGain * (0.7 + 0.3 * this.random()), t, k * 0.5);
    this.crunch.filter.frequency.setTargetAtTime(l.crunchFrequency, t, k);
    this.slosh.gain.gain.setTargetAtTime(l.sloshGain, t, k * 2);
    this.squeal.gain.gain.setTargetAtTime(l.squealGain, t, k);
    this.squeal.filter.frequency.setTargetAtTime(l.squealFrequency, t, k);
    this.wind.gain.gain.setTargetAtTime(l.windGain, t, k * 4);
    return l;
  }

  /** Play one-shots for events (suspension thumps with a surface burst, shift clunks). */
  play(events: readonly VehicleSoundEvent[]): void {
    if (this.disposed) return;
    for (const e of events) {
      if (e.kind === "shift") this.burst("lowpass", 700, 1, 0.05, 0.25 * e.strength);
      else {
        const heavy = e.kind === "landing" || e.kind === "bottomOut";
        this.thump(heavy ? 70 : 95, heavy ? 0.28 : 0.14, (heavy ? 0.9 : 0.55) * e.strength);
        const p = VEHICLE_SURFACE_SOUND[e.surface];
        if (p.crunch > 0.2) this.burst("bandpass", p.crunchFrequency, 1.2, heavy ? 0.25 : 0.1, 0.5 * p.crunch * e.strength);
        if (p.slosh > 0.2) this.burst("lowpass", 400, 2, heavy ? 0.4 : 0.2, 0.6 * p.slosh * e.strength);
      }
    }
  }

  /** Stop every voice (the context stays with the host). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sources) {
      s.stop();
      s.disconnect();
    }
    this.output.disconnect();
    this.panner?.disconnect();
  }

  private random(): number {
    let s = this.rng;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rng = s >>> 0 || 1;
    return this.rng / 4294967296;
  }

  private thump(frequency: number, duration: number, level: number): void {
    const ctx = this.context;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(frequency, t);
    o.frequency.exponentialRampToValueAtTime(frequency * 0.45, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(1, level), t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + duration);
    o.connect(g).connect(this.output);
    o.onended = () => g.disconnect();
    o.start(t);
    o.stop(t + duration + 0.02);
  }

  private burst(type: BiquadFilterType, frequency: number, q: number, duration: number, level: number): void {
    const ctx = this.context;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(1, level), t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + duration);
    src.connect(filter).connect(g).connect(this.output);
    src.onended = () => g.disconnect();
    src.start(t, this.random() * Math.max(0, this.noise.duration - duration - 0.05));
    src.stop(t + duration + 0.02);
  }
}

export interface VehicleAudioOptions extends VehicleSoundAnalyzerOptions, VehicleSoundscapeOptions {}

/** One vehicle's audio: analyzer + soundscape, updated once per presented frame after the step. */
export class VehicleAudio {
  readonly analyzer: VehicleSoundAnalyzer;
  readonly soundscape: VehicleSoundscape;

  constructor(readonly vehicle: Vehicle, context: BaseAudioContext, destination: AudioNode = context.destination, options: VehicleAudioOptions = {}) {
    this.analyzer = new VehicleSoundAnalyzer(vehicle, options);
    this.soundscape = new VehicleSoundscape(context, destination, options);
  }

  get state(): VehicleSoundState {
    return this.analyzer.state;
  }

  get levels(): VehicleSoundLevels {
    return this.soundscape.levels;
  }

  update(dt: number): VehicleSoundLevels {
    const state = this.analyzer.update(dt);
    const p = this.vehicle.position;
    this.soundscape.setPosition(p.x, p.y, p.z);
    this.soundscape.play(this.analyzer.events);
    return this.soundscape.set(state);
  }

  dispose(): void {
    this.soundscape.dispose();
  }
}
