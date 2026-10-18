import type { Vec3Ops } from "../math/vec.js";
import { ResourceRegistry, type ResourceDescriptor, type ResourceHandle } from "../resources/registry.js";
import { EffectRack } from "./effects.js";
import { AUDIO_RESOURCE_KIND, audioClipDescriptor, audioClipId, decodedAudioBytes, type AudioClipOptions, type AudioClipProvider, type AudioClipSource } from "./resources.js";
import { AudioVoice } from "./source.js";
import { setAudioListener } from "./spatial.js";
import type { AudioBusName, AudioClip, AudioStats, ListenerTransform, PlayOptions } from "./types.js";

export interface AudioSystemOptions {
  context?: AudioContext;
  masterVolume?: number;
  maxVoices?: number;
  /**
   * Phase 20.2: where decoded clips live. Pass the engine's (`engine.resources`) to share one byte
   * budget with textures and meshes; by default the system owns a private, unbounded registry.
   */
  registry?: ResourceRegistry;
}
interface Bus { gain: GainNode; rack: EffectRack; }

/**
 * Browser-native mixer, decoder and 3D voice manager. Codec support follows `decodeAudioData`
 * (WAV/MP3/Ogg/Opus/AAC where the browser supplies them); clips may list alternatives (resources.ts).
 * Decoded clips are `ResourceRegistry` entries: `acquire` hands out refcounted handles, `load` keeps
 * one for the life of the system (or until `clearCache`). Positions are engine space (spatial.ts).
 */
export class AudioSystem implements AudioClipProvider {
  readonly context: AudioContext;
  readonly maxVoices: number;
  readonly registry: ResourceRegistry;
  private readonly ownsRegistry: boolean;
  /** Handles `load`/`decode` keep, by clip id. */
  private readonly held = new Map<string, ResourceHandle<AudioClip>>();
  private readonly voices = new Set<AudioVoice>();
  private readonly buses = new Map<AudioBusName, Bus>();
  private decodeSeq = 0;
  private disposed = false;

  constructor(options: AudioSystemOptions = {}) {
    const Ctor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!options.context && !Ctor) throw new Error("Web Audio API is unavailable");
    this.context = options.context ?? new Ctor!();
    this.maxVoices = Math.max(1, options.maxVoices ?? 128);
    this.ownsRegistry = !options.registry;
    this.registry = options.registry ?? new ResourceRegistry();
    const master = this.createBus("master", undefined);
    master.gain.gain.value = options.masterVolume ?? 1;
    for (const name of ["music", "sfx", "dialogue", "ambient"] as const) this.createBus(name);
  }

  createBus(name: AudioBusName, destination: AudioBusName | undefined = "master"): Bus {
    if (this.buses.has(name)) return this.buses.get(name)!;
    const gain = this.context.createGain(), output = this.context.createGain();
    const rack = new EffectRack(gain, output);
    const target = destination ? this.buses.get(destination)?.gain : this.context.destination;
    if (!target) output.connect(this.context.destination);
    else output.connect(target);
    const bus = { gain, rack };
    this.buses.set(name, bus);
    return bus;
  }

  bus(name: AudioBusName): EffectRack {
    const bus = this.buses.get(name);
    if (!bus) throw new Error(`Unknown audio bus: ${name}`);
    return bus.rack;
  }

  setBusVolume(name: AudioBusName, volume: number, ramp = 0): void {
    const param = this.buses.get(name)?.gain.gain;
    if (!param) throw new Error(`Unknown audio bus: ${name}`);
    param.linearRampToValueAtTime(Math.max(0, volume), this.context.currentTime + Math.max(0, ramp));
  }

  /**
   * Phase 20.2: a refcounted handle on a clip (a url, alternative sources, or any audio descriptor
   * such as `proceduralClipDescriptor`). Release it when done; idle clips are evicted by the
   * registry's budget.
   */
  acquire(source: AudioClipSource | ResourceDescriptor<AudioClip>, options: AudioClipOptions = {}): ResourceHandle<AudioClip> {
    this.assertLive();
    const descriptor = typeof source === "object" && !Array.isArray(source) && "load" in source ? (source as ResourceDescriptor<AudioClip>) : audioClipDescriptor(this.context, source as AudioClipSource, options);
    return this.registry.acquire(descriptor);
  }

  /** Load (once) and keep a clip for the life of the system. Concurrent loads share one fetch. */
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

  /** Decode bytes already in memory and keep the clip like `load` does. */
  async decode(data: ArrayBuffer, url?: string): Promise<AudioClip> {
    this.assertLive();
    const id = url ? `${audioClipId(url)}#decoded` : `${AUDIO_RESOURCE_KIND}:decoded/${++this.decodeSeq}`;
    const context = this.context;
    const handle = this.registry.acquire<AudioClip>({
      id,
      kind: AUDIO_RESOURCE_KIND,
      bytes: (clip) => decodedAudioBytes(clip.buffer),
      async load() {
        const buffer = await context.decodeAudioData(data.slice(0));
        return { buffer, url, id, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate };
      },
    });
    this.held.get(id)?.release();
    this.held.set(id, handle);
    return handle.wait();
  }

  play(clip: AudioClip | AudioBuffer, options: PlayOptions = {}): AudioVoice {
    this.assertLive();
    if (this.voices.size >= this.maxVoices) this.voices.values().next().value?.stop(0.01);
    const source = this.context.createBufferSource();
    source.buffer = "buffer" in clip ? clip.buffer : clip;
    const bus = this.buses.get(options.bus ?? "sfx");
    if (!bus) throw new Error(`Unknown audio bus: ${options.bus}`);
    const voice = new AudioVoice(this.context, source, bus.gain, options, (ended) => this.voices.delete(ended));
    this.voices.add(voice);
    return voice.start(options.delay, options.offset);
  }

  /** Engine-space listener pose (converted to Web Audio's handedness; spatial.ts). `ramp` smooths it. */
  setListener(transform: ListenerTransform, ramp = 0): void {
    setAudioListener(this.context, transform.position, transform.forward, transform.up, this.context.currentTime, Math.max(0, ramp) / 3);
  }

  async resume(): Promise<void> {
    this.assertLive();
    if (this.context.state === "suspended") await this.context.resume();
  }

  async suspend(): Promise<void> {
    this.assertLive();
    if (this.context.state === "running") await this.context.suspend();
  }

  stats(): AudioStats {
    const clipBytes = this.registry.bytesOfKind(AUDIO_RESOURCE_KIND);
    return { activeVoices: this.voices.size, cachedClips: this.held.size, clipBytes, buses: this.buses.size, state: this.context.state };
  }

  /** Release every clip `load`/`decode` kept; the registry evicts them when idle or over budget. */
  clearCache(): void {
    for (const h of this.held.values()) h.release();
    this.held.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
    for (const bus of this.buses.values()) {
      bus.rack.clear();
      bus.gain.disconnect();
    }
    this.buses.clear();
    this.clearCache();
    if (this.ownsRegistry) this.registry.dispose();
    await this.context.close();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("AudioSystem is disposed");
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
