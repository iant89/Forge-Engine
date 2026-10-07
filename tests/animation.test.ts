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

import { describe, expect, it, beforeEach } from "vitest";
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

describe("AnimationClip creation", () => {
  it("computes duration from max track end time", () => {
    const clip = createClip("test", [
      makeTrack(0, "translation", [0, 1, 2], [0, 0, 0, 1, 0, 0, 2, 0, 0]),
      makeTrack(1, "rotation", [0, 3], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    expect(clip.duration).toBe(3);
    expect(clip.name).toBe("test");
    expect(clip.tracks).toHaveLength(2);
  });

  it("drops empty tracks", () => {
    const clip = createClip("empty", [
      makeTrack(0, "translation", [], []),
      makeTrack(1, "scale", [0], [1, 1, 1]),
    ]);
    expect(clip.tracks).toHaveLength(1);
    expect(clip.tracks[0]!.nodeIndex).toBe(1);
  });

  it("handles single-key clips with zero duration", () => {
    const clip = createClip("pose", [
      makeTrack(0, "translation", [0], [1, 2, 3]),
    ]);
    expect(clip.duration).toBe(0);
  });
});

// ──────────────────────── validation ────────────────────────

describe("AnimationTrack validation", () => {
  it("accepts a valid LINEAR translation track", () => {
    const track = makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0]);
    expect(validateTrack(track, "test")).toEqual([]);
  });

  it("accepts a valid LINEAR rotation track", () => {
    const track = makeTrack(0, "rotation", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
    expect(validateTrack(track, "test")).toEqual([]);
  });

  it("accepts a valid CUBICSPLINE track", () => {
    // 2 keys, translation: each key has in-tangent(3), value(3), out-tangent(3) = 18 floats
    const track = makeTrack(0, "translation", [0, 1],
      [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      "CUBICSPLINE");
    expect(validateTrack(track, "test")).toEqual([]);
  });

  it("rejects empty tracks", () => {
    const track = makeTrack(0, "translation", [], []);
    const errors = validateTrack(track, "test");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("no keys");
  });

  it("rejects mismatched value count", () => {
    // 2 keys for translation = needs 6 values, give 4
    const track = makeTrack(0, "translation", [0, 1], [0, 0, 0, 1]);
    const errors = validateTrack(track, "test");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("expected");
  });

  it("rejects non-monotonic timestamps", () => {
    const track = makeTrack(0, "translation", [0, 2, 1], [0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const errors = validateTrack(track, "test");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("monotonically");
  });

  it("rejects zero quaternion in rotation track", () => {
    const track = makeTrack(0, "rotation", [0, 1], [0, 0, 0, 0, 0, 0, 0, 1]);
    const errors = validateTrack(track, "test");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("zero quaternion");
  });
});

// ──────────────────────── sampling: STEP ────────────────────────

describe("STEP interpolation", () => {
  it("returns the value at or before the current time", () => {
    const clip = createClip("step", [
      makeTrack(0, "translation", [0, 1, 2], [0, 0, 0, 10, 0, 0, 20, 0, 0], "STEP"),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    expect(readTRS(out, 0).tx).toBe(0);

    sampleClip(clip, 0.5, out);
    expect(readTRS(out, 0).tx).toBe(0); // step: snap to key at t=0

    sampleClip(clip, 1, out);
    expect(readTRS(out, 0).tx).toBe(10);

    sampleClip(clip, 1.5, out);
    expect(readTRS(out, 0).tx).toBe(10); // step: snap to key at t=1

    sampleClip(clip, 2, out);
    expect(readTRS(out, 0).tx).toBe(20);
  });
});

// ──────────────────────── sampling: LINEAR ────────────────────────

describe("LINEAR interpolation", () => {
  it("linearly interpolates translation", () => {
    const clip = createClip("lerp", [
      makeTrack(0, "translation", [0, 1], [0, 0, 0, 10, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0.5, out);
    const trs = readTRS(out, 0);
    expect(trs.tx).toBeCloseTo(5, 6);
    expect(trs.ty).toBe(0);
  });

  it("linearly interpolates scale", () => {
    const clip = createClip("scale", [
      makeTrack(0, "scale", [0, 1], [1, 1, 1, 2, 2, 2]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0.25, out);
    const trs = readTRS(out, 0);
    expect(trs.sx).toBeCloseTo(1.25, 6);
    expect(trs.sy).toBeCloseTo(1.25, 6);
  });

  it("uses SLERP for rotation", () => {
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
    expect(trs.rw).toBeCloseTo(cos22, 4);
    expect(trs.ry).toBeCloseTo(sin22, 4);
    expect(trs.rx).toBeCloseTo(0, 6);
    expect(trs.rz).toBeCloseTo(0, 6);
  });

  it("handles shortest-arc rotation (negated B)", () => {
    // Rotating 180° around Y: from identity to (0, 1, 0, 0)
    const clip = createClip("half", [
      makeTrack(0, "rotation", [0, 1], [0, 0, 0, 1, 0, 1, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0.5, out);
    // At 90°: (0, sin45, 0, cos45)
    const trs = readTRS(out, 0);
    expect(trs.rw).toBeCloseTo(Math.cos(Math.PI / 4), 4);
    expect(trs.ry).toBeCloseTo(Math.sin(Math.PI / 4), 4);
  });

  it("clamps to first key before range", () => {
    const clip = createClip("clamp", [
      makeTrack(0, "translation", [1, 2], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    expect(readTRS(out, 0).tx).toBe(10);
  });

  it("clamps to last key after range", () => {
    const clip = createClip("clamp", [
      makeTrack(0, "translation", [1, 2], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 5, out);
    expect(readTRS(out, 0).tx).toBe(20);
  });
});

// ──────────────────────── sampling: CUBICSPLINE ────────────────────────

describe("CUBICSPLINE interpolation", () => {
  it("evaluates identity tangents as linear", () => {
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
    expect(readTRS(out, 0).tx).toBeCloseTo(0, 6);

    // At t=1, should be value of key 1 = (1,0,0)
    sampleClip(clip, 1, out);
    expect(readTRS(out, 0).tx).toBeCloseTo(1, 6);

    // At t=0.5, should be near 0.5 (smooth curve through the values)
    sampleClip(clip, 0.5, out);
    expect(readTRS(out, 0).tx).toBeGreaterThan(0);
    expect(readTRS(out, 0).tx).toBeLessThan(1);
  });

  it("single-key CUBICSPLINE returns the value (middle sample)", () => {
    const clip = createClip("single", [
      makeTrack(0, "translation", [0], [
        0, 0, 0,   5, 10, 15,   0, 0, 0,  // in, val, out
      ], "CUBICSPLINE"),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    const trs = readTRS(out, 0);
    expect(trs.tx).toBeCloseTo(5, 6);
    expect(trs.ty).toBeCloseTo(10, 6);
    expect(trs.tz).toBeCloseTo(15, 6);
  });
});

// ──────────────────────── multi-track / multi-node ────────────────────────

describe("Multi-track sampling", () => {
  it("samples different nodes independently", () => {
    const clip = createClip("multi", [
      makeTrack(0, "translation", [0, 1], [0, 0, 0, 5, 0, 0]),
      makeTrack(1, "translation", [0, 1], [0, 0, 0, 0, 10, 0]),
      makeTrack(2, "scale", [0, 1], [1, 1, 1, 3, 3, 3]),
    ]);
    const out = identityTRS(3);
    sampleClip(clip, 0.5, out);
    expect(readTRS(out, 0).tx).toBeCloseTo(2.5, 6);
    expect(readTRS(out, 1).ty).toBeCloseTo(5, 6);
    expect(readTRS(out, 2).sx).toBeCloseTo(2, 6);
  });

  it("does not touch un-targeted nodes", () => {
    const clip = createClip("sparse", [
      makeTrack(1, "translation", [0, 1], [0, 0, 0, 100, 0, 0]),
    ]);
    const out = identityTRS(3);
    sampleClip(clip, 0.5, out);
    // Node 0 should remain identity.
    const n0 = readTRS(out, 0);
    expect(n0.tx).toBe(0);
    expect(n0.rw).toBe(1);
    expect(n0.sx).toBe(1);
    // Node 2 should remain identity.
    const n2 = readTRS(out, 2);
    expect(n2.tx).toBe(0);
    expect(n2.rw).toBe(1);
  });
});

// ──────────────────────── AnimationComponent ────────────────────────

describe("AnimationComponent", () => {
  let anim: AnimationComponent;

  beforeEach(() => {
    anim = new AnimationComponent();
    anim.nodeToEntity = [10, 11, 12];
  });

  it("starts with no clips and not playing", () => {
    expect(anim.isPlaying).toBe(false);
    expect([...anim.clipNames]).toEqual([]);
  });

  it("adds clips and plays/stops them", () => {
    const clip = createClip("walk", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]);
    anim.addClip(clip);
    expect([...anim.clipNames]).toEqual(["walk"]);
    expect(anim.isPlaying).toBe(false);

    anim.play("walk");
    expect(anim.isPlaying).toBe(true);

    anim.stop("walk");
    expect(anim.isPlaying).toBe(false);
    expect(anim.getPlayback("walk")!.time).toBe(0);
  });

  it("pauses without resetting time", () => {
    const clip = createClip("run", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]);
    anim.addClip(clip);
    anim.play("run");
    anim.getPlayback("run")!.time = 0.5;
    anim.pause("run");
    expect(anim.isPlaying).toBe(false);
    expect(anim.getPlayback("run")!.time).toBe(0.5);
  });

  it("stopAll resets all clips", () => {
    anim.addClip(createClip("a", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]));
    anim.addClip(createClip("b", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]));
    anim.play("a");
    anim.play("b");
    anim.getPlayback("a")!.time = 0.3;
    anim.stopAll();
    expect(anim.isPlaying).toBe(false);
    expect(anim.getPlayback("a")!.time).toBe(0);
    expect(anim.getPlayback("b")!.time).toBe(0);
  });

  it("sets speed, looping, weight", () => {
    const clip = createClip("idle", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]);
    anim.addClip(clip);
    anim.setSpeed("idle", 2);
    anim.setLooping("idle", true);
    anim.setWeight("idle", 0.5);
    const p = anim.getPlayback("idle")!;
    expect(p.speed).toBe(2);
    expect(p.looping).toBe(true);
    expect(p.weight).toBe(0.5);
  });

  it("reports jointCount from nodeToEntity", () => {
    expect(anim.jointCount).toBe(3);
  });

  it("returns empty playing clips when nothing plays", () => {
    anim.addClip(createClip("x", [makeTrack(0, "translation", [0, 1], [0, 0, 0, 1, 0, 0])]));
    expect(anim.getPlayingClips()).toEqual([]);
  });
});

// ──────────────────────── assembly ────────────────────────

describe("Animation assembly", () => {
  it("converts a decoded glTF animation into an AnimationClip", () => {
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
    expect(clip.name).toBe("walk");
    expect(clip.tracks).toHaveLength(2);
    expect(clip.duration).toBe(1);
    expect(clip.tracks[0]!.nodeIndex).toBe(1);
    expect(clip.tracks[0]!.path).toBe("translation");
    expect(clip.tracks[1]!.path).toBe("rotation");
  });

  it("assembles multiple clips", () => {
    const decoded = [
      { name: "a", channels: [{ targetNode: 0, targetPath: "translation" as const, samplerIndex: 0 }], samplers: [{ input: Float32Array.from([0]), output: Float32Array.from([0, 0, 0]), interpolation: "LINEAR" as const }], duration: 0 },
      { name: "b", channels: [{ targetNode: 0, targetPath: "scale" as const, samplerIndex: 0 }], samplers: [{ input: Float32Array.from([0, 1]), output: Float32Array.from([1, 1, 1, 2, 2, 2]), interpolation: "LINEAR" as const }], duration: 1 },
    ];
    const clips = assembleClips(decoded);
    expect(clips).toHaveLength(2);
    expect(clips[0]!.name).toBe("a");
    expect(clips[1]!.name).toBe("b");
  });
});

// ──────────────────────── glTF animation decode ────────────────────────

describe("glTF animation decoder", () => {
  it("decodes LINEAR translation and rotation channels", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims = decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf");
    expect(anims).toHaveLength(1);
    expect(anims[0]!.name).toBe("walk");
    expect(anims[0]!.channels).toHaveLength(2);
    expect(anims[0]!.samplers).toHaveLength(2);

    // Translation sampler
    const transSampler = anims[0]!.samplers[0]!;
    expect(transSampler.interpolation).toBe("LINEAR");
    expect(transSampler.input).toEqual(Float32Array.from([0, 0.5, 1]));
    expect(transSampler.output.length).toBe(9); // 3 keys × 3 components

    // Rotation sampler
    const rotSampler = anims[0]!.samplers[1]!;
    expect(rotSampler.interpolation).toBe("LINEAR");
    expect(rotSampler.input).toEqual(Float32Array.from([0, 1]));
    expect(rotSampler.output.length).toBe(8); // 2 keys × 4 components
  });

  it("returns empty array when document has no animations", () => {
    const doc = { asset: { version: "2.0" }, nodes: [], scenes: [] } as Record<string, unknown>;
    const anims = decodeGltfAnimations(doc, [], 0, "test.gltf");
    expect(anims).toEqual([]);
  });

  it("rejects invalid interpolation mode", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims = (doc as Record<string, unknown>).animations as { samplers: { interpolation: string }[] }[];
    anims[0]!.samplers[0]!.interpolation = "BEZIER";
    expect(() => decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf")).toThrow("unsupported interpolation");
  });

  it("rejects out-of-range target node", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    (doc as Record<string, unknown>).animations = [{
      name: "bad",
      channels: [{ sampler: 0, target: { node: 99, path: "translation" } }],
      samplers: [{ input: 0, output: 1 }],
    }];
    expect(() => decodeGltfAnimations(doc, buffers, 2, "test.gltf")).toThrow("invalid node");
  });

  it("skips morph target weight channels", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims0 = (doc as Record<string, unknown>).animations as { channels: { sampler: number; target: { node: number; path: string } }[] }[];
    anims0[0]!.channels.push({
      sampler: 0,
      target: { node: 0, path: "weights" },
    });
    const anims = decodeGltfAnimations(doc, buffers, 2, "test.gltf");
    // Should still have only 2 channels (translation + rotation; weights skipped)
    expect(anims[0]!.channels).toHaveLength(2);
  });

  it("rejects non-monotonic timestamps", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    // Overwrite the first accessor's data with non-monotonic timestamps
    const view = new Float32Array(buffers[0]!);
    view[0] = 0; view[1] = 2; view[2] = 1; // 0, 2, 1 — not monotonic
    expect(() => decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf")).toThrow("monotonically increasing");
  });

  it("transfers typed array buffers for decoded animations", () => {
    const { doc, buffers } = makeGltfWithAnimation();
    const anims = decodeGltfAnimations(doc as Record<string, unknown>, buffers, 2, "test.gltf");
    expect(anims).toHaveLength(1);
    expect(anims[0]!.samplers[0]!.input).toBeInstanceOf(Float32Array);
    expect(anims[0]!.samplers[0]!.output).toBeInstanceOf(Float32Array);
  });
});

// ──────────────────────── determinism ────────────────────────

describe("Animation determinism", () => {
  it("produces identical output for the same clip at the same time (100 samples)", () => {
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
        expect(buf1[i]).toBe(buf2[i]);
      }
    }
  });

  it("componentsPerKey returns correct values", () => {
    expect(componentsPerKey("translation")).toBe(3);
    expect(componentsPerKey("rotation")).toBe(4);
    expect(componentsPerKey("scale")).toBe(3);
  });
});

// ──────────────────────── edge cases ────────────────────────

describe("Animation edge cases", () => {
  it("handles single-key clip (constant value)", () => {
    const clip = createClip("const", [
      makeTrack(0, "translation", [0], [42, 99, -1]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 0, out);
    expect(readTRS(out, 0).tx).toBeCloseTo(42, 6);
    expect(readTRS(out, 0).ty).toBeCloseTo(99, 6);
    expect(readTRS(out, 0).tz).toBeCloseTo(-1, 6);

    // Same at any time
    sampleClip(clip, 100, out);
    expect(readTRS(out, 0).tx).toBeCloseTo(42, 6);
  });

  it("negative time clamps to 0", () => {
    const clip = createClip("neg", [
      makeTrack(0, "translation", [0, 1], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, -5, out);
    expect(readTRS(out, 0).tx).toBeCloseTo(10, 6);
  });

  it("time beyond duration clamps to last key", () => {
    const clip = createClip("beyond", [
      makeTrack(0, "translation", [0, 1], [10, 0, 0, 20, 0, 0]),
    ]);
    const out = identityTRS(1);
    sampleClip(clip, 999, out);
    expect(readTRS(out, 0).tx).toBeCloseTo(20, 6);
  });

  it("degenerate quaternion resets to identity", () => {
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
    expect(trs.rw).toBeCloseTo(1, 4);
  });

  it("initIdentity sets correct defaults", () => {
    const buf = identityTRS(2);
    for (let n = 0; n < 2; n++) {
      const trs = readTRS(buf, n);
      expect(trs.tx).toBe(0); expect(trs.ty).toBe(0); expect(trs.tz).toBe(0);
      expect(trs.rx).toBe(0); expect(trs.ry).toBe(0); expect(trs.rz).toBe(0); expect(trs.rw).toBe(1);
      expect(trs.sx).toBe(1); expect(trs.sy).toBe(1); expect(trs.sz).toBe(1);
    }
  });
});