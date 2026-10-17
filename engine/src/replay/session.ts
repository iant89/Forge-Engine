/**
 * Recording and deterministic playback (Phase 19.4).
 *
 * Both sides attach two hooks to a scene:
 *
 *  - an **input point**: a system at order `inputOrder` (default 105 — after the input band 0–100
 *    and `scripts.fixed`, before `vehicles` at 110 and `physics` at 300). The recorder reads every
 *    channel there and logs the frame's `dt` / `fixedSteps` / `alpha`; the player writes the
 *    recorded values there, overriding whatever live input code wrote earlier in the frame.
 *  - an **end-of-frame point**: a scene object appended to `scene.objects`, whose `update` runs
 *    after every system and every earlier scene object. Checkpoint hashes are taken there, so they
 *    describe the frame's finished state, including weather and day/night updates.
 *
 * Playback must start from the state the recording started from: the same scene built the same way
 * (19.3 snapshots will let a save stand in for that). `ReplayPlayer.start()` compares the scene's
 * hash with the recording's initial hash and reports a mismatch before a frame is played.
 *
 * Driving the frames: pass `clock` (an `Engine`'s clock) and the player schedules the recording's
 * frames on it (`Clock.scriptFrames`), so the engine's normal loop plays them at its own pace.
 * Headless code can instead run `player.frame(i)` contexts through `scene.update` itself. Either
 * way the player checks each frame's schedule against the recording and reports a `schedule`
 * divergence if they differ.
 */

import { UsageError } from "../core/errors.js";
import type { Clock, ScriptedFrame } from "../core/time.js";
import { SceneObject, type Scene } from "../scene/scene.js";
import { System, type SystemContext } from "../scene/systems.js";
import type { ReplayChannel } from "./channels.js";
import { STATE_HASH_ALGORITHM, hashSceneState, stateHashParts, type StateHash } from "./hash.js";
import { REPLAY_FORMAT, REPLAY_VERSION, validateReplay, type ReplayCheckpoint, type ReplayFrameRecord, type ReplayRecording } from "./recording.js";

export const REPLAY_INPUT_ORDER = 105;

interface Hooks {
  onInputPoint(context: SystemContext): void;
  onFrameEnd(): void;
}

class ReplayInputSystem extends System {
  readonly name: string;
  override readonly order: number;
  constructor(name: string, order: number, private readonly hooks: Hooks) {
    super();
    this.name = name;
    this.order = order;
  }
  update(context: SystemContext): void {
    this.hooks.onInputPoint(context);
  }
}

class ReplayFrameEnd extends SceneObject {
  readonly name: string;
  constructor(name: string, private readonly hooks: Hooks) {
    super();
    this.name = name;
  }
  override update(): void {
    this.hooks.onFrameEnd();
  }
}

function checkChannels(channels: readonly ReplayChannel[]): void {
  const names = new Set<string>();
  for (const c of channels) {
    if (names.has(c.name)) throw new UsageError(`replay: duplicate channel "${c.name}"`);
    if (!Number.isInteger(c.size) || c.size < 0) throw new UsageError(`replay: channel "${c.name}" has a bad size ${c.size}`);
    names.add(c.name);
  }
}

function readChannel(c: ReplayChannel): number[] {
  const out = new Array<number>(c.size).fill(0);
  c.read(out);
  for (let i = 0; i < out.length; i++) {
    if (typeof out[i] !== "number" || !Number.isFinite(out[i]!)) throw new UsageError(`replay: channel "${c.name}" read a non-finite value at ${i}`);
  }
  return out;
}

function sameValues(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// ====================================================================== recorder

export interface ReplayRecorderOptions {
  channels: readonly ReplayChannel[];
  /** Take a checkpoint hash every this many frames (0 = only the initial and final hashes). Default 60. */
  hashEvery?: number;
  /** State-hash parts to compare (default: every registered part). */
  parts?: readonly string[];
  /** Order of the input point (default 105). Must run after the game's input code and before the simulation. */
  inputOrder?: number;
  meta?: Record<string, string | number | boolean>;
}

export class ReplayRecorder {
  private readonly channels: readonly ReplayChannel[];
  private readonly hashEvery: number;
  private readonly parts: string[];
  private readonly inputOrder: number;
  private readonly meta: Record<string, string | number | boolean> | undefined;
  private frames: ReplayFrameRecord[] = [];
  private checkpoints: ReplayCheckpoint[] = [];
  private last: number[][] = [];
  private initial: (StateHash & { values: number[][] }) | null = null;
  private fixedDeltaTime = 0;
  private systemReg: { dispose(): void } | null = null;
  private endObject: ReplayFrameEnd | null = null;
  private state: "idle" | "recording" | "stopped" = "idle";

  constructor(
    private readonly scene: Scene,
    options: ReplayRecorderOptions,
  ) {
    checkChannels(options.channels);
    this.channels = [...options.channels];
    this.hashEvery = options.hashEvery ?? 60;
    if (!(this.hashEvery >= 0) || !Number.isInteger(this.hashEvery)) throw new UsageError("replay: hashEvery must be a non-negative integer");
    this.parts = options.parts ? [...options.parts].sort() : stateHashParts();
    this.inputOrder = options.inputOrder ?? REPLAY_INPUT_ORDER;
    this.meta = options.meta;
  }

  get recording(): boolean {
    return this.state === "recording";
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Capture the starting state (hash + channel values) and begin recording with the next frame. */
  start(): void {
    if (this.state !== "idle") throw new UsageError("replay recorder: start() may be called once");
    const h = hashSceneState(this.scene, { parts: this.parts });
    this.last = this.channels.map(readChannel);
    this.initial = { ...h, values: this.last.map((v) => [...v]) };
    const hooks: Hooks = { onInputPoint: (c) => this.onInputPoint(c), onFrameEnd: () => this.onFrameEnd() };
    this.systemReg = this.scene.world.registerSystem(new ReplayInputSystem("replay.record", this.inputOrder, hooks));
    this.endObject = new ReplayFrameEnd("replay.record.end", hooks);
    this.scene.addObject(this.endObject);
    this.state = "recording";
  }

  private onInputPoint(context: SystemContext): void {
    if (this.state !== "recording") return;
    if (this.frames.length === 0) this.fixedDeltaTime = context.fixedDt;
    else if (context.fixedSteps > 0 && context.fixedDt !== this.fixedDeltaTime) {
      throw new UsageError(`replay recorder: fixedDt changed from ${this.fixedDeltaTime} to ${context.fixedDt} mid-recording`);
    }
    const changes: number[][] = [];
    this.channels.forEach((c, i) => {
      const now = readChannel(c);
      if (!sameValues(now, this.last[i]!)) {
        changes.push([i, ...now]);
        this.last[i] = now;
      }
    });
    this.frames.push(changes.length > 0 ? [context.dt, context.fixedSteps, context.alpha, changes] : [context.dt, context.fixedSteps, context.alpha]);
  }

  private onFrameEnd(): void {
    if (this.state !== "recording" || this.hashEvery === 0 || this.frames.length === 0) return;
    if (this.frames.length % this.hashEvery === 0) {
      this.checkpoints.push({ frame: this.frames.length - 1, ...hashSceneState(this.scene, { parts: this.parts }) });
    }
  }

  /** End the recording (between frames) and return it. Detaches from the scene. */
  stop(): ReplayRecording {
    if (this.state !== "recording") throw new UsageError("replay recorder: stop() before start()");
    const final: ReplayCheckpoint = { frame: this.frames.length, ...hashSceneState(this.scene, { parts: this.parts }) };
    this.detach();
    this.state = "stopped";
    const rec: ReplayRecording = {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      hashAlgorithm: STATE_HASH_ALGORITHM,
      fixedDeltaTime: this.fixedDeltaTime,
      channels: this.channels.map((c) => ({ name: c.name, size: c.size })),
      parts: this.parts,
      initial: this.initial!,
      frames: this.frames,
      checkpoints: this.checkpoints,
      final,
    };
    if (this.meta) rec.meta = { ...this.meta };
    return rec;
  }

  private detach(): void {
    this.systemReg?.dispose();
    this.systemReg = null;
    if (this.endObject) this.scene.removeObject(this.endObject);
    this.endObject = null;
  }

  /** Abandon a recording without producing one. */
  dispose(): void {
    this.detach();
    this.state = "stopped";
  }
}

// ====================================================================== player

export type ReplayDivergenceKind = "initial" | "schedule" | "checkpoint" | "final";

export interface ReplayDivergence {
  kind: ReplayDivergenceKind;
  /** Frame index (−1 for the initial state; the frame count for the final state). */
  frame: number;
  expected: string;
  actual: string;
  /** State-hash parts whose hashes differ (empty for a schedule divergence). */
  parts: string[];
}

export interface ReplayPlayerOptions {
  /** Channels by name; every recorded channel must be present with the same size. */
  channels: readonly ReplayChannel[];
  /** Schedule the recording's frames on this clock (an `Engine`'s), so the normal loop plays them. */
  clock?: Clock;
  /** Order of the input point (default: 105, as when recording). */
  inputOrder?: number;
  /** Called for every divergence as it is found. */
  onDivergence?: (d: ReplayDivergence) => void;
}

export interface ReplayResult {
  finished: boolean;
  framesPlayed: number;
  framesTotal: number;
  /** Checkpoints compared so far (the final hash counts once played). */
  checkpointsCompared: number;
  divergences: ReplayDivergence[];
  /** True when the whole recording played and every hash matched. */
  ok: boolean;
}

export class ReplayPlayer {
  readonly recording: ReplayRecording;
  private readonly channelMap: ReplayChannel[];
  private readonly inputOrder: number;
  private readonly clock: Clock | null;
  private readonly onDivergence: ((d: ReplayDivergence) => void) | null;
  private readonly checkpointByFrame = new Map<number, ReplayCheckpoint>();
  private next = 0;
  private compared = 0;
  /** Each channel's current recorded values (the recording stores changes; playback writes all). */
  private current: number[][] = [];
  private readonly divergences: ReplayDivergence[] = [];
  private systemReg: { dispose(): void } | null = null;
  private endObject: ReplayFrameEnd | null = null;
  private state: "idle" | "playing" | "finished" | "stopped" = "idle";

  constructor(
    private readonly scene: Scene,
    recording: unknown,
    options: ReplayPlayerOptions,
  ) {
    this.recording = validateReplay(recording);
    if (this.recording.hashAlgorithm !== STATE_HASH_ALGORITHM) {
      throw new UsageError(`replay: recorded with hash "${this.recording.hashAlgorithm}", this build hashes with "${STATE_HASH_ALGORITHM}"`);
    }
    checkChannels(options.channels);
    const byName = new Map(options.channels.map((c) => [c.name, c]));
    this.channelMap = this.recording.channels.map((info) => {
      const c = byName.get(info.name);
      if (!c) throw new UsageError(`replay: no channel named "${info.name}" was supplied (recorded: ${this.recording.channels.map((x) => x.name).join(", ")})`);
      if (c.size !== info.size) throw new UsageError(`replay: channel "${info.name}" has size ${c.size}, the recording has ${info.size}`);
      return c;
    });
    const known = new Set(stateHashParts());
    for (const p of this.recording.parts) if (!known.has(p)) throw new UsageError(`replay: the recording compares state-hash part "${p}", which this build does not register`);
    for (const c of this.recording.checkpoints) this.checkpointByFrame.set(c.frame, c);
    this.inputOrder = options.inputOrder ?? REPLAY_INPUT_ORDER;
    this.clock = options.clock ?? null;
    if (this.clock && this.recording.frames.length > 0 && this.clock.fixedDeltaTime !== this.recording.fixedDeltaTime) {
      throw new UsageError(`replay: the clock steps ${this.clock.fixedDeltaTime} s, the recording ${this.recording.fixedDeltaTime} s`);
    }
    this.onDivergence = options.onDivergence ?? null;
  }

  get framesTotal(): number {
    return this.recording.frames.length;
  }

  get framesPlayed(): number {
    return this.next;
  }

  get finished(): boolean {
    return this.state === "finished";
  }

  /** The schedule of frame `i` (headless drivers build their `SystemContext` from it). */
  frame(i: number): ScriptedFrame {
    const f = this.recording.frames[i];
    if (!f) throw new UsageError(`replay: frame ${i} is out of range (0..${this.framesTotal - 1})`);
    return { dt: f[0], fixedSteps: f[1], alpha: f[2] };
  }

  /**
   * Compare the scene with the recording's start, apply the initial channel values and attach.
   * Returns the initial divergence, if any (playback still runs, so later hashes can be inspected).
   */
  start(): ReplayDivergence | null {
    if (this.state !== "idle") throw new UsageError("replay player: start() may be called once");
    const rec = this.recording;
    const now = hashSceneState(this.scene, { parts: rec.parts });
    const initial = now.hash === rec.initial.hash ? null : this.diverge("initial", -1, rec.initial, now);
    this.current = rec.initial.values.map((v) => [...v]);
    this.channelMap.forEach((c, i) => c.write(this.current[i]!));
    const hooks: Hooks = { onInputPoint: (c) => this.onInputPoint(c), onFrameEnd: () => this.onFrameEnd() };
    this.systemReg = this.scene.world.registerSystem(new ReplayInputSystem("replay.play", this.inputOrder, hooks));
    this.endObject = new ReplayFrameEnd("replay.play.end", hooks);
    this.scene.addObject(this.endObject);
    this.state = rec.frames.length === 0 ? "finished" : "playing";
    if (this.state === "finished") this.compareFinal();
    else if (this.clock) this.clock.scriptFrames(rec.frames.map((f) => ({ dt: f[0], fixedSteps: f[1], alpha: f[2] })));
    return initial;
  }

  private onInputPoint(context: SystemContext): void {
    if (this.state !== "playing") return;
    const f = this.recording.frames[this.next]!;
    if (context.fixedSteps !== f[1] || context.dt !== f[0]) {
      this.divergences.push({ kind: "schedule", frame: this.next, expected: `dt ${f[0]} × ${f[1]} steps`, actual: `dt ${context.dt} × ${context.fixedSteps} steps`, parts: [] });
      this.onDivergence?.(this.divergences[this.divergences.length - 1]!);
    }
    if (f.length === 4) for (const ch of f[3]) this.current[ch[0]!] = ch.slice(1);
    // Every channel, every frame: live input code earlier in the frame may have overwritten it.
    for (let i = 0; i < this.channelMap.length; i++) this.channelMap[i]!.write(this.current[i]!);
  }

  private onFrameEnd(): void {
    if (this.state !== "playing") return;
    const frame = this.next++;
    const cp = this.checkpointByFrame.get(frame);
    if (cp) {
      const now = hashSceneState(this.scene, { parts: this.recording.parts });
      this.compared++;
      if (now.hash !== cp.hash) this.diverge("checkpoint", frame, cp, now);
    }
    if (this.next === this.recording.frames.length) {
      this.state = "finished";
      this.compareFinal();
      this.detachHooks();
    }
  }

  private compareFinal(): void {
    const fin = this.recording.final;
    const now = hashSceneState(this.scene, { parts: this.recording.parts });
    this.compared++;
    if (now.hash !== fin.hash) this.diverge("final", fin.frame, fin, now);
  }

  private diverge(kind: ReplayDivergenceKind, frame: number, expected: { hash: string; parts: Record<string, string> }, actual: StateHash): ReplayDivergence {
    const parts = Object.keys(expected.parts)
      .filter((p) => expected.parts[p] !== actual.parts[p])
      .sort();
    const d: ReplayDivergence = { kind, frame, expected: expected.hash, actual: actual.hash, parts };
    this.divergences.push(d);
    this.onDivergence?.(d);
    return d;
  }

  /** The first divergence (initial, schedule, checkpoint or final), or null. */
  get firstDivergence(): ReplayDivergence | null {
    return this.divergences[0] ?? null;
  }

  result(): ReplayResult {
    return {
      finished: this.state === "finished",
      framesPlayed: this.next,
      framesTotal: this.framesTotal,
      checkpointsCompared: this.compared,
      divergences: [...this.divergences],
      ok: this.state === "finished" && this.divergences.length === 0,
    };
  }

  private detachHooks(): void {
    // Called from inside the scene's object loop: defer removing the object to the next frame
    // boundary by disabling it now (removing mid-iteration would skip the next object).
    this.systemReg?.dispose();
    this.systemReg = null;
    if (this.endObject) this.endObject.enabled = false;
  }

  /** Stop playback (any remaining scripted frames are cancelled) and detach from the scene. */
  stop(): void {
    if (this.state === "playing" && this.clock && this.clock.scriptedFramesRemaining > 0) this.clock.cancelScriptedFrames();
    this.systemReg?.dispose();
    this.systemReg = null;
    if (this.endObject) this.scene.removeObject(this.endObject);
    this.endObject = null;
    if (this.state !== "finished") this.state = "stopped";
  }
}
