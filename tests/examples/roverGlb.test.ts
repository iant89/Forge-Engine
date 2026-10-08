/**
 * @suite examples:roverGlb
 * @group integration
 * @covers examples/assets/Perseverance.glb
 * @covers examples/src/scenes/roverArm.ts
 * @desc Pins rover glb behavior and regression guarantees
 */

export const suite = {
  name: "examples:roverGlb",
  group: "integration",
  covers:   [
    "examples/assets/Perseverance.glb",
    "examples/src/scenes/roverArm.ts"
  ],
  desc: "Pins rover glb behavior and regression guarantees",
};
import assert from "node:assert/strict";
import { assertCloseTo, assertContains, finish, group, test } from "selrun";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARM_JOINTS,
  ARM_LINKS_UV,
  ARM_SHOULDER_HEIGHT,
  ARM_STOWED_FOREARM_DEG,
  ARM_STOWED_UPPER_ARM_DEG,
} from "../../examples/src/scenes/roverArm.js";

interface GlbAccessor {
  bufferView?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GlbBufferView {
  byteOffset?: number;
  byteLength: number;
}

interface GlbMesh {
  name?: string;
  primitives: { attributes: Record<string, number>; indices?: number }[];
}

interface GlbJson {
  accessors: GlbAccessor[];
  bufferViews: GlbBufferView[];
  meshes: GlbMesh[];
  nodes?: {
    name?: string;
    mesh?: number;
    translation?: number[];
    children?: number[];
    extras?: { joint?: unknown; axis?: unknown };
  }[];
  scenes?: { nodes?: number[] }[];
}

const GLB_PATH = fileURLToPath(new URL("../../examples/assets/Perseverance.glb", import.meta.url));

/** Container-only parse: JSON chunk plus the BIN chunk's file offset (no image decode). */
function parseGlbContainer(file: Buffer): { json: GlbJson; binStart: number } {
  assert.equal(file.toString("ascii", 0, 4), "glTF");
  const total = file.readUInt32LE(8);
  let off = 12;
  let json: GlbJson | null = null;
  let binStart = -1;
  while (off < total) {
    const len = file.readUInt32LE(off);
    const type = file.toString("ascii", off + 4, off + 8);
    if (type === "JSON") json = JSON.parse(file.toString("utf8", off + 8, off + 8 + len)) as GlbJson;
    else if (type === "BIN\0") binStart = off + 8;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || binStart < 0) throw new Error("GLB missing JSON or BIN chunk");
  return { json, binStart };
}

group("Perseverance.glb (mars showcase rover)", () => {
  test("keeps the six wheel roots the showcase poses by name", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    const wheels = new Map(
      (json.nodes ?? [])
        .filter((n) => n.name !== undefined && /^wheel_[FMR][LR]$/.test(n.name))
        .map((n) => [n.name as string, n.translation ?? [0, 0, 0]]),
    );
    assert.deepEqual([...wheels.keys()].sort(), [
      "wheel_FL",
      "wheel_FR",
      "wheel_ML",
      "wheel_MR",
      "wheel_RL",
      "wheel_RR",
    ]);
    // Hubs must sit on the expected axles/sides: -X left, +Z nose (metres, ±2 cm).
    const expected: Record<string, [number, number]> = {
      wheel_FL: [-1.091, 1.095],
      wheel_FR: [1.091, 1.095],
      wheel_ML: [-1.213, -0.09],
      wheel_MR: [1.213, -0.09],
      wheel_RL: [-1.091, -1.165],
      wheel_RR: [1.091, -1.165],
    };
    for (const [name, [x, z]] of Object.entries(expected)) {
      const hub = wheels.get(name) ?? [0, 0, 0];
      assertCloseTo(hub[0], x, 1);
      assertCloseTo(hub[2], z, 1);
    }
  });

  test("keeps the camera-mast assembly on a hinge-rooted `mast` node", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    const roots = (json.nodes ?? []).filter((n) => n.name === "mast");
    assert.equal(roots.length, 1);
    // Deployment hinge at the stowed pose's front bracket (converter `mast.pivot`).
    const pivot = roots[0]!.translation ?? [0, 0, 0];
    assertCloseTo(pivot[0], -0.4754, 2);
    assertCloseTo(pivot[1], 1.245, 2);
    assertCloseTo(pivot[2], 0.8388, 2);
    // Hinge-relative parts: nothing ahead of the hinge, the stowed boom reaching back.
    const mastMeshes = json.meshes.filter((m) => m.name?.startsWith("mast_"));
    assert.ok(mastMeshes.length > 0);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const mesh of mastMeshes) {
      const acc = json.accessors[mesh.primitives[0]!.attributes.POSITION!]!;
      minZ = Math.min(minZ, acc.min?.[2] ?? Infinity);
      maxZ = Math.max(maxZ, acc.max?.[2] ?? -Infinity);
    }
    assert.ok(maxZ < 0.1);
    assert.ok(minZ < -0.5);
  });

  test("records the mast sub-group joints in extras, not translations that double-offset its parts", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    for (const name of ["mast_upper", "mast_head"]) {
      const node = (json.nodes ?? []).find((n) => n.name === name);
      assert.notEqual(node, undefined, name);
      assert.equal(node!.translation, undefined);
      assert.equal(Array.isArray(node!.extras?.joint) && (node!.extras!.joint as unknown[]).length, 3);
    }
  });

  test("ships the robotic arm as a nested, pivot-relative joint chain matching the controller", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    const nodes = json.nodes ?? [];
    const chain = ["arm", "arm_shoulder", "arm_elbow", "arm_wrist", "arm_turret"].map((name) => {
      const matches = nodes.flatMap((n, i) => (n.name === name ? [i] : []));
      assert.equal(matches.length, 1, name);
      return matches[0]!;
    });
    // A scene root, each joint hanging directly off the previous one (so it rides along).
    assertContains(json.scenes?.[0]?.nodes, chain[0]);
    for (let j = 1; j < chain.length; j++) assertContains(nodes[chain[j - 1]!]!.children, chain[j]);
    // Joint roles in the controller's order, and the axes it rotates about.
    assert.deepEqual(chain.map((i) => nodes[i]!.extras?.joint), [...ARM_JOINTS]);
    assert.deepEqual(chain.map((i) => nodes[i]!.extras?.axis), [[0, 1, 0], [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 1, 0]]);
    // Azimuth pivot on the front-right mount ring (converter `arm[0].pivot`).
    const t = chain.map((i) => nodes[i]!.translation ?? [0, 0, 0]);
    assertCloseTo(t[0]![0], 0.4515, 3);
    assertCloseTo(t[0]![1], 0.9148, 3);
    assertCloseTo(t[0]![2], 1.1755, 3);
    // The planar geometry roverArm.ts hardcodes for its ground guard and ready pose: J2 height,
    // then each link's stowed (reach = −X, up = +Y) vector — re-derived so a reconversion that
    // moves a pivot fails here instead of silently mis-aiming the arm.
    assertCloseTo(t[0]![1] + t[1]![1], ARM_SHOULDER_HEIGHT, 3);
    for (let k = 0; k < 3; k++) {
      assertCloseTo(-t[k + 2]![0], ARM_LINKS_UV[k]![0], 3);
      assertCloseTo(t[k + 2]![1], ARM_LINKS_UV[k]![1], 3);
    }
    const planarDeg = (v: number[]): number => (Math.atan2(v[1]!, -v[0]!) * 180) / Math.PI;
    assertCloseTo(planarDeg(t[2]!), ARM_STOWED_UPPER_ARM_DEG, 1);
    assertCloseTo(planarDeg(t[3]!), ARM_STOWED_FOREARM_DEG, 1);
    // Every link carries pivot-relative geometry that surrounds its own joint housing (world-space
    // vertices would sit ~1 m away from the origin) and stays within a link length of it.
    for (const [j, index] of chain.entries()) {
      const parts = (nodes[index]!.children ?? []).map((c) => nodes[c]!).filter((n) => n.mesh !== undefined);
      assert.ok(parts.length > 0, ARM_JOINTS[j]);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const part of parts) {
        for (const prim of json.meshes[part.mesh!]!.primitives) {
          const acc = json.accessors[prim.attributes.POSITION!]!;
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, acc.min?.[k] ?? Infinity);
            max[k] = Math.max(max[k]!, acc.max?.[k] ?? -Infinity);
          }
        }
      }
      for (let k = 0; k < 3; k++) {
        assert.ok(min[k] < 0.02, `${ARM_JOINTS[j]} min[${k}]`);
        assert.ok(max[k] > -0.02, `${ARM_JOINTS[j]} max[${k}]`);
        assert.ok(Math.max(-min[k]!, max[k]!) < 1.2, `${ARM_JOINTS[j]} extent[${k}]`);
      }
    }
    // The parent-relative translations compose back to the turret post's model-space pivot.
    const turretPivot = [0, 1, 2].map((k) => t.reduce((sum, v) => sum + v[k]!, 0));
    assertCloseTo(turretPivot[0], 0.4272, 3);
    assertCloseTo(turretPivot[1], 1.228, 3);
    assertCloseTo(turretPivot[2], 0.9964, 3);
  });

  test("has in-range indices on every mesh (no invisible wheels)", () => {
    // Regression: the converter once emitted per-wheel slices with global (non-rebased)
    // indices, so only wheel_FL (base 0) rendered and the other five wheels were invisible
    // with no error. Every mesh's index max must be below its vertex count.
    const file = fs.readFileSync(GLB_PATH);
    const { json, binStart } = parseGlbContainer(file);
    assert.ok(json.meshes.length > 0);
    for (const mesh of json.meshes) {
      for (const prim of mesh.primitives) {
        const verts = json.accessors[prim.attributes.POSITION!]!.count;
        const idxAcc = json.accessors[prim.indices!]!;
        assert.equal(idxAcc.componentType, 5125); // converter writes UINT32 indices
        const bv: GlbBufferView = json.bufferViews[idxAcc.bufferView!]!;
        const start = binStart + (bv.byteOffset ?? 0);
        let max = -1;
        for (let i = 0; i < idxAcc.count; i++) {
          const v = file.readUInt32LE(start + i * 4);
          if (v > max) max = v;
        }
        assert.ok(max < verts);
      }
    }
  });
});

await finish();
