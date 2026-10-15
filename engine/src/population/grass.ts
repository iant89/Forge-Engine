/**
 * Procedural grass (fe-37b): patches of real blade geometry (not cards), as `GeometrySource`s.
 *
 * A patch is a square of `size` metres holding `blades` tapered, curved blades rooted on the
 * ground (`groundAt`, relative to the patch origin, so patches follow berms and slopes). Each
 * blade is a strip of `segments` quads narrowing to a point, leaning and curving by its own random
 * amount. UV v runs 1 at the root → 0 at the tip (u across), for {@link grassBladePixels}' root-to-
 * tip gradient. Normals are bent toward +Y — the standard foliage trick that keeps thin blades from
 * flickering dark/light as they turn edge-on and lets 17.4 snow and wetness settle on them.
 *
 * Density LOD is two patches built from the same seed: `"hi"` (all blades, 3 segments) for the
 * near ring and `"lo"` (a third of the blades, wider, 1 segment) beyond; {@link VegetationField}
 * switches them by distance, instances them and sways them in the wind.
 */

import { Rng } from "../math/rng.js";
import { clamp } from "../math/scalar.js";
import type { GeometrySource } from "../rendering/geometry.js";

export interface GrassPatchOptions {
  /** Patch side (m). Default 2. */
  size?: number;
  /** Blades in the hi patch. Default 90. */
  blades?: number;
  /** Blade height range (m). Default [0.25, 0.55]. */
  height?: [number, number];
  /** Blade root width (m). Default 0.03. */
  width?: number;
  /** Ground height relative to the patch origin at local (x, z). Default flat. */
  groundAt?: (lx: number, lz: number) => number;
  /** How far roots are pushed below the ground (hides the base on slopes). Default 0.03. */
  sink?: number;
  seed?: number;
  label?: string;
}

/** A grass patch at `lod` ("lo" keeps every third blade, widened ×1.8, one segment). */
export function grassPatchSource(options: GrassPatchOptions = {}, lod: "hi" | "lo" = "hi"): GeometrySource {
  const size = options.size ?? 2;
  const count = Math.max(1, Math.floor(options.blades ?? 90));
  const [h0, h1] = options.height ?? [0.25, 0.55];
  const width = options.width ?? 0.03;
  const ground = options.groundAt ?? (() => 0);
  const sink = options.sink ?? 0.03;
  const rng = new Rng((options.seed ?? 1) >>> 0);
  const hi = lod === "hi";
  const segs = hi ? 3 : 1;
  const p: number[] = [], n: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let b = 0; b < count; b++) {
    // Every random draw happens for every blade so hi and lo agree on the blades lo keeps.
    const x = (rng.nextFloat() - 0.5) * size;
    const z = (rng.nextFloat() - 0.5) * size;
    const h = h0 + (h1 - h0) * rng.nextFloat() ** 1.3;
    const yaw = rng.nextFloat() * Math.PI * 2;
    const lean = 0.15 + 0.45 * rng.nextFloat();
    const curve = 0.6 + 0.8 * rng.nextFloat();
    const leanDir = rng.nextFloat() * Math.PI * 2;
    if (!hi && b % 3 !== 0) continue;
    const w = width * (hi ? 1 : 1.8) * (0.7 + 0.6 * ((b * 7919) % 13) / 13);
    const y0 = ground(x, z) - sink;
    const sx = Math.cos(yaw), sz = Math.sin(yaw); // across-blade direction
    const lx = Math.cos(leanDir), lz = Math.sin(leanDir);
    const base = p.length / 3;
    for (let r = 0; r <= segs; r++) {
      const t = r / segs;
      const off = lean * h * t ** (1 + curve); // curls over toward the tip
      const cx = x + lx * off, cz = z + lz * off;
      const cy = y0 + h * t * (1 - 0.25 * lean * t);
      const half = (w / 2) * (1 - t) ** 0.8;
      if (r < segs) {
        p.push(cx - sx * half, cy, cz - sz * half, cx + sx * half, cy, cz + sz * half);
        uv.push(0, 1 - t, 1, 1 - t);
      } else {
        p.push(cx, cy, cz);
        uv.push(0.5, 0);
      }
      // Bent normal: the blade's face normal (horizontal, ⊥ to the across direction) mixed with up.
      const fx = -sz, fz = sx;
      const ny = 0.75 + 0.2 * t;
      const k = Math.hypot(fx * 0.5, ny, fz * 0.5);
      const cnt = r < segs ? 2 : 1;
      for (let c = 0; c < cnt; c++) n.push((fx * 0.5) / k, ny / k, (fz * 0.5) / k);
    }
    for (let r = 0; r < segs; r++) {
      const a = base + r * 2;
      if (r < segs - 1) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else idx.push(a, a + 2, a + 1);
    }
  }
  const positions = new Float32Array(p);
  const tangents = new Float32Array((positions.length / 3) * 4);
  for (let k = 0; k < tangents.length; k += 4) {
    tangents[k] = 1;
    tangents[k + 3] = 1;
  }
  return { positions, normals: new Float32Array(n), uvs: new Float32Array(uv), tangents, indices: new Uint32Array(idx), label: options.label ?? `grass.${lod}` };
}

/**
 * RGBA8 pixels (`width` × `height`, v = 0 at the top/tip) for blade colour: dark, slightly yellow
 * roots to lighter tips with a faint midrib. White-balanced so per-instance tint sets the hue
 * (summer green, autumn straw).
 */
export function grassBladePixels(width = 8, height = 64): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const v = j / (height - 1); // 0 tip, 1 root
    for (let i = 0; i < width; i++) {
      const u = i / Math.max(1, width - 1);
      const rib = 1 - 0.12 * Math.max(0, 1 - Math.abs(u - 0.5) * 6);
      const l = clamp((0.95 - 0.55 * v ** 1.5) * rib, 0, 1);
      const o = (j * width + i) * 4;
      px[o] = Math.round(l * 255);
      px[o + 1] = Math.round(l * 255);
      px[o + 2] = Math.round(l * 0.85 * 255);
      px[o + 3] = 255;
    }
  }
  return px;
}
