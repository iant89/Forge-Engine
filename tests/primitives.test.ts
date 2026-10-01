import { describe, expect, it } from "vitest";
import {
  boxGeometrySource,
  sphereGeometrySource,
  cylinderGeometrySource,
  planeGeometrySource,
  torusGeometrySource,
  coneGeometrySource,
  debrisGeometrySource,
  vegetationGeometrySource,
  propGeometrySource,
  rockGeometrySource,
  createLodPrimitive,
  Geometry,
  GraphicsDevice,
  MAX_GEOMETRY_LODS,
  Mat4,
  Vec3,
  type GeometrySource,
} from "@forge/engine";

function analyzeGeometry(geo: ReturnType<typeof boxGeometrySource>, name: string) {
  const p = geo.positions;
  const n = geo.normals!;
  const idx = geo.indices!;
  let outward = 0;
  let inward = 0;
  let zero = 0;

  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]!;
    const i1 = idx[t + 1]!;
    const i2 = idx[t + 2]!;

    const p0 = [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!];
    const p1 = [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!];
    const p2 = [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!];

    // e1 = p1 - p0, e2 = p2 - p0
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];

    // Cross product e1 x e2
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];

    // Vertex normals average
    const vn = [
      (n[i0 * 3]! + n[i1 * 3]! + n[i2 * 3]!) / 3,
      (n[i0 * 3 + 1]! + n[i1 * 3 + 1]! + n[i2 * 3 + 1]!) / 3,
      (n[i0 * 3 + 2]! + n[i1 * 3 + 2]! + n[i2 * 3 + 2]!) / 3,
    ];

    const dot = fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2];
    if (dot > 1e-6) outward++;
    else if (dot < -1e-6) inward++;
    else zero++;
  }

  // `name` is part of the returned record so a failing assertion says which primitive it was.
  return { name, outward, inward, zero, total: idx.length / 3 };
}

describe("Primitive face normal vs vertex normal", () => {
  it("all primitives have outward windings matching pipeline frontFace: cw", () => {
    const box = analyzeGeometry(boxGeometrySource(), "box");
    expect(box.inward).toBe(0);

    const plane = analyzeGeometry(planeGeometrySource(), "plane");
    expect(plane.inward).toBe(0);

    const cyl = analyzeGeometry(cylinderGeometrySource(), "cylinder");
    expect(cyl.inward).toBe(0);

    const cone = analyzeGeometry(coneGeometrySource(), "cone");
    expect(cone.inward).toBe(0);

    const sphere = analyzeGeometry(sphereGeometrySource(), "sphere");
    expect(sphere.inward).toBe(0);

    const torus = analyzeGeometry(torusGeometrySource(), "torus");
    expect(torus.inward).toBe(0);
    expect(torus.outward).toBe(torus.total);
  });

  it("torus camera-facing triangles wind clockwise on screen", () => {
    const geo = torusGeometrySource({ radius: 0.8, tube: 0.28 });
    const view = new Mat4().setLookAt(new Vec3(0, 0, -5), new Vec3(0, 0, 0), new Vec3(0, 1, 0));
    const proj = new Mat4().setPerspective(Math.PI / 3, 16 / 9, 0.1, 100);
    const vp = new Mat4().multiplyMatrices(proj, view);

    const p = geo.positions;
    const n = geo.normals!;
    const idx = geo.indices!;

    let cameraFacingCw = 0;
    let cameraFacingCcw = 0;

    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t]!;
      const i1 = idx[t + 1]!;
      const i2 = idx[t + 2]!;

      // Normal facing camera has n_z < -0.2 (camera looks down +Z from -5 to 0)
      const avgNz = (n[i0 * 3 + 2]! + n[i1 * 3 + 2]! + n[i2 * 3 + 2]!) / 3;
      if (avgNz >= -0.2) continue;

      const tri = [
        [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!],
        [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!],
        [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!],
      ];

      const ndc = tri.map(([x, y, z]) => {
        const o = new Float32Array(4);
        vp.transformVec4(x!, y!, z!, 1, o);
        return [o[0]! / o[3]!, o[1]! / o[3]!];
      });

      const signedArea =
        (ndc[1]![0]! - ndc[0]![0]!) * (ndc[2]![1]! - ndc[0]![1]!) -
        (ndc[2]![0]! - ndc[0]![0]!) * (ndc[1]![1]! - ndc[0]![1]!);

      if (signedArea < 0) cameraFacingCw++;
      else cameraFacingCcw++;
    }

    expect(cameraFacingCw).toBeGreaterThan(0);
    expect(cameraFacingCcw).toBe(0);
  });
});

/**
 * Phase 14.2's population primitives and Phase 14.4's LOD chain.
 *
 * A population primitive is drawn thousands of times a frame at scatter scale, so the properties that
 * matter are the ones a scatter assumes: the base sits at y = 0 (that is what `embed` sinks), the
 * shape is wound outward (back-face culling is on for everything but vegetation), the vertex and index
 * counts are the documented formula (so a LOD level's cost is predictable), and the whole thing is a
 * pure function of its options — two scenes with the same seed must place the same shards.
 *
 * A LOD chain is one geometry whose index buffer holds every level, because that is what lets the
 * device culler switch levels by rewriting two words of an indirect record instead of rebinding
 * buffers. So the chain's windows must tile the index buffer exactly, its indices must be global
 * (`baseVertex` stays 0 for every level), and a level authored with fewer channels must still fill the
 * fixed vertex layout.
 */
describe("Population primitives (14.2)", () => {
  /** Every index in range, every count a multiple of three, every channel finite. */
  function assertWellFormed(src: GeometrySource, name: string) {
    const verts = Math.floor(src.positions.length / 3);
    expect(verts, name).toBeGreaterThan(0);
    expect(src.indices, name).toBeDefined();
    expect(src.indices!.length % 3, name).toBe(0);
    for (let i = 0; i < src.indices!.length; i++) {
      expect(src.indices![i]!, `${name} index ${i}`).toBeLessThan(verts);
    }
    expect(src.normals!.length, name).toBe(verts * 3);
    expect(src.uvs!.length, name).toBe(verts * 2);
    expect(src.tangents!.length, name).toBe(verts * 4);
    for (let v = 0; v < verts; v++) {
      for (let k = 0; k < 3; k++) {
        expect(Number.isFinite(src.positions[v * 3 + k]!), `${name} position`).toBe(true);
        expect(Number.isFinite(src.normals![v * 3 + k]!), `${name} normal`).toBe(true);
      }
      // Vertex normals are unit: the shaders normal-map against them without renormalizing.
      const nx = src.normals![v * 3]!;
      const ny = src.normals![v * 3 + 1]!;
      const nz = src.normals![v * 3 + 2]!;
      expect(Math.hypot(nx, ny, nz), `${name} normal length`).toBeCloseTo(1, 5);
      expect(src.uvs![v * 2]!, `${name} uv`).toBeGreaterThanOrEqual(0);
      expect(src.uvs![v * 2]!, `${name} uv`).toBeLessThanOrEqual(1);
      expect(src.uvs![v * 2 + 1]!, `${name} uv`).toBeGreaterThanOrEqual(0);
      expect(src.uvs![v * 2 + 1]!, `${name} uv`).toBeLessThanOrEqual(1);
      expect(Math.abs(src.tangents![v * 4 + 3]!), `${name} tangent handedness`).toBe(1);
    }
    return verts;
  }

  /** Triangles wound outward about a point inside the shape (what back-face culling assumes). */
  function assertWoundOutward(src: GeometrySource, centre: [number, number, number], name: string) {
    const p = src.positions;
    const idx = src.indices!;
    let inward = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3;
      const b = idx[t + 1]! * 3;
      const c = idx[t + 2]! * 3;
      const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const fn = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      const mid = [(p[a]! + p[b]! + p[c]!) / 3 - centre[0], (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3 - centre[1], (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3 - centre[2]];
      if (fn[0]! * mid[0]! + fn[1]! * mid[1]! + fn[2]! * mid[2]! < -1e-9) inward++;
    }
    expect(inward, `${name} inward-wound triangles`).toBe(0);
  }

  it("builds debris as tapered shards with no underside, wound outward", () => {
    const src = debrisGeometrySource({ fragments: 3, sides: 4, radius: 0.5, seed: 3 });
    const verts = assertWellFormed(src, "debris");
    // One base ring plus one apex per fragment, and the side fans only: 3 × (4 + 1) verts, 3 × 4 tris.
    expect(verts).toBe(15);
    expect(src.indices!.length).toBe(36);
    // The base sits at y = 0 (the scatter's `embed` sinks it) and nothing dips far below: a shard
    // with an underside would be a closed solid costing triangles nobody ever sees.
    let lowest = Infinity;
    let highest = -Infinity;
    for (let v = 0; v < verts; v++) {
      lowest = Math.min(lowest, src.positions[v * 3 + 1]!);
      highest = Math.max(highest, src.positions[v * 3 + 1]!);
    }
    expect(lowest).toBeGreaterThanOrEqual(-0.2);
    expect(highest).toBeGreaterThan(0.05);
    // Each fragment is wound outward about its own centroid, so back-face culling keeps the walls a
    // camera can see and drops the far side of the shard.
    const perFragment = 4 + 1;
    for (let f = 0; f < 3; f++) {
      const sub: GeometrySource = {
        positions: src.positions.subarray(f * perFragment * 3, (f + 1) * perFragment * 3),
        normals: src.normals!.subarray(f * perFragment * 3, (f + 1) * perFragment * 3),
        uvs: src.uvs!.subarray(f * perFragment * 2, (f + 1) * perFragment * 2),
        tangents: src.tangents!.subarray(f * perFragment * 4, (f + 1) * perFragment * 4),
        indices: new Uint32Array([...src.indices!.subarray(f * 12, (f + 1) * 12)].map((i) => i - f * perFragment)),
        label: `debris-${f}`,
      };
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let v = 0; v < perFragment; v++) {
        cx += sub.positions[v * 3]!;
        cy += sub.positions[v * 3 + 1]!;
        cz += sub.positions[v * 3 + 2]!;
      }
      assertWoundOutward(sub, [cx / perFragment, cy / perFragment, cz / perFragment], `debris fragment ${f}`);
    }
  });

  it("builds vegetation as tapered blade ribbons that stay above their base", () => {
    const blades = 9;
    const segments = 3;
    const src = vegetationGeometrySource({ blades, segments, height: 1, radius: 0.3, seed: 11 });
    const verts = assertWellFormed(src, "vegetation");
    expect(verts).toBe(blades * (segments + 1) * 2);
    expect(src.indices!.length).toBe(blades * segments * 6);
    let lowest = Infinity;
    let highest = -Infinity;
    for (let v = 0; v < verts; v++) {
      lowest = Math.min(lowest, src.positions[v * 3 + 1]!);
      highest = Math.max(highest, src.positions[v * 3 + 1]!);
    }
    // A tuft grows up from y = 0 and its tips stay inside the height the scatter scaled by.
    expect(lowest).toBe(0);
    expect(highest).toBeGreaterThan(0.5);
    expect(highest).toBeLessThanOrEqual(1.25);
    // Each blade is a *ribbon*: its two verts per ring are either side of the blade's centre line, so
    // the tip is narrower than the base and the blade is a plane a double-sided material can shade.
    for (let b = 0; b < blades; b++) {
      const ringOf = (ring: number) => b * (segments + 1) * 2 + ring * 2;
      const widthAt = (ring: number) => {
        const i = ringOf(ring);
        return Math.hypot(
          src.positions[i * 3]! - src.positions[(i + 1) * 3]!,
          src.positions[i * 3 + 1]! - src.positions[(i + 1) * 3 + 1]!,
          src.positions[i * 3 + 2]! - src.positions[(i + 1) * 3 + 2]!,
        );
      };
      expect(widthAt(segments), `blade ${b} tip`).toBeLessThan(widthAt(0) * 0.5);
      expect(widthAt(0), `blade ${b} base`).toBeGreaterThan(0);
      // Planar: the ring-to-ring direction and the across-blade direction stay in one plane, which is
      // what makes the ribbon a surface rather than a twisted strip.
      const i0 = ringOf(0);
      const across = [src.positions[(i0 + 1) * 3]! - src.positions[i0 * 3]!, src.positions[(i0 + 1) * 3 + 1]! - src.positions[i0 * 3 + 1]!, src.positions[(i0 + 1) * 3 + 2]! - src.positions[i0 * 3 + 2]!];
      const iTop = ringOf(segments);
      const along = [src.positions[iTop * 3]! - src.positions[i0 * 3]!, src.positions[iTop * 3 + 1]! - src.positions[i0 * 3 + 1]!, src.positions[iTop * 3 + 2]! - src.positions[i0 * 3 + 2]!];
      const topAcross = [src.positions[(iTop + 1) * 3]! - src.positions[iTop * 3]!, src.positions[(iTop + 1) * 3 + 1]! - src.positions[iTop * 3 + 1]!, src.positions[(iTop + 1) * 3 + 2]! - src.positions[iTop * 3 + 2]!];
      // The tip's across vector is parallel to the base's (a twist would make them cross).
      const cross = [
        across[1]! * topAcross[2]! - across[2]! * topAcross[1]!,
        across[2]! * topAcross[0]! - across[0]! * topAcross[2]!,
        across[0]! * topAcross[1]! - across[1]! * topAcross[0]!,
      ];
      const sinAngle = Math.hypot(cross[0]!, cross[1]!, cross[2]!) / (Math.hypot(...across as [number, number, number]) * Math.hypot(...topAcross as [number, number, number]) || 1);
      expect(sinAngle, `blade ${b} twist`).toBeLessThan(0.6);
      expect(Math.hypot(...along as [number, number, number])).toBeGreaterThan(0);
    }
  });

  it("builds a prop as a beveled post wound outward about its own axis", () => {
    const sides = 6;
    const height = 1.6;
    const src = propGeometrySource({ sides, height, radius: 0.18, bevel: 0.14, seed: 5 });
    const verts = assertWellFormed(src, "prop");
    // Three rings plus the apex; two shaft bands of quads and a cap fan.
    expect(verts).toBe(sides * 3 + 1);
    expect(src.indices!.length).toBe(sides * 5 * 3);
    // The post stands on y = 0 and reaches its height, and every triangle faces away from the axis.
    let lowest = Infinity;
    for (let v = 0; v < verts; v++) lowest = Math.min(lowest, src.positions[v * 3 + 1]!);
    expect(lowest).toBe(0);
    let highest = -Infinity;
    for (let v = 0; v < verts; v++) highest = Math.max(highest, src.positions[v * 3 + 1]!);
    expect(highest).toBeCloseTo(height, 6);
    assertWoundOutward(src, [0, height * 0.45, 0], "prop");
    // The cap steps in: the shoulder rim is narrower than the shaft, which is what reads as "beveled".
    const shaftRadius = src.positions[0]!;
    const capRimRadius = src.positions[sides * 2 * 3]!;
    expect(Math.abs(capRimRadius)).toBeLessThan(Math.abs(shaftRadius));
  });

  it("is a pure function of its options, and moves when the seed moves", () => {
    // Two scenes scattering the same type must get the same shards: the primitive is data, not state.
    const a = debrisGeometrySource({ fragments: 3, seed: 42 });
    const b = debrisGeometrySource({ fragments: 3, seed: 42 });
    expect(a.positions).toEqual(b.positions);
    expect(a.indices).toEqual(b.indices);
    expect(a.label).toBe("debris");
    const c = debrisGeometrySource({ fragments: 3, seed: 43 });
    expect(c.positions).not.toEqual(a.positions);
    // And the level ramp a LOD chain uses is the same function at fewer fragments/sides.
    const fine = vegetationGeometrySource({ blades: 9, segments: 3, seed: 7 });
    const coarse = vegetationGeometrySource({ blades: 4, segments: 1, seed: 7 });
    expect(coarse.positions.length).toBeLessThan(fine.positions.length);
    expect(coarse.indices!.length).toBeLessThan(fine.indices!.length);
    const propFine = propGeometrySource({ sides: 8, seed: 2 });
    const propCoarse = propGeometrySource({ sides: 4, seed: 2 });
    expect(propCoarse.indices!.length).toBeLessThan(propFine.indices!.length);
  });

  it("scales with its options the way a scatter's scale range assumes", () => {
    // The scatter multiplies an instance by up to `scaleMax`, so the primitive's own extents are the
    // unit the type's scale range is expressed in: a rock of radius 0.8 spans ~1.6 m, a prop of
    // height 1.6 spans 1.6 m.
    const rock = rockGeometrySource({ radius: 0.8, segments: 7, seed: 7 });
    let span = 0;
    for (let v = 0; v < rock.positions.length / 3; v++) span = Math.max(span, Math.abs(rock.positions[v * 3]!));
    expect(span).toBeGreaterThan(0.5);
    expect(span).toBeLessThan(1.2);
    const prop = propGeometrySource({ height: 2, radius: 0.2 });
    let propHeight = 0;
    for (let v = 0; v < prop.positions.length / 3; v++) propHeight = Math.max(propHeight, prop.positions[v * 3 + 1]!);
    expect(propHeight).toBeCloseTo(2, 6);
  });
});

describe("Geometry LOD chains (14.4)", () => {
  /** Two levels of the same rock: the coarse one is the same shape at fewer segments. */
  function rockLevels(): GeometrySource[] {
    return [rockGeometrySource({ radius: 0.8, segments: 8, seed: 7 }), rockGeometrySource({ radius: 0.8, segments: 4, seed: 7 })];
  }

  it("tiles the index buffer with one window per level, indices global", () => {
    const levels = rockLevels();
    const chain = Geometry.concatenateLods(levels, [60]);
    const verts = chain.source.positions.length / 3;
    expect(verts).toBe(levels[0]!.positions.length / 3 + levels[1]!.positions.length / 3);
    expect(chain.source.indices!.length).toBe(levels[0]!.indices!.length + levels[1]!.indices!.length);
    expect(chain.lods).toHaveLength(2);
    // The windows tile: level 0 starts at 0, level 1 starts where level 0 ended, and together they
    // cover the buffer exactly — a gap would draw nothing, an overlap would draw both levels.
    expect(chain.lods[0]).toEqual({ indexStart: 0, indexCount: levels[0]!.indices!.length, vertexCount: levels[0]!.positions.length / 3, minDistance: 0 });
    expect(chain.lods[1]!.indexStart).toBe(chain.lods[0]!.indexCount);
    expect(chain.lods[1]!.indexCount).toBe(levels[1]!.indices!.length);
    expect(chain.lods[1]!.minDistance).toBe(60);
    expect(chain.lods[0]!.indexCount + chain.lods[1]!.indexCount).toBe(chain.source.indices!.length);
    // Global indices: level 1's own indices address level 1's own vertices, so every one of them is
    // offset by level 0's vertex count — and `baseVertex` can stay 0 for both windows.
    const base = levels[0]!.positions.length / 3;
    for (let k = 0; k < levels[1]!.indices!.length; k++) {
      expect(chain.source.indices![chain.lods[1]!.indexStart + k]!).toBe(levels[1]!.indices![k]! + base);
    }
    // A chain is always uint32-indexed: a uint16 level 1 could not address level 0's vertices.
    expect(chain.source.indices).toBeInstanceOf(Uint32Array);
    // Bounds are the union, so a coarse level whose silhouette is not exactly the fine one's still
    // culls conservatively.
    expect(chain.source.bounds!.min.x).toBeLessThanOrEqual(Math.min(levels[0]!.bounds?.min.x ?? Infinity, levels[1]!.bounds?.min.x ?? Infinity) + 1e-6);
    expect(chain.source.label).toBe("rock+2lods");
  });

  it("is pure and deterministic, so a chain can be built in a worker or compared in a test", () => {
    const a = Geometry.concatenateLods(rockLevels(), [40, 120].slice(0, 1));
    const b = Geometry.concatenateLods(rockLevels(), [40]);
    expect(a.source.positions).toEqual(b.source.positions);
    expect(a.source.indices).toEqual(b.source.indices);
    expect(a.lods).toEqual(b.lods);
  });

  it("fills the channels a level did not author with the defaults the layout requires", () => {
    // A hand-authored coarse level often carries positions and indices only; the vertex layout is
    // fixed, so the missing channels get the same defaults `Geometry.create` would have written —
    // and a zero tangent would leave a normal-mapped material with a degenerate TBN.
    const fine = rockGeometrySource({ radius: 1, segments: 6, seed: 1 });
    const bare: GeometrySource = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      label: "bare",
    };
    const chain = Geometry.concatenateLods([fine, bare], [30]);
    const base = fine.positions.length / 3;
    const normals = chain.source.normals!;
    const tangents = chain.source.tangents!;
    const uvs = chain.source.uvs!;
    for (let v = 0; v < 3; v++) {
      const o = (base + v) * 3;
      expect([normals[o]!, normals[o + 1]!, normals[o + 2]!]).toEqual([0, 0, 1]);
      const t = (base + v) * 4;
      expect([tangents[t]!, tangents[t + 1]!, tangents[t + 2]!, tangents[t + 3]!]).toEqual([1, 0, 0, 1]);
      expect([uvs[(base + v) * 2]!, uvs[(base + v) * 2 + 1]!]).toEqual([0, 0]);
    }
    // The authored level kept its own channels.
    expect(normals[2]).not.toBe(0);
  });

  it("rejects a chain that could not be drawn", () => {
    const levels = rockLevels();
    expect(() => Geometry.concatenateLods([levels[0]!], [])).toThrow(/at least two levels/);
    const five = [levels[0]!, levels[1]!, levels[0]!, levels[1]!, levels[0]!];
    expect(() => Geometry.concatenateLods(five, [10, 20, 30, 40])).toThrow(new RegExp(`exceeds MAX_GEOMETRY_LODS \\(${MAX_GEOMETRY_LODS}\\)`));
    expect(() => Geometry.concatenateLods(levels, [])).toThrow(/need 1 distances/);
    expect(() => Geometry.concatenateLods(levels, [10, 20])).toThrow(/need 1 distances/);
    // Distances ascend: a descending pair would make the selection depend on the order it scans.
    expect(() => Geometry.concatenateLods(levels, [0])).toThrow(/positive number of metres/);
    expect(() => Geometry.concatenateLods(levels, [Number.NaN])).toThrow(/positive number of metres/);
    const three = [levels[0]!, levels[1]!, levels[0]!];
    expect(() => Geometry.concatenateLods(three, [50, 40])).toThrow(/must ascend/);
    // An unindexed level has no index window to draw, and a stray index reads another level's vertices.
    const unindexed: GeometrySource = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), label: "unindexed" };
    expect(() => Geometry.concatenateLods([levels[0]!, unindexed], [20])).toThrow(/unindexed/);
    const stray: GeometrySource = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 3]), label: "stray" };
    expect(() => Geometry.concatenateLods([levels[0]!, stray], [20])).toThrow(/exceeds its 3 vertices/);
    const ragged: GeometrySource = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2, 0]), label: "ragged" };
    expect(() => Geometry.concatenateLods([levels[0]!, ragged], [20])).toThrow(/not a multiple of 3/);
    const empty: GeometrySource = { positions: new Float32Array(0), indices: new Uint32Array(0), label: "empty" };
    expect(() => Geometry.concatenateLods([levels[0]!, empty], [20])).toThrow(/has no positions/);
  });

  it("uploads one geometry whose primary window is level 0", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const levels = rockLevels();
    const geometry = createLodPrimitive(device, { build: (level) => levels[level]!, levels: 2, distances: [60] });
    try {
      expect(geometry.lods).toHaveLength(2);
      expect(geometry.drawStart).toBe(0);
      expect(geometry.drawCount).toBe(levels[0]!.indices!.length);
      // The buffer holds every level (that is the point): the whole index count, not level 0's.
      expect(geometry.indexCount).toBe(levels[0]!.indices!.length + levels[1]!.indices!.length);
      expect(geometry.vertexCount).toBe(levels[0]!.positions.length / 3 + levels[1]!.positions.length / 3);
      expect(geometry.indexFormat).toBe("uint32");
      expect(geometry.lodWindow(0)).toEqual({ indexStart: 0, indexCount: levels[0]!.indices!.length });
      expect(geometry.lodWindow(1)).toEqual({ indexStart: levels[0]!.indices!.length, indexCount: levels[1]!.indices!.length });
      // Out-of-range levels clamp rather than read past the table: a device that picked level 9 must
      // still draw something, and the coarsest level is the safe answer.
      expect(geometry.lodWindow(9)).toEqual(geometry.lodWindow(1));
      expect(geometry.lodWindow(-1)).toEqual(geometry.lodWindow(0));
      expect(device.mock.errors).toEqual([]);
      // Both levels' bytes really are on the device: one vertex buffer, one index buffer.
      const buffers = [...device.mock.liveBuffers];
      const vertex = buffers.find((b) => b.label.startsWith("geometry.vertex."))!;
      const index = buffers.find((b) => b.label.startsWith("geometry.index."))!;
      expect(vertex.size).toBe(geometry.vertexCount * 48);
      expect(index.size).toBe(geometry.indexCount * 4);
    } finally {
      geometry.dispose();
      await device.dispose();
      expect(device.mock.outstanding.buffers).toEqual([]);
    }
  });

  it("builds the levels it is asked for, from the builder it is given", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const built: number[] = [];
    const geometry = createLodPrimitive(device, {
      build: (level) => {
        built.push(level);
        // A real chain is one shape at descending detail; the builder is what keeps the levels the
        // same object rather than three unrelated meshes.
        // `rockGeometrySource` clamps at four segments, so the ramp has to start above that to keep
        // descending: 12 → 7 → 4 segments is 864 → 294 → 96 indices.
        return rockGeometrySource({ radius: 0.8, segments: [12, 7, 4][level]!, seed: 7 });
      },
      levels: 3,
      distances: [40, 120],
    });
    try {
      expect(built).toEqual([0, 1, 2]);
      expect(geometry.lods).toHaveLength(3);
      expect(geometry.lods!.map((l) => l.minDistance)).toEqual([0, 40, 120]);
      // Detail really descends: each level draws fewer indices than the one before it.
      expect(geometry.lods![1]!.indexCount).toBeLessThan(geometry.lods![0]!.indexCount);
      expect(geometry.lods![2]!.indexCount).toBeLessThan(geometry.lods![1]!.indexCount);
      expect(geometry.drawCount).toBe(geometry.lods![0]!.indexCount);
    } finally {
      geometry.dispose();
      await device.dispose();
    }
  });
});
