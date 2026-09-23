/**
 * Procedural texture mip chains — without them, tiled terrain albedo/normals sparkle into
 * grazing-angle moiré on mobile GPUs (fe-14 / TERRAIN on iOS Safari).
 *
 * Averaging must respect the texel domain: sRGB albedo in linear light, tangent normals after
 * unpack+renormalize. Byte-averaging either darkens albedos or shortens normal vectors into sparkle.
 */
import { describe, expect, it } from "vitest";
import { GraphicsDevice, Texture, boxFilterRgba8, linearToSrgb, srgbToLinear } from "@forge/engine";

describe("Texture mip generation", () => {
  it("boxFilterRgba8 averages a 2×2 block into one texel (linear / byte domain)", () => {
    const src = new Uint8Array([
      0, 0, 0, 255,  100, 0, 0, 255,
      0, 100, 0, 255,  0, 0, 100, 255,
    ]);
    const dst = boxFilterRgba8(src, 2, 2, 1, 1, "linear");
    expect(dst).toHaveLength(4);
    expect(dst[0]).toBe(25); // (0+100+0+0+2)>>2
    expect(dst[1]).toBe(25);
    expect(dst[2]).toBe(25);
    expect(dst[3]).toBe(255);
  });

  it("boxFilterRgba8 srgb averages in linear light then re-encodes", () => {
    // Two black + two mid-grey (188 ≈ mid after encode of 0.5 linear-ish). Exact check via curve.
    const mid = Math.round(linearToSrgb(0.5) * 255); // ~188
    const src = new Uint8Array([
      0, 0, 0, 255,  mid, mid, mid, 255,
      0, 0, 0, 255,  mid, mid, mid, 255,
    ]);
    const dst = boxFilterRgba8(src, 2, 2, 1, 1, "srgb");
    const expectedLin = (0 + srgbToLinear(mid / 255) + 0 + srgbToLinear(mid / 255)) * 0.25;
    const expected = Math.round(linearToSrgb(expectedLin) * 255);
    expect(dst[0]).toBe(expected);
    expect(dst[1]).toBe(expected);
    expect(dst[2]).toBe(expected);
    // Byte-average of the same bytes would be mid/2 ≈ 94; linear-space result is darker (~73).
    expect(dst[0]).not.toBe(((0 + mid + 0 + mid) + 2) >> 2);
  });

  it("boxFilterRgba8 normal unpacks, averages, and renormalizes", () => {
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
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 2);
    expect(nx).toBeGreaterThan(0);
    expect(nz).toBeGreaterThan(0);
    // Byte-average would leave Z ≈ (255+128+255+128)/4 = 191.5 → packed short normal.
    expect(dst[2]).toBeGreaterThan(191);
  });

  it("fromRgba8 with mipmaps uploads a full chain (no empty higher levels)", async () => {
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
    expect(tex.mipLevels).toBe(4); // 8→4→2→1
    // Memory accounts for the full chain (8²+4²+2²+1²).
    expect(tex.gpuBytes).toBe((64 + 16 + 4 + 1) * 4);
    tex.release();
    await device.dispose();
  });

  it("fromRgba8 rejects combining srgb and normal flags", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    expect(() =>
      Texture.fromRgba8(device, 1, 1, new Uint8Array([128, 128, 255, 255]), {
        srgb: true,
        normal: true,
      }),
    ).toThrow(/normal map cannot be sRGB/);
    await device.dispose();
  });
});
