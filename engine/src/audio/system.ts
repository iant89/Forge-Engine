/**
 * The audio mixer (Phase 20.1–20.4): one `AudioContext`, a tree of buses, decoded clips, voices and
 * streams.
 *
 *  - **Buses** (20.4): `master` → the speakers; `music`, `sfx`, `dialogue` and `ambient` → `master`;
 *    games add their own with `createBus(name, parent)`. Each bus is a gain with an `EffectRack` of
 *    live-insertable effects. Volume changes are anchored ramps, so a fade starts at the bus's level.
 *  - **Clips** (20.2): decoded clips are `ResourceRegistry` entries (resources.ts) — the engine's
 *    registry when one is passed, else a private one. `acquire(source)` hands out refcounted handles
 *    (a url, alternative sources, or any audio descriptor); `load(url)` keeps one for the system —
 *    concurrent loads share one request — and a failed fetch or decode is not kept, so a retry can
 *    succeed. `release` and `clearCache` drop them; `stats()` counts them, their decoded seconds and
 *    the decoded bytes of every audio clip in the registry.
 *  - **Voices** (20.1): `play(clip, options)`, optionally spatial (an HRTF panner fed by `setListener`;
 *    positions are engine space, converted to Web Audio's handedness in spatial.ts).
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
import { ResourceRegistry, type ResourceDescriptor, type ResourceHandle } from "../resources/registry.js";
import { rampParam } from "./params.js";
import { AUDIO_RESOURCE_KIND, audioClipDescriptor, audioClipId, type AudioClipOptions, type AudioClipProvider, type AudioClipSource } from "./resources.js";
import { AudioVoice } from "./source.js";
import { setAudioListener } from "./spatial.js";
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
  /**
   * Phase 20.2: where decoded clips live. Pass the engine's (`engine.resources`) to share one byte
   * budget with textures and meshes; by default the system owns a private, unbounded registry.
   */
  registry?: ResourceRegistry;
}

interface Bus {
  gain: GainNode;
  output: GainNode;
  rack: EffectRack;
  parent: AudioBusName | null;
}

/** Fade-out given to a voice stolen by the voice limit (seconds). */
export const VOICE_STEAL_FADE = 0.01;

export class AudioSystem implements AudioClipProvider {
  readonly context: AudioContext;
  readonly maxVoices: number;
  readonly registry: ResourceRegistry;
  private readonly ownsRegistry: boolean;
  /** Handles `load` keeps, by clip id. */
  private readonly held = new Map<string, ResourceHandle<AudioClip>>();
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
    this.ownsRegistry = !options.registry;
    this.registry = options.registry ?? new ResourceRegistry();
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

  /**
   * A refcounted handle on a clip: a url, alternative sources (resources.ts), or any audio descriptor
   * such as `proceduralClipDescriptor`. Release it when done; idle clips are evicted by the registry.
   */
  acquire(source: AudioClipSource | ResourceDescriptor<AudioClip>, options: AudioClipOptions = {}): ResourceHandle<AudioClip> {
    this.assertLive();
    const descriptor = typeof source === "object" && !Array.isArray(source) && "load" in source ? (source as ResourceDescriptor<AudioClip>) : audioClipDescriptor(this.context, source as AudioClipSource, { fetch: this.fetchImpl, ...options });
    return this.registry.acquire(descriptor);
  }

  /** Load (once) and keep a clip until `release`/`clearCache`. Concurrent loads share one fetch. */
  async load(url: AudioClipSource, init?: RequestInit): Promise<AudioClip> {
    this.assertLive();
    const id = audioClipId(url);
    let handle = this.held.get(id);
    if (!handle || handle.state === "failed" || handle.releasedFlag) {
      handle?.release();
      handle = this.acquire(url, { init });
      this.held.set(id, handle);
    }
    try {
      return await handle.wait();
    } catch (error) {
      // A failed load is not kept, so the next `load` retries.
      if (this.held.get(id) === handle) this.held.delete(id);
      handle.release();
      throw error;
    }
  }

  async decode(data: ArrayBuffer, url?: string): Promise<AudioClip> {
    this.assertLive();
    const buffer = await this.context.decodeAudioData(data.slice(0));
    return { buffer, url, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate };
  }

  /**
   * Forget one kept clip (voices already playing it keep playing). The registry entry goes too unless
   * something else still holds it, so the next `load` fetches again.
   */
  release(url: AudioClipSource): boolean {
    const id = audioClipId(url);
    const handle = this.held.get(id);
    if (!handle) return false;
    this.held.delete(id);
    const last = handle.refCount <= 1;
    handle.release();
    if (last) this.registry.evict(id);
    return true;
  }

  /** Release every kept clip; the registry evicts them when idle or over budget. */
  clearCache(): void {
    for (const h of this.held.values()) h.release();
    this.held.clear();
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

  /**
   * Move the listener (the camera) to an engine-space pose; it is converted to Web Audio's handedness
   * (spatial.ts). `ramp` > 0 glides there from where it is; 0 jumps.
   */
  setListener(transform: ListenerTransform, ramp = 0): void {
    setAudioListener(this.context, transform.position, transform.forward, transform.up, ramp);
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
    for (const h of this.held.values()) {
      const clip = h.currentValue;
      if (clip) decodedSeconds += clip.duration * clip.channels;
    }
    return {
      activeVoices: this.voices.size,
      releasingVoices: this.releasing.size,
      stolenVoices: this.stolen,
      streams: this.streams.size,
      cachedClips: this.held.size,
      decodedSeconds,
      clipBytes: this.registry.bytesOfKind(AUDIO_RESOURCE_KIND),
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
    if (this.ownsRegistry) this.registry.dispose();
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
