/**
 * Streaming audio (Phase 20.3): music and long ambiences played from a media element instead of
 * being decoded whole. The element streams and decodes as it plays; a `MediaElementAudioSourceNode`
 * routes it through a gain into a bus, so streams mix, duck and fade like any other voice.
 *
 * Browsers refuse `play()` until the page has had a user gesture. A refused stream is `blocked`, not
 * failed: `AudioSystem.resume()` (called from the gesture) retries it.
 */

import { rampParam } from "./params.js";

export type AudioStreamState = "idle" | "playing" | "blocked" | "paused" | "ended" | "error" | "disposed";

export interface StreamOptions {
  bus?: string;
  volume?: number;
  loop?: boolean;
  /** `crossOrigin` for the element; cross-origin streams need CORS to be audible through Web Audio. Default "anonymous". */
  crossOrigin?: "anonymous" | "use-credentials" | null;
  /** Fade in over this many seconds when playback starts. */
  fadeIn?: number;
  /** Called once when a non-looping stream reaches its end. */
  onEnded?: () => void;
}

export class AudioStream {
  readonly gain: GainNode;
  private readonly source: MediaElementAudioSourceNode;
  private stateValue: AudioStreamState = "idle";
  private volume: number;
  private readonly onEndedEvent = (): void => {
    if (this.stateValue === "disposed") return;
    this.stateValue = "ended";
    this.options.onEnded?.();
  };
  private readonly onErrorEvent = (): void => {
    if (this.stateValue !== "disposed") this.stateValue = "error";
  };

  constructor(
    readonly context: AudioContext,
    readonly element: HTMLMediaElement,
    readonly url: string,
    destination: AudioNode,
    private readonly options: StreamOptions,
    private readonly onDisposed: (stream: AudioStream) => void,
  ) {
    this.volume = Math.max(0, options.volume ?? 1);
    element.crossOrigin = options.crossOrigin === undefined ? "anonymous" : options.crossOrigin;
    element.preload = "auto";
    element.loop = options.loop ?? false;
    element.src = url;
    this.source = context.createMediaElementSource(element);
    this.gain = context.createGain();
    this.gain.gain.setValueAtTime(this.volume, context.currentTime);
    this.source.connect(this.gain).connect(destination);
    element.addEventListener("ended", this.onEndedEvent);
    element.addEventListener("error", this.onErrorEvent);
  }

  get state(): AudioStreamState {
    return this.stateValue;
  }

  /** Start or resume. Resolves either way; a refusal by the autoplay policy leaves the stream `blocked`. */
  async play(): Promise<AudioStreamState> {
    if (this.stateValue === "disposed") return this.stateValue;
    const fade = this.options.fadeIn ?? 0;
    if (fade > 0 && this.stateValue !== "paused") {
      const now = this.context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(0, now);
      this.gain.gain.linearRampToValueAtTime(this.volume, now + fade);
    }
    try {
      await this.element.play();
      if ((this.stateValue as AudioStreamState) !== "disposed") this.stateValue = "playing";
    } catch (e) {
      if ((this.stateValue as AudioStreamState) === "disposed") return this.stateValue;
      this.stateValue = (e as { name?: string }).name === "NotAllowedError" ? "blocked" : "error";
    }
    return this.stateValue;
  }

  pause(): void {
    if (this.stateValue !== "playing" && this.stateValue !== "blocked") return;
    this.element.pause();
    this.stateValue = "paused";
  }

  /** Pause and rewind. */
  stop(): void {
    if (this.stateValue === "disposed") return;
    this.element.pause();
    this.element.currentTime = 0;
    this.stateValue = "idle";
  }

  setVolume(value: number, ramp = 0): void {
    this.volume = Math.max(0, value);
    rampParam(this.gain.gain, this.volume, this.context.currentTime, ramp);
  }

  /** Stop, release the element's network stream and disconnect. */
  dispose(): void {
    if (this.stateValue === "disposed") return;
    this.stateValue = "disposed";
    this.element.pause();
    this.element.removeEventListener("ended", this.onEndedEvent);
    this.element.removeEventListener("error", this.onErrorEvent);
    this.element.removeAttribute("src");
    this.element.load();
    this.source.disconnect();
    this.gain.disconnect();
    this.onDisposed(this);
  }
}
