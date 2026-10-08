/** Runtime-modifiable WebAudio effects. Every effect has stable input/output nodes. */
export interface AudioEffect { readonly input: AudioNode; readonly output: AudioNode; readonly bypassed: boolean; setBypassed(value: boolean): void; dispose(): void; }

abstract class BaseEffect implements AudioEffect {
  readonly input: GainNode; readonly output: GainNode; protected readonly wet: GainNode; protected readonly dry: GainNode;
  private _bypassed = false;
  constructor(protected readonly context: BaseAudioContext) {
    this.input = context.createGain(); this.output = context.createGain(); this.wet = context.createGain(); this.dry = context.createGain();
    this.input.connect(this.dry).connect(this.output); this.wet.connect(this.output);
  }
  get bypassed(): boolean { return this._bypassed; }
  setBypassed(value: boolean): void { this._bypassed = value; this.dry.gain.value = value ? 1 : 0; this.wet.gain.value = value ? 0 : 1; }
  setMix(mix: number): void { const m = Math.max(0, Math.min(1, mix)); this.wet.gain.value = m; this.dry.gain.value = 1 - m; }
  dispose(): void { this.input.disconnect(); this.output.disconnect(); this.wet.disconnect(); this.dry.disconnect(); }
}

export class FilterEffect extends BaseEffect {
  readonly filter: BiquadFilterNode;
  constructor(context: BaseAudioContext, type: BiquadFilterType = "lowpass", frequency = 20_000, q = 0.707) { super(context); this.filter = context.createBiquadFilter(); this.filter.type = type; this.filter.frequency.value = frequency; this.filter.Q.value = q; this.input.connect(this.filter).connect(this.wet); }
}

export class DelayEffect extends BaseEffect {
  readonly delay: DelayNode; readonly feedback: GainNode;
  constructor(context: BaseAudioContext, seconds = 0.25, feedback = 0.25, mix = 0.3) { super(context); this.delay = context.createDelay(5); this.feedback = context.createGain(); this.delay.delayTime.value = seconds; this.feedback.gain.value = feedback; this.input.connect(this.delay); this.delay.connect(this.feedback).connect(this.delay); this.delay.connect(this.wet); this.setMix(mix); }
  override dispose(): void { this.delay.disconnect(); this.feedback.disconnect(); super.dispose(); }
}

export class ConvolutionReverb extends BaseEffect {
  readonly convolver: ConvolverNode;
  constructor(context: BaseAudioContext, impulse?: AudioBuffer, mix = 0.25) { super(context); this.convolver = context.createConvolver(); this.convolver.buffer = impulse ?? null; this.input.connect(this.convolver).connect(this.wet); this.setMix(mix); }
  setImpulse(impulse: AudioBuffer | null): void { this.convolver.buffer = impulse; }
  override dispose(): void { this.convolver.disconnect(); super.dispose(); }
}

export class CompressorEffect extends BaseEffect {
  readonly compressor: DynamicsCompressorNode;
  constructor(context: BaseAudioContext) { super(context); this.compressor = context.createDynamicsCompressor(); this.input.connect(this.compressor).connect(this.wet); this.setMix(1); }
  override dispose(): void { this.compressor.disconnect(); super.dispose(); }
}

/** Reconnectable serial chain supporting live insertion/removal without restarting sounds. */
export class EffectRack {
  private readonly effects: AudioEffect[] = [];
  constructor(readonly input: GainNode, readonly output: GainNode) { this.input.connect(this.output); }
  add(effect: AudioEffect): void { this.effects.push(effect); this.rewire(); }
  remove(effect: AudioEffect): boolean { const i = this.effects.indexOf(effect); if (i < 0) return false; this.effects.splice(i, 1); this.rewire(); return true; }
  clear(dispose = true): void { if (dispose) for (const effect of this.effects) effect.dispose(); this.effects.length = 0; this.rewire(); }
  private rewire(): void { this.input.disconnect(); for (const effect of this.effects) effect.output.disconnect(); let node: AudioNode = this.input; for (const effect of this.effects) { node.connect(effect.input); node = effect.output; } node.connect(this.output); }
}
