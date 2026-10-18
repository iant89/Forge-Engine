/**
 * Phase 19.4 replay: input recording, deterministic playback and state hashing (docs/REPLAY.md).
 */

export { STATE_HASH_ALGORITHM, StateHasher, hashSceneState, registerStateHashContributor, stateHashParts, unregisterStateHashContributor, type HashSceneStateOptions, type StateHash, type StateHashContributor } from "./hash.js";
export { fieldsChannel, vehicleInputChannel, type ReplayChannel } from "./channels.js";
export { REPLAY_FORMAT, REPLAY_VERSION, validateReplay, type ReplayChannelInfo, type ReplayCheckpoint, type ReplayFrameRecord, type ReplayHashRecord, type ReplayRecording } from "./recording.js";
export { REPLAY_INPUT_ORDER, ReplayPlayer, ReplayRecorder, type ReplayDivergence, type ReplayDivergenceKind, type ReplayPlayerOptions, type ReplayRecorderOptions, type ReplayResult } from "./session.js";
