# Forge Editor

Phase 26 builds authoring tools **above** the runtime. The editor is a separate `@forge/editor`
workspace and depends only on the public `@forge/engine` package. No file under `engine/src` imports
editor code; both `npm run lint:arch` and `tests/engine/architecture.test.ts` enforce that direction.

## Current Phase 26 slice

The first slice is a DOM-free document model. It is intentionally usable by a future Forge UI panel,
a conventional browser DOM shell, or an external host without putting editor policy into the engine.

```ts
import { EditorSession } from "@forge/editor";
import { Scene } from "@forge/engine";

const scene = new Scene({ name: "Workshop" });
const editor = new EditorSession(scene);

const hierarchy = editor.hierarchy({ filter: "camera", limit: 500 });
editor.select(hierarchy.rows[0]?.id ?? null);
const selected = editor.inspect();

editor.renameEntity(selected!.id, "Survey Camera");
editor.setLocalTransform(selected!.id, { position: [0, 2.5, 0] });
editor.undo();
```

`EditorSession` never owns or steps the `Scene`. The host remains responsible for scene lifetime,
rendering, pausing simulation while authoring, saving and loading.

### Scene hierarchy

`hierarchy()` returns a bounded plain-data snapshot in deterministic root-first preorder. Rows carry
entity id, name/fallback label, parent, depth, child count, component names, selection and expansion
state. Collapse state is editor-local and never modifies the scene. Filtering is case-insensitive:
entity names use substring matching and component types use exact matching. Matching rows include
their ancestors for context, even when an ancestor was collapsed.

The model supports single selection, collapse/expand, undoable rename and undoable reparent. Reparent
retains the entity's **local** transform, so its world pose can change under the new parent. Create,
duplicate, delete, drag/drop presentation and world-pose-preserving reparent remain future work.

### Entity and component inspection

`inspect()` returns copied data for the selected entity:

- name, parent and direct children,
- authoritative local position/rotation/scale when a transform slot exists,
- registered component type and `editorGroup`, enabled state, and bounded scalar/vector fields.

The first editing seam supports validated local transform changes and component enable/disable. It
does not expose arbitrary live component objects. Generic schema-driven field editors, add/remove
component operations and specialist component panels belong to later Phase 26 slices.

### Command history and stale handles

`EditorHistory` is bounded (100 entries by default), clears redo on a new command, and preserves stack
integrity when an apply/revert callback throws. `EditorSession` records rename, reparent, transform and
component-enabled changes. Selection itself and expand/collapse view state are not document history.

Entity ids are generational engine handles. If the host destroys an entity, a selected stale handle
is cleared and command history is invalidated rather than allowing an old command to target a reused
slot. Edits validate entity, transform and component identity each time they apply or revert.

## Not implemented yet

This slice does **not** provide a visible editor application, viewport docking, transform gizmos,
entity creation/deletion, generic property widgets, terrain/material/particle/vehicle/environment
editors, streaming/render-graph views, an asset browser, or a profiler panel. Existing runtime debug
inspectors remain read-only runtime tools; they are evidence/data sources, not completion of Phase 26.
The phase remains `inProgress` until a complete Mars scene can be created and modified without editing
engine source code.
