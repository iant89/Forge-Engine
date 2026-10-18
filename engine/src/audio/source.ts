import type { Vec3Ops } from "../math/vec.js";
import { setPannerOrientation, setPannerPosition } from "./spatial.js";
import type { PlayOptions } from "./types.js";

/**
 * One playing buffer: source → volume gain → occlusion gain → (spatial: low-pass → panner) → bus.
 * Positions are engine space; the panner writers convert to Web Audio's handedness (spatial.ts).
 */
export class AudioVoice {
  private _ended = false;
  private disposed = false;
  private readonly onEndedCallback: (voice: AudioVoice) => void;
  readonly gain: GainNode;
  /** Occlusion attenuation, separate from the voice volume so the two never fight. */
  readonly occlusionGain: GainNode;
  /** Spatial voices only: the low-pass air absorption and occlusion drive (spatial.ts). */
  readonly filter?: BiquadFilterNode;
  readonly panner?: PannerNode;

  constructor(readonly context: AudioContext, readonly source: AudioBufferSourceNode, destination: AudioNode, options: PlayOptions, onEnded: (voice: AudioVoice) => void) {
    this.onEndedCallback = onEnded;
    this.gain = context.createGain();
    this.occlusionGain = context.createGain();
    this.gain.connect(this.occlusionGain);
    let tail: AudioNode = this.occlusionGain;
    if (options.spatial) {
      const f = context.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 20_000;
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
      if (options.orientation) setPannerOrientation(p, options.orientation, context.currentTime);
      tail.connect(f).connect(p);
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
    const volume = Math.max(0, options.volume ?? 1);
    if ((options.fadeIn ?? 0) > 0) {
      this.gain.gain.setValueAtTime(0, now);
      this.gain.gain.linearRampToValueAtTime(volume, now + options.fadeIn!);
    } else this.gain.gain.value = volume;
    source.onended = () => {
      this._ended = true;
      this.dispose();
      this.onEndedCallback(this);
    };
  }

  /** The source finished (or was stopped and has played out). */
  get ended(): boolean {
    return this._ended;
  }

  start(delay = 0, offset = 0): this {
    this.source.start(this.context.currentTime + Math.max(0, delay), Math.max(0, offset));
    return this;
  }

  stop(fadeOut = 0): void {
    if (this._ended || this.disposed) return;
    const now = this.context.currentTime;
    if (fadeOut > 0) {
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(0, now + fadeOut);
      this.source.stop(now + fadeOut);
    } else this.source.stop();
  }

  setVolume(value: number, ramp = 0): void {
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.linearRampToValueAtTime(Math.max(0, value), now + Math.max(0, ramp));
  }

  /** Engine-space position. */
  setPosition(value: Vec3Ops): void {
    if (this.panner) setPannerPosition(this.panner, value, this.context.currentTime);
  }

  /** Engine-space direction the cone faces. */
  setOrientation(value: Vec3Ops): void {
    if (this.panner) setPannerOrientation(this.panner, value, this.context.currentTime);
  }

  /** Occlusion attenuation (1 = clear), smoothed over ~30 ms. */
  setOcclusionGain(value: number): void {
    this.occlusionGain.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), this.context.currentTime, 0.03);
  }

  /** Cheap obstruction: 0 clear … 1 fully blocked (−75 % level). `SpatialAudioSource` also filters. */
  setOcclusion(amount: number): void {
    const x = Math.max(0, Math.min(1, amount));
    this.setOcclusionGain(1 - x * 0.75);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.disconnect();
    this.gain.disconnect();
    this.occlusionGain.disconnect();
    this.filter?.disconnect();
    this.panner?.disconnect();
  }
}
