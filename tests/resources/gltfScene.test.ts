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
  AnimationComponent,
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
  computeJointBounds,
  decodeGltfMesh,
  instantiateGltfScene,
  posedSkinBounds,
  type DecodedGltfAsset,
  type SystemContext,
} from "@forge/engine";

// These suites check the file's authored numbers, so they decode without the handedness mirror
// (tests/resources/gltfHandedness.test.ts covers the conversion).
const PRESERVE = { handedness: "preserve" as const };
const assetPath = fileURLToPath(new URL("../../examples/assets/SimpleSkin.gltf", import.meta.url));
const assetJson = readFileSync(assetPath, "utf8");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(): Promise<{ device: GraphicsDevice; scene: Scene; asset: DecodedGltfAsset; instance: ReturnType<typeof instantiateGltfScene> }> {
  const device = await GraphicsDevice.create({ forceMock: true });
  const scene = new Scene({ name: "gltf-skin-test" });
  const asset = await decodeGltfMesh(assetJson, { ...PRESERVE, source: "SimpleSkin.gltf" });
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
    const asset = await decodeGltfMesh(assetJson, PRESERVE);
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

  test("per-joint bind boxes cover exactly the IBM-space vertices each joint influences", async () => {
    const { asset, instance } = await setup();
    const primitive = asset.meshes[0]!.primitives[0]!;
    const boxes = computeJointBounds(primitive.attributes.POSITION!, primitive.skin!.joints, primitive.skin!.weights, asset.skins[0]!.inverseBindMatrices, 2);
    // Joint 0 (identity IBM) has weight on rows y = 0 … 1.5; joint 1 (IBM = translate −1 in y) on 0.5 … 2.
    assert.deepEqual([...boxes.subarray(0, 6)], [-0.5, 0, 0, 0.5, 1.5, 0]);
    assert.deepEqual([...boxes.subarray(6, 12)], [-0.5, -0.5, 0, 0.5, 1, 0]);
    assert.deepEqual([...instance.meshes[0]!.skin!.jointBounds!], [...boxes], "Mesh.from precomputes them");
  });

  test("posed bounds contain every CPU-skinned vertex across the clip", async () => {
    const { scene, instance, asset } = await setup();
    scene.world.registerSystem(new AnimationSystem());
    instance.animation!.play("animation-0");
    const skin = instance.meshes[0]!.skin!;
    const lookup = (id: number): Float32Array | null => scene.world.transforms.worldView(scene.world.transformSlot(id as never, false));
    const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    for (const t of [0, 0.5, 1.0, 1.7, 2.75, 4.1]) {
      instance.animation!.setTime("animation-0", t);
      scene.world.runSystems(ctx(scene, 0));
      scene.world.updateTransforms([], true);
      assert.ok(posedSkinBounds(skin.jointBounds!, skin.joints, lookup, box));
      for (let v = 0; v < 10; v++) {
        const p = skinVertex(asset, instance, v);
        const eps = 1e-5;
        assert.ok(p[0] >= box.min.x - eps && p[0] <= box.max.x + eps && p[1] >= box.min.y - eps && p[1] <= box.max.y + eps,
          `t=${t} vertex ${v} (${p.join(", ")}) outside ${JSON.stringify(box)}`);
      }
    }
  });

  test("a skeleton translated far outside its rest bounds is culled by where it is, not where it was bound", async () => {
    const { device, scene, instance } = await setup();
    const renderer = new Renderer(device);
    cleanups.push(() => renderer.dispose());
    // Move the root joint 50 m away; the mesh node stays at the origin (glTF: its transform does not
    // move skinned vertices), so the geometry's own bind box still sits at the origin.
    instance.nodes[1]!.require(Transform).setPosition(50, 0, 0);
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(50, 1, 5));
    cameraEntity.add(new Camera());
    cameraEntity.transform.lookAt(new Vec3(50, 1, 0));
    renderer.renderScene(scene);
    assert.equal(renderer.stats.skinnedBatches, 1, "drawn where the joints put it");
    assert.equal(renderer.stats.culled, 0);
    // And looking at the bind position instead culls it: the bounds moved, they were not just inflated.
    cameraEntity.require(Transform).setPosition(0, 1, 5);
    cameraEntity.transform.lookAt(new Vec3(0, 1, 0));
    renderer.renderScene(scene);
    assert.equal(renderer.stats.skinnedBatches, 0);
    assert.equal(renderer.stats.culled, 1);
  });

  test("an AnimationSystem can run before any AnimationComponent exists (asset still loading)", async () => {
    const scene = new Scene({ name: "empty-animation" });
    cleanups.push(() => scene.dispose());
    // runSystems logs and swallows a throwing system, so ask for the query it makes directly.
    const query = scene.world.query([AnimationComponent]);
    assert.equal(query.count, 0);
    scene.world.releaseQuery(query);
  });

  test("skips nodes outside the active scene", async () => {
    const doc = JSON.parse(assetJson);
    doc.nodes.push({ name: "orphan" });
    const asset = await decodeGltfMesh(JSON.stringify(doc), PRESERVE);
    const device = await GraphicsDevice.create({ forceMock: true });
    const scene = new Scene({ name: "orphan" });
    const instance = instantiateGltfScene(device, scene, asset);
    cleanups.push(async () => { instance.dispose(); scene.dispose(); await device.dispose(); });
    assert.equal(instance.nodes[3], null, "nodes outside the active scene are not instantiated");
    assert.equal(instance.animation!.nodeToEntity[3], -1);
  });
});

await finish();
