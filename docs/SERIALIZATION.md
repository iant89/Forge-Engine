# Scene saves (Phase 19.1 + 19.2)

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

## Not covered yet

- **Simulation state (19.3).** Rigid bodies, vehicles and RNG streams are not in a save. The
  `serialization.snapshots` capability tracks this. Weather and day/night restore their clocks, which
  is all their simulation needs.
- **Replay (19.4)**: input recording, playback and state hashing. Tracked by `determinism.replay`.
