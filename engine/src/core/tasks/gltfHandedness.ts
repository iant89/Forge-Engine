/**
 * glTF → engine handedness.
 *
 * glTF is right-handed (+Y up, the asset's front faces +Z, so its left side is +X). The engine's world
 * is left-handed (+Y up, +Z forward, +X right — see `Mat4.setLookAt`). Taking glTF numbers as-is
 * therefore mirrors every asset left-to-right (text reads backwards, a rover's left wheels are on its
 * right). The fix is the reflection S = diag(-1, 1, 1): front stays +Z, up stays +Y, left becomes -X.
 *
 * Applied to the decoded arrays (each typed array once, even when primitives/samplers share it):
 *  - POSITION, NORMAL: x → -x; TANGENT: x → -x and w → -w (the reflection flips the bitangent sign);
 *  - indices: every triangle's winding is swapped (a reflection turns outward-CCW into CW); a
 *    non-indexed primitive gets an index list that does it;
 *  - bounds: x range mirrored;
 *  - node TRS: t → (-tx, ty, tz), q → (qx, -qy, -qz, qw), scale unchanged; node matrices and inverse
 *    bind matrices: M → S·M·S;
 *  - animation keys (incl. CUBICSPLINE tangents, which transform like their values): translation and
 *    rotation as above, scale unchanged.
 */

import type { DecodedGltfAsset } from "./gltfMesh.js";

/** `asset.extras` key/value written by `tools/gltf-fix-handedness.mjs` on a pre-converted file. */
export const GLTF_HANDEDNESS_MARKER = { key: "forgeHandedness", value: "engine-left-handed" } as const;

/** S·M·S for a column-major 4×4 with S = diag(-1, 1, 1, 1): negate entries where exactly one of row/col is 0. */
function mirrorMatrixInPlace(m: Float32Array, offset: number): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      if ((r === 0) !== (c === 0)) m[offset + c * 4 + r] = -m[offset + c * 4 + r]!;
    }
  }
}

const neg = (v: number): number => (v === 0 ? 0 : -v);

/** Mirror a decoded asset into the engine's handedness in place (see module comment). */
export function convertGltfAssetHandedness(asset: DecodedGltfAsset): void {
  const seen = new WeakSet<object>();
  const once = (a: object | null | undefined): boolean => {
    if (!a || seen.has(a)) return false;
    seen.add(a);
    return true;
  };
  for (const mesh of asset.meshes) {
    for (const p of mesh.primitives) {
      const pos = p.attributes.POSITION;
      if (once(pos)) for (let i = 0; i < pos!.length; i += 3) pos![i] = neg(pos![i]!);
      const nrm = p.attributes.NORMAL;
      if (once(nrm)) for (let i = 0; i < nrm!.length; i += 3) nrm![i] = neg(nrm![i]!);
      const tan = p.attributes.TANGENT;
      if (once(tan)) {
        for (let i = 0; i < tan!.length; i += 4) {
          tan![i] = neg(tan![i]!);
          tan![i + 3] = neg(tan![i + 3]!);
        }
      }
      if (p.indices) {
        if (once(p.indices)) {
          const ix = p.indices;
          for (let i = 0; i + 2 < ix.length; i += 3) {
            const t = ix[i + 1]!;
            ix[i + 1] = ix[i + 2]!;
            ix[i + 2] = t;
          }
        }
      } else {
        const n = p.vertexCount - (p.vertexCount % 3);
        const ix = p.vertexCount <= 65535 ? new Uint16Array(n) : new Uint32Array(n);
        for (let i = 0; i < n; i += 3) {
          ix[i] = i;
          ix[i + 1] = i + 2;
          ix[i + 2] = i + 1;
        }
        p.indices = ix;
        seen.add(ix);
        asset.decodedBytes += ix.byteLength;
      }
      if (once(p.bounds)) {
        const minX = p.bounds[0]!;
        p.bounds[0] = neg(p.bounds[3]!);
        p.bounds[3] = neg(minX);
      }
    }
  }
  for (const node of asset.nodes) {
    if (once(node.translation)) node.translation![0] = neg(node.translation![0]!);
    if (once(node.rotation)) {
      node.rotation![1] = neg(node.rotation![1]!);
      node.rotation![2] = neg(node.rotation![2]!);
    }
    if (once(node.matrix)) mirrorMatrixInPlace(node.matrix!, 0);
  }
  for (const skin of asset.skins) {
    if (once(skin.inverseBindMatrices)) {
      for (let o = 0; o + 16 <= skin.inverseBindMatrices.length; o += 16) mirrorMatrixInPlace(skin.inverseBindMatrices, o);
    }
  }
  for (const animation of asset.animations) {
    for (const channel of animation.channels) {
      if (channel.targetPath === "scale") continue;
      const out = animation.samplers[channel.samplerIndex]?.output;
      if (!once(out)) continue;
      if (channel.targetPath === "translation") for (let i = 0; i < out!.length; i += 3) out![i] = neg(out![i]!);
      else {
        for (let i = 0; i < out!.length; i += 4) {
          out![i + 1] = neg(out![i + 1]!);
          out![i + 2] = neg(out![i + 2]!);
        }
      }
    }
  }
}
