/**
 * @suite editor:editor
 * @group unit
 * @covers editor/src/history.ts
 * @covers editor/src/index.ts
 * @covers editor/src/session.ts
 * @covers editor/src/gizmo.ts
 * @covers editor/src/panels.ts
 * @covers editor/src/workspace.ts
 * @covers editor/src/shell.ts
 * @desc Phase 26.1–26.13 public-API-only hierarchy, authoring workspace, gizmos, specialist panels and shell
 */

export const suite = {
  name: "editor:editor",
  group: "unit",
  covers: [
    "editor/src/history.ts",
    "editor/src/index.ts",
    "editor/src/session.ts",
    "editor/src/gizmo.ts",
    "editor/src/panels.ts",
    "editor/src/workspace.ts",
    "editor/src/shell.ts",
  ],
  desc: "Phase 26.1–26.13 public-API-only hierarchy, authoring workspace, gizmos, specialist panels and shell",
};

import assert from "node:assert/strict";
import {
  EditorHistory,
  EditorSession,
  EditorWorkspace,
  beginGizmoDrag,
  pickGizmoAxis,
  updateGizmoDrag,
} from "@forge/editor";
import { Component, Mat4, Material, Renderable, Scene, Transform, UsageError, registerComponent } from "@forge/engine";
import { finish, group, test } from "selrun";

class EditorFixtureComponent extends Component {
  health = 75;
  label = "editable fixture";
}
registerComponent(EditorFixtureComponent, { editorGroup: "Gameplay", allowMultiple: false });

function makeScene(): {
  scene: Scene;
  root: ReturnType<Scene["createEntity"]>;
  child: ReturnType<Scene["createEntity"]>;
  grandchild: ReturnType<Scene["createEntity"]>;
  unnamed: ReturnType<Scene["createEntity"]>;
  fixture: EditorFixtureComponent;
} {
  const scene = new Scene({ name: "Editor fixture" });
  const root = scene.createEntity("Rover");
  root.add(new Transform()).setPosition(1, 2, 3);
  const child = scene.createEntity("Camera Mast");
  child.add(new Transform()).setPosition(0, 1, 0);
  const fixture = child.add(new EditorFixtureComponent());
  const grandchild = scene.createEntity("Navigation Camera");
  grandchild.add(new Transform());
  const unnamed = scene.createEntity();
  unnamed.add(new Transform());
  scene.world.setParent(child.id, root.id);
  scene.world.setParent(grandchild.id, child.id);
  return { scene, root, child, grandchild, unnamed, fixture };
}

group("Phase 26 editor document model", () => {
  test("builds a bounded hierarchy with collapse, ancestor-context filtering and stable selection", () => {
    const { scene, root, child, grandchild, unnamed } = makeScene();
    const session = new EditorSession(scene);
    const generation = scene.world.generation;

    const initial = session.hierarchy();
    assert.deepEqual(initial.rows.map((row) => row.id), [root.id, child.id, grandchild.id, unnamed.id]);
    assert.deepEqual(initial.rows.map((row) => row.depth), [0, 1, 2, 0]);
    assert.equal(initial.rows[3]!.label.startsWith("Entity "), true);
    assert.equal(initial.totalEntities, 4);
    assert.equal(initial.matchingEntities, 4);
    assert.equal(initial.truncated, false);
    assert.equal(scene.world.generation, generation, "hierarchy snapshots must be read-only");

    assert.equal(session.setExpanded(root.id, false), true);
    assert.deepEqual(session.hierarchy().rows.map((row) => row.id), [root.id, unnamed.id]);
    assert.equal(session.setExpanded(root.id, false), false);

    const componentFilter = session.hierarchy({ filter: "editorfixturecomponent" });
    assert.deepEqual(componentFilter.rows.map((row) => row.id), [root.id, child.id]);
    assert.deepEqual(componentFilter.rows.map((row) => row.matchesFilter), [false, true]);
    const descendantFilter = session.hierarchy({ filter: "navigation" });
    assert.deepEqual(descendantFilter.rows.map((row) => row.id), [root.id, child.id, grandchild.id]);
    assert.equal(session.hierarchy({ limit: 1 }).truncated, true);
    assert.deepEqual(session.hierarchy({ limit: 0 }).rows, []);

    const changes: (number | null)[] = [];
    session.selectionChanged.on(({ current }) => changes.push(current));
    assert.equal(session.select(child.id), true);
    assert.equal(session.select(child.id), false);
    assert.equal(session.hierarchy({ filter: "mast" }).rows[1]!.selected, true);
    assert.deepEqual(changes, [child.id]);

    session.dispose();
    scene.dispose();
  });

  test("inspects copied public data and applies undoable rename, hierarchy, transform and component edits", () => {
    const { scene, root, child, grandchild, fixture } = makeScene();
    const session = new EditorSession(scene, { historyLimit: 8 });
    session.select(child.id);

    const inspected = session.inspect()!;
    assert.equal(inspected.name, "Camera Mast");
    assert.equal(inspected.parent, root.id);
    assert.deepEqual(inspected.children, [grandchild.id]);
    assert.deepEqual(inspected.transform, {
      position: [0, 1, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    assert.deepEqual(inspected.components.find((entry) => entry.type === "Transform")!.fields, {
      position: [0, 1, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    const component = inspected.components.find((entry) => entry.type === "EditorFixtureComponent")!;
    assert.equal(component.group, "Gameplay");
    assert.deepEqual(component.fields, { health: 75, label: "editable fixture" });
    (component.fields as { health: number }).health = -1;
    assert.equal((session.inspect()!.components.find((entry) => entry.type === "EditorFixtureComponent")!.fields.health), 75);

    const documentKinds: string[] = [];
    session.documentChanged.on((change) => documentKinds.push(change.kind));

    assert.equal(session.renameEntity(child.id, "Remote Sensing Mast"), true);
    assert.equal(child.name, "Remote Sensing Mast");
    assert.equal(session.history.state.nextUndoLabel, "Rename Camera Mast");
    assert.equal(session.undo(), true);
    assert.equal(child.name, "Camera Mast");
    assert.equal(session.redo(), true);
    assert.equal(child.name, "Remote Sensing Mast");

    session.history.clear();
    assert.equal(session.reparentEntity(grandchild.id, root.id), true);
    assert.equal(grandchild.parent?.id, root.id);
    session.undo();
    assert.equal(grandchild.parent?.id, child.id);
    session.redo();
    assert.equal(grandchild.parent?.id, root.id);

    session.history.clear();
    assert.equal(session.setLocalTransform(child.id, {
      position: [4, 5, 6],
      rotation: [0, 0, 0, 1],
      scale: [2, 3, 4],
    }), true);
    assert.deepEqual(session.inspect(child.id)!.transform, {
      position: [4, 5, 6],
      rotation: [0, 0, 0, 1],
      scale: [2, 3, 4],
    });
    assert.deepEqual(child.require(Transform).position.toArray(), [4, 5, 6], "component mirror follows editor writes");
    session.undo();
    assert.deepEqual(session.inspect(child.id)!.transform?.position, [0, 1, 0]);

    session.history.clear();
    assert.equal(session.setComponentEnabled(child.id, "EditorFixtureComponent", false), true);
    assert.equal(fixture.enabled, false);
    session.undo();
    assert.equal(fixture.enabled, true);
    assert.ok(documentKinds.includes("rename"));
    assert.ok(documentKinds.includes("reparent"));
    assert.ok(documentKinds.includes("transform"));
    assert.ok(documentKinds.includes("component"));

    session.history.clear();
    assert.throws(() => session.reparentEntity(root.id, child.id), /cycle detected/);
    assert.equal(session.history.canUndo, false, "failed commands are not retained");
    assert.throws(() => session.setLocalTransform(child.id, { position: [Number.NaN, 0, 0] }), /finite numbers/);
    assert.equal(session.history.canUndo, false);
    const noTransform = scene.createEntity("Data only");
    assert.throws(() => session.setLocalTransform(noTransform.id, { position: [1, 2, 3] }), /no Transform component/);

    session.dispose();
    scene.dispose();
  });

  test("clears stale selection and history when the host destroys an entity", () => {
    const { scene, child } = makeScene();
    const session = new EditorSession(scene);
    session.select(child.id);
    session.renameEntity(child.id, "Soon removed");
    assert.equal(session.history.canUndo, true);
    scene.world.destroyEntity(child.id);
    assert.equal(session.selection, null);
    assert.equal(session.history.canUndo, false);
    assert.equal(session.inspect(child.id), null);
    scene.dispose();
    assert.throws(() => session.hierarchy(), /scene has been disposed/);
    session.dispose();
    assert.throws(() => session.hierarchy(), /EditorSession has been disposed/);
  });
});

group("Editor command history", () => {
  test("is bounded and retains a command when undo throws", () => {
    const history = new EditorHistory({ limit: 2 });
    let value = 0;
    let blockUndo = true;
    history.execute({ label: "First", apply: () => { value = 1; }, revert: () => {
      if (blockUndo) throw new UsageError("blocked");
      value = 0;
    } });
    assert.throws(() => history.undo(), /blocked/);
    assert.equal(history.state.undoDepth, 1);
    assert.equal(value, 1);
    blockUndo = false;
    assert.equal(history.undo(), true);
    assert.equal(value, 0);
    assert.equal(history.redo(), true);
    assert.equal(value, 1);

    history.execute({ label: "Second", apply: () => { value = 2; }, revert: () => { value = 1; } });
    history.execute({ label: "Third", apply: () => { value = 3; }, revert: () => { value = 2; } });
    assert.equal(history.state.undoDepth, 2);
    assert.equal(history.state.nextUndoLabel, "Third");
    assert.equal(history.undo(), true);
    assert.equal(value, 2);
  });
});

group("Phase 26 authoring extensions", () => {
  test("keeps world pose during reparent and restores CRUD subtrees through history", () => {
    const { scene, root, child, grandchild, fixture } = makeScene();
    const session = new EditorSession(scene);
    session.history.clear();
    scene.world.updateTransforms([]);
    const beforeWorld = scene.world.getWorldMatrix(child.id, new Mat4()).clone();

    const newParent = scene.createEntity("Instrument Bay");
    newParent.add(new Transform()).setPosition(10, 0, 0);
    assert.equal(session.reparentEntity(child.id, newParent.id, { preserveWorld: true }), true);
    scene.world.updateTransforms([]);
    const afterWorld = scene.world.getWorldMatrix(child.id, new Mat4());
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(afterWorld.m[i]! - beforeWorld.m[i]!) < 1e-4, `world matrix changed at ${i}`);
    assert.equal(child.parent?.id, newParent.id);
    assert.equal(session.undo(), true);
    assert.equal(child.parent?.id, root.id);
    scene.world.updateTransforms([]);
    const undoWorld = scene.world.getWorldMatrix(child.id, new Mat4());
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(undoWorld.m[i]! - beforeWorld.m[i]!) < 1e-4, `undo world matrix changed at ${i}`);

    const created = session.createEntity("Created rover", {
      parent: root.id,
      components: [{ type: "Transform", fields: { position: [7, 8, 9] } }, { type: "EditorFixtureComponent", fields: { health: 91 } }],
    });
    assert.equal(scene.world.parentOf(created), root.id);
    assert.deepEqual(session.inspect(created)!.transform!.position, [7, 8, 9]);
    assert.equal(scene.world.getComponent(created, EditorFixtureComponent)!.health, 91);
    assert.equal(session.undo(), true);
    assert.equal(scene.world.exists(created), false);
    assert.equal(session.redo(), true);
    assert.equal(scene.world.liveEntityIds().length >= 5, true);

    const duplicate = session.duplicateEntity(child.id);
    assert.notEqual(duplicate, child.id);
    assert.equal(scene.world.name(duplicate), "Camera Mast");
    assert.equal(scene.world.parentOf(duplicate), root.id);
    assert.ok(scene.world.getComponent(duplicate, EditorFixtureComponent));
    assert.equal(session.undo(), true);
    assert.equal(scene.world.exists(duplicate), false);
    assert.equal(session.redo(), true);
    const duplicateRedo = session.selection;
    assert.notEqual(duplicateRedo, null);
    assert.equal(scene.world.exists(duplicateRedo!), true);

    assert.equal(session.deleteEntity(duplicateRedo!), true);
    assert.equal(scene.world.exists(duplicateRedo!), false);
    assert.equal(session.history.canUndo, true, "internal delete must not clear unrelated editor history");
    assert.equal(session.undo(), true);
    const restored = session.selection;
    assert.notEqual(restored, null);
    assert.equal(scene.world.name(restored!), "Camera Mast");
    assert.equal(session.redo(), true);
    assert.equal(scene.world.exists(restored!), false);

    // The original subtree remains intact and component fields are copied into snapshots.
    assert.equal(scene.world.exists(grandchild.id), true);
    assert.equal(fixture.health, 75);
    session.dispose();
    scene.dispose();
  });

  test("edits generic fields and exposes deterministic gizmo math", () => {
    const { scene, child, fixture } = makeScene();
    const session = new EditorSession(scene);
    assert.equal(session.setComponentFields(child.id, "EditorFixtureComponent", { health: 88, label: "updated" }), true);
    assert.equal(fixture.health, 88);
    assert.equal(fixture.label, "updated");
    assert.equal(session.undo(), true);
    assert.equal(fixture.health, 75);
    assert.equal(fixture.label, "editable fixture");
    assert.equal(session.redo(), true);
    assert.equal(fixture.health, 88);

    const state = {
      position: [0, 0, 0] as const,
      rotation: [0, 0, 0, 1] as const,
      scale: [1, 1, 1] as const,
    };
    const pick = pickGizmoAxis({ origin: [2, 0.04, 4], direction: [-0.4, 0, -1] }, [0, 0, 0], { tolerance: 0.15 });
    assert.equal(pick?.axis, "x");
    const drag = beginGizmoDrag("translate", "x", [0, 0, 0], [0, 0, 0], state);
    assert.deepEqual(updateGizmoDrag(drag, [1.24, 2, 3], { snap: 0.5 }).position, [1, 0, 0]);
    const scaleDrag = beginGizmoDrag("scale", "z", [0, 0, 0], [0, 0, 0], state);
    assert.deepEqual(updateGizmoDrag(scaleDrag, [0, 0, 0.75], { snap: 0.25 }).scale, [1, 1, 1.75]);

    session.dispose();
    scene.dispose();
  });

  test("workspace selection, material authoring, panels and scene settings stay public-API-only", () => {
    const scene = new Scene({ name: "Workspace fixture" });
    const entity = scene.createEntity("Material target");
    entity.add(new Transform());
    const material = new Material({ label: "Mars dust", roughness: 0.8 });
    entity.add(new Renderable().setMaterial(material));
    const other = scene.createEntity("Second target");
    other.add(new Transform());
    const workspace = new EditorWorkspace(scene);
    workspace.select(entity.id);
    assert.deepEqual(workspace.selection, [entity.id]);
    assert.equal(workspace.setMaterial(entity.id, { metallic: 0.4, baseColor: [0.7, 0.2, 0.1, 1] }), true);
    assert.equal(material.metallic, 0.4);
    assert.equal(material.baseColor.r, 0.7);
    const materialPanel = workspace.panel("material");
    assert.equal(materialPanel.available, true);
    assert.equal(materialPanel.data!.selected!.label, "Mars dust");
    const allPanels = workspace.panels();
    assert.equal(allPanels.terrain.available, false);
    assert.equal(allPanels.environment.available, true);
    assert.equal(allPanels.particles.available, true);
    assert.equal(allPanels.vehicle.available, true);
    assert.equal(workspace.undo(), true);
    assert.equal(material.metallic, 0);
    assert.equal(workspace.redo(), true);
    assert.equal(material.metallic, 0.4);

    assert.equal(workspace.setSceneSettings({ fog: { density: 0.25 } }), true);
    assert.equal(scene.settings.fog.density, 0.25);
    assert.equal(workspace.undo(), true);
    assert.notEqual(scene.settings.fog.density, 0.25);
    const unavailable = workspace.panel("profiler");
    assert.equal(unavailable.available, false);
    assert.match(unavailable.message!, /Engine/);

    workspace.selectMany([entity.id, other.id]);
    assert.deepEqual(workspace.selection, [entity.id, other.id]);
    assert.deepEqual(workspace.hierarchy().rows.filter((row) => row.selected).map((row) => row.id), [entity.id, other.id]);
    workspace.dispose();
    scene.dispose();
  });
});

await finish();
