/**
 * The replay file format (`"forge.replay"`, version 1): plain JSON a game can store or send.
 *
 * ```json
 * {
 *   "format": "forge.replay", "version": 1, "hashAlgorithm": "forge-sh1",
 *   "fixedDeltaTime": 0.016666666666666666,
 *   "channels": [{ "name": "car", "size": 6 }],
 *   "parts": ["objects", "physics", "transforms", "vehicles"],
 *   "initial": { "values": [[0, 0, 0, 0, 0, 1]], "hash": "…", "parts": { … } },
 *   "frames": [[0.0166, 1, 0.02], [0.0167, 1, 0.03, [[0, 1, 0, 0, 0, 0, 1]]], …],
 *   "checkpoints": [{ "frame": 59, "hash": "…", "parts": { … } }],
 *   "final": { "frame": 600, "hash": "…", "parts": { … } }
 * }
 * ```
 *
 * A frame is `[dt, fixedSteps, alpha]`, plus a list of channel changes `[channelIndex, ...values]`
 * when any channel's values differ from the previous frame. The schedule (`dt`, `fixedSteps`) is
 * part of the recording because Forge's fixed-step systems are not interleaved: all of a frame's
 * vehicle steps run before its physics steps, so the same steps grouped differently into frames
 * are a different simulation (docs/REPLAY.md). Checkpoint `frame` is the index of the frame whose
 * end the hash describes; `final.frame` is the frame count.
 */

import { UsageError } from "../core/errors.js";

export const REPLAY_FORMAT = "forge.replay";
export const REPLAY_VERSION = 1;

export interface ReplayChannelInfo {
  name: string;
  size: number;
}

export interface ReplayHashRecord {
  hash: string;
  parts: Record<string, string>;
}

export interface ReplayCheckpoint extends ReplayHashRecord {
  /** Index of the frame whose end this hash describes (`final.frame` is the frame count). */
  frame: number;
}

/** `[dt, fixedSteps, alpha]` or `[dt, fixedSteps, alpha, [[channelIndex, ...values], ...]]`. */
export type ReplayFrameRecord = [number, number, number] | [number, number, number, number[][]];

export interface ReplayRecording {
  format: typeof REPLAY_FORMAT;
  version: number;
  hashAlgorithm: string;
  fixedDeltaTime: number;
  channels: ReplayChannelInfo[];
  /** State-hash parts the recording compares. */
  parts: string[];
  initial: ReplayHashRecord & { values: number[][] };
  frames: ReplayFrameRecord[];
  checkpoints: ReplayCheckpoint[];
  final: ReplayCheckpoint;
  meta?: Record<string, string | number | boolean>;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Check a parsed document is a replay this build can play. Throws `UsageError` naming the first
 * problem; returns the document typed.
 */
export function validateReplay(doc: unknown): ReplayRecording {
  const fail = (msg: string): never => {
    throw new UsageError(`replay: ${msg}`);
  };
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) fail("not an object");
  const d = doc as Partial<ReplayRecording>;
  if (d.format !== REPLAY_FORMAT) fail(`format is ${JSON.stringify(d.format)}, expected "${REPLAY_FORMAT}"`);
  if (!isNum(d.version)) fail("missing version");
  if (d.version! > REPLAY_VERSION) fail(`version ${d.version} is newer than this build supports (${REPLAY_VERSION})`);
  if (d.version! < 1) fail(`version ${d.version} is not a replay version`);
  if (typeof d.hashAlgorithm !== "string") fail("missing hashAlgorithm");
  if (!isNum(d.fixedDeltaTime) || d.fixedDeltaTime! < 0) fail("fixedDeltaTime must be a non-negative number");
  if (!Array.isArray(d.channels)) fail("channels must be an array");
  const sizes: number[] = [];
  const names = new Set<string>();
  d.channels!.forEach((c, i) => {
    if (typeof c?.name !== "string" || !Number.isInteger(c.size) || c.size < 0) fail(`channels[${i}] needs a name and an integer size`);
    if (names.has(c.name)) fail(`channels[${i}]: duplicate name "${c.name}"`);
    names.add(c.name);
    sizes.push(c.size);
  });
  if (!Array.isArray(d.parts) || !d.parts.every((p) => typeof p === "string")) fail("parts must be a list of names");
  const hashRec = (r: unknown, where: string): void => {
    const h = r as Partial<ReplayHashRecord>;
    if (typeof h?.hash !== "string" || typeof h.parts !== "object" || h.parts === null) fail(`${where} needs a hash and parts`);
  };
  hashRec(d.initial, "initial");
  if (!Array.isArray(d.initial!.values) || d.initial!.values.length !== sizes.length) fail("initial.values must hold one array per channel");
  d.initial!.values.forEach((v, i) => {
    if (!Array.isArray(v) || v.length !== sizes[i] || !v.every(isNum)) fail(`initial.values[${i}] must be ${sizes[i]} finite numbers`);
  });
  if (!Array.isArray(d.frames)) fail("frames must be an array");
  d.frames!.forEach((f, i) => {
    if (!Array.isArray(f) || f.length < 3 || f.length > 4) fail(`frames[${i}] must be [dt, fixedSteps, alpha] or [dt, fixedSteps, alpha, changes]`);
    if (!isNum(f[0]) || f[0] < 0 || !Number.isInteger(f[1]) || f[1] < 0 || !isNum(f[2])) fail(`frames[${i}] has a bad dt, fixedSteps or alpha`);
    if (f.length === 4) {
      const changes = f[3];
      if (!Array.isArray(changes)) fail(`frames[${i}][3] must be a list of changes`);
      for (const ch of changes as unknown[]) {
        const c = ch as number[];
        if (!Array.isArray(c) || !Number.isInteger(c[0]) || c[0]! < 0 || c[0]! >= sizes.length) fail(`frames[${i}] changes an unknown channel`);
        if (c.length !== sizes[c[0]!]! + 1 || !c.every(isNum)) fail(`frames[${i}]: channel ${c[0]} needs ${sizes[c[0]!]} finite values`);
      }
    }
  });
  if (!Array.isArray(d.checkpoints)) fail("checkpoints must be an array");
  let last = -1;
  d.checkpoints!.forEach((c, i) => {
    hashRec(c, `checkpoints[${i}]`);
    if (!Number.isInteger(c.frame) || c.frame <= last || c.frame >= d.frames!.length) fail(`checkpoints[${i}].frame must increase and name a recorded frame`);
    last = c.frame;
  });
  hashRec(d.final, "final");
  if (d.final!.frame !== d.frames!.length) fail("final.frame must equal the frame count");
  return d as ReplayRecording;
}
