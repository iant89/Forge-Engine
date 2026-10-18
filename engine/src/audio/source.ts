/**
 * One playing sound (Phase 20.1): buffer source → gain → [low-pass → panner] → bus.
 *
 * A voice's loudness is `volume × occlusion attenuation`; `setVolume` and `setOcclusion` change one
 * factor each, so occluding a quiet voice keeps it quiet rather than resetting it to full volume.
 * Spatial voices carry a low-pass filter that occlusion closes (22 kHz open, 800 Hz fully occluded),
 * which is what an obstruction sounds like. Every fade is an anchored ramp (`rampParam`), so it starts
 * at the level the voice is at. `onEnded` runs exactly once, when the source finishes or the voice is
 * disposed, and the voice disconnects all of its nodes then.
 */

import type { Vec3Ops } from "../math/vec.js";
import { rampParam } from "./params.js";
import type { PlayOptions } from "./types.js";

/** Remaining gain at full occlusion. */
export const OCCLUSION_FLOOR = 0.25;
/** Low-pass cutoff of a fully occluded voice (Hz); an open voice is at the Nyquist limit. */
export const OCCLUSION_CUTOFF = 800;

function setParam(param: AudioParam, value: number, time: number): void {
  param.setValueAtTime(value, time);
}
function setPosition(panner: PannerNode, value: Vec3Ops, time: number): void {
  setParam(panner.positionX, value.x, time);
  setParam(panner.positionY, value.y, time);
  setParam(panner.positionZ, value.z, time);
}

export class AudioVoice {
  private ended = false;
  private disposed = false;
  private stopping = false;
  private volume: number;
  private occlusion = 0;
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
      if (options.position) setPosition(p, options.position, context.currentTime);
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

  setPosition(value: Vec3Ops): void {
    if (this.panner) setPosition(this.panner, value, this.context.currentTime);
  }

  setOrientation(value: Vec3Ops): void {
    if (!this.panner) return;
    const t = this.context.currentTime;
    setParam(this.panner.orientationX, value.x, t);
    setParam(this.panner.orientationY, value.y, t);
    setParam(this.panner.orientationZ, value.z, t);
  }

  /**
   * Obstruction between the voice and the listener, 0 (clear) to 1 (fully behind a wall): the gain
   * falls to `OCCLUSION_FLOOR` of the voice's volume and, on spatial voices, the low-pass closes to
   * `OCCLUSION_CUTOFF` (geometrically, so it sounds even). Smoothed over 30 ms.
   */
  setOcclusion(amount: number, ramp = 0.03): void {
    this.occlusion = Math.max(0, Math.min(1, amount));
    this.applyGain(ramp);
    if (this.filter) {
      const open = this.context.sampleRate / 2;
      rampParam(this.filter.frequency, open * Math.pow(OCCLUSION_CUTOFF / open, this.occlusion), this.context.currentTime, ramp);
    }
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

  private applyGain(ramp: number): void {
    if (this.stopping) return; // a fade-out owns the gain now
    const target = this.volume * (1 - (1 - OCCLUSION_FLOOR) * this.occlusion);
    rampParam(this.gain.gain, target, this.context.currentTime, Math.max(0, ramp));
  }
}
