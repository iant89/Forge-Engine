import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARM_JOINTS,
  ARM_LINKS_UV,
  ARM_SHOULDER_HEIGHT,
  ARM_STOWED_FOREARM_DEG,
  ARM_STOWED_UPPER_ARM_DEG,
} from "../examples/src/scenes/roverArm.js";

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

const GLB_PATH = fileURLToPath(new URL("../examples/assets/Perseverance.glb", import.meta.url));

/** Container-only parse: JSON chunk plus the BIN chunk's file offset (no image decode). */
function parseGlbContainer(file: Buffer): { json: GlbJson; binStart: number } {
  expect(file.toString("ascii", 0, 4)).toBe("glTF");
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

describe("Perseverance.glb (mars showcase rover)", () => {
  it("keeps the six wheel roots the showcase poses by name", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    const wheels = new Map(
      (json.nodes ?? [])
        .filter((n) => n.name !== undefined && /^wheel_[FMR][LR]$/.test(n.name))
        .map((n) => [n.name as string, n.translation ?? [0, 0, 0]]),
    );
    expect([...wheels.keys()].sort()).toEqual([
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
      expect(hub[0]).toBeCloseTo(x, 1);
      expect(hub[2]).toBeCloseTo(z, 1);
    }
  });

  it("keeps the camera-mast assembly on a hinge-rooted `mast` node", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    const roots = (json.nodes ?? []).filter((n) => n.name === "mast");
    expect(roots.length).toBe(1);
    // Deployment hinge at the stowed pose's front bracket (converter `mast.pivot`).
    const pivot = roots[0]!.translation ?? [0, 0, 0];
    expect(pivot[0]).toBeCloseTo(-0.4754, 2);
    expect(pivot[1]).toBeCloseTo(1.245, 2);
    expect(pivot[2]).toBeCloseTo(0.8388, 2);
    // Hinge-relative parts: nothing ahead of the hinge, the stowed boom reaching back.
    const mastMeshes = json.meshes.filter((m) => m.name?.startsWith("mast_"));
    expect(mastMeshes.length).toBeGreaterThan(0);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const mesh of mastMeshes) {
      const acc = json.accessors[mesh.primitives[0]!.attributes.POSITION!]!;
      minZ = Math.min(minZ, acc.min?.[2] ?? Infinity);
      maxZ = Math.max(maxZ, acc.max?.[2] ?? -Infinity);
    }
    expect(maxZ).toBeLessThan(0.1);
    expect(minZ).toBeLessThan(-0.5);
  });

  it("records the mast sub-group joints in extras, not translations that double-offset its parts", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    for (const name of ["mast_upper", "mast_head"]) {
      const node = (json.nodes ?? []).find((n) => n.name === name);
      expect(node, name).toBeDefined();
      expect(node!.translation).toBeUndefined();
      expect(Array.isArray(node!.extras?.joint) && (node!.extras!.joint as unknown[]).length).toBe(3);
    }
  });

  it("ships the robotic arm as a nested, pivot-relative joint chain matching the controller", () => {
    const { json } = parseGlbContainer(fs.readFileSync(GLB_PATH));
    const nodes = json.nodes ?? [];
    const chain = ["arm", "arm_shoulder", "arm_elbow", "arm_wrist", "arm_turret"].map((name) => {
      const matches = nodes.flatMap((n, i) => (n.name === name ? [i] : []));
      expect(matches.length, name).toBe(1);
      return matches[0]!;
    });
    // A scene root, each joint hanging directly off the previous one (so it rides along).
    expect(json.scenes?.[0]?.nodes).toContain(chain[0]);
    for (let j = 1; j < chain.length; j++) expect(nodes[chain[j - 1]!]!.children).toContain(chain[j]);
    // Joint roles in the controller's order, and the axes it rotates about.
    expect(chain.map((i) => nodes[i]!.extras?.joint)).toEqual([...ARM_JOINTS]);
    expect(chain.map((i) => nodes[i]!.extras?.axis)).toEqual([[0, 1, 0], [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 1, 0]]);
    // Azimuth pivot on the front-right mount ring (converter `arm[0].pivot`).
    const t = chain.map((i) => nodes[i]!.translation ?? [0, 0, 0]);
    expect(t[0]![0]).toBeCloseTo(0.4515, 3);
    expect(t[0]![1]).toBeCloseTo(0.9148, 3);
    expect(t[0]![2]).toBeCloseTo(1.1755, 3);
    // The planar geometry roverArm.ts hardcodes for its ground guard and ready pose: J2 height,
    // then each link's stowed (reach = −X, up = +Y) vector — re-derived so a reconversion that
    // moves a pivot fails here instead of silently mis-aiming the arm.
    expect(t[0]![1] + t[1]![1]).toBeCloseTo(ARM_SHOULDER_HEIGHT, 3);
    for (let k = 0; k < 3; k++) {
      expect(-t[k + 2]![0]).toBeCloseTo(ARM_LINKS_UV[k]![0], 3);
      expect(t[k + 2]![1]).toBeCloseTo(ARM_LINKS_UV[k]![1], 3);
    }
    const planarDeg = (v: number[]): number => (Math.atan2(v[1]!, -v[0]!) * 180) / Math.PI;
    expect(planarDeg(t[2]!)).toBeCloseTo(ARM_STOWED_UPPER_ARM_DEG, 1);
    expect(planarDeg(t[3]!)).toBeCloseTo(ARM_STOWED_FOREARM_DEG, 1);
    // Every link carries pivot-relative geometry that surrounds its own joint housing (world-space
    // vertices would sit ~1 m away from the origin) and stays within a link length of it.
    for (const [j, index] of chain.entries()) {
      const parts = (nodes[index]!.children ?? []).map((c) => nodes[c]!).filter((n) => n.mesh !== undefined);
      expect(parts.length, ARM_JOINTS[j]).toBeGreaterThan(0);
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
        expect(min[k], `${ARM_JOINTS[j]} min[${k}]`).toBeLessThan(0.02);
        expect(max[k], `${ARM_JOINTS[j]} max[${k}]`).toBeGreaterThan(-0.02);
        expect(Math.max(-min[k]!, max[k]!), `${ARM_JOINTS[j]} extent[${k}]`).toBeLessThan(1.2);
      }
    }
    // The parent-relative translations compose back to the turret post's model-space pivot.
    const turretPivot = [0, 1, 2].map((k) => t.reduce((sum, v) => sum + v[k]!, 0));
    expect(turretPivot[0]).toBeCloseTo(0.4272, 3);
    expect(turretPivot[1]).toBeCloseTo(1.228, 3);
    expect(turretPivot[2]).toBeCloseTo(0.9964, 3);
  });

  it("has in-range indices on every mesh (no invisible wheels)", () => {
    // Regression: the converter once emitted per-wheel slices with global (non-rebased)
    // indices, so only wheel_FL (base 0) rendered and the other five wheels were invisible
    // with no error. Every mesh's index max must be below its vertex count.
    const file = fs.readFileSync(GLB_PATH);
    const { json, binStart } = parseGlbContainer(file);
    expect(json.meshes.length).toBeGreaterThan(0);
    for (const mesh of json.meshes) {
      for (const prim of mesh.primitives) {
        const verts = json.accessors[prim.attributes.POSITION!]!.count;
        const idxAcc = json.accessors[prim.indices!]!;
        expect(idxAcc.componentType).toBe(5125); // converter writes UINT32 indices
        const bv: GlbBufferView = json.bufferViews[idxAcc.bufferView!]!;
        const start = binStart + (bv.byteOffset ?? 0);
        let max = -1;
        for (let i = 0; i < idxAcc.count; i++) {
          const v = file.readUInt32LE(start + i * 4);
          if (v > max) max = v;
        }
        expect(max).toBeLessThan(verts);
      }
    }
  });
});
