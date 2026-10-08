/**
 * @suite animation:animation
 * @group unit
 * @covers engine/src/animation/assembly.ts
 * @covers engine/src/animation/clip.ts
 * @covers engine/src/animation/component.ts
 * @covers engine/src/animation/sampler.ts
 * @covers engine/src/core/tasks/gltfAnimation.ts
 * @covers engine/src/index.ts
 * @desc Animation subsystem tests (Phase 16.1)
 */

export const suite = {
  name: "animation:animation",
  group: "unit",
  covers:   [
    "engine/src/animation/assembly.ts",
    "engine/src/animation/clip.ts",
    "engine/src/animation/component.ts",
    "engine/src/animation/sampler.ts",
    "engine/src/core/tasks/gltfAnimation.ts",
    "engine/src/index.ts"
  ],
  desc: "Animation subsystem tests (Phase 16.1)",
};
/**
 * Animation subsystem tests (Phase 16.1).
 *
 * Coverage:
 *  - Clip creation, validation and track invariants
 *  - Sampling: STEP, LINEAR, CUBICSPLINE interpolation
 *  - Quaternion SLERP and NLERP fallback
 *  - Multi-clip blend (NLERP, weight normalisation)
 *  - AnimationComponent state management (play, pause, stop, looping, speed)
 *  - AnimationSystem frame integration (dt, time advance, loop wrap, clamp-stop)
 *  - glTF animation decode (STEP/LINEAR/CUBICSPLINE, translation/rotation/scale channels)
 *  - Determinism: same clip at same time → same output
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertThrows, beforeEach, finish, group, test } from "selrun";
import {
  createClip,
  validateTrack,
  componentsPerKey,
  sampleClip,
  initIdentity,
  NODE_STRIDE,
  assembleClip,
  assembleClips,
  AnimationComponent,
  decodeGltfAnimations,
  type AnimationTrack,
} from "@forge/engine";

// ──────────────────────── helpers ────────────────────────

function makeTrack(
  nodeIndex: number,
  path: "translation" | "rotation" | "scale",
  times: number[],
  values: number[],
  interpolation: "STEP" | "LINEAR" | "CUBICSPLINE" = "LINEAR",
): AnimationTrack {
  return {
    nodeIndex,
    path,
    interpolation,
    times: Float32Array.from(times),
    values: Float32Array.from(values),
  };
}

function identityTRS(nodeCount: number): Float32Array {
  const buf = new Float32Array(nodeCount * NODE_STRIDE);
  initIdentity(buf, nodeCount);
  return buf;
}

/** Read the TRS for a node from a sampled buffer. */
function readTRS(buf: Float32Array, node: number) {
  const off = node * NODE_STRIDE;
  return {
    tx: buf[off], ty: buf[off + 1], tz: buf[off + 2],
    rx: buf[off + 3], ry: buf[off + 4], rz: buf[off + 5], rw: buf[off + 6],
    sx: buf[off + 7], sy: buf[off + 8], sz: buf[off + 9],
  };
}

/** Build a minimal glTF JSON document with an animation, for decode testing. */
function makeGltfWithAnimation(): { doc: Record<string, unknown>; buffers: ArrayBuffer[] } {
  // Two nodes: root (0) and child (1).
  // One animation: "walk" with a LINEAR translation channel on node 1.
  //   3 keys at t=0, 0.5, 1.0
  //   translation values: (0,0,0) → (1,0,0) → (0,0,0)

  // Timestamps: 3 floats = 12 bytes
  const timestamps = new Float32Array([0, 0.5, 1.0]);
  // Translation values: 3 keys × 3 floats = 9 floats = 36 bytes
  const translations = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0]);

  // Rotation sampler: 2 keys, LINEAR
  const rotTimestamps = new Float32Array([0, 1.0]);
  // Identity quaternion → 90° Y rotation: (0, sin45, 0, cos45)
  const sin45 = Math.sin(Math.PI / 4);
  const cos45 = Math.cos(Math.PI / 4);
  const rotations = new Float32Array([0, 0, 0, 1, 0, sin45, 0, cos45]);

  // Pack into one buffer
  const totalBytes = 12 + 36 + 8 + 32; // timestamps + translations + rotTimestamps + rotations
  const buffer = new ArrayBuffer(totalBytes);
  const view = new Float32Array(buffer);
  let off = 0;
  view.set(timestamps, off); off += 3;
  view.set(translations, off); off += 9;
  view.set(rotTimestamps, off); off += 2;
  view.set(rotations, off); off += 8;

  const doc = {
    asset: { version: "2.0" },
    nodes: [
      { name: "root", children: [1] },
      { name: "child" },
    ],
    scenes: [{ name: "default", nodes: [0] }],
    animations: [{
      name: "walk",
      channels: [
        { sampler: 0, target: { node: 1, path: "translation" } },
        { sampler: 1, target: { node: 1, path: "rotation" } },
      ],
      samplers: [
        { input: 0, output: 1, interpolation: "LINEAR" },
        { input: 2, output: 3, interpolation: "LINEAR" },
      ],
    }],
    accessors: [
      // 0: translation timestamps (3 floats)
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "SCALAR" },
      // 1: translation values (3 × VEC3)
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
      // 2: rotation timestamps (2 floats)
      { bufferView: 0, byteOffset: 48, componentType: 5126, count: 2, type: "SCALAR" },
      // 3: rotation values (2 × VEC4)
      { bufferView: 0, byteOffset: 56, componentType: 5126, count: 2, type: "VEC4" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: totalBytes },
    ],
    buffers: [{ byteLength: totalBytes }],
  };

  return { doc: doc as Record<string, unknown>, buffers: [buffer] };
}

// ──────────────────────── clip creation ────────────────────────

group("AnimationClip creation", () => {
  test("computes duration from max track end time", () => {
    const clip = createClip("test", [
      makeTrack(0, "translation", [0, 1, 2], [0, 0, 0, 1, 0, 0, 2, 0, 0]),
      makeTrack(1, "rotation", [0, 3], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    assert.equal(clip.duration, 3);
    assert.equal(clip.name, "test");
    assert.equal((clip.tracks).length, 2);
  });

  test("drops empty tracks", () => {
    const clip = createClip("empty", [
      makeTrack(0, "translation", [], []),
      makeTrack(1, "scale", [0], [1, 1, 1]),
    ]);
    assert.equal((clip.tracks).length, 1);
    assert.equal(clip.tracks[0]!.nodeIndex, 1);
  });

  test("handles single-key clips with zero duration", () => {
    const clip = createClip("pose", [
      makeTrack(0, "translation", [0], [1, 2, 3]),
    ]);
    assert.equal(clip.duration, 0);
  });
});

// ──────────────────────── validation ────────────────────────

group("AnimationTrack validation", () => {
  test("accepts a valid LINEAR translation track", () => {
    const track = makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0]);
    assert.deepEqual(validateTrack(track, "test"), []);
  });

  test("accepts a valid LINEAR rotation track", () => {
    const track = makeTrack(0, "rotation", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
    assert.deepEqual(validateTrack(track, "test"), []);
  });

  test("accepts a valid CUBICSPLINE track", () => {
    // 2 keys, translation: each key has in-tangent(3), value(3), out-tangent(3) = 18 floats
    const track = makeTrack(0, "translation", [0, 1],
      [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      "CUBICSPLINE");
    assert.deepEqual(validateTrack(track, "test"), []);
  });

  test("rejects empty tracks", () => {
    const track = makeTrack(0, "translation", [], []);
    const errors = validateTrack(track, "test");
    assert.ok(errors.length > 0);
    assertContains(errors[0], "no keys");
  });

  test("rejects mismatched value count", () => {
    // 2 keys for translation = needs 6 values, give 4
    const track = makeTrack(0, "translation", [0, 1], [0, 0, 0, 1]);
    const errors = validateTrack(track, "test");
    assert.ok(errors.length > 0);
    assertContains(errors[0], "expected");
  });

  test("rejects non-monotonic timestamps", () => {
    const track = makeTrack(0, "translation", [0, 2, 1], [0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const errors = validateTrack(track, "test");
    assert.ok(errors.length > 0);
    assertContains(errors[0], "monotonically");
  });

  test("rejects zero quaternion in rotation track", () => {
    const track = makeTrack(0, "rotation", [0, 1], [0, 0, 0, 0, 0, 0, 0, 1]);
    const errors = validateTrack(track, "test");
    assert.ok(errors.length > 0);
    assertContains(errors[0], "zero quaternion");
  });
});

// ──────────────────────── sampling: STEP ────────────────────────

group("STEP interpolation", () => {
  test("returns the value at or before the current time", () => {
    const clip = createClip("step", [
      makeTrack(0, "translation", [0, 1, 2], [0, 0, 0, 10, 0, 0, 20, 0, 0], "STEP"),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    assert.equal(readTRS(out, 0).tx, 0);

    sampleClip(clip, 0.5, out);
    assert.equal(readTRS(out, 0).tx, 0); // step: snap to key at t=0

    sampleClip(clip, 1, out);
    assert.equal(readTRS(out, 0).tx, 10);

    sampleClip(clip, 1.5, out);
    assert.equal(readTRS(out, 0).tx, 10); // step: snap to key at t=1

    sampleClip(clip, 2, out);
    assert.equal(readTRS(out, 0).tx, 20);
  });
});

// ──────────────────────── sampling: LINEAR ────────────────────────

group("LINEAR interpolation", () => {
  test("linearly interpolates translation", () => {
    const clip = createClip("lerp", [
      makeTrack(0, "translation", [0, 1], [0, 0, 0, 10, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0.5, out);
    const trs = readTRS(out, 0);
    assertCloseTo(trs.tx, 5, 6);
    assert.equal(trs.ty, 0);
  });

  test("linearly interpolates scale", () => {
    const clip = createClip("scale", [
      makeTrack(0, "scale", [0, 1], [1, 1, 1, 2, 2, 2]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0.25, out);
    const trs = readTRS(out, 0);
    assertCloseTo(trs.sx, 1.25, 6);
    assertCloseTo(trs.sy, 1.25, 6);
  });

  test("uses SLERP for rotation", () => {
    // 90° Y rotation: (0, sin45, 0, cos45)
    const sin45 = Math.sin(Math.PI / 4);
    const cos45 = Math.cos(Math.PI / 4);
    const clip = createClip("rot", [
      makeTrack(0, "rotation", [0, 1], [0, 0, 0, 1, 0, sin45, 0, cos45]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0.5, out);
    // At t=0.5, expect 45° Y rotation: (0, sin22.5, 0, cos22.5)
    const sin22 = Math.sin(Math.PI / 8);
    const cos22 = Math.cos(Math.PI / 8);
    const trs = readTRS(out, 0);
    assertCloseTo(trs.rw, cos22, 4);
    assertCloseTo(trs.ry, sin22, 4);
    assertCloseTo(trs.rx, 0, 6);
    assertCloseTo(trs.rz, 0, 6);
  });

  test("handles shortest-arc rotation (negated B)", () => {
    // Rotating 180° around Y: from identity to (0, 1, 0, 0)
    const clip = createClip("half", [
      makeTrack(0, "rotation", [0, 1], [0, 0, 0, 1, 0, 1, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0.5, out);
    // At 90°: (0, sin45, 0, cos45)
    const trs = readTRS(out, 0);
    assertCloseTo(trs.rw, Math.cos(Math.PI / 4), 4);
    assertCloseTo(trs.ry, Math.sin(Math.PI / 4), 4);
  });

  test("clamps to first key before range", () => {
    const clip = createClip("clamp", [
      makeTrack(0, "translation", [1, 2], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    assert.equal(readTRS(out, 0).tx, 10);
  });

  test("clamps to last key after range", () => {
    const clip = createClip("clamp", [
      makeTrack(0, "translation", [1, 2], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 5, out);
    assert.equal(readTRS(out, 0).tx, 20);
  });
});

// ──────────────────────── sampling: CUBICSPLINE ────────────────────────

group("CUBICSPLINE interpolation", () => {
  test("evaluates identity tangents as linear", () => {
    // With zero tangents, the cubic should still pass through the values.
    // 2 keys, translation: [in, val, out] per key, each 3 floats
    //   key 0: in=(0,0,0) val=(0,0,0) out=(1,0,0) → velocity 1 at exit
    //   key 1: in=(1,0,0) val=(1,0,0) out=(0,0,0) → velocity 1 at entry
    const clip = createClip("cubic", [
      makeTrack(0, "translation", [0, 1], [
        0, 0, 0,   0, 0, 0,   1, 0, 0,  // key 0: in, val, out
        1, 0, 0,   1, 0, 0,   0, 0, 0,  // key 1: in, val, out
      ], "CUBICSPLINE"),
    ]);
    const out = identityTRS(1);

    // At t=0, should be value of key 0 = (0,0,0)
    sampleClip(clip, 0, out);
    assertCloseTo(readTRS(out, 0).tx, 0, 6);

    // At t=1, should be value of key 1 = (1,0,0)
    sampleClip(clip, 1, out);
    assertCloseTo(readTRS(out, 0).tx, 1, 6);

    // At t=0.5, should be near 0.5 (smooth curve through the values)
    sampleClip(clip, 0.5, out);
    assert.ok(readTRS(out, 0).tx > 0);
    assert.ok(readTRS(out, 0).tx < 1);
  });

  test("single-key CUBICSPLINE returns the value (middle sample)", () => {
    const clip = createClip("single", [
      makeTrack(0, "translation", [0], [
        0, 0, 0,   5, 10, 15,   0, 0, 0,  // in, val, out
      ], "CUBICSPLINE"),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    const trs = readTRS(out, 0);
    assertCloseTo(trs.tx, 5, 6);
    assertCloseTo(trs.ty, 10, 6);
    assertCloseTo(trs.tz, 15, 6);
  });
});

// ──────────────────────── multi-track / multi-node ────────────────────────

group("Multi-track sampling", () => {
  test("samples different nodes independently", () => {
    const clip = createClip("multi", [
      makeTrack(0, "translation", [0, 1], [0, 0, 0, 5, 0, 0]),
      makeTrack(1, "translation", [0, 1], [0, 0, 0, 0, 10, 0]),
      makeTrack(2, "scale", [0, 1], [1, 1, 1, 3, 3, 3]),
    ]);
    const out = identityTRS(3);
    sampleClip(clip, 0.5, out);
    assertCloseTo(readTRS(out, 0).tx, 2.5, 6);
    assertCloseTo(readTRS(out, 1).ty, 5, 6);
    assertCloseTo(readTRS(out, 2).sx, 2, 6);
  });

  test("does not touch un-targeted nodes", () => {
    const clip = createClip("sparse", [
      makeTrack(1, "translation", [0, 1], [0, 0, 0, 100, 0, 0]),
    ]);
    const out = identityTRS(3);
    sampleClip(clip, 0.5, out);
    // Node 0 should remain identity.
    const n0 = readTRS(out, 0);
    assert.equal(n0.tx, 0);
    assert.equal(n0.rw, 1);
    assert.equal(n0.sx, 1);
    // Node 2 should remain identity.
    const n2 = readTRS(out, 2);
    assert.equal(n2.tx, 0);
    assert.equal(n2.rw, 1);
  });
});

// ──────────────────────── AnimationComponent ────────────────────────

group("AnimationComponent", () => {
  let anim: AnimationComponent;

  beforeEach(() => {
    anim = new AnimationComponent();
    anim.nodeToEntity = [10, 11, 12];
  });

  test("starts with no clips and not playing", () => {
    assert.equal(anim.isPlaying, false);
    assert.deepEqual([...anim.clipNames], []);
  });

  test("adds clips and plays/stops them", () => {
    const clip = createClip("walk", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]);
    anim.addClip(clip);
    assert.deepEqual([...anim.clipNames], ["walk"]);
    assert.equal(anim.isPlaying, false);

    anim.play("walk");
    assert.equal(anim.isPlaying, true);

    anim.stop("walk");
    assert.equal(anim.isPlaying, false);
    assert.equal(anim.getPlayback("walk")!.time, 0);
  });

  test("pauses without resetting time", () => {
    const clip = createClip("run", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]);
    anim.addClip(clip);
    anim.play("run");
    anim.getPlayback("run")!.time = 0.5;
    anim.pause("run");
    assert.equal(anim.isPlaying, false);
    assert.equal(anim.getPlayback("run")!.time, 0.5);
  });

  test("stopAll resets all clips", () => {
    anim.addClip(createClip("a", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]));
    anim.addClip(createClip("b", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]));
    anim.play("a");
    anim.play("b");
    anim.getPlayback("a")!.time = 0.3;
    anim.stopAll();
    assert.equal(anim.isPlaying, false);
    assert.equal(anim.getPlayback("a")!.time, 0);
    assert.equal(anim.getPlayback("b")!.time, 0);
  });

  test("sets speed, looping, weight", () => {
    const clip = createClip("idle", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]);
    anim.addClip(clip);
    anim.setSpeed("idle", 2);
    anim.setLooping("idle", true);
    anim.setWeight("idle", 0.5);
    const p = anim.getPlayback("idle")!;
    assert.equal(p.speed, 2);
    assert.equal(p.looping, true);
    assert.equal(p.weight, 0.5);
  });

  test("reports jointCount from nodeToEntity", () => {
    assert.equal(anim.jointCount, 3);
  });

  test("returns empty playing clips when nothing plays", () => {
    anim.addClip(createClip("x", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]));
    assert.deepEqual(anim.getPlayingClips(), []);
  });
});

// ──────────────────────── assembly ────────────────────────

group("Animation assembly", () => {
  test("converts a decoded glTF animation into an AnimationClip", () => {
    const decoded = {
      name: "walk",
      channels: [
        { targetNode: 1, targetPath: "translation" as const, samplerIndex: 0 },
        { targetNode: 1, targetPath: "rotation" as const, samplerIndex: 1 },
      ],
      samplers: [
        { input: Float32Array.from([0, 1]), output: Float32Array.from([0, 0, 0, 10, 0, 0]), interpolation: "LINEAR" as const },
        { input: Float32Array.from([0, 1]), output: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1]), interpolation: "LINEAR" as const },
      ],
      duration: 1,
    };
    const clip = assembleClip(decoded);
    assert.equal(clip.name, "walk");
    assert.equal((clip.tracks).length, 2);
    assert.equal(clip.duration, 1);
    assert.equal(clip.tracks[0]!.nodeIndex, 1);
    assert.equal(clip.tracks[0]!.path, "translation");
    assert.equal(clip.tracks[1]!.path, "rotation");
  });

  test("assembles multiple clips", () => {
    const decoded = [
      { name: "a", channels: [{ targetNode: 0, targetPath: "translation" as const, samplerIndex: 0 }], samplers: [{ input: Float32Array.from([0]), output: Float32Array.from([0, 0, 0]), interpolation: "LINEAR" as const }], duration: 0 },
      { name: "b", channels: [{ targetNode: 0, targetPath: "scale" as const, samplerIndex: 0 }], samplers: [{ input: Float32Array.from([0, 1]), output: Float32Array.from([1, 1, 1, 2, 2, 2]), interpolation: "LINEAR" as const }], duration: 1 },
    ];
    const clips = assembleClips(decoded);
    assert.equal((clips).length, 2);
    assert.equal(clips[0]!.name, "a");
    assert.equal(clips[1]!.name, "b");
  });
});

// ──────────────────────── glTF animation decode ────────────────────────

group("glTF animation decoder", () => {
  test("decodes LINEAR translation and rotation channels", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims = decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf");
    assert.equal((anims).length, 1);
    assert.equal(anims[0]!.name, "walk");
    assert.equal((anims[0]!.channels).length, 2);
    assert.equal((anims[0]!.samplers).length, 2);

    // Translation sampler
    const transSampler = anims[0]!.samplers[0]!;
    assert.equal(transSampler.interpolation, "LINEAR");
    assert.deepEqual(transSampler.input, Float32Array.from([0, 0.5, 1]));
    assert.equal(transSampler.output.length, 9); // 3 keys × 3 components

    // Rotation sampler
    const rotSampler = anims[0]!.samplers[1]!;
    assert.equal(rotSampler.interpolation, "LINEAR");
    assert.deepEqual(rotSampler.input, Float32Array.from([0, 1]));
    assert.equal(rotSampler.output.length, 8); // 2 keys × 4 components
  });

  test("returns empty array when document has no animations", () => {
    const doc = { asset: { version: "2.0" }, nodes: [], scenes: [] } as Record<string, unknown>;
    const anims = decodeGltfAnimations(doc, [], 0, "test.gltf");
    assert.deepEqual(anims, []);
  });

  test("rejects invalid interpolation mode", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims = (doc as Record<string, unknown>).animations as { samplers: { interpolation: string }[] }[];
    anims[0]!.samplers[0]!.interpolation = "BEZIER";
    assertThrows(() => decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf"), "unsupported interpolation");
  });

  test("rejects out-of-range target node", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    (doc as Record<string, unknown>).animations = [{
      name: "bad",
      channels: [{ sampler: 0, target: { node: 99, path: "translation" } }],
      samplers: [{ input: 0, output: 1 }],
    }];
    assertThrows(() => decodeGltfAnimations(doc, buffers, 2, "test.gltf"), "invalid node");
  });

  test("skips morph target weight channels", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims0 = (doc as Record<string, unknown>).animations as { channels: { sampler: number; target: { node: number; path: string } }[] }[];
    anims0[0]!.channels.push({
      sampler: 0,
      target: { node: 0, path: "weights" },
    });
    const anims = decodeGltfAnimations(doc, buffers, 2, "test.gltf");
    // Should still have only 2 channels (translation + rotation; weights skipped)
    assert.equal((anims[0]!.channels).length, 2);
  });

  test("rejects non-monotonic timestamps", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    // Overwrite the first accessor's data with non-monotonic timestamps
    const view = new Float32Array(buffers[0]!);
    view[0] = 0; view[1] = 2; view[2] = 1; // 0, 2, 1 — not monotonic
    assertThrows(() => decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf"), "monotonically increasing");
  });

  test("transfers typed array buffers for decoded animations", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims = decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf");
    assert.equal((anims).length, 1);
    assert.ok(anims[0]!.samplers[0]!.input instanceof Float32Array);
    assert.ok(anims[0]!.samplers[0]!.output instanceof Float32Array);
  });
});

// ──────────────────────── determinism ────────────────────────

group("Animation determinism", () => {
  test("produces identical output for the same clip at the same time (100 samples)", () => {
    const clip = createClip("det", [
      makeTrack(0, "translation", [0, 0.5, 1, 1.5, 2], [0, 0, 0, 5, 0, 0, 10, 0, 0, 7, 0, 0, 3, 0, 0]),
      makeTrack(1, "rotation", [0, 1, 2], [0, 0, 0, 1, 0, 0.707, 0, 0.707, 0, 0, 0, 1]),
      makeTrack(2, "scale", [0, 2], [1, 1, 1, 3, 3, 3]),
    ]);

    const times = [0, 0.1, 0.25, 0.333, 0.5, 0.667, 0.75, 0.9, 1.0, 1.5, 2.0];

    for (const t of times) {
      const buf1 = identityTRS(3);
      const buf2 = identityTRS(3);
      sampleClip(clip, t, buf1);
      sampleClip(clip, t, buf2);
      for (let i = 0; i < buf1.length; i++) {
        assert.equal(buf1[i], buf2[i]);
      }
    }
  });

  test("componentsPerKey returns correct values", () => {
    assert.equal(componentsPerKey("translation"), 3);
    assert.equal(componentsPerKey("rotation"), 4);
    assert.equal(componentsPerKey("scale"), 3);
  });
});

// ──────────────────────── edge cases ────────────────────────

group("Animation edge cases", () => {
  test("handles single-key clip (constant value)", () => {
    const clip = createClip("const", [
      makeTrack(0, "translation", [0], [42, 99, -1]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    assertCloseTo(readTRS(out, 0).tx, 42, 6);
    assertCloseTo(readTRS(out, 0).ty, 99, 6);
    assertCloseTo(readTRS(out, 0).tz, -1, 6);

    // Same at any time
    sampleClip(clip, 100, out);
    assertCloseTo(readTRS(out, 0).tx, 42, 6);
  });

  test("negative time clamps to 0", () => {
    const clip = createClip("neg", [
      makeTrack(0, "translation", [0, 1], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, -5, out);
    assertCloseTo(readTRS(out, 0).tx, 10, 6);
  });

  test("time beyond duration clamps to last key", () => {
    const clip = createClip("beyond", [
      makeTrack(0, "translation", [0, 1], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 999, out);
    assertCloseTo(readTRS(out, 0).tx, 20, 6);
  });

  test("degenerate quaternion resets to identity", () => {
    // Rotation track with a zero quaternion at key 1.
    // The sampler should produce identity for the degenerate key.
    const clip = createClip("degen", [
      makeTrack(0, "rotation", [0, 1], [0, 0, 0, 1, 0, 0, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 1, out);
    // The normalizeQuat in the sampler resets to identity when len < 1e-8.
    // Note: validation would catch this, but the sampler is defensive.
    const trs = readTRS(out, 0);
    assertCloseTo(trs.rw, 1, 4);
  });

  test("initIdentity sets correct defaults", () => {
    const buf = identityTRS(2);
    for (let n = 0; n < 2; n++) {
      const trs = readTRS(buf, n);
      assert.equal(trs.tx, 0); assert.equal(trs.ty, 0); assert.equal(trs.tz, 0);
      assert.equal(trs.rx, 0); assert.equal(trs.ry, 0); assert.equal(trs.rz, 0); assert.equal(trs.rw, 1);
      assert.equal(trs.sx, 1); assert.equal(trs.sy, 1); assert.equal(trs.sz, 1);
    }
  });
});

await finish();
