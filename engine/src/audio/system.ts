import type { Vec3Ops } from "../math/vec.js";
import { EffectRack } from "./effects.js";
import { AudioVoice } from "./source.js";
import type { AudioBusName, AudioClip, AudioStats, ListenerTransform, PlayOptions } from "./types.js";

export interface AudioSystemOptions { context?: AudioContext; masterVolume?: number; maxVoices?: number; }
interface Bus { gain: GainNode; rack: EffectRack; }

/** Browser-native mixer, decoder and 3D voice manager. Codec support follows decodeAudioData (WAV/MP3/Ogg/Opus/AAC where supplied by the browser). */
export class AudioSystem {
  readonly context: AudioContext; readonly maxVoices: number; private readonly clips = new Map<string, Promise<AudioClip>>(); private readonly voices = new Set<AudioVoice>(); private readonly buses = new Map<AudioBusName, Bus>(); private disposed = false;
  constructor(options: AudioSystemOptions = {}) { const Ctor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (!options.context && !Ctor) throw new Error("Web Audio API is unavailable"); this.context = options.context ?? new Ctor!(); this.maxVoices = Math.max(1, options.maxVoices ?? 128); const master = this.createBus("master", undefined); master.gain.gain.value = options.masterVolume ?? 1; for (const name of ["music", "sfx", "dialogue", "ambient"] as const) this.createBus(name); }
  createBus(name: AudioBusName, destination: AudioBusName | undefined = "master"): Bus { if (this.buses.has(name)) return this.buses.get(name)!; const gain = this.context.createGain(), output = this.context.createGain(); const rack = new EffectRack(gain, output); const target = destination ? this.buses.get(destination)?.gain : this.context.destination; if (!target) output.connect(this.context.destination); else output.connect(target); const bus = { gain, rack }; this.buses.set(name, bus); return bus; }
  bus(name: AudioBusName): EffectRack { const bus = this.buses.get(name); if (!bus) throw new Error(`Unknown audio bus: ${name}`); return bus.rack; }
  setBusVolume(name: AudioBusName, volume: number, ramp = 0): void { const param = this.buses.get(name)?.gain.gain; if (!param) throw new Error(`Unknown audio bus: ${name}`); param.linearRampToValueAtTime(Math.max(0, volume), this.context.currentTime + Math.max(0, ramp)); }
  async load(url: string, init?: RequestInit): Promise<AudioClip> { this.assertLive(); let pending = this.clips.get(url); if (!pending) { pending = fetch(url, init).then(response => { if (!response.ok) throw new Error(`Audio request failed (${response.status}): ${url}`); return response.arrayBuffer(); }).then(data => this.decode(data, url)); this.clips.set(url, pending); pending.catch(() => this.clips.delete(url)); } return pending; }
  async decode(data: ArrayBuffer, url?: string): Promise<AudioClip> { this.assertLive(); const buffer = await this.context.decodeAudioData(data.slice(0)); return { buffer, url, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate }; }
  play(clip: AudioClip | AudioBuffer, options: PlayOptions = {}): AudioVoice { this.assertLive(); if (this.voices.size >= this.maxVoices) this.voices.values().next().value?.stop(0.01); const source = this.context.createBufferSource(); source.buffer = "buffer" in clip ? clip.buffer : clip; const bus = this.buses.get(options.bus ?? "sfx"); if (!bus) throw new Error(`Unknown audio bus: ${options.bus}`); const voice = new AudioVoice(this.context, source, bus.gain, options, ended => this.voices.delete(ended)); this.voices.add(voice); return voice.start(options.delay, options.offset); }
  setListener(transform: ListenerTransform, ramp = 0): void { const listener = this.context.listener, t = this.context.currentTime + Math.max(0, ramp); this.param(listener.positionX, transform.position.x, t); this.param(listener.positionY, transform.position.y, t); this.param(listener.positionZ, transform.position.z, t); this.param(listener.forwardX, transform.forward.x, t); this.param(listener.forwardY, transform.forward.y, t); this.param(listener.forwardZ, transform.forward.z, t); this.param(listener.upX, transform.up.x, t); this.param(listener.upY, transform.up.y, t); this.param(listener.upZ, transform.up.z, t); }
  async resume(): Promise<void> { this.assertLive(); if (this.context.state === "suspended") await this.context.resume(); }
  async suspend(): Promise<void> { this.assertLive(); if (this.context.state === "running") await this.context.suspend(); }
  stats(): AudioStats { return { activeVoices: this.voices.size, cachedClips: this.clips.size, buses: this.buses.size, state: this.context.state }; }
  clearCache(): void { this.clips.clear(); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const voice of this.voices) voice.stop(); this.voices.clear(); for (const bus of this.buses.values()) { bus.rack.clear(); bus.gain.disconnect(); } this.buses.clear(); this.clips.clear(); await this.context.close(); }
  private param(param: AudioParam, value: number, time: number): void { param.linearRampToValueAtTime(value, time); }
  private assertLive(): void { if (this.disposed) throw new Error("AudioSystem is disposed"); }
}

/** Updates a looping spatial voice from simulation state without allocating an audio component. */
export class SpatialAudioEmitter { constructor(readonly voice: AudioVoice) {} update(position: Vec3Ops, forward?: Vec3Ops): void { this.voice.setPosition(position); if (forward) this.voice.setOrientation(forward); } }
