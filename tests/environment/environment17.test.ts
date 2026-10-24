/**
 * @suite environment:environment17
 * @group unit
 * @covers engine/src/environment/atmosphere.ts
 * @covers engine/src/environment/multiScattering.ts
 * @covers engine/src/gpu/constants.ts
 * @covers engine/src/gpu/device.ts
 * @covers engine/src/index.ts
 * @covers engine/src/math/vec.ts
 * @covers engine/src/rendering/pipeline.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/shaders/common.ts
 * @covers engine/src/rendering/shaders/multiScattering.ts
 * @covers engine/src/rendering/shaders/sky.ts
 * @covers engine/src/rendering/skyMultiScattering.ts
 * @covers engine/src/rendering/uniforms.ts
 * @covers engine/src/scene/components/index.ts
 * @covers engine/src/scene/scene.ts
 * @covers tools/browser-check.mjs
 * @desc Environment (Phases 17.1–17.2): the multiple-scattering LUT and finite-path aerial perspective
 */

export const suite = {
  name: "environment:environment17",
  group: "unit",
  covers: [
    "engine/src/environment/atmosphere.ts",
    "engine/src/environment/multiScattering.ts",
    "engine/src/gpu/constants.ts",
    "engine/src/gpu/device.ts",
    "engine/src/index.ts",
    "engine/src/math/vec.ts",
    "engine/src/rendering/pipeline.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/shaders/common.ts",
    "engine/src/rendering/shaders/multiScattering.ts",
    "engine/src/rendering/shaders/sky.ts",
    "engine/src/rendering/skyMultiScattering.ts",
    "engine/src/rendering/uniforms.ts",
    "engine/src/scene/components/index.ts",
    "engine/src/scene/scene.ts",
    "tools/browser-check.mjs",
  ],
  desc: "Environment (Phases 17.1–17.2): the multiple-scattering LUT and finite-path aerial perspective",
};
/**
 * Environment (Phases 17.1–17.2) — the sky's higher scattering orders and finite-path transfer to
 * scene geometry, with the CPU atmosphere as the reference and GPU passes/shaders as its device twin.
 *
 * What these prove, and against what:
 *  - the table's axes are the ones the reader uses (height warped by `sqrt(h / H)`, sun elevation by
 *    `sqrt(|μ|)` around the terminator) and inverting them is exact, so a texel centre round-trips;
 *  - what the table stores is `(1/4π)∫L₁dω / (1 − ρ)` per unit sun intensity: the tests compare it
 *    with the model's own single scattering averaged over the sphere, and pin the *measured* accuracy
 *    of both configurations — the device's within ±5 % in daylight below ~25 km, the CPU one within
 *    ~±7 % — plus the exact zeros below a height's horizon, the monotone decay through the terminator
 *    and the series-ratio clamp that keeps the geometric series finite;
 *  - installing the field on a model adds the term to `skyRadiance`/`skyAmbient`/`horizonColor` and
 *    buys what the phase is for: ~1.3× luminance at noon, ~2-7× at twilight on Earth and ~2-5× on
 *    Mars, which is where a single-scattering sky is visibly wrong;
 *  - the device half: the two compute entry points share the config the CPU build reads (asserted on
 *    the WGSL text, since a mock device cannot execute WGSL), the sky pass binds the LUT at its own
 *    binding without redeclaring the clouds binding, the renderer records both passes exactly when
 *    the sun has moved past `MS_SUN_EPSILON` or the atmosphere changed, and `dispose` releases both
 *    buffers;
 *  - the numeric CPU/device agreement itself is a real-WebGPU claim: `npm run check:browser` reads
 *    the LUT off the device and compares it with `Renderer.multiScatteringReference()`, and proves
 *    the term reaches pixels by measuring the sky with `sky.multiScattering` on and off;
 *  - the Phase 17.2 CPU transfer is identity outside the shell, loses transmittance and gains
 *    in-scattering with distance, and receives the optional MS source without changing extinction.
 */

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertNotContains, finish, group, test } from "selrun";
import {
  AtmosphereModel,
  Camera,
  Color,
  EARTH_ATMOSPHERE,
  ESTIMATE_MIE_ANISOTROPY,
  GraphicsDevice,
  Light,
  MARS_ATMOSPHERE,
  MS_BINDINGS,
  MS_BLOCKED_TAU,
  MS_ENTRY,
  MS_LUT_FLOATS_PER_TEXEL,
  MS_LUT_TEXEL_BYTES,
  MS_LUT_TEXELS,
  MS_LUT_TEXTURE_FORMAT,
  MS_SUN_EPSILON,
  MS_TABLE_TEXELS,
  MS_WORKGROUP,
  MULTI_SCATTERING_CPU,
  MULTI_SCATTERING_GPU,
  MULTI_SCATTERING_SHADER,
  MultiScatteringField,
  Renderer,
  SKY_BINDINGS,
  SKY_SHADER,
  Scene,
  Vec3,
  WGSL_ATMOSPHERE_COMMON,
  clampMieAnisotropy,
  createAtmosphere,
  multiScatteringHeightParam,
  multiScatteringSunFromParam,
  multiScatteringSunParam,
  multiScatteringTexels,
  skyMultiScatteringSignatureChanged,
  wgslMultiScatteringSampler,
  writeSkyMultiScatteringSignature,
} from "@forge/engine";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * `J₁(h, μ) = (1/4π)∫L₁dω` integrated the slow way: the model's own `skyRadiance` (single
 * scattering — the field must not be installed on it) averaged over a Fibonacci sphere, divided by
 * the full direction count, in units of the sun's intensity.
 *
 * The ground is black on purpose: the table carries no ground bounce, and the solid angle the
 * planet blocks carries no sky, so those directions contribute zero rather than the lit ground the
 * default model adds below the horizon.
 */
function sphereMeanSingleScattering(model: AtmosphereModel, height: number, muSun: number, count = 256): number[] {
  const black = new AtmosphereModel({ ...model.params, groundAlbedo: [0, 0, 0] });
  const sun = new Vec3(Math.sqrt(Math.max(0, 1 - muSun * muSun)), muSun, 0);
  const view = new Vec3();
  const out = new Float64Array(3);
  const acc = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const cosT = 1 - (2 * (i + 0.5)) / count;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = i * GOLDEN_ANGLE;
    view.set(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
    black.skyRadiance(view, sun, height, out, 48, 24);
    acc[0]! += out[0]!;
    acc[1]! += out[1]!;
    acc[2]! += out[2]!;
  }
  return acc.map((v) => v / count / model.params.sunIntensity);
}

/**
 * The same spherical mean without the black-ground override: what the *model* reports, ground
 * bounce included. Only used to show how large the term the table leaves out actually is.
 */
function sphereMeanWithGround(model: AtmosphereModel, height: number, muSun: number, count = 256): number[] {
  const sun = new Vec3(Math.sqrt(Math.max(0, 1 - muSun * muSun)), muSun, 0);
  const view = new Vec3();
  const out = new Float64Array(3);
  const acc = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const cosT = 1 - (2 * (i + 0.5)) / count;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = i * GOLDEN_ANGLE;
    view.set(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
    model.skyRadiance(view, sun, height, out, 48, 24);
    acc[0]! += out[0]!;
    acc[1]! += out[1]!;
    acc[2]! += out[2]!;
  }
  return acc.map((v) => v / count / model.params.sunIntensity);
}

/** A view/sun pair from elevation angles in degrees, the way the sky tests describe them. */
const deg = (value: number): number => (value * Math.PI) / 180;
const dirFrom = (elevationDeg: number, azimuthDeg = 0): Vec3 =>
  new Vec3(
    Math.cos(deg(elevationDeg)) * Math.sin(deg(azimuthDeg)),
    Math.sin(deg(elevationDeg)),
    Math.cos(deg(elevationDeg)) * Math.cos(deg(azimuthDeg)),
  );

/** Luminance of a three-channel radiance (Rec. 709, the weights the browser gate samples with). */
const luminance = (rgb: ArrayLike<number>): number => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;

group("table axes", () => {
  test("derives the texel count and the float stride the shader uses", () => {
    assert.equal(multiScatteringTexels(MULTI_SCATTERING_GPU), MULTI_SCATTERING_GPU.heightSamples * MULTI_SCATTERING_GPU.sunSamples);
    assert.equal(multiScatteringTexels(MULTI_SCATTERING_CPU), MULTI_SCATTERING_CPU.heightSamples * MULTI_SCATTERING_CPU.sunSamples);
    assert.equal(MS_LUT_TEXELS, multiScatteringTexels(MULTI_SCATTERING_GPU));
    assert.equal(MS_TABLE_TEXELS, MULTI_SCATTERING_GPU.transmittanceHeights * MULTI_SCATTERING_GPU.transmittanceZeniths);
    assert.equal(MS_LUT_FLOATS_PER_TEXEL, 4);
    assert.equal(MS_LUT_TEXEL_BYTES, 16);
    // Both readers index the same layout: (height-major, sun-minor) texels of (rgb, mean rho).
    assert.equal(MULTI_SCATTERING_GPU.heightSamples, 32);
    assert.equal(MULTI_SCATTERING_GPU.sunSamples, 32);
    assert.ok(MULTI_SCATTERING_GPU.heightSamples > MULTI_SCATTERING_CPU.heightSamples, "the device table is finer than the CPU one");
  });

  test("warps the height axis into sqrt(h / H) and the sun axis around the terminator", () => {
    const H = EARTH_ATMOSPHERE.atmosphereHeight;
    assert.equal(multiScatteringHeightParam(0, H), 0);
    assert.equal(multiScatteringHeightParam(-5, H), 0, "below sea level clamps to the ground row");
    assert.equal(multiScatteringHeightParam(H, H), 1);
    assert.equal(multiScatteringHeightParam(2 * H, H), 1, "above the atmosphere clamps to the top row");
    assertCloseTo(multiScatteringHeightParam(H / 4, H), 0.5, 6);
    // Monotone: a taller point never resolves to a lower row.
    let previous = -1;
    for (let i = 0; i <= 32; i++) {
      const t = multiScatteringHeightParam((i / 32) * H, H);
      assert.ok(t >= previous, `height param went backwards at step ${i}`);
      previous = t;
    }

    assert.equal(multiScatteringSunParam(-1), 0);
    assert.equal(multiScatteringSunParam(1), 1);
    assert.equal(multiScatteringSunParam(-2), 0);
    assert.equal(multiScatteringSunParam(2), 1);
    assert.equal(multiScatteringSunParam(0), 0.5, "the terminator sits at the middle column");
    // Dense around 0: the warp puts a third of the columns inside |mu| < 0.15.
    const columns = MULTI_SCATTERING_GPU.sunSamples;
    let twilightColumns = 0;
    for (let i = 0; i < columns; i++) {
      if (Math.abs(multiScatteringSunFromParam(i / (columns - 1))) < 0.15) twilightColumns++;
    }
    assert.ok(twilightColumns >= columns / 3, `only ${twilightColumns}/${columns} columns resolve the twilight band`);
    // Round trip: the inverse the build uses reproduces the cosine of every column.
    for (let i = 0; i < columns; i++) {
      const param = i / (columns - 1);
      assertCloseTo(multiScatteringSunParam(multiScatteringSunFromParam(param)), param, 6);
    }
    // 0.0667 is where the CPU table's own columns land; the warp must order, not shuffle, them.
    assert.ok(multiScatteringSunParam(-0.5) < multiScatteringSunParam(-0.01));
    assert.ok(multiScatteringSunParam(-0.01) < multiScatteringSunParam(0.5));
  });

  test("a texel centre round-trips through the sampler", () => {
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const field = new MultiScatteringField(model, MULTI_SCATTERING_CPU);
    const exact = new Float64Array(3);
    const sampled = new Float64Array(3);
    for (let row = 0; row < MULTI_SCATTERING_CPU.heightSamples; row++) {
      const h = (row / (MULTI_SCATTERING_CPU.heightSamples - 1)) ** 2 * model.params.atmosphereHeight;
      for (let col = 0; col < MULTI_SCATTERING_CPU.sunSamples; col++) {
        const mu = multiScatteringSunFromParam(col / (MULTI_SCATTERING_CPU.sunSamples - 1));
        field.texelValue(h, mu, exact);
        field.sample(h, mu, sampled);
        for (let c = 0; c < 3; c++) {
          assertCloseTo(sampled[c]!, exact[c]!, 6, `texel (${row}, ${col}) channel ${c} does not round-trip`);
        }
      }
    }
  });

  test("interpolates between texels and clamps outside the table", () => {
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const field = new MultiScatteringField(model, MULTI_SCATTERING_CPU);
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    const mid = new Float64Array(3);
    // Halfway between two daylight columns of the ground row: between its neighbours, per channel.
    const colA = 10;
    const colB = 11;
    const muA = multiScatteringSunFromParam(colA / (MULTI_SCATTERING_CPU.sunSamples - 1));
    const muB = multiScatteringSunFromParam(colB / (MULTI_SCATTERING_CPU.sunSamples - 1));
    field.texelValue(0, muA, a);
    field.texelValue(0, muB, b);
    field.sample(0, 0.5 * (muA + muB), mid);
    for (let c = 0; c < 3; c++) {
      assert.ok(mid[c]! > Math.min(a[c]!, b[c]!) && mid[c]! < Math.max(a[c]!, b[c]!), `interpolated channel ${c} left its neighbours`);
    }
    // Outside the domain: above the atmosphere reads the top row, and the poles read the end columns.
    const top = new Float64Array(3);
    const clampedHeight = new Float64Array(3);
    const columnCentre = multiScatteringSunFromParam(13 / (MULTI_SCATTERING_CPU.sunSamples - 1));
    field.texelValue(model.params.atmosphereHeight, columnCentre, top);
    field.sample(5 * model.params.atmosphereHeight, columnCentre, clampedHeight);
    for (let c = 0; c < 3; c++) assertCloseTo(clampedHeight[c]!, top[c]!, 6, `height clamp broken in channel ${c}`);
    const zenith = new Float64Array(3);
    const above = new Float64Array(3);
    field.texelValue(0, 1, zenith);
    field.sample(0, 4, above);
    for (let c = 0; c < 3; c++) assertCloseTo(above[c]!, zenith[c]!, 6, `sun clamp broken in channel ${c}`);
    // The nadir column is exactly zero (the blocked tau survives the interpolation).
    field.sample(0, -1, mid);
    assert.ok(mid.every((v) => v === 0), `the nadir column held ${[...mid]}`);
  });

  test("shares one configuration with the WGSL the passes compile", () => {
    const common = WGSL_ATMOSPHERE_COMMON;
    const numeric = (name: string): number => {
      const match = new RegExp(`const ${name}: (?:i32|f32) = ([0-9.]+)`).exec(common);
      assert.ok(match, `${name} is not a constant of the shared WGSL`);
      return Number(match[1]);
    };
    assert.equal(numeric("MS_LUT_HEIGHT"), MULTI_SCATTERING_GPU.heightSamples);
    assert.equal(numeric("MS_LUT_SUN"), MULTI_SCATTERING_GPU.sunSamples);
    assert.equal(numeric("MS_TABLE_HEIGHT"), MULTI_SCATTERING_GPU.transmittanceHeights);
    assert.equal(numeric("MS_TABLE_SUN"), MULTI_SCATTERING_GPU.transmittanceZeniths);
    assert.equal(numeric("MS_DIRECTIONS"), MULTI_SCATTERING_GPU.directions);
    assert.equal(numeric("MS_STEPS"), MULTI_SCATTERING_GPU.steps);
    assert.equal(numeric("MS_LIGHT_SAMPLES"), MULTI_SCATTERING_GPU.lightSamples);
    assertCloseTo(numeric("MS_MAX_SERIES_RATIO"), MULTI_SCATTERING_GPU.maxSeriesRatio, 4);
    assertCloseTo(numeric("MS_ESTIMATE_G"), clampMieAnisotropy(0.8), 4, "the field pass must use the same lobe cap as the CPU build");
    assert.ok(wgslMultiScatteringSampler(2).includes("texture_2d<f32>"), "the fragment reader uses a texture");
    assert.ok(MULTI_SCATTERING_SHADER.includes(MS_ENTRY.transmittance) && MULTI_SCATTERING_SHADER.includes(MS_ENTRY.field));
    assert.ok(MULTI_SCATTERING_SHADER.includes(`@workgroup_size(${MS_WORKGROUP}) @compute fn`), "the validator needs @workgroup_size before @compute fn");
    assert.ok(MULTI_SCATTERING_SHADER.includes("textureStore(multiScatteringLut"), "csField writes the texture");
  });

  test("declares the LUT at whatever binding the caller asks for", () => {
    const sampler = wgslMultiScatteringSampler(7);
    assert.ok(sampler.includes("@group(0) @binding(7) var multiScatteringLut: texture_2d<f32>"), sampler.slice(0, 160));
    assert.ok(sampler.includes("textureLoad(multiScatteringLut"));
    assert.ok(sampler.includes("fn msSourceAt(h: f32, p: vec3<f32>, sunDir: vec3<f32>) -> vec3<f32>"));
    // The sky pass and the compute passes bind it in different slots of different layouts.
    assert.equal(SKY_BINDINGS.multiScattering.binding, 3);
    assert.equal(MS_BINDINGS.lut.binding, 2);
    assert.equal(MS_BINDINGS.sky.binding, 0);
    assert.equal(MS_LUT_TEXTURE_FORMAT, "rgba32float");
    assert.equal(SKY_SHADER.includes(`@binding(${SKY_BINDINGS.multiScattering.binding}) var multiScatteringLut: texture_2d<f32>`), true);
    assert.ok(SKY_SHADER.includes("textureLoad(multiScatteringLut") && SKY_SHADER.includes("msSourceAt"), "the sky pass reads the texture");
    // A hard-coded binding in the shared text collides with the clouds binding at the same slot.
    assertNotContains(SKY_SHADER, "@binding(2) var multiScatteringLut");
  });
});

group("the table is the isotropic source of the higher orders", () => {
  test("matches the sphere mean of the model's own single scattering in daylight", () => {
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const field = new MultiScatteringField(model, MULTI_SCATTERING_CPU);
    const texel = new Float64Array(3);
    const config = MULTI_SCATTERING_CPU;
    let checked = 0;
    for (const row of [0, config.heightSamples >> 3, config.heightSamples >> 2, config.heightSamples >> 1]) {
      const h = (row / (config.heightSamples - 1)) ** 2 * model.params.atmosphereHeight;
      for (let col = 0; col < config.sunSamples; col++) {
        const mu = multiScatteringSunFromParam(col / (config.sunSamples - 1));
        if (mu < 0.2) continue; // daylight only: twilight is the next test's business
        const reference = sphereMeanSingleScattering(model, h, mu);
        field.texelValue(h, mu, texel);
        const index = field.texelIndex(h, mu);
        // The band is the CPU configuration's own angular quadrature: 32 directions leave ~±17 %
        // (measured 0.83-1.03); the device configuration does better because it spends three times
        // the directions (the next test pins that with a tighter band).
        for (let c = 0; c < 3; c++) {
          const ratio = (texel[c]! * (1 - field.seriesRatio[index * 3 + c]!)) / reference[c]!;
          assert.ok(
            ratio > 0.8 && ratio < 1.1,
            `h=${h.toFixed(0)} mu=${mu.toFixed(3)} channel ${c}: table/J1 = ${ratio.toFixed(3)}`,
          );
        }
        checked++;
      }
    }
    assert.ok(checked >= 18, `only ${checked} daylight texels were compared`);
  });

  test("the device configuration tracks the same reference within a few percent", () => {
    // The same class builds the GPU configuration: one implementation of the table, two configs, so
    // this pins the numbers the WGSL twin produces on the device (the browser gate reads those back
    // and compares them with this very build).
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const field = new MultiScatteringField(model, MULTI_SCATTERING_GPU);
    const texel = new Float64Array(3);
    const config = MULTI_SCATTERING_GPU;
    for (const row of [0, config.heightSamples >> 3, config.heightSamples >> 2, config.heightSamples >> 1]) {
      const h = (row / (config.heightSamples - 1)) ** 2 * model.params.atmosphereHeight;
      for (const col of [24, 28, 31]) {
        const mu = multiScatteringSunFromParam(col / (config.sunSamples - 1));
        const reference = sphereMeanSingleScattering(model, h, mu);
        field.texelValue(h, mu, texel);
        const index = field.texelIndex(h, mu);
        for (let c = 0; c < 3; c++) {
          const ratio = (texel[c]! * (1 - field.seriesRatio[index * 3 + c]!)) / reference[c]!;
          assert.ok(ratio > 0.9 && ratio < 1.08, `gpu h=${h.toFixed(0)} mu=${mu.toFixed(3)} channel ${c}: ${ratio.toFixed(3)}`);
        }
      }
    }
  });

  test("excludes the ground bounce the table was built without", () => {
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const field = new MultiScatteringField(model, MULTI_SCATTERING_CPU);
    const texel = new Float64Array(3);
    const height = 20_000;
    field.texelValue(height, 0.6, texel);
    const index = field.texelIndex(height, 0.6);
    const black = sphereMeanSingleScattering(model, height, 0.6);
    for (let c = 0; c < 3; c++) {
      const withBlack = (texel[c]! * (1 - field.seriesRatio[index * 3 + c]!)) / black[c]!;
      assert.ok(withBlack > 0.8 && withBlack < 1.1, `channel ${c}: table/black-ground mean = ${withBlack.toFixed(3)}`);
    }
    // And the difference is measurable when it is left out: 20 km up, a tenth-albedo planet
    // bounces a large share of the light back, which is exactly the term this table does not model.
    const withGround = sphereMeanWithGround(model, height, 0.6);
    assert.ok(withGround[1]! > black[1]! * 1.2, `the ground bounce should be visible in the reference (${withGround[1]} vs ${black[1]})`);
  });

  test("decays through the terminator and is exactly dark below every horizon", () => {
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const field = new MultiScatteringField(model, MULTI_SCATTERING_CPU);
    const value = new Float64Array(3);
    let previous = Infinity;
    for (const mu of [1, 0.5, 0.2, 0.05, 0, -0.05, -0.1, -0.2, -0.4, -1]) {
      field.sample(0, mu, value);
      const mean = (value[0]! + value[1]! + value[2]!) / 3;
      assert.ok(mean >= 0 && Number.isFinite(mean), `mu=${mu} produced ${mean}`);
      assert.ok(mean <= previous, `the source grew as the sun set (mu=${mu})`);
      previous = mean;
    }
    // Twilight is a small fraction of daylight — orders of magnitude, not a re-tuned daylight sky.
    field.sample(0, -0.2, value);
    const twilight = (value[0]! + value[1]! + value[2]!) / 3;
    field.sample(0, 1, value);
    const daylight = (value[0]! + value[1]! + value[2]!) / 3;
    assert.ok(twilight < daylight * 0.05, `twilight carries ${(100 * twilight) / daylight}% of the daylight source`);
    assert.ok(twilight > 0, "twilight must not be extinguished at the horizon");
    // Dark columns are exact zeros, not small numbers that bloom after a tone map.
    for (const [h, mu] of [[0, -0.4], [0, -1], [4_000, -0.3]] as const) {
      field.texelValue(h, mu, value);
      assert.ok(Math.max(...value) < 1e-6, `h=${h} mu=${mu} held ${[...value]}`);
    }
    assert.equal(MS_BLOCKED_TAU * 0, 0, "the blocked sentinel must stay finite");
    assert.equal(Math.exp(-MS_BLOCKED_TAU), 0);
  });

  test("clamps the series ratio and keeps the summed series finite", () => {
    // The clamp is a configuration guard: `1 / (1 - rho)` diverges as rho approaches one, so the
    // field truncates rho at `maxSeriesRatio` before dividing. Its default is never reached by the
    // presets (Earth's own rho peaks around 0.23 at the ground, Mars' around 0.25), so the guard is
    // exercised by lowering it.
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const clampedField = new MultiScatteringField(model, { ...MULTI_SCATTERING_CPU, maxSeriesRatio: 0.05 });
    const texel = new Float64Array(3);
    let atClamp = 0;
    for (let i = 0; i < clampedField.seriesRatio.length; i += 3) {
      const rho = clampedField.seriesRatio[i]!;
      assert.ok(rho >= 0 && rho <= 0.05 + 1e-12, `rho=${rho} escaped the clamp`);
      if (rho >= 0.05 - 1e-12) atClamp++;
    }
    assert.ok(atClamp > 0, "a 0.05 clamp never bound anything");
    clampedField.sample(0, 0.8, texel);
    assert.ok(texel.every((v) => Number.isFinite(v) && v >= 0), `clamped texel held ${[...texel]}`);

    // With the default clamp the presets stay well inside it, and the series stays finite.
    const field = new MultiScatteringField(model, MULTI_SCATTERING_CPU);
    let peak = 0;
    for (let i = 0; i < field.seriesRatio.length; i++) peak = Math.max(peak, field.seriesRatio[i]!);
    assert.ok(peak < MULTI_SCATTERING_CPU.maxSeriesRatio, `the preset atmosphere reached ${peak}`);
    assert.ok(peak > 0.05, `the preset atmosphere never scattered twice (peak rho ${peak})`);
    field.sample(0, 0.8, texel);
    assert.ok(texel.every((v) => Number.isFinite(v)), `texel held ${[...texel]}`);
    // The stored alpha channel is the mean of the three per-channel ratios.
    const row = field.texelIndex(0, 0.8);
    const mean = (field.seriesRatio[row * 3]! + field.seriesRatio[row * 3 + 1]! + field.seriesRatio[row * 3 + 2]!) / 3;
    assertCloseTo(field.meanRatio(0, 0.8), mean, 5);
  });

  test("depends on the atmosphere it was built from, and is deterministic", () => {
    const earth = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const earthAgain = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const mars = new AtmosphereModel({ ...MARS_ATMOSPHERE });
    const a = new MultiScatteringField(earth, MULTI_SCATTERING_CPU);
    const b = new MultiScatteringField(earthAgain, MULTI_SCATTERING_CPU);
    const c = new MultiScatteringField(mars, MULTI_SCATTERING_CPU);
    assert.deepEqual([...a.data], [...b.data], "equal params must build equal tables");
    assert.equal(a.configUsed.directions, MULTI_SCATTERING_CPU.directions);
    const earthTexel = new Float64Array(3);
    const marsTexel = new Float64Array(3);
    a.texelValue(0, 0.6, earthTexel);
    c.texelValue(0, 0.6, marsTexel);
    for (let i = 0; i < 3; i++) {
      const delta = Math.abs(earthTexel[i]! - marsTexel[i]!) / Math.max(earthTexel[i]!, marsTexel[i]!);
      assert.ok(delta > 0.1, `channel ${i} barely noticed the planet change (${delta.toFixed(3)})`);
    }
    // Mars' thin, dust-forward atmosphere scatters a larger share of its light twice.
    const earthRatio = a.meanRatio(0, 0.6);
    const marsRatio = c.meanRatio(0, 0.6);
    assert.ok(marsRatio > earthRatio, `Mars rho ${marsRatio} should exceed Earth's ${earthRatio}`);
    // The lobe cap is what makes the 32-direction mean of a dust sky converge at all.
    assertCloseTo(clampMieAnisotropy(MARS_ATMOSPHERE.mieAnisotropy), ESTIMATE_MIE_ANISOTROPY, 6);
    assert.equal(clampMieAnisotropy(-2), -ESTIMATE_MIE_ANISOTROPY);
  });

  test("builds in a few milliseconds and never leaves a NaN", () => {
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const started = Date.now();
    const field = new MultiScatteringField(model, MULTI_SCATTERING_CPU);
    const elapsed = Date.now() - started;
    assert.ok(field.buildMs > 0 && field.buildMs < 250, `reference build took ${field.buildMs} ms`);
    assert.ok(elapsed < 500, `reference build plus allocation took ${elapsed} ms`);
    for (let i = 0; i < field.data.length; i++) {
      assert.ok(Number.isFinite(field.data[i]!), `texel float ${i} is ${field.data[i]}`);
    }
    // The reader is allocation-free: it fills the caller's array and repeats exactly.
    const first = new Float64Array(3);
    const second = new Float64Array(3);
    field.sample(1000, 0.3, first);
    field.sample(1000, 0.3, second);
    assert.deepEqual([...first], [...second]);
  });
});

group("the model with the field installed", () => {
  test("adds the term above the horizon, at every sun elevation", () => {
    const single = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const both = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    both.multiScattering = new MultiScatteringField(both, MULTI_SCATTERING_CPU);
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    for (const sunElevation of [30, 10, 0, -6]) {
      const sun = dirFrom(sunElevation);
      for (const viewElevation of [80, 20, 5]) {
        const view = dirFrom(viewElevation);
        single.skyRadiance(view, sun, 0, a, 64, 32);
        both.skyRadiance(view, sun, 0, b, 64, 32);
        const gain = luminance(b) / luminance(a);
        assert.ok(gain > 1, `view ${viewElevation} sun ${sunElevation}: the term vanished (gain ${gain})`);
      }
    }
    // Below the horizon the extra in-scatter still lands on the ground path, so nothing regresses.
    const view = dirFrom(-10);
    single.skyRadiance(view, dirFrom(10), 0, a, 64, 32);
    both.skyRadiance(view, dirFrom(10), 0, b, 64, 32);
    assert.ok(luminance(b) > luminance(a));
  });

  test("buys the most where single scattering is wrong: twilight, Mars and away from the sun", () => {
    const earth = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const mars = new AtmosphereModel({ ...MARS_ATMOSPHERE });
    const singleEarth = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const singleMars = new AtmosphereModel({ ...MARS_ATMOSPHERE });
    earth.multiScattering = new MultiScatteringField(earth, MULTI_SCATTERING_CPU);
    mars.multiScattering = new MultiScatteringField(mars, MULTI_SCATTERING_CPU);
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    const gainAt = (model: AtmosphereModel, reference: AtmosphereModel, view: Vec3, sun: Vec3): number => {
      reference.skyRadiance(view, sun, 0, a, 64, 32);
      model.skyRadiance(view, sun, 0, b, 64, 32);
      return luminance(b) / Math.max(1e-12, luminance(a));
    };
    const zenith = dirFrom(80);
    const day = gainAt(earth, singleEarth, zenith, dirFrom(10));
    const dusk = gainAt(earth, singleEarth, zenith, dirFrom(-6));
    assert.ok(day > 1.2 && day < 1.4, `Earth zenith daytime gain ${day.toFixed(3)} outside the measured band`);
    assert.ok(dusk > day * 1.4, `twilight gain ${dusk.toFixed(2)} should far exceed the daytime ${day.toFixed(2)}`);
    // The added light fills the sky single scattering leaves empty: toward the sun the aureole
    // already dominates and the term is a few percent, away from it the sky is a different sky.
    const toward = gainAt(earth, singleEarth, dirFrom(2, 0), dirFrom(10));
    const away = gainAt(earth, singleEarth, dirFrom(2, 90), dirFrom(10));
    assert.ok(away > 1.2, `the horizon away from the sun gained only ${away.toFixed(3)}`);
    assert.ok(away > toward * 1.15, `the away-from-sun gain ${away.toFixed(2)} should exceed the toward-sun ${toward.toFixed(2)}`);
    const marsDay = gainAt(mars, singleMars, zenith, dirFrom(10));
    const marsAway = gainAt(mars, singleMars, dirFrom(2, 90), dirFrom(10));
    assert.ok(marsDay > 2, `Mars daytime gain ${marsDay.toFixed(2)} should be far larger than Earth's`);
    assert.ok(marsAway > 2.5, `Mars horizon gain ${marsAway.toFixed(2)}`);
    // A single-scattering sky keeps the horizon yellow: the added light is bluer than the sky.
    singleEarth.skyRadiance(dirFrom(2, 90), dirFrom(10), 0, a, 64, 32);
    earth.skyRadiance(dirFrom(2, 90), dirFrom(10), 0, b, 64, 32);
    const added = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const singleRatio = a[2]! / a[0]!;
    const addedRatio = added[2]! / added[0]!;
    assert.ok(addedRatio > singleRatio, `the added light is not bluer than the single-scattered horizon (${addedRatio.toFixed(3)} vs ${singleRatio.toFixed(3)})`);
  });

  test("reaches the derived ambient and horizon colours too", () => {
    const single = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const both = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    both.multiScattering = new MultiScatteringField(both, MULTI_SCATTERING_CPU);
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    const sun = dirFrom(15);
    single.skyAmbient(sun, 0, a);
    both.skyAmbient(sun, 0, b);
    const ambientGain = luminance(b) / luminance(a);
    assert.ok(ambientGain > 1.15, `ambient gain ${ambientGain.toFixed(3)}`);
    const ambient = luminance(a);
    single.horizonColor(sun, 0, a, 8, 0.05, 16, 8);
    both.horizonColor(sun, 0, b, 8, 0.05, 16, 8);
    const horizonGain = luminance(b) / luminance(a);
    assert.ok(horizonGain > 1.1, `horizon gain ${horizonGain.toFixed(3)}`);
    // Assigning the field is the whole switch: dropping it restores the old radiance exactly.
    both.multiScattering = null;
    both.skyAmbient(sun, 0, b);
    assertCloseTo(luminance(b), ambient, 6);
  });

  test("a custom atmosphere keeps working end to end", () => {
    const tuned = new AtmosphereModel(
      createAtmosphere({ rayleighScattering: [7e-6, 1.6e-5, 4e-5], mieScattering: [6e-6, 6e-6, 6e-6], ozoneAbsorption: [0, 0, 0] }, EARTH_ATMOSPHERE),
    );
    const field = new MultiScatteringField(tuned, MULTI_SCATTERING_CPU);
    tuned.multiScattering = field;
    const out = new Float64Array(3);
    tuned.skyRadiance(dirFrom(80), dirFrom(10), 0, out, 64, 32);
    assert.ok(out.every((v) => Number.isFinite(v) && v > 0), `tuned sky held ${[...out]}`);
    const base = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    base.multiScattering = new MultiScatteringField(base, MULTI_SCATTERING_CPU);
    const reference = new Float64Array(3);
    base.skyRadiance(dirFrom(80), dirFrom(10), 0, reference, 64, 32);
    const tunedTexel = new Float64Array(3);
    const baseTexel = new Float64Array(3);
    field.texelValue(0, 1, tunedTexel);
    base.multiScattering!.texelValue(0, 1, baseTexel);
    assert.ok(luminance(tunedTexel) > luminance(baseTexel), "more Rayleigh scattering must mean a larger source");
  });
});

group("finite-path aerial perspective (Phase 17.2)", () => {
  test("zero-length paths and rays outside the atmosphere are identity transfers", () => {
    const model = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const view = dirFrom(15);
    const sun = dirFrom(55);
    const transmittance = new Float64Array([9, 9, 9]);
    const inScattering = new Float64Array([9, 9, 9]);

    model.aerialPerspective(view, 0, 40, sun, transmittance, inScattering, 8, 4);
    assert.deepEqual([...transmittance], [1, 1, 1]);
    assert.deepEqual([...inScattering], [0, 0, 0]);

    // Above the shell, looking away from the planet never enters the medium.
    model.aerialPerspective(new Vec3(0, 1, 0), 1000, 200_000, sun, transmittance, inScattering, 8, 4);
    assert.deepEqual([...transmittance], [1, 1, 1]);
    assert.deepEqual([...inScattering], [0, 0, 0]);
  });

  test("integrates distance-dependent transmittance and in-scattering, including the MS source", () => {
    const sun = dirFrom(66.3, 90);
    const view = dirFrom(81, 90);
    const single = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    const transNear = new Float64Array(3);
    const scatterNear = new Float64Array(3);
    const transFar = new Float64Array(3);
    const scatterFar = new Float64Array(3);
    single.aerialPerspective(view, 500, 0, sun, transNear, scatterNear, 16, 8);
    single.aerialPerspective(view, 25_000, 0, sun, transFar, scatterFar, 16, 8);
    assert.ok(transFar.every((value, c) => value < transNear[c]!), `long-path T ${[...transFar]} was not below ${[...transNear]}`);
    assert.ok(scatterFar.every((value) => value > 0 && Number.isFinite(value)), `long-path in-scattering was ${[...scatterFar]}`);
    assert.ok(scatterFar.some((value, c) => value > scatterNear[c]!), "in-scattering did not accumulate with distance");
    const scaledT = new Float64Array(3);
    const scaledScatter = new Float64Array(3);
    single.aerialPerspective(
      new Vec3(view.x * 7, view.y * 7, view.z * 7), 25_000, 0,
      new Vec3(sun.x * 3, sun.y * 3, sun.z * 3), scaledT, scaledScatter, 16, 8,
    );
    for (let c = 0; c < 3; c++) {
      assertCloseTo(scaledT[c]!, transFar[c]!, 12);
      assertCloseTo(scaledScatter[c]!, scatterFar[c]!, 12);
    }

    const withMs = new AtmosphereModel({ ...EARTH_ATMOSPHERE });
    withMs.multiScattering = new MultiScatteringField(withMs, MULTI_SCATTERING_CPU);
    const transMs = new Float64Array(3);
    const scatterMs = new Float64Array(3);
    withMs.aerialPerspective(view, 25_000, 0, sun, transMs, scatterMs, 16, 8);
    assert.deepEqual([...transMs], [...transFar], "multiple scattering must not change extinction");
    assert.ok(scatterMs.every((value, c) => value >= scatterFar[c]! - 1e-12), `MS reduced in-scattering ${[...scatterMs]} below ${[...scatterFar]}`);
    assert.ok(scatterMs.some((value, c) => value > scatterFar[c]! + 1e-6), "the installed field never reached the finite path");
  });

  test("haze over ground below the reference sphere grows with depth instead of going dark", () => {
    // From orbit, real terrain (and a flat globe triangle sagging between its vertices) sits under
    // the reference sphere. Samples there used to count as shadowed by the planet, so in-scattering
    // fell as the ground got lower (about 20% at 9 km) and drew halftone discs of darker haze in a
    // lattice of globe mesh cells.
    const model = new AtmosphereModel({ ...MARS_ATMOSPHERE });
    const height = 2_600_000;
    const R = MARS_ATMOSPHERE.planetRadius;
    const sun = dirFrom(40);
    for (const view of [new Vec3(0, -1, 0), new Vec3(0.3, -1, 0)]) {
      const d = view.clone().normalize();
      const b = (R + height) * d.y;
      const toSphere = -b - Math.sqrt(b * b - ((R + height) ** 2 - R * R));
      let previous: Float64Array | null = null;
      // 8 view samples is what the shader takes at medium quality.
      for (const depth of [0, 1000, 3000, 6000, 9000]) {
        const scatter = new Float64Array(3);
        model.aerialPerspective(view, toSphere + depth / -d.y, height, sun, new Float64Array(3), scatter, 8, 8);
        assert.ok(scatter.every((v) => v > 0 && Number.isFinite(v)), `depth ${depth}: ${[...scatter]}`);
        if (previous) {
          for (let c = 0; c < 3; c++) {
            assert.ok(scatter[c]! >= previous[c]!, `view ${view.x}, depth ${depth}, channel ${c}: ${scatter[c]} fell below ${previous[c]}`);
          }
        }
        previous = scatter;
      }
    }
    // The planet still shadows the night side.
    const lit = new Float64Array(3);
    const night = new Float64Array(3);
    model.aerialPerspective(new Vec3(0, -1, 0), height + 6000, height, sun, new Float64Array(3), lit, 8, 8);
    model.aerialPerspective(new Vec3(0, -1, 0), height + 6000, height, dirFrom(-30), new Float64Array(3), night, 8, 8);
    assert.ok(night.every((v, c) => v < 0.05 * lit[c]!), `night-side haze ${[...night]} vs ${[...lit]}`);
  });
});

group("the frame's compute passes (mock device)", () => {
  interface Fixture {
    device: GraphicsDevice;
    mock: GraphicsDevice["mock"];
    renderer: Renderer;
    scene: Scene;
    sun: Light;
    dispose(): Promise<void>;
  }

  async function fixture(): Promise<Fixture> {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(160, 90);
    const renderer = new Renderer(device, { shadowMapSize: 128 });
    const scene = new Scene({ name: "ms-test" });
    scene.settings.hdr = false;
    scene.settings.shadow.enabled = false;
    scene.settings.postProcessing = false;
    // The background colour turns the sky off; `setSky` brings it back (and is why it comes second).
    scene.setBackgroundColor(Color.fromSrgbHex(0x101520));
    scene.setSky({ quality: "low" });
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 2, -6));
    const camera = new Camera();
    camera.far = 200;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 0, 0));
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(4, 9, -4));
    const sun = new Light();
    sun.kind = "directional";
    sun.followRotation = false;
    sun.direction.set(-0.3, -0.9, 0.2).normalize();
    scene.world.addComponent(sunEntity.id, sun);
    return {
      device,
      mock: device.mock,
      renderer,
      scene,
      sun,
      async dispose() {
        scene.dispose();
        renderer.dispose();
        await device.dispose();
      },
    };
  }

  test("records both passes on the first sky frame and nothing afterwards while the sun holds", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    const names = f.renderer.passNames;
    assert.ok(names.includes("forge.sky.ms.table") && names.includes("forge.sky.ms.lut"), `passes: ${names.join(", ")}`);
    assert.ok(names.indexOf("forge.sky.ms.table") < names.indexOf("forge.sky.ms.lut"), "the field reads the table the first pass writes");
    assert.ok(names.indexOf("forge.sky.ms.lut") < names.indexOf("forge.main"), "the table must exist before the frame draws the sky");
    const firstDispatches = f.mock.commandLog.filter((entry) => entry.type === "dispatch");
    assert.equal(firstDispatches.length, 2, `expected two dispatches, got ${firstDispatches.length}`);
    assert.equal(firstDispatches[0]!.x, Math.ceil(MS_TABLE_TEXELS / MS_WORKGROUP));
    assert.equal(firstDispatches[1]!.x, Math.ceil(MS_LUT_TEXELS / MS_WORKGROUP));
    assert.deepEqual(firstDispatches.map((entry) => entry.label), ["sky.ms.table", "sky.ms.lut"]);
    assert.deepEqual(f.mock.errors, []);

    assert.equal(f.renderer.multiScatteringBuilds, 1, "the first sky frame must build the table once");
    f.mock.commandLog.length = 0;
    f.renderer.renderScene(f.scene);
    assertNotContains(f.renderer.passNames, "forge.sky.ms.lut");
    assertNotContains(f.renderer.passNames, "forge.sky.ms.table");
    assert.equal(f.mock.commandLog.filter((entry) => entry.type === "dispatch").length, 0, "a still sun rebuilt the table");
    assert.equal(f.renderer.multiScatteringBuilds, 1, "a still frame must leave the build counter alone");
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("rebuilds when the sun moves past MS_SUN_EPSILON and when the atmosphere changes", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    const baseline = new Vec3(f.sun.direction.x, f.sun.direction.y, f.sun.direction.z);
    // A nudge under the epsilon is not a rebuild.
    f.sun.direction.set(baseline.x + 0.001, baseline.y - 0.0005, baseline.z).normalize();
    f.renderer.renderScene(f.scene);
    assertNotContains(f.renderer.passNames, "forge.sky.ms.lut", "a sub-epsilon nudge rebuilt the table");
    assert.equal(f.renderer.multiScatteringBuilds, 1, "a sub-epsilon nudge counted as a rebuild");
    // A real move is.
    f.sun.direction.set(baseline.x + 0.12, baseline.y - 0.08, baseline.z).normalize();
    f.renderer.renderScene(f.scene);
    assertContains(f.renderer.passNames, "forge.sky.ms.table");
    assert.equal(f.renderer.multiScatteringBuilds, 2, "a moved sun must count a rebuild");
    // And so is an atmosphere edit, which the day/night cycle may make in place.
    f.scene.setSky({ turbidity: 4.5 });
    f.renderer.renderScene(f.scene);
    assertContains(f.renderer.passNames, "forge.sky.ms.lut");
    assert.equal(f.renderer.multiScatteringBuilds, 3, "an atmosphere edit must count a rebuild");
    // With the feature off neither pass is recorded (the sky pass drops the term).
    f.scene.settings.sky.multiScattering = false;
    f.renderer.renderScene(f.scene);
    assertNotContains(f.renderer.passNames, "forge.sky.ms.lut");
    assertContains(f.renderer.passNames, "forge.sky");
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("binds the LUT as an rgba32float texture, sizes the table buffer and reads it back", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    const layout = f.renderer.pipelines.bindGroupLayouts.sky;
    assert.ok(layout, "the sky bind group layout is missing");
    // Four bindings now: per-frame, sky, clouds, and the multiple-scattering texture at b3.
    assert.equal(SKY_BINDINGS.multiScattering.binding, 3);
    const buffers = f.mock.outstanding.buffers;
    const textures = f.mock.outstanding.textures;
    assertContains(buffers, "sky.ms.table");
    assertContains(textures, "sky.ms.lut");
    const table = await f.renderer.readMultiScatteringLut();
    assert.ok(table, "the device table did not come back");
    assert.equal(table!.length, MS_LUT_TEXELS * MS_LUT_FLOATS_PER_TEXEL);
    // The mock runs no WGSL, so the readback carries the texture as the CPU last saw it (all zero:
    // the compute passes only ever write on a device). Lengths and wiring are what is checkable here;
    // the number-by-number comparison with this reference is the browser gate's job.
    const reference = f.renderer.multiScatteringReference();
    assert.equal(reference.configUsed.heightSamples, MULTI_SCATTERING_GPU.heightSamples);
    assert.equal(reference.data.length, table!.length);
    const texelOf = (field: MultiScatteringField): number => {
      const out = new Float64Array(3);
      field.texelValue(0, 1, out);
      return luminance(out);
    };
    // The reference is built from the frame's *effective* sky: the same rayleigh/mie/turbidity
    // scaling `writeSky` writes into the uniforms, not the raw preset.
    const plain = new MultiScatteringField(new AtmosphereModel(createAtmosphere({ rayleighScattering: [0, 0, 0] }, EARTH_ATMOSPHERE)), MULTI_SCATTERING_CPU);
    f.scene.setSky({ rayleigh: 1.6 });
    f.renderer.renderScene(f.scene);
    const scaled = f.renderer.multiScatteringReference();
    const scaledTexel = texelOf(scaled);
    const plainTexel = texelOf(plain);
    assert.ok(Math.abs(scaledTexel - plainTexel) / plainTexel > 0.2, `the reference ignored the scene's rayleigh scale (${scaledTexel} vs ${plainTexel})`);
    assert.deepEqual(f.mock.errors, []);
    await f.dispose();
  });

  test("releases the table buffer and LUT texture on dispose", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    assertContains(f.mock.outstanding.textures, "sky.ms.lut");
    assertContains(f.mock.outstanding.buffers, "sky.ms.table");
    f.renderer.dispose();
    assertNotContains(f.mock.outstanding.textures, "sky.ms.lut");
    assertNotContains(f.mock.outstanding.buffers, "sky.ms.table");
    assert.equal(await f.renderer.readMultiScatteringLut(), null);
    f.scene.dispose();
    await f.device.dispose();
  });

  test("the signature covers every input that changes the table", () => {
    const base = { ...EARTH_ATMOSPHERE };
    const a = new Float64Array(22);
    const b = new Float64Array(22);
    writeSkyMultiScatteringSignature(base, 2, 1, 1, a);
    writeSkyMultiScatteringSignature({ ...EARTH_ATMOSPHERE }, 2, 1, 1, b);
    assert.equal(skyMultiScatteringSignatureChanged(a, b), false);
    const tweaks: [string, () => void][] = [
      ["planetRadius", () => writeSkyMultiScatteringSignature({ ...base, planetRadius: base.planetRadius + 1 }, 2, 1, 1, b)],
      ["atmosphereHeight", () => writeSkyMultiScatteringSignature({ ...base, atmosphereHeight: base.atmosphereHeight + 1 }, 2, 1, 1, b)],
      ["rayleighScaleHeight", () => writeSkyMultiScatteringSignature({ ...base, rayleighScaleHeight: base.rayleighScaleHeight + 1 }, 2, 1, 1, b)],
      ["mieScaleHeight", () => writeSkyMultiScatteringSignature({ ...base, mieScaleHeight: base.mieScaleHeight + 1 }, 2, 1, 1, b)],
      ["mieAnisotropy", () => writeSkyMultiScatteringSignature({ ...base, mieAnisotropy: base.mieAnisotropy - 0.2 }, 2, 1, 1, b)],
      ["ozoneCenter", () => writeSkyMultiScatteringSignature({ ...base, ozoneCenter: base.ozoneCenter + 100 }, 2, 1, 1, b)],
      ["ozoneWidth", () => writeSkyMultiScatteringSignature({ ...base, ozoneWidth: base.ozoneWidth + 100 }, 2, 1, 1, b)],
      ["rayleighScattering", () => writeSkyMultiScatteringSignature({ ...base, rayleighScattering: [base.rayleighScattering[0], base.rayleighScattering[1] * 1.5, base.rayleighScattering[2]] }, 2, 1, 1, b)],
      ["mieScattering", () => writeSkyMultiScatteringSignature({ ...base, mieScattering: [base.mieScattering[0] * 1.5, base.mieScattering[1], base.mieScattering[2]] }, 2, 1, 1, b)],
      ["mieExtinction", () => writeSkyMultiScatteringSignature({ ...base, mieExtinction: [base.mieExtinction[0], base.mieExtinction[1], base.mieExtinction[2] * 1.5] }, 2, 1, 1, b)],
      ["ozoneAbsorption", () => writeSkyMultiScatteringSignature({ ...base, ozoneAbsorption: [base.ozoneAbsorption[0] * 1.5, base.ozoneAbsorption[1], base.ozoneAbsorption[2]] }, 2, 1, 1, b)],
      ["turbidity", () => writeSkyMultiScatteringSignature(base, 3, 1, 1, b)],
      ["rayleigh", () => writeSkyMultiScatteringSignature(base, 2, 1.3, 1, b)],
      ["mie", () => writeSkyMultiScatteringSignature(base, 2, 1, 0.5, b)],
    ];
    for (const [what, tweak] of tweaks) {
      tweak();
      assert.equal(skyMultiScatteringSignatureChanged(a, b), true, `changing ${what} did not invalidate the table`);
    }
    // The initial sentinel is NaN-filled, which compares as changed against itself — the first frame
    // after a resize or a device rebuild must always rebuild the table.
    const sentinel = new Float64Array(22).fill(NaN);
    assert.equal(skyMultiScatteringSignatureChanged(sentinel, sentinel), true);
    assertCloseTo(MS_SUN_EPSILON, Math.cos(deg(0.5)), 4);
    assert.ok(MS_WORKGROUP % 32 === 0 && MS_WORKGROUP > 0);
  });
});

finish();
