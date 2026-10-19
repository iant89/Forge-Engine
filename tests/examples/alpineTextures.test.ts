/**
 * @suite examples:alpineTextures
 * @group unit
 * @covers examples/src/textures/alpine.ts
 * @desc Pins the procedural alpine surface art: tileable, deterministic ground layers, packed-snow road, winter tread, spruce bough card and hi-vis stripe
 */

export const suite = {
  name: "examples:alpineTextures",
  group: "unit",
  covers: ["examples/src/textures/alpine.ts"],
  desc: "Pins the procedural alpine surface art: tileable, deterministic ground layers, packed-snow road, winter tread, spruce bough card and hi-vis stripe",
};
import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  ALPINE_LAYER_ORDER,
  alpineLayerPixels,
  hiVisStripePixels,
  meanLinearAlbedo,
  snowRoadPixels,
  spruceBoughPixels,
  tyreTreadPixels,
  wrapCells,
  wrapFbm,
  wrapNoise,
} from "../../examples/src/textures/alpine.js";

const SIZE = 64;

/** Mean luminance (0..1) of an RGBA8 image's colour channels. */
function luminance(px: Uint8Array): number {
  let sum = 0;
  const n = px.length / 4;
  for (let i = 0; i < n; i++) sum += (px[i * 4]! * 0.2126 + px[i * 4 + 1]! * 0.7152 + px[i * 4 + 2]! * 0.0722) / 255;
  return sum / n;
}

/**
 * How well an image tiles: the seam between the last and first column (or row) compared with the
 * typical step between neighbouring columns. A seamless wrap is as smooth as the interior (≈ 1);
 * a texture that does not wrap shows a seam several times larger.
 */
function seamRatio(px: Uint8Array, w: number, h: number, axis: "x" | "y"): number {
  const at = (x: number, y: number): number => px[(y * w + x) * 4]! + px[(y * w + x) * 4 + 1]! + px[(y * w + x) * 4 + 2]!;
  let seam = 0, interior = 0, seamN = 0, interiorN = 0;
  if (axis === "x") {
    for (let y = 0; y < h; y++) {
      seam += Math.abs(at(0, y) - at(w - 1, y)); seamN++;
      for (let x = 0; x < w - 1; x++) { interior += Math.abs(at(x, y) - at(x + 1, y)); interiorN++; }
    }
  } else {
    for (let x = 0; x < w; x++) {
      seam += Math.abs(at(x, 0) - at(x, h - 1)); seamN++;
      for (let y = 0; y < h - 1; y++) { interior += Math.abs(at(x, y) - at(x, y + 1)); interiorN++; }
    }
  }
  return seam / seamN / Math.max(1e-9, interior / interiorN);
}

group("alpine textures — noise primitives", () => {
  test("wrapped noise repeats exactly across its period and stays in [0, 1]", () => {
    for (const [x, y] of [[0.3, 0.7], [1.9, 2.2], [3.5, 0.1]] as const) {
      assertCloseTo(wrapNoise(x, y, 4, 4, 9), wrapNoise(x + 4, y, 4, 4, 9), 9);
      assertCloseTo(wrapNoise(x, y, 4, 4, 9), wrapNoise(x, y + 4, 4, 4, 9), 9);
      const v = wrapFbm(x, y, 4, 4, 4, 9);
      assert.ok(v >= 0 && v <= 1);
      assertCloseTo(v, wrapFbm(x + 4, y + 4, 4, 4, 4, 9), 9, "fBm tiles because every octave doubles its period");
    }
  });

  test("cellular noise tiles, reports consistent distances and a stable cell id", () => {
    const a = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 }, b = { ...a };
    wrapCells(1.3, 2.6, 5, 7, a);
    wrapCells(1.3 + 5, 2.6 + 5, 5, 7, b);
    assertCloseTo(a.f1, b.f1, 9);
    assert.equal(a.id, b.id);
    assert.ok(a.f2 >= a.f1 && a.f1 >= 0 && a.id >= 0 && a.id < 1);
    assertCloseTo(Math.hypot(a.dx, a.dy), a.f1, 9, "the offset vector has the nearest-feature distance");
  });
});

group("alpine textures — ground layers", () => {
  const layers = ALPINE_LAYER_ORDER.map((kind) => [kind, alpineLayerPixels(kind, SIZE)] as const);

  test("each layer is deterministic, fully opaque and tangent-space correct", () => {
    for (const [kind, layer] of layers) {
      const again = alpineLayerPixels(kind, SIZE);
      assert.deepEqual(Array.from(again.albedo), Array.from(layer.albedo), `${kind} albedo`);
      assert.equal(layer.albedo.length, SIZE * SIZE * 4);
      for (let i = 0; i < SIZE * SIZE; i++) {
        assert.equal(layer.albedo[i * 4 + 3], 255);
        // Tangent-space normals point out of the surface: blue is above one half.
        assert.ok(layer.normal[i * 4 + 2]! > 127, `${kind} normal ${i} faces outward`);
        assert.equal(layer.metallicRoughness[i * 4 + 2], 255, "metallic factor passes the layer's own value through");
        assert.ok(layer.metallicRoughness[i * 4 + 1]! > 80, `${kind} stays rough`);
      }
    }
  });

  test("tiles in both axes (the splat repeats it every few metres)", () => {
    for (const [kind, layer] of layers) {
      // Bytes above a threshold would hide a seam inside the noise floor; ratios near 1 mean seamless.
      assert.ok(seamRatio(layer.albedo, SIZE, SIZE, "x") < 1.6, `${kind} seam x ${seamRatio(layer.albedo, SIZE, SIZE, "x").toFixed(2)}`);
      assert.ok(seamRatio(layer.albedo, SIZE, SIZE, "y") < 1.6, `${kind} seam y ${seamRatio(layer.albedo, SIZE, SIZE, "y").toFixed(2)}`);
    }
  });

  test("snow is the brightest layer and the others stay darker; every mean lands in a usable range", () => {
    const lum = Object.fromEntries(layers.map(([kind, layer]) => [kind, luminance(layer.albedo)])) as Record<string, number>;
    assert.ok(lum.snow! > 0.8, `snow ${lum.snow}`);
    for (const kind of ["rock", "scree", "tundra"]) {
      assert.ok(lum[kind]! < lum.snow! - 0.1 && lum[kind]! > 0.3, `${kind} ${lum[kind]}`);
    }
    for (const [, layer] of layers) {
      const mean = meanLinearAlbedo(layer.albedo);
      for (const c of mean) assert.ok(c > 0.05 && c <= 1);
    }
  });

  test("the relief carries detail: rock and scree are far rougher than snow", () => {
    const variation = (kind: string): number => {
      const n = layers.find(([k]) => k === kind)![1].normal;
      let sum = 0;
      for (let i = 0; i < SIZE * SIZE; i++) sum += Math.abs(n[i * 4]! - 128) + Math.abs(n[i * 4 + 1]! - 128);
      return sum / (SIZE * SIZE);
    };
    assert.ok(variation("rock") > variation("snow") * 1.5);
    assert.ok(variation("scree") > variation("snow") * 1.5);
  });

  test("meanLinearAlbedo decodes sRGB bytes", () => {
    const grey = new Uint8Array(16).fill(128);
    for (let i = 0; i < 4; i++) grey[i * 4 + 3] = 255;
    const [r, g, b] = meanLinearAlbedo(grey);
    for (const c of [r, g, b]) assertCloseTo(c, 0.2158, 3);
  });
});

group("alpine textures — road, tyre, bough and stripe", () => {
  const road = snowRoadPixels({ width: 128, height: 256 });

  test("the packed-snow road has darker ruts, a lighter bank and tiles along its length", () => {
    assert.equal(road.albedo.length, 128 * 256 * 4);
    const column = (x: number): number => {
      let sum = 0;
      for (let y = 0; y < road.height; y++) sum += road.albedo[(y * road.width + x) * 4]!;
      return sum / road.height;
    };
    const span = 3.4;
    const at = (lateral: number): number => column(Math.round(((lateral + span) / (2 * span)) * (road.width - 1)));
    const crown = at(0), rut = at(0.85), bank = at(3.2);
    assert.ok(rut < crown - 4, `rut ${rut.toFixed(0)} is darker than the crown ${crown.toFixed(0)}`);
    assert.ok(bank > crown + 8, `bank ${bank.toFixed(0)} is lighter than the crown ${crown.toFixed(0)}`);
    assert.ok(seamRatio(road.albedo, road.width, road.height, "y") < 1.6, "tiles in v");
    for (let i = 0; i < road.width * road.height; i++) assert.equal(road.albedo[i * 4 + 3], 255);
    // The ruts are glossier than the banks (lower roughness byte).
    const roughAt = (lateral: number): number => road.metallicRoughness[(10 * road.width + Math.round(((lateral + span) / (2 * span)) * (road.width - 1))) * 4 + 1]!;
    assert.ok(roughAt(0.85) < roughAt(3.2) - 15, "polished ruts, matte banks");
  });

  test("the tyre tread has a chevron relief in the tread band and a smoother sidewall, and tiles around", () => {
    const from = 0.3375, to = 0.6625;
    const tyre = tyreTreadPixels({ width: 64, height: 128, treadFrom: from, treadTo: to });
    const variation = (v0: number, v1: number): number => {
      let sum = 0, n = 0;
      for (let y = Math.floor(v0 * tyre.height); y < Math.ceil(v1 * tyre.height); y++) {
        for (let x = 0; x < tyre.width; x++) { sum += Math.abs(tyre.normal[(y * tyre.width + x) * 4]! - 128) + Math.abs(tyre.normal[(y * tyre.width + x) * 4 + 1]! - 128); n++; }
      }
      return sum / n;
    };
    assert.ok(variation(from + 0.02, to - 0.02) > variation(0.05, from - 0.05) * 1.5, "the tread is much more modelled than the sidewall");
    assert.ok(seamRatio(tyre.albedo, tyre.width, tyre.height, "x") < 1.8, "tiles around the circumference");
    // Rubber is near black: a linear albedo of a few percent.
    for (const c of meanLinearAlbedo(tyre.albedo)) assert.ok(c < 0.12, `rubber albedo ${c}`);
  });

  test("the spruce bough card is a sparse alpha-cut frond that tints white-balanced", () => {
    const card = spruceBoughPixels(96, 17);
    assert.deepEqual(Array.from(spruceBoughPixels(96, 17)), Array.from(card));
    let opaque = 0, ink = 0;
    for (let i = 0; i < 96 * 96; i++) {
      if (card[i * 4 + 3]! > 127) { opaque++; ink += card[i * 4]!; }
      assert.equal(card[i * 4]!, card[i * 4 + 1]!, "white-balanced (R = G)");
    }
    const coverage = opaque / (96 * 96);
    assert.ok(coverage > 0.1 && coverage < 0.6, `coverage ${coverage.toFixed(2)}`);
    assert.ok(ink / Math.max(1, opaque) > 100, "light enough to be tinted");
    // The bottom of the card carries the twig (centre column opaque) and the corners are empty.
    assert.ok(card[(90 * 96 + 48) * 4 + 3]! > 127 || card[(88 * 96 + 48) * 4 + 3]! > 127);
    assert.equal(card[3], 0);
    assert.notDeepEqual(Array.from(spruceBoughPixels(96, 18)), Array.from(card), "another seed, another sprig");
  });

  test("the hi-vis stripe alternates signal orange and white", () => {
    const stripe = hiVisStripePixels(64, 16);
    let orange = 0, white = 0;
    for (let i = 0; i < 64 * 16; i++) {
      const r = stripe.albedo[i * 4]!, g = stripe.albedo[i * 4 + 1]!, b = stripe.albedo[i * 4 + 2]!;
      if (r > 200 && g < 150 && b < 90) orange++;
      else if (r > 200 && g > 200 && b > 200) white++;
    }
    assert.ok(orange > 64 * 16 * 0.3 && white > 64 * 16 * 0.3, `orange ${orange}, white ${white}`);
  });
});

await finish();
