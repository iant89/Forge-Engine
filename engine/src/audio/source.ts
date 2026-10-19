/**
 * One playing sound (Phase 20.1): buffer source → gain → [low-pass → panner] → bus.
 *
 * A voice's loudness is `volume × occlusion attenuation`; `setVolume` and `setOcclusion` change one
 * factor each, so occluding a quiet voice keeps it quiet rather than resetting it to full volume.
 * Spatial voices carry one low-pass filter shared by air absorption and occlusion: the cutoff is the
 * air-absorption cutoff (`setAirAbsorption`, open = Nyquist) pulled toward `OCCLUSION_CUTOFF` as
 * occlusion rises (22 kHz open, 800 Hz fully occluded), which is what distance and an obstruction
 * sound like. Positions and directions are engine space, converted to Web Audio's handedness by the
 * spatial.ts writers. Every fade is an anchored ramp (`rampParam`), so it starts
 * at the level the voice is at. `onEnded` runs exactly once, when the source finishes or the voice is
 * disposed, and the voice disconnects all of its nodes then.
 */

import type { Vec3Ops } from "../math/vec.js";
import { rampParam } from "./params.js";
import { setPannerOrientation, setPannerPosition } from "./spatial.js";
import type { PlayOptions } from "./types.js";

/** Remaining gain at full occlusion. */
export const OCCLUSION_FLOOR = 0.25;
/** Low-pass cutoff of a fully occluded voice (Hz); an open voice is at the Nyquist limit. */
export const OCCLUSION_CUTOFF = 800;

export class AudioVoice {
  private ended = false;
  private disposed = false;
  private stopping = false;
  private volume: number;
  private occlusion = 0;
  /** Air-absorption cutoff (Hz); Infinity = open. */
  private air = Infinity;
  private readonly onEndedCallback: (voice: AudioVoice) => void;
  readonly gain: GainNode;
  readonly panner?: PannerNode;
  /** The occlusion low-pass (spatial voices only). */
  readonly filter?: BiquadFilterNode;

  constructor(
    readonly context: AudioContext,
    readonly source: AudioBufferSourceNode,
    destination: AudioNode,
    options: PlayOptions,
    onEnded: (voice: AudioVoice) => void,
  ) {
    this.onEndedCallback = onEnded;
    this.gain = context.createGain();
    let tail: AudioNode = this.gain;
    if (options.spatial) {
      const f = context.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = context.sampleRate / 2;
      f.Q.value = 0.707;
      this.filter = f;
      const p = context.createPanner();
      this.panner = p;
      p.panningModel = options.panningModel ?? "HRTF";
      p.distanceModel = options.distanceModel ?? "inverse";
      p.refDistance = options.refDistance ?? 1;
      p.maxDistance = options.maxDistance ?? 10_000;
      p.rolloffFactor = options.rolloffFactor ?? 1;
      p.coneInnerAngle = options.coneInnerAngle ?? 360;
      p.coneOuterAngle = options.coneOuterAngle ?? 360;
      p.coneOuterGain = options.coneOuterGain ?? 0;
      if (options.position) setPannerPosition(p, options.position, context.currentTime);
      if (options.orientation) this.setOrientation(options.orientation);
      this.gain.connect(f).connect(p);
      tail = p;
    }
    tail.connect(destination);
    source.connect(this.gain);
    source.loop = options.loop ?? false;
    source.loopStart = options.loopStart ?? 0;
    if (options.loopEnd !== undefined) source.loopEnd = options.loopEnd;
    source.playbackRate.value = options.playbackRate ?? 1;
    source.detune.value = options.detune ?? 0;
    const now = context.currentTime;
    this.volume = Math.max(0, options.volume ?? 1);
    if ((options.fadeIn ?? 0) > 0) {
      this.gain.gain.setValueAtTime(0, now);
      this.gain.gain.linearRampToValueAtTime(this.volume, now + options.fadeIn!);
    } else {
      this.gain.gain.setValueAtTime(this.volume, now);
    }
    source.onended = () => {
      this.ended = true;
      this.dispose();
    };
  }

  /** True once the voice finished, was stopped without a fade, or was disposed. */
  get finished(): boolean {
    return this.ended || this.disposed;
  }
  /** True while a fade-out started by `stop(fadeOut)` is running. */
  get fadingOut(): boolean {
    return this.stopping && !this.finished;
  }

  start(delay = 0, offset = 0): this {
    this.source.start(this.context.currentTime + Math.max(0, delay), Math.max(0, offset));
    return this;
  }

  /** Stop now, or fade out over `fadeOut` seconds and stop at its end. */
  stop(fadeOut = 0): void {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    const now = this.context.currentTime;
    if (fadeOut > 0) {
      rampParam(this.gain.gain, 0, now, fadeOut);
      this.source.stop(now + fadeOut);
    } else {
      this.source.stop();
    }
  }

  setVolume(value: number, ramp = 0): void {
    this.volume = Math.max(0, value);
    this.applyGain(ramp);
  }

  /** Engine-space position. */
  setPosition(value: Vec3Ops): void {
    if (this.panner) setPannerPosition(this.panner, value, this.context.currentTime);
  }

  /** Engine-space direction the cone faces. */
  setOrientation(value: Vec3Ops): void {
    if (this.panner) setPannerOrientation(this.panner, value, this.context.currentTime);
  }

  /**
   * Obstruction between the voice and the listener, 0 (clear) to 1 (fully behind a wall): the gain
   * falls to `OCCLUSION_FLOOR` of the voice's volume and, on spatial voices, the low-pass closes to
   * `OCCLUSION_CUTOFF` (geometrically, so it sounds even). Smoothed over 30 ms.
   */
  setOcclusion(amount: number, ramp = 0.03): void {
    this.occlusion = Math.max(0, Math.min(1, amount));
    this.applyGain(ramp);
    this.applyFilter(ramp);
  }

  /**
   * Phase 20.1: the air-absorption cutoff for the voice's distance (`airAbsorptionCutoff`), capped at
   * Nyquist; occlusion still closes the filter from there toward `OCCLUSION_CUTOFF`. Spatial only.
   */
  setAirAbsorption(cutoff: number, ramp = 0.03): void {
    this.air = Math.max(1, cutoff);
    this.applyFilter(ramp);
  }

  /** The low-pass cutoff the voice is heading to (Hz): air absorption, then occlusion. */
  get cutoff(): number {
    const open = Math.min(this.context.sampleRate / 2, this.air);
    return open * Math.pow(Math.min(1, OCCLUSION_CUTOFF / open), this.occlusion);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.ended) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // never started, or already stopped
      }
    }
    this.source.disconnect();
    this.gain.disconnect();
    this.filter?.disconnect();
    this.panner?.disconnect();
    this.onEndedCallback(this);
  }

  private applyFilter(ramp: number): void {
    if (this.filter) rampParam(this.filter.frequency, this.cutoff, this.context.currentTime, ramp);
  }

  private applyGain(ramp: number): void {
    if (this.stopping) return; // a fade-out owns the gain now
    const target = this.volume * (1 - (1 - OCCLUSION_FLOOR) * this.occlusion);
    rampParam(this.gain.gain, target, this.context.currentTime, Math.max(0, ramp));
  }
}
