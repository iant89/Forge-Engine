/**
 * The Phase 16.5 demo arm on the strict mock device: the scene's rig resolves, its mesh draws
 * through the skinned pipelines, and the renderer uploads one palette per frame sized to the arm's
 * joints, following the pose the scene writes. A mock device rasterises nothing, so the pixels are
 * the browser gate's job — this owns the wiring between the scene, the skin and the renderer, which
 * is what would silently rot if the demo's joint list or inverse bind matrices drifted from the
 * geometry they deform (the failure is a `skinFallbacks` count or an unskinned draw, not a crash).
 */

import { afterEach, describe, expect, it } from "vitest";
import { GraphicsDevice, JOINT_PALETTE_BYTES, Renderer, type Engine } from "@forge/engine";
import { buildSkinningScene, type SkinningSceneHandle } from "../examples/src/scenes/skinningScene.js";

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

describe("skinning demo scene", () => {
  it("draws its arm through the skinned pipelines with the rig's resolved joints", async () => {
    const { device, renderer, handle } = await fixture();
    renderer.renderScene(handle.scene);

    const state = handle.skinningState();
    expect(state.joints).toBe(4);
    expect(state.skinnedBatches).toBe(1);
    expect(state.skinJoints).toBe(4);
    expect(state.skinFallbacks).toBe(0);
    expect(device.mock.errors).toEqual([]);
    device.mock.assertClean();
  });

  it("uploads one palette sized to the arm's joints, and follows the pose the scene writes", async () => {
    const { device, renderer, handle } = await fixture();
    renderer.renderScene(handle.scene);
    const first = paletteUploads(device);
    expect(first).toHaveLength(1);
    expect(first[0]!.size).toBe(4 * JOINT_PALETTE_BYTES);

    // Freeze the idle wave on a pose and check the joints really moved (the palette is computed from
    // these world matrices, so a demo that failed to write them would upload the same bytes twice).
    // World matrices are recomputed once per frame, exactly as the next `renderScene` will do.
    const rootJoint = handle.scene.world.facade(handle.scene.world.findByName("joint-0")[0]!)!;
    const before = Float32Array.from(rootJoint.transform.worldMatrix);
    handle.setSkinPose(0.4);
    handle.scene.world.updateTransforms([]);
    const after = Float32Array.from(rootJoint.transform.worldMatrix);
    expect(after).not.toEqual(before);

    renderer.renderScene(handle.scene);
    expect(paletteUploads(device)).toHaveLength(2);
    expect(handle.skinningState().pose).toBeCloseTo(0.4, 6);
    expect(device.mock.errors).toEqual([]);
  });
});
