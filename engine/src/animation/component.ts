/**
 * Animation component — attaches animation playback state to an entity.
 *
 * The component is a thin state container: it references clips, holds the playback cursor, and
 * stores blend weights. The actual sampling + transform application is done by `AnimationSystem`
 * (order 300) to keep the ECS contract clean: components hold data, systems hold behaviour.
 *
 * Usage:
 *  ```
 *  const anim = entity.addComponent(Animation);
 *  anim.addClip(walkClip);
 *  anim.addClip(runClip);
 *  anim.play("walk");
 *  ```
 *
 * Multiple clips can play simultaneously for crossfade blending. The system samples each playing
 * clip into a per-node TRS buffer, blends them, and applies the result to the joint entities'
 * `Transform` components.
 */

import { Component, registerComponent } from "../scene/components.js";
import type { AnimationClip } from "./clip.js";

/** Playback state for a single clip instance. */
export interface ClipPlayback {
  clip: AnimationClip;
  /** Current playback time in seconds (0..clip.duration for non-looping). */
  time: number;
  /** Playback speed multiplier (1 = normal, negative = reverse). */
  speed: number;
  /** Whether the clip loops when it reaches the end. */
  looping: boolean;
  /** Blend weight [0..1] — used when multiple clips play simultaneously. */
  weight: number;
  /** Whether this clip is currently playing. */
  playing: boolean;
}

/**
 * Animation playback state for one entity (typically the root of a skeleton hierarchy).
 *
 * The component owns a map of clip names to their playback state. Multiple clips can play
 * at once for crossfade; blend weights are normalised by the system before sampling.
 */
export class AnimationComponent extends Component {
  /** Clip name → playback state. */
  private clips = new Map<string, ClipPlayback>();

  /** Node index → entity id mapping (set during skeleton assembly). */
  nodeToEntity: readonly number[] = [];

  /** The max joint count across all attached clips (sized for the TRS buffer). */
  get jointCount(): number {
    return this.nodeToEntity.length;
  }

  /** Add a clip and prepare it for playback (initially paused at time 0). */
  addClip(clip: AnimationClip): void {
    this.clips.set(clip.name, {
      clip,
      time: 0,
      speed: 1,
      looping: false,
      weight: 1,
      playing: false,
    });
  }

  /** Remove a clip by name. Stops it first if playing. */
  removeClip(name: string): void {
    this.clips.delete(name);
  }

  /** Start or resume a clip by name. */
  play(name: string): void {
    const playback = this.clips.get(name);
    if (playback) {
      playback.playing = true;
    }
  }

  /** Pause a clip by name without resetting its time. */
  pause(name: string): void {
    const playback = this.clips.get(name);
    if (playback) {
      playback.playing = false;
    }
  }

  /** Stop a clip and reset its time to 0. */
  stop(name: string): void {
    const playback = this.clips.get(name);
    if (playback) {
      playback.playing = false;
      playback.time = 0;
    }
  }

  /** Stop all clips. */
  stopAll(): void {
    for (const playback of this.clips.values()) {
      playback.playing = false;
      playback.time = 0;
    }
  }

  /** Set playback speed for a clip. */
  setSpeed(name: string, speed: number): void {
    const playback = this.clips.get(name);
    if (playback) playback.speed = speed;
  }

  /** Set looping for a clip. */
  setLooping(name: string, looping: boolean): void {
    const playback = this.clips.get(name);
    if (playback) playback.looping = looping;
  }

  /** Set blend weight for a clip. */
  setWeight(name: string, weight: number): void {
    const playback = this.clips.get(name);
    if (playback) playback.weight = weight;
  }

  /** Set the time cursor for a clip. */
  setTime(name: string, time: number): void {
    const playback = this.clips.get(name);
    if (playback) playback.time = time;
  }

  /** Get the playback state for a clip. */
  getPlayback(name: string): ClipPlayback | undefined {
    return this.clips.get(name);
  }

  /** Get all currently playing clips (for the system to iterate). */
  getPlayingClips(): ClipPlayback[] {
    const result: ClipPlayback[] = [];
    for (const playback of this.clips.values()) {
      if (playback.playing) result.push(playback);
    }
    return result;
  }

  /** Whether any clip is currently playing. */
  get isPlaying(): boolean {
    for (const playback of this.clips.values()) {
      if (playback.playing) return true;
    }
    return false;
  }

  /** All clip names. */
  get clipNames(): IterableIterator<string> {
    return this.clips.keys();
  }
}

registerComponent(AnimationComponent as never, { name: "Animation", allowMultiple: false, editorGroup: "Animation" });