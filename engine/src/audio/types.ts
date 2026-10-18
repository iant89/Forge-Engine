import type { Vec3Ops } from "../math/vec.js";

export type AudioBusName = "master" | "music" | "sfx" | "dialogue" | "ambient" | (string & {});

export interface AudioClip {
  readonly buffer: AudioBuffer;
  /** Registry id (`audio:<url>` / `audio:procedural/<name>`) when it came from one. */
  readonly id?: string;
  /** The source that decoded (the first playable of a clip's alternatives). */
  readonly url?: string;
  readonly duration: number;
  readonly channels: number;
  readonly sampleRate: number;
}

export interface SpatialOptions {
  position?: Vec3Ops;
  orientation?: Vec3Ops;
  distanceModel?: DistanceModelType;
  panningModel?: PanningModelType;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  coneInnerAngle?: number;
  coneOuterAngle?: number;
  coneOuterGain?: number;
}

export interface PlayOptions extends SpatialOptions {
  bus?: AudioBusName;
  volume?: number;
  playbackRate?: number;
  detune?: number;
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number;
  delay?: number;
  offset?: number;
  spatial?: boolean;
  fadeIn?: number;
}

export interface ListenerTransform {
  position: Vec3Ops;
  forward: Vec3Ops;
  up: Vec3Ops;
}

export interface AudioStats {
  activeVoices: number;
  /** Clips the system holds a handle for (loaded through `load`). */
  cachedClips: number;
  /** Decoded bytes of every audio clip in the registry (held or idle). */
  clipBytes: number;
  buses: number;
  state: AudioContextState;
}
