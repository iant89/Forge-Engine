/**
 * @suite resources:textureMips
 * @group unit
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/scalar.ts
 * @covers engine/src/resources/texture.ts
 * @desc Procedural texture mip chains — without them, tiled terrain albedo/normals sparkle into
 */

export const suite = {
  name: "resources:textureMips",
  group: "unit",
  covers:   [
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/scalar.ts",
    "engine/src/resources/texture.ts"
  ],
  desc: "Procedural texture mip chains — without them, tiled terrain albedo/normals sparkle into",
};
/**
 * Procedural texture mip chains — without them, tiled terrain albedo/normals sparkle into
 * grazing-angle moiré on mobile GPUs (fe-14 / TERRAIN on iOS Safari).
 *
 * Averaging must respect the texel domain: sRGB albedo in linear light, tangent normals after
 * unpack+renormalize. Byte-averaging either darkens albedos or shortens normal vectors into sparkle.
 */
import assert from "node:assert/strict";
import { assertCloseTo, assertThrows, finish, group, test } from "selrun";
import { GraphicsDevice, Texture, boxFilterRgba8, linearToSrgb, srgbToLinear } from "@forge/engine";

group("Texture mip generation", () => {
  test("boxFilterRgba8 averages a 2×2 block into one texel (linear / byte domain)", () => {
    const src = new Uint8Array([
      0, 0, 0, 255,  100, 0, 0, 255,
      0, 100, 0, 255,  0, 0, 100, 255,
    ]);
    const dst = boxFilterRgba8(src, 2, 2, 1, 1, "linear");
    assert.equal((dst).length, 4);
    assert.equal(dst[0], 25); // (0+100+0+0+2)>>2
    assert.equal(dst[1], 25);
    assert.equal(dst[2], 25);
    assert.equal(dst[3], 255);
  });

  test("boxFilterRgba8 srgb averages in linear light then re-encodes", () => {
    // Two black + two mid-grey (188 ≈ mid after encode of 0.5 linear-ish). Exact check via curve.
    const mid = Math.round(linearToSrgb(0.5) * 255); // ~188
    const src = new Uint8Array([
      0, 0, 0, 255,  mid, mid, mid, 255,
      0, 0, 0, 255,  mid, mid, mid, 255,
    ]);
    const dst = boxFilterRgba8(src, 2, 2, 1, 1, "srgb");
    const expectedLin = (0 + srgbToLinear(mid / 255) + 0 + srgbToLinear(mid / 255)) * 0.25;
    const expected = Math.round(linearToSrgb(expectedLin) * 255);
    assert.equal(dst[0], expected);
    assert.equal(dst[1], expected);
    assert.equal(dst[2], expected);
    // Byte-average of the same bytes would be mid/2 ≈ 94; linear-space result is darker (~73).
    assert.notEqual(dst[0], ((0 + mid + 0 + mid) + 2) >> 2);
  });

  test("boxFilterRgba8 normal unpacks, averages, and renormalizes", () => {
    // Flat +Z normal (128,128,255) mixed with a tilted +X bias (255,128,128) — result must be
    // unit-length after pack, not the byte mean (which shortens Z).
    const src = new Uint8Array([
      128, 128, 255, 255,  255, 128, 128, 255,
      128, 128, 255, 255,  255, 128, 128, 255,
    ]);
    const dst = boxFilterRgba8(src, 2, 2, 1, 1, "normal");
    const nx = dst[0]! / 255 * 2 - 1;
    const ny = dst[1]! / 255 * 2 - 1;
    const nz = dst[2]! / 255 * 2 - 1;
    assertCloseTo(Math.hypot(nx, ny, nz), 1, 2);
    assert.ok(nx > 0);
    assert.ok(nz > 0);
    // Byte-average would leave Z ≈ (255+128+255+128)/4 = 191.5 → packed short normal.
    assert.ok(dst[2] > 191);
  });

  test("fromRgba8 with mipmaps uploads a full chain (no empty higher levels)", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const size = 8;
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 200;
      pixels[i + 1] = 80;
      pixels[i + 2] = 40;
      pixels[i + 3] = 255;
    }
    const tex = Texture.fromRgba8(device, size, size, pixels, { label: "mip-test", mipmaps: true, srgb: true });
    assert.equal(tex.mipLevels, 4); // 8→4→2→1
    // Memory accounts for the full chain (8²+4²+2²+1²).
    assert.equal(tex.gpuBytes, (64 + 16 + 4 + 1) * 4);
    tex.release();
    await device.dispose();
  });

  test("fromRgba8 rejects combining srgb and normal flags", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    assertThrows(() =>
      Texture.fromRgba8(device, 1, 1, new Uint8Array([128, 128, 255, 255]), {
        srgb: true,
        normal: true,
      }), /normal map cannot be sRGB/);
    await device.dispose();
  });
});

await finish();
