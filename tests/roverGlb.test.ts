import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

interface GlbAccessor {
  bufferView?: number;
  componentType: number;
  count: number;
  type: string;
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
  nodes?: { name?: string; translation?: number[] }[];
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
