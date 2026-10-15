/**
 * Procedural trees (fe-37b): a trunk-and-branch hierarchy with alpha-cut leaf cards, at two levels
 * of detail, as plain `GeometrySource`s (pure: no GPU, deterministic for a species + seed).
 *
 * - **Wood**: recursive tapered tubes. The trunk is level 0; each level spawns children along its
 *   parent at a spiral (golden-angle) phyllotaxis, tilted `branchAngle` off the parent axis and
 *   bent toward/away from the sky by `gravitropism`, each `lengthRatio` of its parent. Rings follow
 *   the bent path so limbs curve. UVs wrap the circumference (u) and run along the length in
 *   metres (v), for a tiling bark texture.
 * - **Leaves**: cards (quads) clustered along the outer two levels, each a sprig of several leaves
 *   on the leaf texture ({@link leafCardPixels}, alpha = the leaf silhouettes). Card normals are
 *   bent out from the crown centre, the usual foliage trick: a cloud of flat cards then shades like
 *   a volume (lit side bright, far side dark) instead of a confetti of facets.
 * - **LOD**: `"lo"` drops the last branch level and the thin rings and puts fewer, larger cards on
 *   what is left (same crown volume, ≈ a fifth of the triangles); pair with {@link VegetationField}
 *   for distance switching, instancing and wind sway.
 *
 * Colour is not baked: leaf cards are white-ish so per-instance `tint` gives each tree its autumn
 * colour (one material, one instanced batch, any number of colours).
 */

import { Rng } from "../math/rng.js";
import { clamp } from "../math/scalar.js";
import { computeNormalsAndTangents, type GeometrySource } from "../rendering/geometry.js";

export type TreeLod = "hi" | "lo";

export interface TreeSpecies {
  name: string;
  /** Trunk height range (m) — to the top of the leader. */
  height: [number, number];
  /** Trunk base radius as a fraction of height. Default 0.022. */
  trunkRadius?: number;
  /** Fraction of the trunk that is bare before the first limb. Default 0.35. */
  clearBole?: number;
  /** Branch levels below the trunk (1..3). Default 3. */
  levels?: number;
  /** Children per branch at each level (level 1 first). Default [7, 4, 3]. */
  children?: number[];
  /** Angle (rad) of children off the parent axis, per level. Default [0.95, 0.75, 0.6]. */
  branchAngle?: number[];
  /** Child length as a fraction of the parent's, per level. Default [0.45, 0.55, 0.5]. */
  lengthRatio?: number[];
  /** + bends limbs upward (poplar), − droops them (birch). Default 0.15. */
  gravitropism?: number;
  /** Crown shape: limb length vs height along the trunk. Default "round". */
  shape?: "round" | "conical" | "columnar" | "vase";
  /** Leaf card size (m). Default 0.55. */
  leafSize?: number;
  /** Cards per terminal branch (hi LOD). Default 6. */
  leavesPerBranch?: number;
  /** How much the trunk wanders (0 straight). Default 0.12. */
  wander?: number;
}

export interface TreeGeometry {
  wood: GeometrySource;
  leaves: GeometrySource;
  /** Height of the highest vertex above the base (m). */
  height: number;
  /** Horizontal crown radius (m). */
  crownRadius: number;
}

interface Branch {
  level: number;
  /** Path points (x, y, z) along the branch, base → tip. */
  path: number[];
  radius0: number;
  radius1: number;
  length: number;
}

type Buf = { p: number[]; uv: number[]; i: number[] };

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function shapeEnvelope(shape: NonNullable<TreeSpecies["shape"]>, t: number): number {
  // t: 0 at the first limb, 1 at the top. Returns the relative limb length there.
  switch (shape) {
    case "conical":
      return 1 - 0.85 * t;
    case "columnar":
      return 0.55 + 0.25 * Math.sin(Math.PI * t);
    case "vase":
      return 0.5 + 0.6 * t;
    default:
      return 0.35 + 0.75 * Math.sin(Math.PI * (0.25 + 0.75 * t));
  }
}

/** Orthonormal basis (u, w) around a unit axis d. */
function basis(dx: number, dy: number, dz: number): [number, number, number, number, number, number] {
  let ax = 0, ay = 1, az = 0;
  if (Math.abs(dy) > 0.9) {
    ax = 1;
    ay = 0;
  }
  // u = normalize(a × d), w = d × u
  let ux = ay * dz - az * dy, uy = az * dx - ax * dz, uz = ax * dy - ay * dx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
  return [ux, uy, uz, wx, wy, wz];
}

function growBranch(rng: Rng, level: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, length: number, radius: number, segments: number, gravitropism: number, wander: number): Branch {
  const path = [ox, oy, oz];
  let x = ox, y = oy, z = oz;
  let cx = dx, cy = dy, cz = dz;
  const segLen = length / segments;
  for (let s = 0; s < segments; s++) {
    // Bend toward +y (or away) and wander a little.
    cy += gravitropism * 0.35 * (level === 0 ? 0 : 1);
    cx += (rng.nextFloat() - 0.5) * wander;
    cz += (rng.nextFloat() - 0.5) * wander;
    const l = Math.hypot(cx, cy, cz) || 1;
    cx /= l; cy /= l; cz /= l;
    x += cx * segLen;
    y += cy * segLen;
    z += cz * segLen;
    path.push(x, y, z);
  }
  return { level, path, radius0: radius, radius1: radius * 0.35, length };
}

function tube(buf: Buf, b: Branch, radial: number): void {
  const rings = b.path.length / 3;
  const base = buf.p.length / 3;
  let vAlong = 0;
  for (let r = 0; r < rings; r++) {
    const i0 = Math.max(0, r - 1), i1 = Math.min(rings - 1, r + 1);
    let dx = b.path[i1 * 3]! - b.path[i0 * 3]!, dy = b.path[i1 * 3 + 1]! - b.path[i0 * 3 + 1]!, dz = b.path[i1 * 3 + 2]! - b.path[i0 * 3 + 2]!;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const [ux, uy, uz, wx, wy, wz] = basis(dx, dy, dz);
    const t = r / (rings - 1);
    const rad = b.radius0 + (b.radius1 - b.radius0) * t;
    if (r > 0) vAlong += Math.hypot(b.path[r * 3]! - b.path[r * 3 - 3]!, b.path[r * 3 + 1]! - b.path[r * 3 - 2]!, b.path[r * 3 + 2]! - b.path[r * 3 - 1]!);
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      buf.p.push(b.path[r * 3]! + (ux * c + wx * s) * rad, b.path[r * 3 + 1]! + (uy * c + wy * s) * rad, b.path[r * 3 + 2]! + (uz * c + wz * s) * rad);
      buf.uv.push(k / radial, vAlong / 1.5);
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let k = 0; k < radial; k++) {
      const a = base + r * (radial + 1) + k;
      const c = a + radial + 1;
      buf.i.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
}

function pointOn(b: Branch, t: number): [number, number, number, number, number, number] {
  const segs = b.path.length / 3 - 1;
  const f = clamp(t, 0, 1) * segs;
  const i = Math.min(segs - 1, Math.floor(f));
  const u = f - i;
  const ax = b.path[i * 3]!, ay = b.path[i * 3 + 1]!, az = b.path[i * 3 + 2]!;
  const bx = b.path[i * 3 + 3]!, by = b.path[i * 3 + 4]!, bz = b.path[i * 3 + 5]!;
  const l = Math.hypot(bx - ax, by - ay, bz - az) || 1;
  return [ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u, (bx - ax) / l, (by - ay) / l, (bz - az) / l];
}

/**
 * Generate one tree of `species` from `seed` at `lod`. Same species + seed → the same tree at
 * both LODs (the lo LOD is the hi tree's skeleton minus its last level).
 */
export function generateTree(species: TreeSpecies, seed: number, lod: TreeLod = "hi"): TreeGeometry {
  const rng = new Rng(seed >>> 0);
  const hi = lod === "hi";
  const levels = clamp(Math.round(species.levels ?? 3), 1, 3);
  const children = species.children ?? [7, 4, 3];
  const angles = species.branchAngle ?? [0.95, 0.75, 0.6];
  const ratios = species.lengthRatio ?? [0.45, 0.55, 0.5];
  const gravit = species.gravitropism ?? 0.15;
  const shape = species.shape ?? "round";
  const wander = species.wander ?? 0.12;
  const height = species.height[0] + (species.height[1] - species.height[0]) * rng.nextFloat();
  const trunkR = height * (species.trunkRadius ?? 0.022);
  const clear = species.clearBole ?? 0.35;
  const leafSize = species.leafSize ?? 0.55;
  const perBranch = species.leavesPerBranch ?? 6;

  const trunk = growBranch(rng, 0, 0, -0.3, 0, 0, 1, 0, height + 0.3, trunkR, 6, 0, wander * 0.6);
  const branches: Branch[] = [trunk];
  const terminals: Branch[] = [];
  const grow = (parent: Branch, level: number): void => {
    if (level > levels) {
      terminals.push(parent);
      return;
    }
    // The skeleton is generated identically at both LODs (the RNG stream must not depend on lod);
    // the lo LOD just doesn't *emit* the last level.
    const n = children[level - 1] ?? 3;
    const start = level === 1 ? clear : 0.25;
    let phase = rng.nextFloat() * Math.PI * 2;
    for (let c = 0; c < n; c++) {
      const t = start + (1 - start) * ((c + 0.5 + (rng.nextFloat() - 0.5) * 0.6) / n) * 0.95;
      const [px, py, pz, dx, dy, dz] = pointOn(parent, t);
      phase += GOLDEN * (1 + (rng.nextFloat() - 0.5) * 0.3);
      const [ux, uy, uz, wx, wy, wz] = basis(dx, dy, dz);
      const ang = (angles[level - 1] ?? 0.7) * (0.8 + 0.4 * rng.nextFloat());
      const sa = Math.sin(ang), ca = Math.cos(ang);
      const ox = Math.cos(phase), oz = Math.sin(phase);
      const cdx = dx * ca + (ux * ox + wx * oz) * sa;
      const cdy = dy * ca + (uy * ox + wy * oz) * sa;
      const cdz = dz * ca + (uz * ox + wz * oz) * sa;
      let len = parent.length * (ratios[level - 1] ?? 0.5) * (0.75 + 0.5 * rng.nextFloat());
      if (level === 1) len = height * (ratios[0] ?? 0.45) * shapeEnvelope(shape, (t - clear) / (1 - clear)) * (0.8 + 0.4 * rng.nextFloat());
      const r = (parent.radius0 + (parent.radius1 - parent.radius0) * t) * (0.55 + 0.15 * rng.nextFloat());
      const child = growBranch(rng, level, px, py, pz, cdx, cdy, cdz, len, r, level === 1 ? 4 : level === 2 ? 3 : 2, gravit, wander);
      branches.push(child);
      grow(child, level + 1);
    }
  };
  grow(trunk, 1);

  const emitLevel = hi ? levels : Math.max(1, levels - 1);
  const wood: Buf = { p: [], uv: [], i: [] };
  for (const b of branches) {
    if (b.level > emitLevel) continue;
    const radial = b.level === 0 ? (hi ? 9 : 6) : b.level === 1 ? (hi ? 6 : 4) : hi ? 4 : 3;
    tube(wood, b, radial);
  }

  // Crown centre: mean of terminal tips (for card normals).
  let cx = 0, cy = 0, cz = 0, maxR = 0, maxY = height;
  for (const t of terminals) {
    const n = t.path.length;
    cx += t.path[n - 3]!;
    cy += t.path[n - 2]!;
    cz += t.path[n - 1]!;
  }
  const nt = Math.max(1, terminals.length);
  cx /= nt; cy /= nt; cz /= nt;

  const leaves: Buf & { n: number[] } = { p: [], uv: [], i: [], n: [] };
  const leafRng = new Rng((seed ^ 0x5eed1eaf) >>> 0);
  // Leaves hang off the terminals (hi) or, at lo, off their parents with bigger, fewer cards.
  const cardScale = hi ? 1 : 1.9;
  const cards = hi ? perBranch : Math.max(2, Math.round(perBranch / 2.2));
  const hosts: Branch[] = hi ? terminals : terminals.filter((_, k) => k % 2 === 0);
  for (const b of hosts) {
    for (let c = 0; c < cards; c++) {
      const t = 0.25 + 0.75 * leafRng.nextFloat();
      const [px, py, pz] = pointOn(b, t);
      const size = leafSize * cardScale * (0.75 + 0.5 * leafRng.nextFloat());
      // Random card orientation, biased toward facing up/out.
      const yaw = leafRng.nextFloat() * Math.PI * 2;
      const pitch = (leafRng.nextFloat() - 0.3) * 1.1;
      const fx = Math.cos(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = Math.sin(yaw) * Math.cos(pitch);
      const [ux, uy, uz, wx, wy, wz] = basis(fx, fy, fz);
      const ox = px + (leafRng.nextFloat() - 0.5) * size * 0.6;
      const oy = py + (leafRng.nextFloat() - 0.5) * size * 0.4;
      const oz = pz + (leafRng.nextFloat() - 0.5) * size * 0.6;
      const h = size * 0.5;
      const base = leaves.p.length / 3;
      const corners: Array<[number, number, number, number]> = [[-1, -1, 0, 1], [1, -1, 1, 1], [1, 1, 1, 0], [-1, 1, 0, 0]];
      for (const [a, bb, u, v] of corners) {
        const x = ox + (ux * a + wx * bb) * h, y = oy + (uy * a + wy * bb) * h, z = oz + (uz * a + wz * bb) * h;
        leaves.p.push(x, y, z);
        leaves.uv.push(u, v);
        // Bent normal: mostly "out of the crown", a little of the card's own facing.
        let nx = x - cx, ny = (y - cy) * 0.8 + 0.25 * Math.abs(y - cy) + 0.3, nz = z - cz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx = nx / nl * 0.8 + fx * 0.2;
        ny = ny / nl * 0.8 + Math.abs(fy) * 0.2;
        nz = nz / nl * 0.8 + fz * 0.2;
        const n2 = Math.hypot(nx, ny, nz) || 1;
        leaves.n.push(nx / n2, ny / n2, nz / n2);
        maxR = Math.max(maxR, Math.hypot(x, z));
        maxY = Math.max(maxY, y);
      }
      leaves.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const woodP = new Float32Array(wood.p);
  const woodI = new Uint32Array(wood.i);
  const woodUv = new Float32Array(wood.uv);
  const w = computeNormalsAndTangents(woodP, woodI, woodUv);
  const leafP = new Float32Array(leaves.p);
  const leafI = new Uint32Array(leaves.i);
  const leafUv = new Float32Array(leaves.uv);
  const l = computeNormalsAndTangents(leafP, leafI, leafUv);
  return {
    wood: { positions: woodP, normals: w.normals, uvs: woodUv, tangents: w.tangents, indices: woodI, label: `tree.${species.name}.wood.${lod}` },
    leaves: { positions: leafP, normals: new Float32Array(leaves.n), uvs: leafUv, tangents: l.tangents, indices: leafI, label: `tree.${species.name}.leaves.${lod}` },
    height: maxY,
    crownRadius: maxR,
  };
}

/** Triangle count of a source (diagnostics, LOD tests). */
export function triangleCount(src: GeometrySource): number {
  return src.indices ? src.indices.length / 3 : src.positions.length / 9;
}

export type LeafShape = "maple" | "oval" | "birch";

/**
 * RGBA8 pixels for a leaf card: a sprig of 5–7 leaves of `shape` on a thin twig, white-to-light-
 * grey with darker veins and edges (so a per-instance tint colours it), alpha = silhouette. Use
 * with `Material.alphaTest` ≈ 0.5 and `doubleSided`.
 */
export function leafCardPixels(size = 128, shape: LeafShape = "maple", seed = 1): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const rng = new Rng(seed >>> 0);
  const leaves: Array<{ x: number; y: number; a: number; s: number; shade: number }> = [];
  const n = 5 + Math.floor(rng.nextFloat() * 3);
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    const side = k % 2 === 0 ? -1 : 1;
    leaves.push({
      x: 0.5 + side * (0.12 + 0.1 * rng.nextFloat()) * (1 - t * 0.5),
      y: 0.9 - t * 0.72,
      a: -Math.PI / 2 + side * (0.6 + 0.4 * rng.nextFloat()),
      s: 0.2 + 0.08 * rng.nextFloat(),
      shade: 0.82 + 0.18 * rng.nextFloat(),
    });
  }
  leaves.push({ x: 0.5, y: 0.12, a: -Math.PI / 2, s: 0.24, shade: 1 });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size, v = (j + 0.5) / size;
      let alpha = 0, lum = 0;
      // Twig: a thin line up the middle.
      if (Math.abs(u - 0.5) < 0.012 && v > 0.1 && v < 0.98) {
        alpha = 1;
        lum = 0.35;
      }
      for (const lf of leaves) {
        // Leaf-local coordinates: x along the leaf (0 base → 1 tip), y across.
        const dx = u - lf.x, dy = v - lf.y;
        const ca = Math.cos(lf.a), sa = Math.sin(lf.a);
        const lx = (dx * ca + dy * sa) / lf.s;
        const ly = (-dx * sa + dy * ca) / lf.s;
        if (lx < -0.05 || lx > 1) continue;
        let half: number;
        if (shape === "maple") {
          // Palmate: a broad blade with three lobes.
          const ang = Math.atan2(ly, lx - 0.35);
          const r = Math.hypot(lx - 0.35, ly);
          const lobes = 0.42 + 0.2 * Math.max(0, Math.cos(ang * 3)) ** 2 + 0.06 * Math.cos(ang * 9);
          half = r < lobes ? 1 : 0;
          if (half > 0 && lx < 0.05) half = Math.abs(ly) < 0.02 ? 1 : 0;
          if (half > 0) {
            alpha = 1;
            const vein = Math.abs(Math.sin(ang * 3)) * r < 0.02 || Math.abs(ly) < 0.012 ? 0.75 : 1;
            lum = lf.shade * vein * (1 - 0.25 * r);
          }
          continue;
        }
        const width = shape === "birch" ? 0.32 : 0.24;
        half = width * Math.sin(Math.PI * clamp(lx, 0, 1)) ** (shape === "birch" ? 0.8 : 0.7);
        if (Math.abs(ly) < half) {
          alpha = 1;
          const edge = Math.abs(ly) / Math.max(1e-3, half);
          const vein = Math.abs(ly) < 0.015 || Math.abs(Math.sin(lx * 22) * 0.02 - ly * 0.4) < 0.004 ? 0.78 : 1;
          lum = lf.shade * vein * (1 - 0.18 * edge * edge);
        }
      }
      const o = (j * size + i) * 4;
      const g = Math.round(clamp(lum, 0, 1) * 255);
      px[o] = g;
      px[o + 1] = g;
      px[o + 2] = Math.round(g * 0.94);
      px[o + 3] = alpha > 0 ? 255 : 0;
    }
  }
  return px;
}

/** RGBA8 bark pixels (grey-brown, vertical furrows; `birch`: white with dark lenticels). Tiles in u and v. */
export function barkPixels(size = 64, kind: "furrowed" | "birch" = "furrowed", seed = 3): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const rng = new Rng(seed >>> 0);
  const phase = Array.from({ length: 6 }, () => rng.nextFloat() * Math.PI * 2);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      let l: number;
      if (kind === "birch") {
        const band = Math.sin(v * Math.PI * 2 * 5 + Math.sin(u * Math.PI * 2 * 2 + phase[0]!) * 1.5);
        const lent = band > 0.93 && Math.sin(u * Math.PI * 2 * 3 + phase[1]!) > -0.2 ? 0.25 : 1;
        l = (0.88 + 0.08 * Math.sin(u * Math.PI * 2 * 7 + phase[2]!)) * lent;
      } else {
        const furrow = Math.abs(Math.sin(u * Math.PI * 2 * 6 + Math.sin(v * Math.PI * 2 * 2 + phase[0]!) * 1.2 + phase[1]!));
        l = 0.45 + 0.55 * furrow ** 0.6 * (0.85 + 0.15 * Math.sin(v * Math.PI * 2 * 9 + phase[3]!));
      }
      const o = (j * size + i) * 4;
      const g = Math.round(clamp(l, 0, 1) * 255);
      px[o] = g;
      px[o + 1] = g;
      px[o + 2] = g;
      px[o + 3] = 255;
    }
  }
  return px;
}
