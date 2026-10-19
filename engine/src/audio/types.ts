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
  /** Voices counting against `maxVoices`. */
  activeVoices: number;
  /** Voices fading out after being stolen or stopped with a fade. */
  releasingVoices: number;
  /** Voices stolen by the limit since the system was created. */
  stolenVoices: number;
  streams: number;
  /** Clips the system keeps (loaded through `load`). */
  cachedClips: number;
  /** Decoded bytes of every audio clip in the registry, kept or idle (frames × channels × 4). */
  clipBytes: number;
  /** Seconds of decoded audio held by the clip cache, summed over channels. */
  decodedSeconds: number;
  buses: number;
  state: AudioContextState;
}
