/**
 * @suite resources:gltfScene
 * @group integration
 * @covers engine/src/resources/gltfScene.ts
 * @covers engine/src/core/tasks/gltfMesh.ts
 * @covers engine/src/core/tasks/gltfAnimation.ts
 * @covers engine/src/animation/component.ts
 * @covers engine/src/animation/system.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers examples/assets/SimpleSkin.gltf
 * @desc Phase 16.1f: a decoded skinned glTF becomes a joint hierarchy, a bind pose, an animated clip and a skinned draw
 */

export const suite = {
  name: "resources:gltfScene",
  group: "integration",
  covers:   [
    "engine/src/resources/gltfScene.ts",
    "engine/src/core/tasks/gltfMesh.ts",
    "engine/src/core/tasks/gltfAnimation.ts",
    "engine/src/animation/component.ts",
    "engine/src/animation/system.ts",
    "engine/src/rendering/renderer.ts",
    "examples/assets/SimpleSkin.gltf"
  ],
  desc: "Phase 16.1f: a decoded skinned glTF becomes a joint hierarchy, a bind pose, an animated clip and a skinned draw",
};
/**
 * The Khronos SimpleSkin sample (CC0, examples/assets/SimpleSkin.gltf): node 0 is the skinned mesh,
 * node 1 the root joint, node 2 the upper joint at (0, 1, 0), and one LINEAR clip rotates node 2 about
 * +Z (0° → 45° → 90° and back over 5.5 s). Everything checked here is derivable from that file, so a
 * wrong hierarchy, a dropped rest pose or a mis-wired palette shows up as a number, not a picture.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, finish, group, test } from "selrun";
import {
  AnimationSystem,
  Camera,
  Clock,
  GraphicsDevice,
  Logger,
  Profiler,
  Renderable,
  Renderer,
  Scene,
  SystemScratch,
  Transform,
  Vec3,
  decodeGltfMesh,
  instantiateGltfScene,
  type DecodedGltfAsset,
  type SystemContext,
} from "@forge/engine";

const assetPath = fileURLToPath(new URL("../../examples/assets/SimpleSkin.gltf", import.meta.url));
const assetJson = readFileSync(assetPath, "utf8");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(): Promise<{ device: GraphicsDevice; scene: Scene; asset: DecodedGltfAsset; instance: ReturnType<typeof instantiateGltfScene> }> {
  const device = await GraphicsDevice.create({ forceMock: true });
  const scene = new Scene({ name: "gltf-skin-test" });
  const asset = await decodeGltfMesh(assetJson, { source: "SimpleSkin.gltf" });
  const instance = instantiateGltfScene(device, scene, asset);
  cleanups.push(async () => {
    instance.dispose();
    scene.dispose();
    await device.dispose();
  });
  return { device, scene, asset, instance };
}

function ctx(scene: Scene, dt: number): SystemContext {
  return {
    world: scene.world, clock: new Clock(), dt, fixedDt: dt, fixedSteps: 1, alpha: 0, elapsed: 0, frame: 1,
    logger: new Logger(), profiler: new Profiler(), services: { get: () => undefined, engineConfig: {} }, scratch: new SystemScratch(),
  } as unknown as SystemContext;
}

/** Column-major 4×4 product. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = s;
  }
  return out;
}

/** CPU reference skinning of one vertex (world space): Σ w · jointWorld · IBM · p. */
function skinVertex(asset: DecodedGltfAsset, instance: ReturnType<typeof instantiateGltfScene>, v: number): [number, number, number] {
  const primitive = asset.meshes[0]!.primitives[0]!;
  const skin = asset.skins[0]!;
  const p = primitive.attributes.POSITION!;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const w = primitive.skin!.weights[v * 4 + k]!;
    if (w === 0) continue;
    const joint = primitive.skin!.joints[v * 4 + k]!;
    const world = instance.nodes[skin.joints[joint]!]!.require(Transform).worldMatrix.m;
    const m = mul(world, skin.inverseBindMatrices.subarray(joint * 16, joint * 16 + 16));
    for (let r = 0; r < 3; r++) out[r] += w * (m[r]! * p[v * 3]! + m[4 + r]! * p[v * 3 + 1]! + m[8 + r]! * p[v * 3 + 2]! + m[12 + r]!);
  }
  return out;
}

group("glTF skinned scene import (Phase 16.1f)", () => {
  test("the mesh decode carries the asset's animations", async () => {
    const asset = await decodeGltfMesh(assetJson);
    assert.equal(asset.animations.length, 1);
    const animation = asset.animations[0]!;
    assert.deepEqual(animation.channels, [{ targetNode: 2, targetPath: "rotation", samplerIndex: 0 }]);
    assert.equal(animation.samplers[0]!.interpolation, "LINEAR");
    assert.equal(animation.samplers[0]!.input.length, 12);
    assertCloseTo(animation.duration, 5.5, 1e-6);
  });

  test("builds one entity per scene node with the glTF parent/child links and local TRS", async () => {
    const { instance } = await setup();
    assert.equal(instance.nodes.length, 3);
    const [meshNode, rootJoint, upperJoint] = instance.nodes as NonNullable<(typeof instance.nodes)[number]>[];
    assert.equal(meshNode!.parent?.id, instance.root.id);
    assert.equal(rootJoint!.parent?.id, instance.root.id);
    assert.equal(upperJoint!.parent?.id, rootJoint!.id, "node 2 is node 1's child");
    const t = upperJoint!.require(Transform);
    assert.deepEqual([t.position.x, t.position.y, t.position.z], [0, 1, 0]);
  });

  test("binds the skin to the joint entities with the decoded inverse bind matrices", async () => {
    const { instance, asset } = await setup();
    const renderable = instance.nodes[0]!.require(Renderable);
    assert.ok(renderable.skin, "the mesh node's renderable carries the skin");
    assert.deepEqual(renderable.skin.joints, [instance.nodes[1]!.id, instance.nodes[2]!.id]);
    assert.deepEqual([...renderable.skin.inverseBindMatrices], [...asset.skins[0]!.inverseBindMatrices]);
    assert.ok(renderable.geometry?.skinBuffer, "JOINTS_0/WEIGHTS_0 uploaded as the skin vertex stream");
  });

  test("bind pose: every joint's world × inverse bind matrix is the identity, so vertices sit where authored", async () => {
    const { scene, instance, asset } = await setup();
    scene.world.updateTransforms([], true);
    const skin = asset.skins[0]!;
    skin.joints.forEach((node, j) => {
      const m = mul(instance.nodes[node]!.require(Transform).worldMatrix.m, skin.inverseBindMatrices.subarray(j * 16, j * 16 + 16));
      m.forEach((value, i) => assertCloseTo(value, i % 5 === 0 ? 1 : 0, 1e-6));
    });
    const top = skinVertex(asset, instance, 8);
    [-0.5, 2, 0].forEach((v, i) => assertCloseTo(top[i]!, v, 1e-6));
  });

  test("plays the clip: untargeted channels keep the rest pose and the pose follows the sampled keys", async () => {
    const { scene, instance, asset } = await setup();
    assert.ok(instance.animation, "an AnimationComponent is attached");
    assert.deepEqual(instance.clips.map((c) => c.name), ["animation-0"]);
    scene.world.registerSystem(new AnimationSystem());
    instance.animation.play("animation-0");
    instance.animation.setLooping("animation-0", true);
    instance.animation.setTime("animation-0", 0.5);
    scene.world.runSystems(ctx(scene, 0));
    scene.world.updateTransforms([], true);
    const upper = instance.nodes[2]!.require(Transform);
    // The clip animates rotation only; translation must stay the node's authored (0, 1, 0).
    assert.deepEqual([upper.position.x, upper.position.y, upper.position.z], [0, 1, 0]);
    // t = 0.5 s is the second key: 45° about +Z.
    assertCloseTo(upper.rotation.z, 0.383, 1e-6);
    assertCloseTo(upper.rotation.w, 0.924, 1e-6);
    // The top-left vertex is bound 100 % to the upper joint and swings 45° about (0, 1, 0).
    const top = skinVertex(asset, instance, 8);
    const c = Math.SQRT1_2;
    assertCloseTo(top[0], -0.5 * c - 1 * c, 1e-3);
    assertCloseTo(top[1], 1 + (-0.5 * c + 1 * c), 1e-3);
    // Halfway between keys (t = 0.25) the LINEAR sampler is between 0 and 22.5°.
    instance.animation.setTime("animation-0", 0.25);
    scene.world.runSystems(ctx(scene, 0));
    assert.ok(upper.rotation.z > 0.05 && upper.rotation.z < 0.383 / 2 + 0.01, `z=${upper.rotation.z}`);
  });

  test("draws through the skinned pipelines with two joint matrices and no fallback", async () => {
    const { device, scene } = await setup();
    const renderer = new Renderer(device);
    cleanups.push(() => renderer.dispose());
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 1, 5));
    cameraEntity.add(new Camera());
    cameraEntity.transform.lookAt(new Vec3(0, 1, 0));
    renderer.renderScene(scene);
    assert.equal(renderer.stats.skinnedBatches, 1);
    assert.equal(renderer.stats.skinJoints, 2);
    assert.equal(renderer.stats.skinFallbacks, 0);
    assert.deepEqual(device.mock.errors, []);
  });

  test("skips nodes outside the active scene", async () => {
    const doc = JSON.parse(assetJson);
    doc.nodes.push({ name: "orphan" });
    const asset = await decodeGltfMesh(JSON.stringify(doc));
    const device = await GraphicsDevice.create({ forceMock: true });
    const scene = new Scene({ name: "orphan" });
    const instance = instantiateGltfScene(device, scene, asset);
    cleanups.push(async () => { instance.dispose(); scene.dispose(); await device.dispose(); });
    assert.equal(instance.nodes[3], null, "nodes outside the active scene are not instantiated");
    assert.equal(instance.animation!.nodeToEntity[3], -1);
  });
});

await finish();
