# Scene saves and simulation snapshots (Phase 19.1 – 19.3)

A scene save is a versioned JSON document: the scene's entities with their components, transforms
and parent links; the scene settings (lighting, fog, sky, clouds, water, surface weather, shadows,
post); and the *state* of its scene objects (day/night, weather, terrain settings). The code is
`engine/src/scene/serialization.ts`; `tests/scene/sceneSave.test.ts` pins it.

```ts
import { saveScene, loadScene } from "@forge/engine";

const { save, report } = saveScene(scene, { assetId: (obj) => assets.idOf(obj) });
localStorage.setItem("slot1", JSON.stringify(save));          // report.dropped: what could not be written

const fresh = buildScene();                                    // the game's own scene setup (objects, systems)
const loaded = loadScene(fresh, JSON.parse(localStorage.getItem("slot1")!), {
  resolveAsset: (kind, id) => assets.get(kind, id),
});
// loaded.skipped / loaded.unresolvedAssets / loaded.objects: what did not apply, and why
```

`scene.serialize(options)` and `scene.applySerialized(data, options)` are the same two calls as
methods.

## What is saved, and how

| Part | How it is written | How it is read back |
| --- | --- | --- |
| Entity | `{ key, name?, parent?, components }`. `key` is the entity's index in the file. | Created in file order with its name. Ids are not saved: the world assigns new ones. |
| Hierarchy | `parent` is the parent's **key**, so duplicate and empty names round-trip and a parent may come after its child. | Linked after every entity exists. |
| Component | `{ type, data }`. `type` is the **registered name** (`registerComponent(C, { name })`), never `constructor.name`, which a minifier renames. | Looked up in the component registry, built with the registration's `create` when it has one, else `new C()`. |
| Component data | The registration's `serialize` hook, else the component's own `serialize()` method, else field capture (below). | The registration's `deserialize` hook, else field assignment onto the new component. |
| Transform | Local position, rotation (quaternion) and scale. Read from the transform **store**, because systems such as physics write storage directly and the component's mirror fields can be stale. | Set before the component attaches, so the new slot takes that pose. |
| Asset field | `{ "$asset": { kind, id } }`, when the save's `assetId(obj)` names the object. | `resolveAsset(kind, id)`. An unresolved reference is listed in `unresolvedAssets`. |
| Settings | `scene.exportSettings()`. | `scene.importSettings()`, firing the same change events as setting them by hand. |
| Scene object | `{ name, type, state? }`, where `state` is `object.saveState()`. | `loadState(state)` on the scene's object of the same name and class (see below). |

**Field capture** writes numbers, strings, booleans, `null`, `Vec3`, `Quat`, `Double3`, `Color`
and arrays of numbers. Matrices and typed arrays are skipped as derived state. Every other object
field is either an asset reference or listed in the save report's `dropped` (one entry per type and
field). Fields starting with `_` and the `entity` back-reference are never written. A disabled
component carries `"!disabled": true`.

## Scene objects are code, not data

Systems such as `WeatherSystem`, `DayNightCycle` and `TerrainWorld` are constructed by the scene's
own code, with options a save cannot reproduce: callbacks, materials, schedulers. A save carries
their state; loading hands it to the object that has the **same name and class**.

- **`DayNightCycle`** saves the place, the date and time, the clock rate, the simulated seconds,
  the lighting knobs and its atmosphere. The restore is exact: an in-range time of day is not re-wrapped.
- **`WeatherSystem`** saves:
  - the current state, the target and the surface wetness/puddles/snow
  - the simulated clock (the gust field is a pure function of seed and clock)
  - the drive flags and tuning knobs

  Its seed, time constants and gust/patch scales are fixed at construction. When they differ,
  `loadState` returns a warning instead of pretending to apply them.
- **`TerrainWorld`** saves its settings: seed, chunk grid, view distance, LOD count, skirts and
  horizon extent, plus the generator pipeline as a spec and its hash. All of these are fixed at
  construction. `terrainOptionsFromState(state)` gives the options that build a matching world, and
  `loadState` warns about any setting the scene's world does not share.

A saved object the loading scene does not have goes in `objects.missing`. One whose name matches
but whose class does not goes in `objects.mismatched`. Neither is applied.

## Scripts

`ScriptComponent` saves each script as `{ name, enabled, data }`:
- `name` is the script's `scriptName`: the name it was `define`d under, else its class name.
- `data` is its own data fields, captured the way a component's are. An object field is reported as
  dropped under `Script:<name>`.

On load, each script is queued by name. When the world's `ScriptRuntime` adopts the component, it
builds the script from its definitions, applies the saved fields and `enabled`, and only then runs
`onCreate`, so `onCreate` sees the restored values.

Timers, coroutines and event subscriptions are not saved, because they are closures. `onCreate` is
where a script registers them, so it must do that from the restored state.

If the loading runtime does not `define` a saved name, that script is recorded as a script error
(`runtime.errors`) and the component's other scripts still load.

## What loading does with content it cannot use

Loading only throws when the document itself is unusable:
- it isn't an object, or has no version
- it was written by a newer build
- its format tag is wrong, or no migration covers its version

Anything else is reported in the `SceneLoadReport`, and the rest of the scene still loads:

- `skipped`: a component type not registered in this build, one `resolveType` refused, or a
  component whose constructor, hook or `add` threw (for example a second singleton). Each entry
  names the entity key and the type.
- `unresolvedAssets`: asset references the `resolveAsset` callback could not resolve.
- `objects.applied` / `missing` / `mismatched` / `warnings`.

## Versions and migrations (19.2)

`SCENE_SAVE_VERSION` is the version this build writes (currently 2, with `format: "forge.scene"`).
`migrateSceneSave(doc)` brings any supported document up to it, one step at a time. Each step is
registered with `registerSceneSaveMigration(from, fn)`, upgrades version `from` to `from + 1`, and
has its output version checked. A later registration for the same version replaces the shipped step.

Version 1 is the Phase 3 format: parents by name, no format tag. The built-in step
(`migrateSceneSaveV1`) turns names into keys, resolving duplicates the way version 1 did (the last
entity of a name wins). It also carries the settings, the object list and the components over as
they were.

To change the format: bump `SCENE_SAVE_VERSION`, register the step from the previous version, and
add a test that loads a document written in the old version.

## Simulation snapshots (19.3)

A save rebuilds a scene. A **snapshot** captures a scene that is running, so it can be forked or
rolled back and **continue exactly** as it would have:

```ts
import { captureSceneSnapshot, restoreSceneSnapshot, hashSceneSnapshot } from "@forge/engine";

const snap = captureSceneSnapshot(scene);      // JSON-safe; exact through JSON.stringify
// … keep simulating …
restoreSceneSnapshot(scene, snap);             // back to that instant
hashSceneSnapshot(captureSceneSnapshot(scene)) // 8 hex digits: equal state, equal hash
```

A snapshot restores into **the same scene, or one built the same way**: the same entities, in the
same order and with the same names, the same systems and the same scene objects. Restoring checks
all of this first and throws before changing anything if it doesn't match.

| Part | What it holds |
| --- | --- |
| Transforms | Every live entity's local position, rotation and scale. |
| Settings, surface grip | `scene.exportSettings()` and the world's uniform grip. Weather and day/night rewrite fog, sky, clouds and grip as they run, and the systems read them back next step. Without these, a restored session drifted within two steps. |
| Systems | Each world system's `snapshotState()`. The physics system saves its `PhysicsWorld.snapshot()`. A fixed-step system without a hook saves its step count. |
| Components | Each registered component's `snapshot` hook. `Vehicle` saves `Vehicle.snapshot()`. |
| Scene objects | Each object's `snapshotState()`: weather, day/night and the lightning strike schedule. |

The pieces underneath:

- **`core/snapshot.ts`** has `captureState(obj, { skip })` and `restoreState(obj, data)`.
  - Capture walks an object's own fields, private ones included, and records numbers, booleans,
    strings, arrays, typed arrays and nested objects. It ignores functions, the named `skip` fields
    and any object it has already visited.
  - Restore writes back into the existing objects, so a `readonly position = new Vec3()` keeps its
    identity.
  - Numbers are exact through JSON: `-0`, `NaN` and the infinities are tagged, and typed arrays are
    written as `{ "$t", "v" }`.
  - A shape mismatch, such as an array of a different length, is refused.
  - `hashState` is FNV-1a over the canonical JSON (sorted keys).
- **`PhysicsWorld.snapshot()`** saves every body's pose, velocities, force accumulators,
  interpolation poses, sleep state and mass/material parameters, plus the world clock, step count,
  accumulator, gravity and next id.
  - Shapes are construction data and are not included.
  - Bodies are matched **by id, in order**, because body order sets the pair and manifold order.
- **`Vehicle.snapshot()`** is structural: chassis pose and rates, wheels, input, engine, gearbox and
  shift timer, damage flags, and the integrator's previous velocity. A field added to the vehicle
  later is included without touching the method.
- **`Rng.snapshot()`** includes the cached second Gaussian. `save()`/`restore()` are positions only,
  and `restore()` now clears the cache. Before, it replayed a stale value.
- **`LightningSystem`** saves what decides future strikes: its RNG, its next-strike timer and its
  counters. Strikes already in flight and thunder still travelling are transients and are not saved.

## Not covered yet

- **Script timers, coroutines and event subscriptions** are closures, so they are in neither a save
  nor a snapshot. A loaded script re-registers them in `onCreate`. A replay starts from the
  beginning, where they are recreated anyway. Tracked as `serialization.closuresAndTransients`.
- **The engine clock** is the caller's. A snapshot restores simulation state, and whoever drives
  `scene.update` keeps stepping it.
- **Replay (19.4)** is separate from saves and snapshots: input, frame schedule and per-part state
  hashes, in `docs/REPLAY.md`.
