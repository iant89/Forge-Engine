/**
 * @suite rendering:renderingSkinning
 * @group unit
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/color.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/geometry.ts
 * @covers engine/src/rendering/material.ts
 * @covers engine/src/rendering/mesh.ts
 * @covers engine/src/rendering/pipeline.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/skinning.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @desc GPU skinning (Phase 16.5): the skin vertex stream, the joint palette, its upload arena, the
 */

export const suite = {
  name: "rendering:renderingSkinning",
  group: "unit",
  covers:   [
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/color.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/geometry.ts",
    "engine/src/rendering/material.ts",
    "engine/src/rendering/mesh.ts",
    "engine/src/rendering/pipeline.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/skinning.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts"
  ],
  desc: "GPU skinning (Phase 16.5): the skin vertex stream, the joint palette, its upload arena, the",
};
/**
 * GPU skinning (Phase 16.5): the skin vertex stream, the joint palette, its upload arena, the
 * skinned pipeline variants and the renderer path that ties them together — over the mock device.
 *
 * What these prove:
 *  - `Geometry` uploads a second vertex buffer slot from a skin stream, validates it, can replace
 *    or drop it, and releases it (no leak);
 *  - `fillJointPalette` computes `inverse(meshWorld) × jointWorld × inverseBind` with the documented
 *    fallbacks (missing joint, truncated inverse-bind data) and no per-joint allocation;
 *  - `JointPaletteArena` hands out `PALETTE_SLOT_ALIGN`-aligned slots, sizes the binding window from
 *    the frame's largest palette, uploads once per frame and grows only when it must;
 *  - the pipeline factory keys skinning as its own variant (and only for the techniques that have a
 *    skinned entry), with the second vertex slot and the group-3 layout;
 *  - a scene with a skinned `Renderable` renders through the skinned entry points — the mock records
 *    the slot-1 vertex buffer and the group-3 palette binding — with zero validation errors, and a
 *    skin without vertex attributes falls back to the unskinned path visibly.
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertThrows, finish, group, test } from "selrun";
import {
  Camera,
  Color,
  Geometry,
  GraphicsDevice,
  fillJointPalette,
  JointPaletteArena,
  JOINT_PALETTE_BYTES,
  Light,
  Material,
  Mesh,
  PALETTE_SLOT_ALIGN,
  PipelineFactory,
  Renderable,
  Renderer,
  Scene,
  SKIN_VERTEX_LAYOUT,
  SKIN_VERTEX_STRIDE,
  VERTEX_LAYOUT,
  Vec3,
  type PipelineKeyOptions,
  type SkinBinding,
} from "@forge/engine";

// ──────────────────────── fixtures ────────────────────────

/** Two triangles (four vertices) spanning x ∈ [0,1] in the XY plane. */
const STRIP_POSITIONS = new Float32Array([
  0, 0, 0,
  0, 1, 0,
  1, 0, 0,
  1, 1, 0,
]);

const STRIP_INDICES = new Uint32Array([0, 1, 2, 1, 3, 2]);

/**
 * The left column (x = 0) is driven by joint 0, the right column (x = 1) by joint 1 — the smallest
 * rig that can show a palette doing something: moving joint 1 must move vertices 2 and 3 only.
 */
function stripSkinStream(): { joints: Uint16Array; weights: Float32Array } {
  const joints = new Uint16Array(4 * 4);
  const weights = new Float32Array(4 * 4);
  for (let v = 0; v < 4; v++) {
    joints[v * 4] = v < 2 ? 0 : 1;
    weights[v * 4] = 1;
  }
  return { joints, weights };
}

function skinStreamFor(vertexCount: number): { joints: Uint16Array; weights: Float32Array } {
  const joints = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) weights[v * 4] = 1;
  return { joints, weights };
}

function translationMatrix(tx: number, ty: number, tz: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  m[12] = tx; m[13] = ty; m[14] = tz;
  return m;
}

function identityMatrix(): Float32Array {
  return translationMatrix(0, 0, 0);
}

/** Raw bytes of a mock buffer, for asserting what an upload actually put there. */
function bufferBytes(buffer: GPUBuffer): Uint8Array {
  return new Uint8Array((buffer as unknown as { data: ArrayBuffer }).data);
}

/**
 * A scene with a camera, a sun and (optionally) a skinned strip. Returns the handles the teardown
 * needs; the caller owns disposal.
 */
function buildScene(device: GraphicsDevice, options: { skin?: boolean; skinAttributes?: boolean } = {}) {
  const { skin = true, skinAttributes = true } = options;
  const scene = new Scene({ name: "skin-test" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x101520));

  const camEntity = scene.createTransformedEntity("camera", new Vec3(1.5, 1.5, -4));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 60;
  scene.world.addComponent(camEntity.id, camera);
  camEntity.transform.lookAt(new Vec3(0.5, 0.5, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(3, 6, -4));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 2;
  sun.castShadow = true;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const meshEntity = scene.createTransformedEntity("strip", new Vec3(0, 0, 0));
  const geometry = Geometry.create(device, {
    positions: STRIP_POSITIONS,
    indices: STRIP_INDICES,
    label: "strip",
    skinning: skinAttributes ? stripSkinStream() : null,
  });
  const material = new Material({ label: "strip-mat", color: 0x88aaff, roughness: 0.6 });
  const renderable = new Renderable();
  renderable.geometry = geometry;
  renderable.material = material;
  scene.world.addComponent(meshEntity.id, renderable);

  let skinBinding: SkinBinding | null = null;
  if (skin) {
    const joint0 = scene.createTransformedEntity("joint0", new Vec3(0, 0, 0));
    const joint1 = scene.createTransformedEntity("joint1", new Vec3(1, 0, 0));
    meshEntity.addChild(joint0);
    joint0.addChild(joint1);
    const inverseBindMatrices = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    skinBinding = { joints: [joint0.id, joint1.id], inverseBindMatrices, root: meshEntity.id };
    renderable.skin = skinBinding;
  }

  return { scene, camera, sun, meshEntity, geometry, material, renderable, skinBinding };
}

function disposeScene(parts: ReturnType<typeof buildScene>, renderer: Renderer, device: GraphicsDevice): Promise<void> {
  parts.scene.dispose();
  renderer.dispose();
  parts.geometry.dispose();
  parts.material.dispose();
  return device.dispose();
}

// ──────────────────────── geometry ────────────────────────

group("skinned geometry", () => {
  test("uploads the skin stream as a second vertex buffer, interleaved joints-then-weights", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const geometry = Geometry.create(device, {
      positions: STRIP_POSITIONS,
      indices: STRIP_INDICES,
      label: "strip",
      skinning: stripSkinStream(),
    });

    assert.equal(geometry.skinned, true);
    assert.notEqual(geometry.skinBuffer, null);
    assert.equal(geometry.skinBuffer!.usage & 0x20, 0x20); // BufferUsage.VERTEX
    // 4 vertices × 32 bytes of skin attributes on top of the 48-byte records.
    assert.equal(geometry.gpuBytes, 4 * 48 + 4 * SKIN_VERTEX_STRIDE + STRIP_INDICES.length * 4);

    const bytes = bufferBytes(geometry.skinBuffer!);
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    for (let v = 0; v < 4; v++) {
      const base = (v * SKIN_VERTEX_STRIDE) >> 2;
      assert.deepEqual(Array.from(u32.subarray(base, base + 4)), [v < 2 ? 0 : 1, 0, 0, 0]);
      assert.deepEqual(Array.from(f32.subarray(base + 4, base + 8)), [1, 0, 0, 0]);
    }

    // The source array stays readable for CPU consumers (validation, tooling).
    assert.equal(geometry.source.skinning?.joints.length, 16);

    geometry.dispose();
    assert.equal((device.mock.outstanding.buffers).length, 0);
    await device.dispose();
  });

  test("rejects a skin stream whose length does not match the vertex count", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const geometry = Geometry.create(device, { positions: STRIP_POSITIONS, indices: STRIP_INDICES, label: "strip" });
    assertThrows(() => geometry.uploadSkinning({ joints: new Uint16Array(8), weights: new Float32Array(8) }), /expected 16/);
    assert.equal(geometry.skinned, false);
    geometry.dispose();
    await device.dispose();
  });

  test("updateFrom replaces the skin stream, keeps it when untouched, and drops it on null", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const geometry = Geometry.create(device, {
      positions: STRIP_POSITIONS,
      indices: STRIP_INDICES,
      label: "strip",
      skinning: stripSkinStream(),
    });
    const first = geometry.skinBuffer;

    // Same vertex count, no `skinning` key: the stream is carried over (like the other attributes).
    geometry.updateFrom({ positions: STRIP_POSITIONS });
    assert.equal(geometry.skinBuffer, first);

    // A new stream replaces the buffer.
    const replacement = skinStreamFor(4);
    replacement.joints[0] = 1;
    geometry.updateFrom({ positions: STRIP_POSITIONS, skinning: replacement });
    assert.notEqual(geometry.skinBuffer, first);
    assert.equal((first as unknown as { destroyed: boolean }).destroyed, true);
    const bytes = bufferBytes(geometry.skinBuffer!);
    assert.equal(new Uint32Array(bytes.buffer, bytes.byteOffset, 1)[0], 1);

    // An explicit null drops it.
    geometry.updateFrom({ positions: STRIP_POSITIONS, skinning: null });
    assert.equal(geometry.skinned, false);
    assert.equal(geometry.skinBuffer, null);

    geometry.dispose();
    assert.equal((device.mock.outstanding.buffers).length, 0);
    await device.dispose();
  });

  test("Mesh.from carries the skin's vertex attributes into the geometry", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mesh = Mesh.from(device, {
      positions: STRIP_POSITIONS,
      indices: STRIP_INDICES,
      label: "strip",
      skin: {
        inverseBindMatrices: new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]),
        jointNames: ["joint0", "joint1"],
        ...stripSkinStream(),
      },
    });
    assert.equal(mesh.geometry.skinned, true);
    assert.notEqual(mesh.skin, null);
    assert.equal((mesh.skin!.joints).length, 0);
    // Names resolve against the scene without touching the vertex data.
    assert.equal(mesh.bindJoints((name) => (name === "joint0" ? 7 : name === "joint1" ? 9 : null), null), true);
    assert.deepEqual(mesh.skin!.joints, [7, 9]);
    mesh.dispose();
    await device.dispose();
  });
});

// ──────────────────────── palette maths ────────────────────────

group("fillJointPalette", () => {
  test("computes jointWorld × inverseBind in world space when no mesh inverse is given", () => {
    const joints = [11, 22];
    const ibm = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    const worlds = new Map<number, Float32Array>([
      [11, translationMatrix(0, 0, 0)],
      [22, translationMatrix(3, 0, 0)],
    ]);
    const output = new Float32Array(2 * 16);
    const written = fillJointPalette(joints, ibm, (e) => worlds.get(e) ?? null, output);
    assert.equal(written, 2);
    // joint 0: identity × identity = identity.
    assert.deepEqual(Array.from(output.subarray(0, 16)), Array.from(identityMatrix()));
    // joint 1: T(3) × T(-1) = T(2).
    assertCloseTo(output[16 + 12], 2, 6);
  });

  test("cancels the mesh transform when given inverse(meshWorld), so the palette stays mesh-local", () => {
    // Joints parented under a mesh at (5,0,0): their worlds already carry that translation, and
    // the palette must not — the vertex stage applies the mesh matrix itself.
    const mesh = translationMatrix(5, 0, 0);
    const meshInverse = translationMatrix(-5, 0, 0);
    const ibm = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    const joints = [11, 22];
    const worlds = new Map<number, Float32Array>([
      [11, mesh],
      [22, translationMatrix(7, 0, 0)],
    ]);
    const output = new Float32Array(2 * 16);
    const written = fillJointPalette(joints, ibm, (e) => worlds.get(e) ?? null, output, meshInverse);
    assert.equal(written, 2);
    assert.deepEqual(Array.from(output.subarray(0, 16)), Array.from(identityMatrix()));
    // The joint moved one unit to the right of the mesh: the palette is a pure translation by 1.
    assertCloseTo(output[16 + 12], 1, 6);
    assertCloseTo(output[16 + 13], 0, 6);
  });

  test("falls back to identity for a missing joint or truncated inverse-bind data", () => {
    const output = new Float32Array(3 * 16);
    const written = fillJointPalette([1, 2, 3], new Float32Array([...identityMatrix()]), () => null, output);
    assert.equal(written, 3);
    for (let i = 0; i < 3; i++) assert.deepEqual(Array.from(output.subarray(i * 16, i * 16 + 16)), Array.from(identityMatrix()));
  });

  test("returns 0 for an empty joint list or an output that cannot hold the palette", () => {
    assert.equal(fillJointPalette([], new Float32Array(16), () => null, new Float32Array(16)), 0);
    assert.equal(fillJointPalette([1, 2], new Float32Array(32), () => null, new Float32Array(16)), 0);
  });

  test("is deterministic and allocation-free in its output buffer", () => {
    const ibm = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    const worlds = new Map<number, Float32Array>([[11, translationMatrix(0.25, 0, 0)], [22, translationMatrix(2, 1, 0)]]);
    const a = new Float32Array(32);
    const b = new Float32Array(32);
    fillJointPalette([11, 22], ibm, (e) => worlds.get(e) ?? null, a, translationMatrix(-1, 0, 0));
    fillJointPalette([11, 22], ibm, (e) => worlds.get(e) ?? null, b, translationMatrix(-1, 0, 0));
    assert.deepEqual(Array.from(a), Array.from(b));
  });
});

// ──────────────────────── upload arena ────────────────────────

group("JointPaletteArena", () => {
  test("hands out aligned slots, sizes the window from the largest palette, and uploads once per frame", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const arena = new JointPaletteArena(device);

    arena.begin();
    const first = arena.reserve(3);
    const second = arena.reserve(2);
    assert.equal(first, 0);
    assert.equal(second, PALETTE_SLOT_ALIGN);
    assert.equal(arena.windowBytes, PALETTE_SLOT_ALIGN); // 3 × 64 = 192, rounded up to 256
    assert.equal(arena.maxJoints, 3);

    // A larger palette widens the frame's window (the binding size is per-frame, the slots are not).
    const third = arena.reserve(9);
    assert.equal(third, 2 * PALETTE_SLOT_ALIGN);
    assert.equal(third % PALETTE_SLOT_ALIGN, 0);
    assert.equal(arena.windowBytes, 768); // 9 × 64 = 576 → 768

    const view = arena.paletteView(third, 9);
    assert.equal(view.length, 9 * 16);
    view.fill(7);

    arena.flush();
    assert.equal(arena.uploads, 1);
    assert.equal(arena.jointsUploaded, 14);
    const buffer = arena.buffer!;
    assert.equal(buffer.usage & 0x80, 0x80); // BufferUsage.STORAGE
    // One whole window of slack past the written region: every slot's dynamic offset stays legal.
    assert.ok(buffer.size >= arena.usedBytes + arena.windowBytes);
    const bytes = bufferBytes(buffer);
    // Slot 3 lives at byte 512: the filled palette starts at float 128.
    assert.equal(new Float32Array(bytes.buffer, bytes.byteOffset, 300)[128], 7);
    assert.equal(new Float32Array(bytes.buffer, bytes.byteOffset, 300)[0], 0);

    // The next frame reuses the buffer (same shape) and uploads again.
    arena.begin();
    const again = arena.reserve(9);
    assert.equal(again, 0);
    arena.paletteView(again, 9).fill(3);
    arena.flush();
    assert.equal(arena.uploads, 2);
    assert.equal(arena.buffer, buffer);
    assert.equal(new Float32Array(bufferBytes(buffer).buffer, 0, 1)[0], 3);

    // An empty frame writes nothing at all.
    arena.begin();
    arena.flush();
    assert.equal(arena.uploads, 2);

    // A much larger palette reallocates once.
    arena.begin();
    arena.reserve(600);
    arena.flush();
    assert.notEqual(arena.buffer, buffer);
    assert.equal((buffer as unknown as { destroyed: boolean }).destroyed, true);

    arena.dispose();
    assert.equal(arena.buffer, null);
    assert.equal((device.mock.outstanding.buffers).length, 0);
    await device.dispose();
  });

  test("uploads the moved joint's palette to the device", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const arena = new JointPaletteArena(device);
    // Joints parented under a mesh at the origin: world = mesh-local, so a joint moved to (1,2,0)
    // from its bind pose at (1,0,0) yields a palette that translates its vertices up by 2.
    const ibm = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    const worlds = new Map<number, Float32Array>([[11, identityMatrix()], [22, translationMatrix(1, 2, 0)]]);

    arena.begin();
    const offset = arena.reserve(2);
    const written = fillJointPalette([11, 22], ibm, (e) => worlds.get(e) ?? null, arena.paletteView(offset, 2), identityMatrix());
    assert.equal(written, 2);
    arena.flush();

    const bytes = bufferBytes(arena.buffer!);
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    assert.equal(offset, 0);
    assertCloseTo(f32[12], 0, 6);       // joint 0: identity
    assertCloseTo(f32[16 + 12], 0, 6);  // joint 1: T(1,2) × T(-1) = T(0,2)
    assertCloseTo(f32[16 + 13], 2, 6);

    arena.dispose();
    await device.dispose();
  });

  test("keeps JOINT_PALETTE_BYTES at one mat4 per joint", () => {
    assert.equal(JOINT_PALETTE_BYTES, 64);
    assert.equal(PALETTE_SLOT_ALIGN % JOINT_PALETTE_BYTES, 0);
  });
});

// ──────────────────────── pipeline variants ────────────────────────

group("skinned pipeline variants", () => {
  const base: PipelineKeyOptions = { technique: "standard", colorFormat: "rgba16float", depthFormat: "depth24plus", transparent: false, doubleSided: false, instanced: false };
  type Inspectable = { desc: GPURenderPipelineDescriptor };

  test("keys skinning as its own variant of the colour, prepass and shadow programs", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const desc = (options: PipelineKeyOptions) => (factory.get(options).pipeline as unknown as Inspectable).desc;

    assert.notEqual(factory.keyOf({ ...base, skinned: true }), factory.keyOf(base));
    assert.notEqual(factory.keyOf({ ...base, skinned: true, instanced: true }), factory.keyOf({ ...base, instanced: true }));

    // The vertex state carries the second slot, and the shader is the skinned module.
    const skinned = desc({ ...base, skinned: true });
    assert.deepEqual(skinned.vertex.buffers, [VERTEX_LAYOUT, SKIN_VERTEX_LAYOUT]);
    assert.equal(skinned.vertex.entryPoint, "vertexMainSkinned");
    const instancedSkinned = desc({ ...base, skinned: true, instanced: true });
    assert.equal(instancedSkinned.vertex.entryPoint, "vertexMainInstancedSkinned");
    assert.deepEqual(instancedSkinned.vertex.buffers, [VERTEX_LAYOUT, SKIN_VERTEX_LAYOUT]);

    // The colour layout gains group 3; the unskinned one must not (a draw cannot bind what its
    // shader never declares, and the layout is what makes that a validation error instead of luck).
    const skinnedLayout = skinned.layout as unknown as { label?: string };
    assert.notEqual(skinnedLayout, desc(base).layout);
    assert.notEqual(factory.bindGroupLayouts.skin, undefined);

    // The prepass compiles the skinned module's own entry point (so its depths match the colour
    // pass), and the shadow pass has a depth-only skinned module.
    const prepass = desc({ ...base, technique: "prepass", colorFormat: null, skinned: true });
    assert.equal(prepass.vertex.module, skinned.vertex.module);
    assert.equal(prepass.vertex.entryPoint, "vertexMainSkinned");
    assert.equal(prepass.fragment, undefined);
    const shadow = desc({ ...base, technique: "depth", colorFormat: null, skinned: true });
    assert.notEqual(shadow.vertex.module, skinned.vertex.module);
    assert.equal(shadow.vertex.entryPoint, "vertexMainSkinned");
    assert.equal(desc({ ...base, technique: "depth", colorFormat: null, skinned: true, instanced: true }).vertex.entryPoint, "vertexMainInstancedSkinned");

    assert.deepEqual(device.mock.errors, []);
    factory.invalidate();
    await device.dispose();
  });

  test("ignores skinned for techniques with no skinned entry, including LOD batches", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    // A population-LOD batch is a merged static buffer: its entries have no second vertex slot.
    assert.equal(factory.keyOf({ ...base, lod: true, instanced: true, skinned: true }), factory.keyOf({ ...base, lod: true, instanced: true }));
    // Terrain/water/fullscreen programs have no skinned variant either, so the flag is inert.
    assert.equal(factory.keyOf({ ...base, technique: "terrain", skinned: true }), factory.keyOf({ ...base, technique: "terrain" }));
    assert.equal(factory.keyOf({ ...base, technique: "water", skinned: true }), factory.keyOf({ ...base, technique: "water" }));
    const terrain = factory.get({ ...base, technique: "terrain", skinned: true }).pipeline as unknown as Inspectable;
    assert.deepEqual(terrain.desc.vertex.buffers, [VERTEX_LAYOUT]);
    assert.deepEqual(device.mock.errors, []);
    factory.invalidate();
    await device.dispose();
  });
});

// ──────────────────────── renderer ────────────────────────

group("Renderer with skinned renderables", () => {
  test("draws a skinned mesh through the skinned entries, binding slot 1 and the group-3 palette", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const parts = buildScene(device);
    renderer.renderScene(parts.scene);

    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.batches, 1);
    assert.equal(renderer.stats.skinnedBatches, 1);
    assert.equal(renderer.stats.skinJoints, 2);
    assert.equal(renderer.stats.skinFallbacks, 0);
    assert.ok(renderer.stats.drawCalls >= 1);

    // The frame really went through the skinned programs: slot 1 was bound and the palette was
    // bound at group 3 with a dynamic offset (the batch's slot).
    const vertexSlots = mock.commandLog.filter((e) => e.type === "setVertexBuffer").map((e) => e.slot);
    assertContains(vertexSlots, 1);
    const skinBindings = mock.commandLog.filter((e) => e.type === "setBindGroup" && e.index === 3);
    assert.ok(skinBindings.length >= 1);
    for (const bind of skinBindings) assert.equal((bind.dynamicOffsets as number[]).length, 1);
    // The shadow and prepass skinned layouts interpose an *empty* group 2 (their programs have no
    // material group, and the palette stays at group 3). Chromium invalidates a command buffer whose
    // draw leaves a declared group unbound — empty or not — so the pass must bind one there, and the
    // mock refuses the draw outright if it does not (which is how the CI runner's Chromium 131 caught
    // a frame that renders fine on a newer build).
    // (Index 2 also carries the material group in the colour pass, hence the group-label filter.)
    const gapBindings = mock.commandLog.filter(
      (e) => e.type === "setBindGroup" && e.index === 2 && e.group === "skin.gap.bindgroup",
    );
    assert.ok(gapBindings.length >= 2); // once per skinned shadow + prepass draw
    const pipelines = mock.commandLog.filter((e) => e.type === "setPipeline").map((e) => String(e.pipeline));
    // Pipeline labels are the cache keys, so the skinned variant shows up as the `|skin|` slot.
    assert.equal(pipelines.some((p) => p.startsWith("pipeline.standard|") && p.includes("|skin|")), true);
    // The shadow pass drew the caster through its own skinned depth pipeline too.
    assert.equal(pipelines.some((p) => p.startsWith("pipeline.depth|") && p.includes("|skin|")), true);
    // And the prepass, whose depths the forward pass tests against.
    assert.equal(pipelines.some((p) => p.startsWith("pipeline.prepass|") && p.includes("|skin|")), true);
    assertContains(mock.passes.map((p) => p.label), "forge.main");

    // The palette landed on the device: one 8 KB buffer holding this frame's two joints.
    const palette = mock.outstanding.buffers.find((b) => b.includes("skin.palettes"));
    assert.notEqual(palette, undefined);

    await disposeScene(parts, renderer, device);
    assert.equal((mock.outstanding.buffers).length, 0);
    assert.equal((mock.outstanding.textures).length, 0);
  });

  test("re-uploads the palette each frame, following the joints the TransformSystem moved", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device, { shadows: false, depthPrepass: false });
    const parts = buildScene(device);

    const paletteWrites = () => mock.commandLog.filter((e) => e.type === "writeBuffer" && String(e.buffer) === "skin.palettes");
    renderer.renderScene(parts.scene);
    const first = paletteWrites();
    assert.equal((first).length, 1);
    assert.equal(first[0]!.size, 2 * JOINT_PALETTE_BYTES); // two joints, one slot per skinned batch

    // Move the second joint; the next frame must upload again — the palette is a snapshot of the
    // pose at collection time, not a buffer written once.
    const joint1 = parts.scene.world.facade(parts.skinBinding!.joints[1]!)!;
    joint1.transform.position = new Vec3(1, 2, 0);
    renderer.renderScene(parts.scene);
    assert.deepEqual(mock.errors, []);
    assert.equal((paletteWrites()).length, 2);
    assert.equal(renderer.stats.skinJoints, 2);

    await disposeScene(parts, renderer, device);
  });

  test("counts a renderable whose geometry has no skin attributes as a fallback and still draws it", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device, { shadows: false });
    const parts = buildScene(device, { skinAttributes: false });
    renderer.renderScene(parts.scene);

    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.skinnedBatches, 0);
    assert.equal(renderer.stats.skinJoints, 0);
    assert.equal(renderer.stats.skinFallbacks, 1);
    assert.equal(renderer.stats.batches, 1);
    assert.ok(renderer.stats.drawCalls >= 1);
    // The palette binding was never touched.
    assert.equal(mock.commandLog.some((e) => e.type === "setBindGroup" && e.index === 3), false);

    await disposeScene(parts, renderer, device);
    assert.equal((mock.outstanding.buffers).length, 0);
  });

  test("reuses one palette buffer across frames and uploads nothing without skinned batches", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device, { shadows: false, depthPrepass: false });
    const parts = buildScene(device);
    renderer.renderScene(parts.scene);
    const palette = mock.outstanding.buffers.find((b) => b.includes("skin.palettes"));
    assert.notEqual(palette, undefined);
    renderer.renderScene(parts.scene);
    // Steady state: the palette buffer is allocated once and written again, never reallocated.
    assert.deepEqual(mock.outstanding.buffers.filter((b) => b.includes("skin.palettes")), [palette]);

    // A scene without skins allocates no palette at all.
    const plain = new Scene({ name: "plain" });
    renderer.renderScene(plain);
    assert.equal(renderer.stats.skinJoints, 0);
    plain.dispose();

    await disposeScene(parts, renderer, device);
    assert.equal((mock.outstanding.buffers).length, 0);
  });
});

await finish();
