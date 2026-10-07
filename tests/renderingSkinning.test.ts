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

import { describe, expect, it } from "vitest";
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

describe("skinned geometry", () => {
  it("uploads the skin stream as a second vertex buffer, interleaved joints-then-weights", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const geometry = Geometry.create(device, {
      positions: STRIP_POSITIONS,
      indices: STRIP_INDICES,
      label: "strip",
      skinning: stripSkinStream(),
    });

    expect(geometry.skinned).toBe(true);
    expect(geometry.skinBuffer).not.toBeNull();
    expect(geometry.skinBuffer!.usage & 0x20).toBe(0x20); // BufferUsage.VERTEX
    // 4 vertices × 32 bytes of skin attributes on top of the 48-byte records.
    expect(geometry.gpuBytes).toBe(4 * 48 + 4 * SKIN_VERTEX_STRIDE + STRIP_INDICES.length * 4);

    const bytes = bufferBytes(geometry.skinBuffer!);
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    for (let v = 0; v < 4; v++) {
      const base = (v * SKIN_VERTEX_STRIDE) >> 2;
      expect(Array.from(u32.subarray(base, base + 4))).toEqual([v < 2 ? 0 : 1, 0, 0, 0]);
      expect(Array.from(f32.subarray(base + 4, base + 8))).toEqual([1, 0, 0, 0]);
    }

    // The source array stays readable for CPU consumers (validation, tooling).
    expect(geometry.source.skinning?.joints.length).toBe(16);

    geometry.dispose();
    expect(device.mock.outstanding.buffers).toHaveLength(0);
    await device.dispose();
  });

  it("rejects a skin stream whose length does not match the vertex count", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const geometry = Geometry.create(device, { positions: STRIP_POSITIONS, indices: STRIP_INDICES, label: "strip" });
    expect(() => geometry.uploadSkinning({ joints: new Uint16Array(8), weights: new Float32Array(8) })).toThrow(/expected 16/);
    expect(geometry.skinned).toBe(false);
    geometry.dispose();
    await device.dispose();
  });

  it("updateFrom replaces the skin stream, keeps it when untouched, and drops it on null", async () => {
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
    expect(geometry.skinBuffer).toBe(first);

    // A new stream replaces the buffer.
    const replacement = skinStreamFor(4);
    replacement.joints[0] = 1;
    geometry.updateFrom({ positions: STRIP_POSITIONS, skinning: replacement });
    expect(geometry.skinBuffer).not.toBe(first);
    expect((first as unknown as { destroyed: boolean }).destroyed).toBe(true);
    const bytes = bufferBytes(geometry.skinBuffer!);
    expect(new Uint32Array(bytes.buffer, bytes.byteOffset, 1)[0]).toBe(1);

    // An explicit null drops it.
    geometry.updateFrom({ positions: STRIP_POSITIONS, skinning: null });
    expect(geometry.skinned).toBe(false);
    expect(geometry.skinBuffer).toBeNull();

    geometry.dispose();
    expect(device.mock.outstanding.buffers).toHaveLength(0);
    await device.dispose();
  });

  it("Mesh.from carries the skin's vertex attributes into the geometry", async () => {
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
    expect(mesh.geometry.skinned).toBe(true);
    expect(mesh.skin).not.toBeNull();
    expect(mesh.skin!.joints).toHaveLength(0);
    // Names resolve against the scene without touching the vertex data.
    expect(mesh.bindJoints((name) => (name === "joint0" ? 7 : name === "joint1" ? 9 : null), null)).toBe(true);
    expect(mesh.skin!.joints).toEqual([7, 9]);
    mesh.dispose();
    await device.dispose();
  });
});

// ──────────────────────── palette maths ────────────────────────

describe("fillJointPalette", () => {
  it("computes jointWorld × inverseBind in world space when no mesh inverse is given", () => {
    const joints = [11, 22];
    const ibm = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    const worlds = new Map<number, Float32Array>([
      [11, translationMatrix(0, 0, 0)],
      [22, translationMatrix(3, 0, 0)],
    ]);
    const output = new Float32Array(2 * 16);
    const written = fillJointPalette(joints, ibm, (e) => worlds.get(e) ?? null, output);
    expect(written).toBe(2);
    // joint 0: identity × identity = identity.
    expect(Array.from(output.subarray(0, 16))).toEqual(Array.from(identityMatrix()));
    // joint 1: T(3) × T(-1) = T(2).
    expect(output[16 + 12]).toBeCloseTo(2, 6);
  });

  it("cancels the mesh transform when given inverse(meshWorld), so the palette stays mesh-local", () => {
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
    expect(written).toBe(2);
    expect(Array.from(output.subarray(0, 16))).toEqual(Array.from(identityMatrix()));
    // The joint moved one unit to the right of the mesh: the palette is a pure translation by 1.
    expect(output[16 + 12]).toBeCloseTo(1, 6);
    expect(output[16 + 13]).toBeCloseTo(0, 6);
  });

  it("falls back to identity for a missing joint or truncated inverse-bind data", () => {
    const output = new Float32Array(3 * 16);
    const written = fillJointPalette([1, 2, 3], new Float32Array([...identityMatrix()]), () => null, output);
    expect(written).toBe(3);
    for (let i = 0; i < 3; i++) expect(Array.from(output.subarray(i * 16, i * 16 + 16))).toEqual(Array.from(identityMatrix()));
  });

  it("returns 0 for an empty joint list or an output that cannot hold the palette", () => {
    expect(fillJointPalette([], new Float32Array(16), () => null, new Float32Array(16))).toBe(0);
    expect(fillJointPalette([1, 2], new Float32Array(32), () => null, new Float32Array(16))).toBe(0);
  });

  it("is deterministic and allocation-free in its output buffer", () => {
    const ibm = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    const worlds = new Map<number, Float32Array>([[11, translationMatrix(0.25, 0, 0)], [22, translationMatrix(2, 1, 0)]]);
    const a = new Float32Array(32);
    const b = new Float32Array(32);
    fillJointPalette([11, 22], ibm, (e) => worlds.get(e) ?? null, a, translationMatrix(-1, 0, 0));
    fillJointPalette([11, 22], ibm, (e) => worlds.get(e) ?? null, b, translationMatrix(-1, 0, 0));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// ──────────────────────── upload arena ────────────────────────

describe("JointPaletteArena", () => {
  it("hands out aligned slots, sizes the window from the largest palette, and uploads once per frame", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const arena = new JointPaletteArena(device);

    arena.begin();
    const first = arena.reserve(3);
    const second = arena.reserve(2);
    expect(first).toBe(0);
    expect(second).toBe(PALETTE_SLOT_ALIGN);
    expect(arena.windowBytes).toBe(PALETTE_SLOT_ALIGN); // 3 × 64 = 192, rounded up to 256
    expect(arena.maxJoints).toBe(3);

    // A larger palette widens the frame's window (the binding size is per-frame, the slots are not).
    const third = arena.reserve(9);
    expect(third).toBe(2 * PALETTE_SLOT_ALIGN);
    expect(third % PALETTE_SLOT_ALIGN).toBe(0);
    expect(arena.windowBytes).toBe(768); // 9 × 64 = 576 → 768

    const view = arena.paletteView(third, 9);
    expect(view.length).toBe(9 * 16);
    view.fill(7);

    arena.flush();
    expect(arena.uploads).toBe(1);
    expect(arena.jointsUploaded).toBe(14);
    const buffer = arena.buffer!;
    expect(buffer.usage & 0x80).toBe(0x80); // BufferUsage.STORAGE
    // One whole window of slack past the written region: every slot's dynamic offset stays legal.
    expect(buffer.size).toBeGreaterThanOrEqual(arena.usedBytes + arena.windowBytes);
    const bytes = bufferBytes(buffer);
    // Slot 3 lives at byte 512: the filled palette starts at float 128.
    expect(new Float32Array(bytes.buffer, bytes.byteOffset, 300)[128]).toBe(7);
    expect(new Float32Array(bytes.buffer, bytes.byteOffset, 300)[0]).toBe(0);

    // The next frame reuses the buffer (same shape) and uploads again.
    arena.begin();
    const again = arena.reserve(9);
    expect(again).toBe(0);
    arena.paletteView(again, 9).fill(3);
    arena.flush();
    expect(arena.uploads).toBe(2);
    expect(arena.buffer).toBe(buffer);
    expect(new Float32Array(bufferBytes(buffer).buffer, 0, 1)[0]).toBe(3);

    // An empty frame writes nothing at all.
    arena.begin();
    arena.flush();
    expect(arena.uploads).toBe(2);

    // A much larger palette reallocates once.
    arena.begin();
    arena.reserve(600);
    arena.flush();
    expect(arena.buffer).not.toBe(buffer);
    expect((buffer as unknown as { destroyed: boolean }).destroyed).toBe(true);

    arena.dispose();
    expect(arena.buffer).toBeNull();
    expect(device.mock.outstanding.buffers).toHaveLength(0);
    await device.dispose();
  });

  it("uploads the moved joint's palette to the device", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const arena = new JointPaletteArena(device);
    // Joints parented under a mesh at the origin: world = mesh-local, so a joint moved to (1,2,0)
    // from its bind pose at (1,0,0) yields a palette that translates its vertices up by 2.
    const ibm = new Float32Array([...identityMatrix(), ...translationMatrix(-1, 0, 0)]);
    const worlds = new Map<number, Float32Array>([[11, identityMatrix()], [22, translationMatrix(1, 2, 0)]]);

    arena.begin();
    const offset = arena.reserve(2);
    const written = fillJointPalette([11, 22], ibm, (e) => worlds.get(e) ?? null, arena.paletteView(offset, 2), identityMatrix());
    expect(written).toBe(2);
    arena.flush();

    const bytes = bufferBytes(arena.buffer!);
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    expect(offset).toBe(0);
    expect(f32[12]).toBeCloseTo(0, 6);       // joint 0: identity
    expect(f32[16 + 12]).toBeCloseTo(0, 6);  // joint 1: T(1,2) × T(-1) = T(0,2)
    expect(f32[16 + 13]).toBeCloseTo(2, 6);

    arena.dispose();
    await device.dispose();
  });

  it("keeps JOINT_PALETTE_BYTES at one mat4 per joint", () => {
    expect(JOINT_PALETTE_BYTES).toBe(64);
    expect(PALETTE_SLOT_ALIGN % JOINT_PALETTE_BYTES).toBe(0);
  });
});

// ──────────────────────── pipeline variants ────────────────────────

describe("skinned pipeline variants", () => {
  const base: PipelineKeyOptions = { technique: "standard", colorFormat: "rgba16float", depthFormat: "depth24plus", transparent: false, doubleSided: false, instanced: false };
  type Inspectable = { desc: GPURenderPipelineDescriptor };

  it("keys skinning as its own variant of the colour, prepass and shadow programs", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    const desc = (options: PipelineKeyOptions) => (factory.get(options).pipeline as unknown as Inspectable).desc;

    expect(factory.keyOf({ ...base, skinned: true })).not.toBe(factory.keyOf(base));
    expect(factory.keyOf({ ...base, skinned: true, instanced: true })).not.toBe(factory.keyOf({ ...base, instanced: true }));

    // The vertex state carries the second slot, and the shader is the skinned module.
    const skinned = desc({ ...base, skinned: true });
    expect(skinned.vertex.buffers).toEqual([VERTEX_LAYOUT, SKIN_VERTEX_LAYOUT]);
    expect(skinned.vertex.entryPoint).toBe("vertexMainSkinned");
    const instancedSkinned = desc({ ...base, skinned: true, instanced: true });
    expect(instancedSkinned.vertex.entryPoint).toBe("vertexMainInstancedSkinned");
    expect(instancedSkinned.vertex.buffers).toEqual([VERTEX_LAYOUT, SKIN_VERTEX_LAYOUT]);

    // The colour layout gains group 3; the unskinned one must not (a draw cannot bind what its
    // shader never declares, and the layout is what makes that a validation error instead of luck).
    const skinnedLayout = skinned.layout as unknown as { label?: string };
    expect(skinnedLayout).not.toBe(desc(base).layout);
    expect(factory.bindGroupLayouts.skin).toBeDefined();

    // The prepass compiles the skinned module's own entry point (so its depths match the colour
    // pass), and the shadow pass has a depth-only skinned module.
    const prepass = desc({ ...base, technique: "prepass", colorFormat: null, skinned: true });
    expect(prepass.vertex.module).toBe(skinned.vertex.module);
    expect(prepass.vertex.entryPoint).toBe("vertexMainSkinned");
    expect(prepass.fragment).toBeUndefined();
    const shadow = desc({ ...base, technique: "depth", colorFormat: null, skinned: true });
    expect(shadow.vertex.module).not.toBe(skinned.vertex.module);
    expect(shadow.vertex.entryPoint).toBe("vertexMainSkinned");
    expect(desc({ ...base, technique: "depth", colorFormat: null, skinned: true, instanced: true }).vertex.entryPoint).toBe("vertexMainInstancedSkinned");

    expect(device.mock.errors).toEqual([]);
    factory.invalidate();
    await device.dispose();
  });

  it("ignores skinned for techniques with no skinned entry, including LOD batches", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const factory = new PipelineFactory(device);
    // A population-LOD batch is a merged static buffer: its entries have no second vertex slot.
    expect(factory.keyOf({ ...base, lod: true, instanced: true, skinned: true })).toBe(factory.keyOf({ ...base, lod: true, instanced: true }));
    // Terrain/water/fullscreen programs have no skinned variant either, so the flag is inert.
    expect(factory.keyOf({ ...base, technique: "terrain", skinned: true })).toBe(factory.keyOf({ ...base, technique: "terrain" }));
    expect(factory.keyOf({ ...base, technique: "water", skinned: true })).toBe(factory.keyOf({ ...base, technique: "water" }));
    const terrain = factory.get({ ...base, technique: "terrain", skinned: true }).pipeline as unknown as Inspectable;
    expect(terrain.desc.vertex.buffers).toEqual([VERTEX_LAYOUT]);
    expect(device.mock.errors).toEqual([]);
    factory.invalidate();
    await device.dispose();
  });
});

// ──────────────────────── renderer ────────────────────────

describe("Renderer with skinned renderables", () => {
  it("draws a skinned mesh through the skinned entries, binding slot 1 and the group-3 palette", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const parts = buildScene(device);
    renderer.renderScene(parts.scene);

    expect(mock.errors).toEqual([]);
    expect(renderer.stats.batches).toBe(1);
    expect(renderer.stats.skinnedBatches).toBe(1);
    expect(renderer.stats.skinJoints).toBe(2);
    expect(renderer.stats.skinFallbacks).toBe(0);
    expect(renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);

    // The frame really went through the skinned programs: slot 1 was bound and the palette was
    // bound at group 3 with a dynamic offset (the batch's slot).
    const vertexSlots = mock.commandLog.filter((e) => e.type === "setVertexBuffer").map((e) => e.slot);
    expect(vertexSlots).toContain(1);
    const skinBindings = mock.commandLog.filter((e) => e.type === "setBindGroup" && e.index === 3);
    expect(skinBindings.length).toBeGreaterThanOrEqual(1);
    for (const bind of skinBindings) expect((bind.dynamicOffsets as number[]).length).toBe(1);
    // The shadow and prepass skinned layouts interpose an *empty* group 2 (their programs have no
    // material group, and the palette stays at group 3). Chromium invalidates a command buffer whose
    // draw leaves a declared group unbound — empty or not — so the pass must bind one there, and the
    // mock refuses the draw outright if it does not (which is how the CI runner's Chromium 131 caught
    // a frame that renders fine on a newer build).
    // (Index 2 also carries the material group in the colour pass, hence the group-label filter.)
    const gapBindings = mock.commandLog.filter(
      (e) => e.type === "setBindGroup" && e.index === 2 && e.group === "skin.gap.bindgroup",
    );
    expect(gapBindings.length).toBeGreaterThanOrEqual(2); // once per skinned shadow + prepass draw
    const pipelines = mock.commandLog.filter((e) => e.type === "setPipeline").map((e) => String(e.pipeline));
    // Pipeline labels are the cache keys, so the skinned variant shows up as the `|skin|` slot.
    expect(pipelines.some((p) => p.startsWith("pipeline.standard|") && p.includes("|skin|"))).toBe(true);
    // The shadow pass drew the caster through its own skinned depth pipeline too.
    expect(pipelines.some((p) => p.startsWith("pipeline.depth|") && p.includes("|skin|"))).toBe(true);
    // And the prepass, whose depths the forward pass tests against.
    expect(pipelines.some((p) => p.startsWith("pipeline.prepass|") && p.includes("|skin|"))).toBe(true);
    expect(mock.passes.map((p) => p.label)).toContain("forge.main");

    // The palette landed on the device: one 8 KB buffer holding this frame's two joints.
    const palette = mock.outstanding.buffers.find((b) => b.includes("skin.palettes"));
    expect(palette).toBeDefined();

    await disposeScene(parts, renderer, device);
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("re-uploads the palette each frame, following the joints the TransformSystem moved", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device, { shadows: false, depthPrepass: false });
    const parts = buildScene(device);

    const paletteWrites = () => mock.commandLog.filter((e) => e.type === "writeBuffer" && String(e.buffer) === "skin.palettes");
    renderer.renderScene(parts.scene);
    const first = paletteWrites();
    expect(first).toHaveLength(1);
    expect(first[0]!.size).toBe(2 * JOINT_PALETTE_BYTES); // two joints, one slot per skinned batch

    // Move the second joint; the next frame must upload again — the palette is a snapshot of the
    // pose at collection time, not a buffer written once.
    const joint1 = parts.scene.world.facade(parts.skinBinding!.joints[1]!)!;
    joint1.transform.position = new Vec3(1, 2, 0);
    renderer.renderScene(parts.scene);
    expect(mock.errors).toEqual([]);
    expect(paletteWrites()).toHaveLength(2);
    expect(renderer.stats.skinJoints).toBe(2);

    await disposeScene(parts, renderer, device);
  });

  it("counts a renderable whose geometry has no skin attributes as a fallback and still draws it", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device, { shadows: false });
    const parts = buildScene(device, { skinAttributes: false });
    renderer.renderScene(parts.scene);

    expect(mock.errors).toEqual([]);
    expect(renderer.stats.skinnedBatches).toBe(0);
    expect(renderer.stats.skinJoints).toBe(0);
    expect(renderer.stats.skinFallbacks).toBe(1);
    expect(renderer.stats.batches).toBe(1);
    expect(renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);
    // The palette binding was never touched.
    expect(mock.commandLog.some((e) => e.type === "setBindGroup" && e.index === 3)).toBe(false);

    await disposeScene(parts, renderer, device);
    expect(mock.outstanding.buffers).toHaveLength(0);
  });

  it("reuses one palette buffer across frames and uploads nothing without skinned batches", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device, { shadows: false, depthPrepass: false });
    const parts = buildScene(device);
    renderer.renderScene(parts.scene);
    const palette = mock.outstanding.buffers.find((b) => b.includes("skin.palettes"));
    expect(palette).toBeDefined();
    renderer.renderScene(parts.scene);
    // Steady state: the palette buffer is allocated once and written again, never reallocated.
    expect(mock.outstanding.buffers.filter((b) => b.includes("skin.palettes"))).toEqual([palette]);

    // A scene without skins allocates no palette at all.
    const plain = new Scene({ name: "plain" });
    renderer.renderScene(plain);
    expect(renderer.stats.skinJoints).toBe(0);
    plain.dispose();

    await disposeScene(parts, renderer, device);
    expect(mock.outstanding.buffers).toHaveLength(0);
  });
});
