/**
 * Procedural texture mip chains — without them, tiled terrain albedo/normals sparkle into
 * grazing-angle moiré on mobile GPUs (fe-14 / TERRAIN on iOS Safari).
 */
import { describe, expect, it } from "vitest";
import { GraphicsDevice, Texture, boxFilterRgba8 } from "@forge/engine";

describe("Texture mip generation", () => {
  it("boxFilterRgba8 averages a 2×2 block into one texel", () => {
    const src = new Uint8Array([
      0, 0, 0, 255,  100, 0, 0, 255,
      0, 100, 0, 255,  0, 0, 100, 255,
    ]);
    const dst = boxFilterRgba8(src, 2, 2, 1, 1);
    expect(dst).toHaveLength(4);
    expect(dst[0]).toBe(25); // (0+100+0+0+2)>>2
    expect(dst[1]).toBe(25);
    expect(dst[2]).toBe(25);
    expect(dst[3]).toBe(255);
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
    const tex = Texture.fromRgba8(device, size, size, pixels, { label: "mip-test", mipmaps: true });
    expect(tex.mipLevels).toBe(4); // 8→4→2→1
    // Memory accounts for the full chain (8²+4²+2²+1²).
    expect(tex.gpuBytes).toBe((64 + 16 + 4 + 1) * 4);
    tex.release();
    await device.dispose();
  });
});
