# Replay (Phase 19.4)

Record what a player did, play it back, and prove the playback produced the same simulation. The
code is `engine/src/replay/`; `tests/replay/replay.test.ts` pins it. A replay is input plus a frame
schedule plus state hashes — not a video and not a state dump — so a 10-minute drive is a few
hundred kilobytes of JSON.

```ts
import { ReplayRecorder, ReplayPlayer, vehicleInputChannel } from "@forge/engine";

// Recording: the game's own input code keeps running; the recorder reads the result each frame.
const recorder = new ReplayRecorder(scene, { channels: [vehicleInputChannel("car", vehicle)] });
recorder.start();
// … play normally …
const recording = recorder.stop();                    // plain JSON: JSON.stringify(recording)

// Playback: build the scene the same way it was built for the recording, then
const player = new ReplayPlayer(freshScene, JSON.parse(saved), {
  channels: [vehicleInputChannel("car", freshVehicle)],
  clock: engine.clock,                                // the engine's own loop plays the frames
  onDivergence: (d) => console.warn(d),               // { kind, frame, expected, actual, parts }
});
player.start();                                       // returns an initial-state mismatch, if any
// … engine.step() as usual; when player.finished: player.result().ok …
```

## What is recorded

| Part | What | Why |
| --- | --- | --- |
| Channels | Named groups of numbers the simulation reads but does not produce: a vehicle's throttle, brake, steer, handbrake, parking brake and gear (`vehicleInputChannel`), or any object's numeric/boolean fields (`fieldsChannel`), or your own `{ name, size, read, write }`. Stored only when they change. | This is the player's input. |
| Frame schedule | Every frame's `dt`, fixed-step count and interpolation alpha. | Forge's fixed-step systems are **not interleaved** (all of a frame's vehicle steps run before its physics steps; `docs/KNOWN-ISSUES.md`), so the same steps grouped into different frames are a different simulation. Variable-rate systems (scripts, weather, day/night) also read `dt`. |
| Initial hash | The scene's state hash when recording started, plus each channel's starting values. | Playback must start from the same state; the player checks this first. |
| Checkpoints | A state hash every `hashEvery` frames (default 60) and at the end. | Where playback is verified, and how far a divergence can hide. |

Values are doubles written as JSON numbers, which round-trip exactly, so a played-back input is
bit-identical to the recorded one.

## Where it hooks in

Both the recorder and the player add two hooks to the scene:

- **Input point**: a system at order 105 (`REPLAY_INPUT_ORDER`). This is after the input band
  (0–100) and `scripts.fixed`, and before `vehicles` (110) and `physics` (300).
  - The recorder reads every channel there, after the game's input code has written it.
  - The player writes every channel there, every frame, so live devices and input code that keep
    running are overridden. You do not have to switch them off, though you usually want to.
  - Pass `inputOrder` if your input code runs later.
- **End of frame**: a scene object appended to `scene.objects`. Objects update after every system,
  so checkpoint hashes describe the finished frame, including weather and day/night.
  - Objects added *after* recording or playback starts run after this hook. Add them first.
  - The hook is named `replay.record.end` / `replay.play.end`, and a scene save made during a
    recording lists it.

## Driving playback

- **In a running engine**: pass `clock: engine.clock`. The player schedules the recording's frames
  on it (`Clock.scriptFrames`), and the engine's normal loop plays them one per `step()` at whatever
  pace the device manages.
  - Each `tick()` reports the recorded `dt` and fixed steps; wall time, pause, time scale and the
    catch-up limit do not apply.
  - When the schedule runs out, the clock carries on from wall time without a jump.
  - `player.stop()` cancels any frames not yet played.
- **Headless** (tests, servers, verification jobs): build each frame's `SystemContext` from
  `player.frame(i)` and call `scene.update`, or script a `ManualClock` and step it.

Either way the player compares each frame's `dt` and fixed steps with the recording and reports a
`schedule` divergence if they differ.

## State hashing

`hashSceneState(scene)` returns `{ hash, parts }`. Each part is a named contributor that folds
exact IEEE-754 bits into a 64-bit fingerprint (`StateHasher`). Built-in parts:

| Part | Contents |
| --- | --- |
| `transforms` | Every live entity with a transform, in id order: id and local position, rotation and scale from the transform store. |
| `physics` | Every body of every physics world the scene uses (physics systems' worlds, then vehicle chassis worlds): type, pose, linear and angular velocity, sleep state. |
| `vehicles` | Each `VehicleComponent`'s vehicle: pose, velocity, yaw/pitch/roll and their rates, acceleration, rpm, distance, step count, gear and shift state, the input it last saw. Each wheel: spin, steering, suspension, loads, forces, slip and contact. |
| `objects` | Each scene object's `saveState()` (weather, day/night, terrain settings), canonically. |

`registerStateHashContributor("game.inventory", (scene, h) => …)` adds a part. A contributor must
read state only and visit it in a deterministic order: ids or insertion order, never wall time.

A divergence names the parts whose hashes differ. If `vehicles` differs but `physics` does not, the
vehicle step went wrong before anything collided.

The hash function is part of the format. Recordings carry `hashAlgorithm: "forge-sh1"`, and the
suite pins its digests so a change cannot silently invalidate saved recordings.

## Divergences

`player.result()` → `{ finished, framesPlayed, framesTotal, checkpointsCompared, divergences, ok }`.
Each divergence is `{ kind, frame, expected, actual, parts }`:

- `initial`: the scene did not start where the recording started (built differently, a different
  seed, a different settle time). Reported by `start()`; playback still runs.
- `schedule`: a frame ran a different `dt` or fixed-step count than recorded (a headless driver
  that did not follow `player.frame(i)`).
- `checkpoint` / `final`: the state hash differs at that frame's end. The first one lies at or
  after the real divergence, never more than `hashEvery` frames later. Hash every frame
  (`hashEvery: 1`) to pin it exactly.

## What makes a scene replayable

- Nothing in the simulation reads wall time, `Math.random()` or unseeded randomness. Use `Rng` with a
  seed that is part of the scene's construction.
- Everything a player influences goes through a channel.
- Playback runs on the same JavaScript engine family as the recording. Arithmetic on doubles is
  identical everywhere, but `Math.sin`, `Math.exp` and friends are only required to be
  approximately right, so V8, JavaScriptCore and SpiderMonkey can differ in the last bit. A replay
  recorded in Chrome may diverge in Safari. Cross-engine verification is part of 19.5.
- Playback starts from the state recording started from. There are two ways to get there:
  - Build the scene the same way.
  - Save a simulation snapshot (19.3, `captureSceneSnapshot`) when recording starts, and restore it
    into a fresh build before playing. 19.3 matches bodies, so step the fresh scene once first to
    let `PhysicsSystem` create them.

  A scene save (19.1) alone is not enough: it restores configuration, not rigid-body, vehicle or
  RNG state.

## Format

`"forge.replay"`, version 1. The full layout is documented in `engine/src/replay/recording.ts`.
`validateReplay(doc)` checks a parsed document and names the first problem. The player also refuses:
- a recording whose channels you did not supply, or supplied with a different size
- a different hash algorithm
- a clock with a different fixed step
