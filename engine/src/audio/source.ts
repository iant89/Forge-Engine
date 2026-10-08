import type { Vec3Ops } from "../math/vec.js";
import type { PlayOptions } from "./types.js";

function setParam(param: AudioParam, value: number, time: number): void { param.setValueAtTime(value, time); }
function setPosition(panner: PannerNode, value: Vec3Ops, time: number): void { setParam(panner.positionX, value.x, time); setParam(panner.positionY, value.y, time); setParam(panner.positionZ, value.z, time); }

export class AudioVoice {
  private ended = false; private disposed = false; private readonly onEndedCallback: (voice: AudioVoice) => void;
  readonly gain: GainNode; readonly panner?: PannerNode;
  constructor(readonly context: AudioContext, readonly source: AudioBufferSourceNode, destination: AudioNode, options: PlayOptions, onEnded: (voice: AudioVoice) => void) {
    this.onEndedCallback = onEnded; this.gain = context.createGain(); let tail: AudioNode = this.gain;
    if (options.spatial) { const p = context.createPanner(); this.panner = p; p.panningModel = options.panningModel ?? "HRTF"; p.distanceModel = options.distanceModel ?? "inverse"; p.refDistance = options.refDistance ?? 1; p.maxDistance = options.maxDistance ?? 10_000; p.rolloffFactor = options.rolloffFactor ?? 1; p.coneInnerAngle = options.coneInnerAngle ?? 360; p.coneOuterAngle = options.coneOuterAngle ?? 360; p.coneOuterGain = options.coneOuterGain ?? 0; if (options.position) setPosition(p, options.position, context.currentTime); this.gain.connect(p); tail = p; }
    tail.connect(destination); source.connect(this.gain); source.loop = options.loop ?? false; source.loopStart = options.loopStart ?? 0; if (options.loopEnd !== undefined) source.loopEnd = options.loopEnd; source.playbackRate.value = options.playbackRate ?? 1; source.detune.value = options.detune ?? 0;
    const now = context.currentTime; const volume = Math.max(0, options.volume ?? 1); if ((options.fadeIn ?? 0) > 0) { this.gain.gain.setValueAtTime(0, now); this.gain.gain.linearRampToValueAtTime(volume, now + options.fadeIn!); } else this.gain.gain.value = volume;
    source.onended = () => { this.ended = true; this.dispose(); this.onEndedCallback(this); };
  }
  start(delay = 0, offset = 0): this { this.source.start(this.context.currentTime + Math.max(0, delay), Math.max(0, offset)); return this; }
  stop(fadeOut = 0): void { if (this.ended || this.disposed) return; const now = this.context.currentTime; if (fadeOut > 0) { this.gain.gain.cancelScheduledValues(now); this.gain.gain.setValueAtTime(this.gain.gain.value, now); this.gain.gain.linearRampToValueAtTime(0, now + fadeOut); this.source.stop(now + fadeOut); } else this.source.stop(); }
  setVolume(value: number, ramp = 0): void { const now = this.context.currentTime; this.gain.gain.cancelScheduledValues(now); this.gain.gain.linearRampToValueAtTime(Math.max(0, value), now + Math.max(0, ramp)); }
  setPosition(value: Vec3Ops): void { if (this.panner) setPosition(this.panner, value, this.context.currentTime); }
  setOrientation(value: Vec3Ops): void { if (!this.panner) return; const t = this.context.currentTime; setParam(this.panner.orientationX, value.x, t); setParam(this.panner.orientationY, value.y, t); setParam(this.panner.orientationZ, value.z, t); }
  /** Applies a cheap obstruction model: attenuation plus low-pass filtering can be handled on a bus rack. */
  setOcclusion(amount: number): void { const x = Math.max(0, Math.min(1, amount)); this.setVolume(1 - x * 0.75, 0.03); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.source.disconnect(); this.gain.disconnect(); this.panner?.disconnect(); }
}
