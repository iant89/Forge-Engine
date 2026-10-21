# Forge Editor

Phase 26 is the authoring layer above the runtime. `@forge/editor` is a separate workspace that
imports runtime symbols only from the public `@forge/engine` barrel. The runtime never imports the
editor; `npm run lint:arch` and `tests/engine/architecture.test.ts` enforce both directions.

## Workspace quick start

`EditorSession` is the small document model. `EditorWorkspace` adds multi-selection, CRUD, gizmo
commits, material/terrain/particle authoring and specialist panel snapshots. Both are DOM-free and
can be hosted by Forge UI, the browser DOM, a test, or an external tool.

```ts
import { EditorWorkspace, mountEditorShell } from "@forge/editor";
import { Scene } from "@forge/engine";

const scene = new Scene({ name: "Mars authoring" });
const workspace = new EditorWorkspace(scene, { engine });
const rover = workspace.createEntity("Perseverance", {
  components: [{ type: "Transform", fields: { position: [0, 1.2, 0] } }],
});
workspace.select(rover);
workspace.setLocalTransform(rover, { position: [4, 1.2, -3] });
workspace.setSceneSettings({ fog: { density: 0.0008 } });
const saved = workspace.save();

// Optional browser host. It owns the scene/engine loop; the shell does not step or dispose them.
const shell = mountEditorShell({ root: document.querySelector("#editor")!, workspace });
```

A host can attach a complete Mars scene produced by the existing public runtime/example factories and
immediately modify its terrain focus, material values, environment settings, vehicle entities and
component properties. It can also create/duplicate/delete ordinary scene entities, then save the
result with `workspace.save()`—no engine source edit is part of that workflow. `EditorWorkspace`
never owns or steps the scene, pauses simulation, or assumes a renderer; the host remains responsible
for scene lifetime, the render loop, save/load and any viewport canvas.

## Document model

`hierarchy()` returns a bounded, copied, deterministic root-first preorder snapshot. Rows include an
entity id, fallback label, parent, depth, child count, component names, selection, expansion and
filter-match state. Filtering is case-insensitive: names use substring matching and component types
use exact matching. Matching rows include ancestors for context. Collapse state and selection are
editor-local; they do not mutate the scene document.

`inspect()` returns copied name, parent/children, authoritative local position/rotation/scale and
registered component summaries (`editorGroup`, enabled state and bounded scalar/vector fields).
`setComponentFields()` edits validated fields without exposing a live component object. Registered
components can be added when creating an entity; create, duplicate, delete, rename, reparent,
world-pose-preserving reparent, transform, enabled and generic field edits participate in bounded
undo/redo. Generational stale entity handles fail closed when the host destroys an entity.

## Transform gizmo

`gizmo.ts` contains renderer-independent axis picking, translate/rotate/scale drag math and snapping.
It accepts a world-space ray and hit point and returns an `EditorTransformPatch`; the host can draw
any visual gizmo it wants and commit the patch through `workspace.setLocalTransform()`. This keeps
camera projection, GPU buffers, pointer capture and viewport policy out of the editor package while
making the math deterministic and testable.

```ts
import { beginGizmoDrag, pickGizmoAxis, updateGizmoDrag } from "@forge/editor";

const pick = pickGizmoAxis(ray, pivot, { tolerance: 0.12 });
if (pick) {
  const drag = beginGizmoDrag("translate", pick.axis, pivot, hitPoint, workspace.inspect()!.transform!);
  const patch = updateGizmoDrag(drag, nextHitPoint, { snap: 0.25 });
  workspace.setLocalTransform(workspace.primarySelection!, patch);
}
```

## Specialist panels

`workspace.panel(id)` and `workspace.panels()` return bounded plain-data snapshots. They deliberately
adapt existing public runtime services rather than duplicate simulation or rendering internals.

| Panel | Runtime surface | Authoring surface |
| --- | --- | --- |
| Terrain | `TerrainWorld` through `inspectTerrain` | focus, forward direction and layered-material visibility via `setTerrain` |
| Material | public `Material` fields and `Renderable` components | color, PBR values, opacity, flags, tiling and offset via `setMaterial` |
| Particles | `inspectParticles` plus CPU `ParticleSimulation` | selected/first CPU emitter settings via `setParticles` |
| Vehicle | `VehicleComponent.vehicle` telemetry/config | inspector snapshot; vehicle simulation remains runtime-owned |
| Environment | `inspectEnvironment` | validated scene-settings patches via `setSceneSettings` |
| Streaming | `inspectStreaming(engine)` | diagnostic snapshot; queue control remains `AssetStreamer`-owned |
| Render Graph | `inspectRenderGraph(engine.renderer.graph)` | diagnostic snapshot; pass construction remains renderer-owned |
| Assets | public `ResourceRegistry` and `AssetStreamer` metadata | bounded filter, dependency/dependent inventory, load state, `requestAsset()` and `cancelAsset()` |
| Profiler | public profiler frame/scope APIs and `frameTimeline` | diagnostic snapshot; profiling remains engine-owned |

Unavailable optional services return `{ available: false, data: null, message }` instead of making a
host guard every panel. This is important for a headless `Scene` test and for editor startup before an
engine/renderer is attached.

## Visible shell

`mountEditorShell()` provides a deliberately small browser shell: toolbar undo/redo/create/duplicate/
delete actions, a filterable hierarchy, copied inspector controls, a viewport slot, and tabs for all
specialist panels. It is not a renderer or a UI framework. A host can pass its own viewport element,
replace regions, or use the same workspace with Forge UI. The shell is optional; importing the
headless package does not require a DOM.

## Public boundary and verification

Editor source imports `@forge/engine` only from its package root. No deep `engine/src` import is
allowed. The focused suite `tests/editor/editor.test.ts` covers hierarchy/inspection/history, CRUD,
world-pose-preserving reparent, generic fields, gizmo math, material editing, panel availability and
scene-settings authoring. Typecheck and architecture checks are run from the repository root.
