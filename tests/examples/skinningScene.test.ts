/**
 * @suite examples:skinningScene
 * @group integration
 * @covers engine/src/core/engine.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/skinning.ts
 * @covers examples/src/scenes/skinningScene.ts
 * @desc The Phase 16.5 demo arm on the strict mock device: the scene's rig resolves, its mesh draws
 */

export const suite = {
  name: "examples:skinningScene",
  group: "integration",
  covers:   [
    "engine/src/core/engine.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/skinning.ts",
    "examples/src/scenes/skinningScene.ts"
  ],
  desc: "The Phase 16.5 demo arm on the strict mock device: the scene's rig resolves, its mesh draws",
};
/**
 * The Phase 16.5 demo arm on the strict mock device: the scene's rig resolves, its mesh draws
 * through the skinned pipelines, and the renderer uploads one palette per frame sized to the arm's
 * joints, following the pose the scene writes. A mock device rasterises nothing, so the pixels are
 * the browser gate's job — this owns the wiring between the scene, the skin and the renderer, which
 * is what would silently rot if the demo's joint list or inverse bind matrices drifted from the
 * geometry they deform (the failure is a `skinFallbacks` count or an unskinned draw, not a crash).
 */

import assert from "node:assert/strict";
import { afterEach, assertCloseTo, finish, group, test } from "selrun";
import { GraphicsDevice, JOINT_PALETTE_BYTES, Renderer, type Engine } from "@forge/engine";
import { buildSkinningScene, type SkinningSceneHandle } from "../../examples/src/scenes/skinningScene.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The demo scene only needs the device and the renderer's stats out of an `Engine`. */
async function fixture(): Promise<{ device: GraphicsDevice; renderer: Renderer; handle: SkinningSceneHandle }> {
  const device = await GraphicsDevice.create({ forceMock: true });
  const renderer = new Renderer(device);
  const engine = { gpu: device, stats: () => ({ render: renderer.stats }) } as unknown as Engine;
  const handle = buildSkinningScene(engine);
  cleanups.push(async () => {
    handle.dispose?.();
    renderer.dispose();
    await device.dispose();
  });
  return { device, renderer, handle };
}

/** Palette uploads so far, in order (the arena writes `joints × JOINT_PALETTE_BYTES` per frame). */
function paletteUploads(device: GraphicsDevice): { size: number }[] {
  return device.mock.commandLog
    .filter((e) => e.type === "writeBuffer" && e.buffer === "skin.palettes")
    .map((e) => ({ size: Number(e.size) }));
}

group("skinning demo scene", () => {
  test("draws its arm through the skinned pipelines with the rig's resolved joints", async () => {
    const { device, renderer, handle } = await fixture();
    renderer.renderScene(handle.scene);

    const state = handle.skinningState();
    assert.equal(state.joints, 4);
    assert.equal(state.skinnedBatches, 1);
    assert.equal(state.skinJoints, 4);
    assert.equal(state.skinFallbacks, 0);
    assert.deepEqual(device.mock.errors, []);
    device.mock.assertClean();
  });

  test("uploads one palette sized to the arm's joints, and follows the pose the scene writes", async () => {
    const { device, renderer, handle } = await fixture();
    renderer.renderScene(handle.scene);
    const first = paletteUploads(device);
    assert.equal((first).length, 1);
    assert.equal(first[0]!.size, 4 * JOINT_PALETTE_BYTES);

    // Freeze the idle wave on a pose and check the joints really moved (the palette is computed from
    // these world matrices, so a demo that failed to write them would upload the same bytes twice).
    // World matrices are recomputed once per frame, exactly as the next `renderScene` will do.
    const rootJoint = handle.scene.world.facade(handle.scene.world.findByName("joint-0")[0]!)!;
    const before = Float32Array.from(rootJoint.transform.worldMatrix);
    handle.setSkinPose(0.4);
    handle.scene.world.updateTransforms([]);
    const after = Float32Array.from(rootJoint.transform.worldMatrix);
    assert.notDeepEqual(after, before);

    renderer.renderScene(handle.scene);
    assert.equal((paletteUploads(device)).length, 2);
    assertCloseTo(handle.skinningState().pose, 0.4, 6);
    assert.deepEqual(device.mock.errors, []);
  });
});

await finish();
