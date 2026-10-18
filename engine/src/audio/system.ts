/**
 * The audio mixer (Phase 20.1–20.4): one `AudioContext`, a tree of buses, decoded clips, voices and
 * streams.
 *
 *  - **Buses** (20.4): `master` → the speakers; `music`, `sfx`, `dialogue` and `ambient` → `master`;
 *    games add their own with `createBus(name, parent)`. Each bus is a gain with an `EffectRack` of
 *    live-insertable effects. Volume changes are anchored ramps, so a fade starts at the bus's level.
 *  - **Clips** (20.2): `load(url)` fetches and decodes once per URL — concurrent loads share one
 *    request — and a failed fetch or decode is evicted so a retry can succeed. `release` and
 *    `clearCache` drop clips; `stats()` counts them and their decoded seconds.
 *  - **Voices** (20.1): `play(clip, options)`, optionally spatial (an HRTF panner fed by `setListener`).
 *    At most `maxVoices` play at once: a new voice beyond the limit steals the oldest, which fades out
 *    over 10 ms and stops counting immediately, so the limit holds however fast sounds are triggered.
 *  - **Streams** (20.3): `stream(url)` plays long audio from a media element; see stream.ts.
 *
 * Browsers start an `AudioContext` suspended until a user gesture; call `resume()` from one (it also
 * retries streams the autoplay policy refused). `dispose()` stops every voice and stream, disconnects
 * every node and closes the context.
 */

import { UsageError } from "../core/errors.js";
import type { Vec3Ops } from "../math/vec.js";
import { EffectRack } from "./effects.js";
import { rampParam } from "./params.js";
import { AudioVoice } from "./source.js";
import { AudioStream, type StreamOptions } from "./stream.js";
import type { AudioBusName, AudioClip, AudioStats, ListenerTransform, PlayOptions } from "./types.js";

export interface AudioSystemOptions {
  context?: AudioContext;
  masterVolume?: number;
  maxVoices?: number;
  /** `fetch` used by `load` (default `globalThis.fetch`). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Creates the media element a stream plays from (default `new Audio()`). */
  createMediaElement?: () => HTMLMediaElement;
}

interface Bus {
  gain: GainNode;
  output: GainNode;
  rack: EffectRack;
  parent: AudioBusName | null;
}

/** Fade-out given to a voice stolen by the voice limit (seconds). */
export const VOICE_STEAL_FADE = 0.01;

export class AudioSystem {
  readonly context: AudioContext;
  readonly maxVoices: number;
  private readonly clips = new Map<string, Promise<AudioClip>>();
  private readonly loaded = new Map<string, AudioClip>();
  /** Voices that count against the limit, oldest first. */
  private readonly voices = new Set<AudioVoice>();
  /** Voices fading out after being stolen or stopped with a fade; disposed with the system. */
  private readonly releasing = new Set<AudioVoice>();
  private readonly streams = new Set<AudioStream>();
  private readonly buses = new Map<AudioBusName, Bus>();
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly createMediaElement: () => HTMLMediaElement;
  private stolen = 0;
  private disposed = false;

  constructor(options: AudioSystemOptions = {}) {
    const Ctor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!options.context && !Ctor) throw new Error("Web Audio API is unavailable");
    this.context = options.context ?? new Ctor!();
    this.maxVoices = Math.max(1, Math.floor(options.maxVoices ?? 128));
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.createMediaElement = options.createMediaElement ?? (() => new Audio());
    const master = this.createBus("master", null);
    master.gain.gain.setValueAtTime(Math.max(0, options.masterVolume ?? 1), this.context.currentTime);
    for (const name of ["music", "sfx", "dialogue", "ambient"] as const) this.createBus(name);
  }

  // -------------------------------------------------------------- buses (20.4)

  /**
   * A bus feeding `parent` (default `master`; `null` = the speakers). Returns the existing bus when
   * `name` is taken. An unknown parent is a usage error, not a silent route to the speakers.
   */
  createBus(name: AudioBusName, parent: AudioBusName | null = "master"): Bus {
    this.assertLive();
    const existing = this.buses.get(name);
    if (existing) return existing;
    const target = parent === null ? this.context.destination : this.buses.get(parent)?.gain;
    if (!target) throw new UsageError(`AudioSystem: bus "${name}" names an unknown parent bus "${String(parent)}"`);
    const gain = this.context.createGain();
    const output = this.context.createGain();
    const rack = new EffectRack(gain, output);
    output.connect(target);
    const bus: Bus = { gain, output, rack, parent };
    this.buses.set(name, bus);
    return bus;
  }

  /** The bus's effect rack. */
  bus(name: AudioBusName): EffectRack {
    return this.requireBus(name).rack;
  }

  /** Ramp a bus's volume from where it is to `volume` over `ramp` seconds. */
  setBusVolume(name: AudioBusName, volume: number, ramp = 0): void {
    rampParam(this.requireBus(name).gain.gain, Math.max(0, volume), this.context.currentTime, Math.max(0, ramp));
  }

  /** The bus's current volume. */
  busVolume(name: AudioBusName): number {
    return this.requireBus(name).gain.gain.value;
  }

  // -------------------------------------------------------------- clips (20.2)

  async load(url: string, init?: RequestInit): Promise<AudioClip> {
    this.assertLive();
    let pending = this.clips.get(url);
    if (!pending) {
      pending = this.fetchImpl(url, init)
        .then((response) => {
          if (!response.ok) throw new Error(`Audio request failed (${response.status}): ${url}`);
          return response.arrayBuffer();
        })
        .then((data) => this.decode(data, url))
        .then((clip) => {
          if (this.clips.get(url) === pending) this.loaded.set(url, clip);
          return clip;
        });
      this.clips.set(url, pending);
      pending.catch(() => {
        if (this.clips.get(url) === pending) this.clips.delete(url);
      });
    }
    return pending;
  }

  async decode(data: ArrayBuffer, url?: string): Promise<AudioClip> {
    this.assertLive();
    const buffer = await this.context.decodeAudioData(data.slice(0));
    return { buffer, url, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate };
  }

  /** Forget one cached clip (voices already playing it keep playing). */
  release(url: string): boolean {
    this.loaded.delete(url);
    return this.clips.delete(url);
  }

  clearCache(): void {
    this.clips.clear();
    this.loaded.clear();
  }

  // -------------------------------------------------------------- voices (20.1)

  play(clip: AudioClip | AudioBuffer, options: PlayOptions = {}): AudioVoice {
    this.assertLive();
    const bus = this.requireBus(options.bus ?? "sfx");
    while (this.voices.size >= this.maxVoices) {
      const oldest = this.voices.values().next().value!;
      this.voices.delete(oldest);
      this.releasing.add(oldest);
      this.stolen++;
      oldest.stop(VOICE_STEAL_FADE);
    }
    const source = this.context.createBufferSource();
    source.buffer = "buffer" in clip ? clip.buffer : clip;
    const voice = new AudioVoice(this.context, source, bus.gain, options, (ended) => {
      this.voices.delete(ended);
      this.releasing.delete(ended);
    });
    this.voices.add(voice);
    return voice.start(options.delay, options.offset);
  }

  /** Stop a voice, counting it out of the limit at once even while it fades. */
  stopVoice(voice: AudioVoice, fadeOut = 0): void {
    if (this.voices.delete(voice)) this.releasing.add(voice);
    voice.stop(fadeOut);
  }

  /** Move the listener (the camera). `ramp` > 0 glides there; 0 jumps. */
  setListener(transform: ListenerTransform, ramp = 0): void {
    const listener = this.context.listener;
    const now = this.context.currentTime;
    if (!listener.positionX) {
      // Safari before 14.1: the deprecated setters.
      listener.setPosition(transform.position.x, transform.position.y, transform.position.z);
      listener.setOrientation(transform.forward.x, transform.forward.y, transform.forward.z, transform.up.x, transform.up.y, transform.up.z);
      return;
    }
    const set = (param: AudioParam, value: number): void => {
      if (ramp > 0) rampParam(param, value, now, ramp);
      else param.setValueAtTime(value, now);
    };
    set(listener.positionX, transform.position.x);
    set(listener.positionY, transform.position.y);
    set(listener.positionZ, transform.position.z);
    set(listener.forwardX, transform.forward.x);
    set(listener.forwardY, transform.forward.y);
    set(listener.forwardZ, transform.forward.z);
    set(listener.upX, transform.up.x);
    set(listener.upY, transform.up.y);
    set(listener.upZ, transform.up.z);
  }

  // -------------------------------------------------------------- streams (20.3)

  /** A stream from `url` on `options.bus` (default `music`). Call `play()` on it. */
  stream(url: string, options: StreamOptions = {}): AudioStream {
    this.assertLive();
    const bus = this.requireBus(options.bus ?? "music");
    const stream = new AudioStream(this.context, this.createMediaElement(), url, bus.gain, options, (s) => this.streams.delete(s));
    this.streams.add(stream);
    return stream;
  }

  // -------------------------------------------------------------- lifecycle

  /** Resume the context (call from a user gesture) and retry streams the autoplay policy refused. */
  async resume(): Promise<void> {
    this.assertLive();
    if (this.context.state === "suspended" || (this.context.state as string) === "interrupted") await this.context.resume();
    await Promise.all([...this.streams].filter((s) => s.state === "blocked").map((s) => s.play()));
  }

  async suspend(): Promise<void> {
    this.assertLive();
    if (this.context.state === "running") await this.context.suspend();
  }

  stats(): AudioStats {
    let decodedSeconds = 0;
    for (const clip of this.loaded.values()) decodedSeconds += clip.duration * clip.channels;
    return {
      activeVoices: this.voices.size,
      releasingVoices: this.releasing.size,
      stolenVoices: this.stolen,
      streams: this.streams.size,
      cachedClips: this.clips.size,
      decodedSeconds,
      buses: this.buses.size,
      state: this.context.state,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of [...this.voices, ...this.releasing]) voice.dispose();
    this.voices.clear();
    this.releasing.clear();
    for (const stream of [...this.streams]) stream.dispose();
    for (const bus of this.buses.values()) {
      bus.rack.clear();
      bus.gain.disconnect();
      bus.output.disconnect();
    }
    this.buses.clear();
    this.clearCache();
    await this.context.close();
  }

  private requireBus(name: AudioBusName): Bus {
    const bus = this.buses.get(name);
    if (!bus) throw new UsageError(`AudioSystem: unknown audio bus "${name}"`);
    return bus;
  }

  private assertLive(): void {
    if (this.disposed) throw new UsageError("AudioSystem is disposed");
  }
}

/** Updates a looping spatial voice from simulation state without allocating an audio component. */
export class SpatialAudioEmitter {
  constructor(readonly voice: AudioVoice) {}
  update(position: Vec3Ops, forward?: Vec3Ops): void {
    this.voice.setPosition(position);
    if (forward) this.voice.setOrientation(forward);
  }
}
