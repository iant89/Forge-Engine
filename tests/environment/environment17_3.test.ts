/**
 * @suite environment:environment17_3
 * @group unit
 * @covers engine/src/environment/clouds.ts
 * @covers engine/src/index.ts
 * @covers engine/src/rendering/pipeline.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/shaders/cloudLayer.ts
 * @covers engine/src/rendering/shaders/sky.ts
 * @covers engine/src/rendering/shaders/standard.ts
 * @covers engine/src/rendering/shaders/water.ts
 * @covers engine/src/rendering/uniforms.ts
 * @covers engine/src/scene/scene.ts
 * @covers tools/browser-check.mjs
 * @desc Environment (Phase 17.3): the multi-layer cloud deck, the shadow it casts and its octave LOD fade
 */

export const suite = {
  name: "environment:environment17_3",
  group: "unit",
  covers: [
    "engine/src/environment/clouds.ts",
    "engine/src/index.ts",
    "engine/src/rendering/pipeline.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/shaders/cloudLayer.ts",
    "engine/src/rendering/shaders/sky.ts",
    "engine/src/rendering/shaders/standard.ts",
    "engine/src/rendering/shaders/water.ts",
    "engine/src/rendering/uniforms.ts",
    "engine/src/scene/scene.ts",
    "tools/browser-check.mjs",
  ],
  desc: "Environment (Phase 17.3): the multi-layer cloud deck, the shadow it casts and its octave LOD fade",
};

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, finish, group, test } from "selrun";
import {
  Camera,
  type CloudShading,
  CLOUD_EXTINCTION,
  CLOUD_SHADOW_REFERENCE_STEPS,
  CLOUD_SHADOW_STEPS,
  Color,
  GraphicsDevice,
  Light,
  MAX_CLOUD_LAYERS,
  Material,
  RENDERING_STRUCTS,
  Renderable,
  Renderer,
  SKY_SHADER,
  Scene,
  STANDARD_FRAGMENT_BODY,
  Vec3,
  WATER_SHADER,
  cloudAlpha,
  cloudDeckColumnAt,
  cloudDeckRadiance,
  cloudDeckShadowTau,
  cloudDeckTransmittance,
  cloudDensityAt,
  cloudFieldAt,
  cloudFootprintAt,
  cloudLayerCentre,
  cloudLayerCount,
  cloudLayerDensityAt,
  cloudLayerDrift,
  cloudLayerScale,
  cloudLayerThickness,
  cloudLayerWeight,
  cloudOctaveFade,
  cloudOctaveWeight,
  createBox,
  defaultCloudDeckParams,
  meanCloudDensity,
  WGSL_CLOUD,
} from "@forge/engine";

/** The deck the phase's numbers were measured on: the scene defaults with a real cover. */
const deckDefaults = () => ({ ...defaultCloudDeckParams(), coverage: 0.6, density: 0.8 });

const cloudShading = (): CloudShading => ({
  sunTint: new Float64Array([1, 1, 1]),
  ambientTint: new Float64Array([0.2, 0.2, 0.2]),
  albedo: new Color(1, 1, 1),
  silverLining: 0.8,
});

group("the sub-layer stack (multi-layer clouds)", () => {
  test("clamps the layer count and spaces the sheets evenly through the slab", () => {
    const deck = defaultCloudDeckParams();
    assert.equal(cloudLayerCount({ ...deck, layers: 0 }), 1);
    assert.equal(cloudLayerCount({ ...deck, layers: 1 }), 1);
    assert.equal(cloudLayerCount({ ...deck, layers: 2.6 }), 3);
    assert.equal(cloudLayerCount({ ...deck, layers: 5 }), MAX_CLOUD_LAYERS);
    assert.equal(cloudLayerCount({ ...deck, layers: 9 }), MAX_CLOUD_LAYERS);

    const n3 = { ...deck, layers: 3 };
    assertCloseTo(cloudLayerThickness(n3), 400 / 3, 9);
    assertCloseTo(cloudLayerCentre(n3, 0), 1366.6666667, 6);
    assertCloseTo(cloudLayerCentre(n3, 1), 1500, 9);
    assertCloseTo(cloudLayerCentre(n3, 2), 1633.3333333, 6);
    // Evenly spaced, symmetric about the slab's centre, and inside the slab at every count.
    for (const layers of [1, 2, 3, 4]) {
      const d = { ...deck, layers };
      const centres = Array.from({ length: layers }, (_, i) => cloudLayerCentre(d, i));
      for (let i = 1; i < layers; i++) assertCloseTo(centres[i]! - centres[i - 1]!, cloudLayerThickness(d), 9);
      assertCloseTo(centres[0]! + centres[layers - 1]!, 2 * d.height, 6);
      assert.ok(centres[0]! > d.height - d.thickness / 2);
      assert.ok(centres[layers - 1]! < d.height + d.thickness / 2);
      if (layers > 1) {
        // A thicker slab spreads the same count further from the centre (the knob the HUD shows).
        const offset = (thickness: number): number => d.height - cloudLayerCentre({ ...d, thickness }, 0);
        assertCloseTo(offset(d.thickness * 2), offset(d.thickness) * 2, 9);
      }
    }
  });

  test("weights the column as a bell summing to one, so a uniform deck keeps the 8b column", () => {
    const deck = defaultCloudDeckParams();
    for (const layers of [1, 2, 3, 4]) {
      const d = { ...deck, layers };
      const weights = Array.from({ length: layers }, (_, i) => cloudLayerWeight(d, i));
      assertCloseTo(weights.reduce((a, b) => a + b, 0), 1, 12);
      for (const w of weights) assert.ok(w > 0 && w <= 1);
      if (layers >= 3) {
        // Bell: the middle sheets carry more of the column than the edges, symmetrically.
        assert.ok(weights[1]! > weights[0]!);
        assertCloseTo(weights[0]!, weights[layers - 1]!, 12);
      }
    }
    assertCloseTo(cloudLayerWeight({ ...deck, layers: 3 }, 0), 0.303921569, 6);
    assertCloseTo(cloudLayerWeight({ ...deck, layers: 3 }, 1), 0.392156863, 6);

    // The property the 8b statistics ride on: a uniform (coverage 1) deck's column density is
    // exactly `density` at any layer count, so splitting the plane did not change the cover.
    for (const layers of [1, 2, 3, 4]) {
      const d = { ...deck, layers, coverage: 1, density: 0.8 };
      for (const [x, z] of [[0, 0], [12345, -6789]] as const) assertCloseTo(cloudDeckColumnAt(x, z, d, 0), 0.8, 12);
    }
    // One sheet at t = 0 *is* the Phase 8b plane, exactly — the reference the 8b suite pins.
    const one = { ...deck, layers: 1 };
    for (const [x, z] of [[0, 0], [4321, 8765], [-18000, 9000]] as const) {
      const plane = cloudDensityAt(x, z, one.coverage, one.density, one.scale, one.seed);
      assertCloseTo(cloudDeckColumnAt(x, z, one, 0), plane, 12);
    }
  });

  test("tracks the 8b coverage statistics: the mean column follows the slider", () => {
    const deck = defaultCloudDeckParams();
    const gridMean = (coverage: number): number => {
      const samples = 24;
      const extent = 20000;
      let sum = 0;
      for (let iz = 0; iz < samples; iz++) {
        for (let ix = 0; ix < samples; ix++) {
          const x = (ix + 0.5 - samples / 2) * (extent / samples);
          const z = (iz + 0.5 - samples / 2) * (extent / samples);
          sum += cloudDeckColumnAt(x, z, { ...deck, coverage }, 0);
        }
      }
      return sum / (samples * samples);
    };
    assert.equal(gridMean(0), 0);
    let prior = 0;
    for (const coverage of [0.25, 0.5, 0.75, 1]) {
      const mean = gridMean(coverage);
      assert.ok(mean > prior, `coverage ${coverage} did not raise the mean column`);
      prior = mean;
    }
    assertCloseTo(gridMean(1), deck.density, 12);
    for (const coverage of [0.25, 0.5, 0.75]) {
      const reference = meanCloudDensity(coverage, deck.density, deck.scale, deck.seed, 24, 20000);
      const ratio = gridMean(coverage) / reference;
      assert.ok(ratio > 0.9 && ratio < 1.1, `coverage ${coverage}: the layered mean is ${ratio.toFixed(3)}× the 8b mean`);
    }
  });

  test("fans the sheets' scale and drift, with the column's mean advection on the wind", () => {
    const deck = { ...defaultCloudDeckParams(), layers: 3, layerScale: 0.9, layerDrift: 0.35, windX: 2, windZ: 1, coverage: 0.8 };
    for (let i = 0; i < 3; i++) assertCloseTo(cloudLayerScale(deck, i), deck.scale * 0.9 ** i, 12);
    const drifts = [0, 1, 2].map((i) => cloudLayerDrift(deck, i, 60));
    assertCloseTo(drifts[1]!.x, 120, 9);
    assertCloseTo(drifts[1]!.z, 60, 9);
    assertCloseTo(drifts[0]!.x, 106, 9);
    assertCloseTo(drifts[2]!.x, 134, 9);
    assertCloseTo(drifts[0]!.x + drifts[2]!.x, 2 * drifts[1]!.x, 9);
    for (let i = 1; i < 3; i++) {
      assert.ok(drifts[i]!.x > drifts[i - 1]!.x);
      assert.ok(drifts[i]!.z > drifts[i - 1]!.z);
    }
    for (let i = 0; i < 3; i++) {
      assert.equal(cloudLayerDrift(deck, i, 0).x, 0);
      assert.equal(cloudLayerDrift(deck, i, 0).z, 0);
    }
    // A sheet's sample is the 8b field advected by its own drift, on its own scale and seed —
    // which is what makes the upper sheets slide through the lower ones instead of in lockstep.
    for (let i = 0; i < 3; i++) {
      const drift = cloudLayerDrift(deck, i, 600);
      const expected = cloudDensityAt(drift.x, drift.z, deck.coverage, deck.density, cloudLayerScale(deck, i), (deck.seed + i) | 0);
      assertCloseTo(cloudLayerDensityAt(0, 0, deck, i, 600), expected, 12);
    }
  });
});

group("the octave LOD fade (temporal stability)", () => {
  test("thins the octave series with the sampling footprint and flattens at the horizon", () => {
    // No footprint: nothing fades, the 4-octave field is intact.
    assert.equal(cloudOctaveWeight(0, 0), 1);
    assert.equal(cloudOctaveWeight(3, 0), 1);
    // The fade window is the Nyquist band: an octave dies at one footprint, survives past three.
    assertCloseTo(cloudOctaveWeight(0, 0.5), 0.5, 9);
    assertCloseTo(cloudOctaveWeight(0, 1), 0, 12);
    assertCloseTo(cloudOctaveWeight(0, 1 / 3), 1, 9);
    assert.equal(cloudOctaveWeight(1, 0.5), 0);
    assertCloseTo(cloudOctaveWeight(0, 0.9), 0.0089, 4);
    // Finer octaves die first at any footprint, and every octave is monotone in the footprint.
    for (const footprint of [0.2, 0.4, 0.8, 1.6]) {
      for (let i = 1; i < 4; i++) assert.ok(cloudOctaveWeight(i, footprint) <= cloudOctaveWeight(i - 1, footprint));
    }
    // The world-metre wrapper is the noise-unit weight of `footprint · scale`.
    assertCloseTo(cloudOctaveFade(0, 0.0008, 1125), cloudOctaveWeight(0, 0.9), 12);
    assertCloseTo(cloudOctaveFade(0, 0.0008, 300), 1, 9);

    // Once every octave has faded the field is its own mean, exactly: a grazing pixel cannot
    // resolve a different sample than its neighbour, which is the frame-to-frame shimmer the fade
    // removes. (Sampling flat 0.5 leaves the coverage remap as the only variation left.)
    for (let i = 0; i < 64; i++) assert.equal(cloudFieldAt(i * 137.7, -i * 91.3, 0.0008, 4242, 3000), 0.5);
    // ...and the series really does thin before it flattens: a 700 m pixel loses the fine octaves.
    const spread = (footprint: number): number => {
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let i = 0; i < 16; i++) {
        for (let j = 0; j < 16; j++) {
          const v = cloudFieldAt(i * 811.3 - 6000, j * -577.1 + 4000, 0.0008, 4242, footprint);
          sum += v;
          sumSq += v * v;
          n++;
        }
      }
      return sumSq / n - (sum / n) ** 2;
    };
    assert.ok(spread(700) < spread(0) * 0.7);
    assert.equal(spread(3000), 0);
  });

  test("the analytic footprint matches the deck's geometry (the dpdx twin)", () => {
    // A 1.5 km deck seen from sea level: the horizon case is kilometres per pixel, the zenith a few.
    assertCloseTo(cloudFootprintAt(1500, 0, 0.02, 0.0016), 6000.8, 0);
    const grazing = cloudFootprintAt(1500, 0, 0.02, 0.0016);
    const steep = cloudFootprintAt(1500, 0, 1, 0.0016);
    assert.ok(grazing > steep * 1000);
    assertCloseTo(steep, 0.0016 * (1500 / Math.sin(1)) * (1 / Math.sin(1)), 6);
    // It grows monotonically as the ray approaches the horizon...
    let prior = cloudFootprintAt(1500, 0, 1, 0.0016);
    for (const elevation of [0.5, 0.2, 0.1, 0.05, 0.02]) {
      const footprint = cloudFootprintAt(1500, 0, elevation, 0.0016);
      assert.ok(footprint > prior);
      prior = footprint;
    }
    // ...and there is no footprint at all above the deck or below the horizon (the shader's guards).
    assert.equal(cloudFootprintAt(1500, 2000, 0.3, 0.0016), 0);
    assert.equal(cloudFootprintAt(1500, 1500, 0.3, 0.0016), 0);
  });

  test("reduces the sample-to-sample change a grazing ray sees (the aliasing it exists for)", () => {
    const deck = { ...defaultCloudDeckParams(), layers: 3, coverage: 0.6 };
    const pixel = 0.0016; // radians per pixel — the gate camera's own angle
    const meanDelta = (elevation: number, faded: boolean): number => {
      const footprint = faded ? cloudFootprintAt(deck.height, 0, elevation, pixel) : 0;
      const columnAt = (azimuth: number): number => {
        const dir = new Vec3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
        const t = deck.height / dir.y;
        return cloudDeckColumnAt(dir.x * t, dir.z * t, deck, 0, footprint);
      };
      let sum = 0;
      for (let a = 0; a < 500; a++) sum += Math.abs(columnAt((a / 500) * Math.PI * 2) - columnAt(((a + 1) / 500) * Math.PI * 2));
      return sum / 500;
    };
    const grazingRaw = meanDelta(0.02, false);
    const grazing = meanDelta(0.02, true);
    const lowRaw = meanDelta(0.05, false);
    const low = meanDelta(0.05, true);
    const steep = meanDelta(0.2, true);
    // At 1.1° one pixel covers 6 km of deck: unfaded the field changes by a third of its range per
    // pixel; faded it is flat.
    assert.ok(grazingRaw > 0.1, `unfaded grazing delta ${grazingRaw}`);
    assert.ok(grazing <= grazingRaw * 0.1, `grazing fade only reached ${grazing} of ${grazingRaw}`);
    assert.ok(low <= lowRaw * 0.35, `2.9° fade only reached ${low} of ${lowRaw}`);
    // Where the deck *can* resolve its octaves the fade stays out of the way — it is a Nyquist cut,
    // not a blur.
    assert.ok(steep <= meanDelta(0.2, false) * 1.05);
    assert.ok(Math.max(grazing, low) < Math.max(grazingRaw, lowRaw) * 0.3);
  });
});

group("the sun-path shadow (better shadowing)", () => {
  test("marches the stack accurately at the device's step count", () => {
    const deck = { ...deckDefaults(), layers: 3 };
    const sun = new Vec3(0.4, 0.7, 0.2).normalize();
    let worst = 0;
    for (let i = 0; i < 64; i++) {
      const x = (i - 32) * 613.7;
      const z = (i - 32) * -241.3;
      const device = cloudDeckShadowTau(x, z, 0, sun, deck, 0, 0, CLOUD_SHADOW_STEPS);
      const reference = cloudDeckShadowTau(x, z, 0, sun, deck, 0, 0, CLOUD_SHADOW_REFERENCE_STEPS);
      if (reference > 1e-3) worst = Math.max(worst, Math.abs(device - reference) / reference);
    }
    assert.ok(worst < 0.01, `the ${CLOUD_SHADOW_STEPS}-step device march is ${(worst * 100).toFixed(2)}% off the dense reference`);

    // The march's own guards and shape.
    assert.equal(cloudDeckShadowTau(0, 0, 0, new Vec3(1, 0.01, 0).normalize(), deck, 0), 0, "a sun on the horizon casts nothing");
    assert.equal(cloudDeckShadowTau(0, 0, 0, sun, { ...deck, coverage: 0 }, 0), 0, "a clear deck casts nothing");
    assert.equal(cloudDeckShadowTau(0, 0, 0, sun, { ...deck, density: 0 }, 0), 0, "a weightless deck casts nothing");
    let lowSum = 0;
    let highSum = 0;
    for (let i = 0; i < 32; i++) {
      const x = (i - 16) * 700;
      const z = (i - 16) * 300;
      lowSum += cloudDeckShadowTau(x, z, 0, new Vec3(0.4, 0.2, 0.2).normalize(), deck, 0);
      highSum += cloudDeckShadowTau(x, z, 0, new Vec3(0.4, 0.95, 0.2).normalize(), deck, 0);
    }
    assert.ok(lowSum / 32 > (highSum / 32) * 1.5, "a low sun should look through more deck, not less");
    // A point inside the stack looks up through less of it than the ground does.
    assert.ok(cloudDeckShadowTau(0, 0, deck.height, sun, deck, 0) < cloudDeckShadowTau(0, 0, 0, sun, deck, 0));
  });

  test("gates the shadow on the knobs and darkens the scene as the cover rises", () => {
    const deck = { ...deckDefaults(), layers: 3, coverage: 0.75 };
    const sun = new Vec3(0.3, 0.6, 0.2).normalize();
    assert.equal(cloudDeckTransmittance(0, 0, 0, sun, { ...deck, surfaceShadows: false }, 0), 1);
    assert.equal(cloudDeckTransmittance(0, 0, 0, sun, { ...deck, shadowStrength: 0 }, 0), 1);
    assert.equal(cloudDeckTransmittance(0, 0, 0, new Vec3(1, 0.01, 0).normalize(), deck, 0), 1, "night has no deck shadow");
    assert.equal(cloudDeckTransmittance(0, 0, 0, sun, { ...deck, coverage: 0 }, 0), 1);

    const meanTransmittance = (coverage: number): number => {
      let sum = 0;
      for (let i = 0; i < 32; i++) {
        for (let j = 0; j < 8; j++) sum += cloudDeckTransmittance((i - 16) * 700, (j - 4) * 300, 0, sun, { ...deck, coverage }, 0);
      }
      return sum / 256;
    };
    const ladder = [0, 0.25, 0.5, 0.75, 1].map(meanTransmittance);
    for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i]! < ladder[i - 1]!, "more cover must mean less sun");
    assertCloseTo(ladder[0]!, 1, 9);
    assert.ok(ladder[1]! > 0.9);
    assert.ok(ladder[4]! < 0.15);
    // A denser deck shields harder than the same cover thinned out.
    const thick = cloudDeckTransmittance(0, 0, 0, sun, { ...deck, coverage: 0.75 }, 0);
    const thin = cloudDeckTransmittance(0, 0, 0, sun, { ...deck, coverage: 0.75, density: 0.2 }, 0);
    assert.ok(thick < thin);
  });
});

group("the composite deck", () => {
  test("keeps the 8b law for one plane and builds the sheets' shading above it", () => {
    const shading = cloudShading();
    const sun = new Vec3(0.3, 0.8, 0.2).normalize();
    const up = new Vec3(0, 1, 0);
    const out = new Float64Array(3);
    const alphas: number[] = [];
    const reds: number[] = [];
    for (const layers of [1, 2, 3, 4]) {
      const deck = { ...defaultCloudDeckParams(), layers, coverage: 1, density: 0.6 };
      alphas.push(cloudDeckRadiance(up, sun, deck, shading, 0, 0, out));
      reds.push(out[0]!);
    }
    // A uniform stack's opacity is the 8b curve at any layer count (the weights sum to one)...
    for (const alpha of alphas) assertCloseTo(alpha, cloudAlpha(0.6, 1), 9);
    assertCloseTo(alphas[0]!, 1 - Math.exp(-CLOUD_EXTINCTION * 0.6), 9);
    // ...while every extra sheet the ray crosses adds its own lit contribution: the deck is a
    // volume, not a plate — more sheets at the same column means a brighter, structured deck.
    for (let i = 1; i < reds.length; i++) {
      assert.ok(reds[i]! > reds[i - 1]!, `layer ${i + 1} did not add to the composite (${reds[i]} vs ${reds[i - 1]})`);
    }
    assertCloseTo(reds[0]!, 0.637705, 5);
    assertCloseTo(reds[3]!, 0.790813, 5);

    // Clear skies and rays under the horizon's fade floor write nothing at all.
    assert.equal(cloudDeckRadiance(up, sun, { ...defaultCloudDeckParams(), coverage: 0 }, shading, 0, 0, out), 0);
    assert.equal(out[0], 0);
    assert.equal(cloudDeckRadiance(new Vec3(0, 0.004, 1).normalize(), sun, { ...defaultCloudDeckParams(), coverage: 1 }, shading, 0, 0, out), 0);
  });
});

group("the deck's GPU contract", () => {
  test("hands the shader the sheets through the uniform record it reads", () => {
    const layers = RENDERING_STRUCTS.CloudUniforms.offsetOf("layers") / 4;
    assert.equal(layers, 36, "layers is the 128-byte tail of the 208-byte block (fe-34 v3 flash fields)");
    // The WGSL twin's own loop and its guards; the strict validator in rendering:wgsl compiles it.
    assertContains(SKY_SHADER, "let deckFootprint = cloudDeckFootprint(dir)");
    const sources = [STANDARD_FRAGMENT_BODY, WATER_SHADER, SKY_SHADER];
    for (const source of sources) {
      assertContains(source, "cloudDeckShadowTau");
      assertContains(source, "CLOUD_DETAIL_FADE_NEAR");
      // The fade must not renormalise itself away: the divisor counts faded octaves at their
      // unfaded amplitude, which is what makes a faded octave actually thinner (and steadier).
      assertContains(source, "norm += amp;");
    }
    // Surfaces take the deck's shadow from their own footprint, sampled at the entry point's first
    // statement so the derivative stays in uniform control flow (Tint rejects it otherwise).
    assertContains(STANDARD_FRAGMENT_BODY, "let cloudFootprint = cloudSurfaceFootprint(in.worldPos);");
    assertContains(STANDARD_FRAGMENT_BODY, "cloudSunVisibility(in.worldPos, cloudFootprint)");
    assertContains(STANDARD_FRAGMENT_BODY, "power = power * s.cloudSun;");
    assertContains(WATER_SHADER, "let sunVisibility = cloudSunVisibility");
  });

  test("uploads the sheet records every frame, advected by the frame clock", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(160, 90);
    const mock = device.mock;
    const renderer = new Renderer(device, { shadowMapSize: 128 });
    const scene = new Scene({ name: "cloud-layers" });
    scene.settings.postProcessing = false;
    const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 40, -120));
    const camera = new Camera();
    camera.far = 800;
    scene.world.addComponent(cameraEntity.id, camera);
    cameraEntity.transform.lookAt(new Vec3(0, 60, 0));
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(20, 60, -30));
    const sun = new Light();
    sun.kind = "directional";
    scene.world.addComponent(sunEntity.id, sun);
    sunEntity.transform.lookAt(new Vec3(0, 0, 0));
    const box = scene.createTransformedEntity("box", new Vec3(0, 20, 0));
    const renderable = new Renderable();
    renderable.geometry = createBox(device, { width: 20, height: 20, depth: 20 });
    renderable.material = new Material({ label: "box", color: 0xffffff });
    scene.world.addComponent(box.id, renderable);
    scene.setClouds({
      coverage: 0.8,
      density: 0.8,
      height: 1500,
      thickness: 400,
      layers: 3,
      layerScale: 0.9,
      layerDrift: 0.35,
      windX: 2,
      windZ: 1,
      shadowSteps: 3,
      surfaceShadows: true,
      shadowStrength: 1,
    });

    renderer.renderScene(scene);
    assert.deepEqual(mock.errors, []);
    assert.equal(renderer.stats.clouds, true);
    const buffer = [...mock.liveBuffers].find((candidate) => candidate.label === "cloud.uniforms");
    assert.ok(buffer, "the renderer did not allocate the cloud uniform buffer");

    const deck = scene.settings.clouds;
    const base = RENDERING_STRUCTS.CloudUniforms.offsetOf("layers") / 4;
    const words = buffer.float32View();
    assert.equal(words[RENDERING_STRUCTS.CloudUniforms.offsetOf("layerCount") / 4], cloudLayerCount(deck));
    assert.equal(words[RENDERING_STRUCTS.CloudUniforms.offsetOf("surfaceShadows") / 4], 1);
    for (let i = 0; i < cloudLayerCount(deck); i++) {
      // No frame context: the clock reads zero, so the sheets sit at their centred drift.
      assert.equal(words[base + i * 4], 0);
      assert.equal(words[base + i * 4 + 1], 0);
      assertCloseTo(words[base + i * 4 + 2]!, cloudLayerCentre(deck, i), 4);
      assertCloseTo(words[base + i * 4 + 3]!, cloudLayerWeight(deck, i), 5);
    }

    // A frame 60 s later carries the advected offsets — the CPU owns the sheets' geometry, so the
    // shader cannot disagree about where they are.
    renderer.renderScene(scene, { elapsed: 60 } as never);
    const later = buffer.float32View();
    for (let i = 0; i < cloudLayerCount(deck); i++) {
      const drift = cloudLayerDrift(deck, i, 60);
      assertCloseTo(later[base + i * 4]!, drift.x, 3);
      assertCloseTo(later[base + i * 4 + 1]!, drift.z, 3);
    }

    scene.dispose();
    renderer.dispose();
    await device.dispose();
    assert.deepEqual(mock.outstanding.buffers, []);
    assert.deepEqual(mock.outstanding.textures, []);
  });
});

group("the GPU noise lattice hash (iOS overcast static)", () => {
  // CPU port of WGSL_CLOUD's latticeHash, u32 arithmetic via Math.imul / >>> 0.
  const latticeHash = (x: number, y: number, seed: number): number => {
    let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(seed >>> 0, 0xcb1ab31f)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h >>> 8) / 16777216;
  };
  const f32Bits = (v: number): number => new Uint32Array(new Float32Array([v]).buffer)[0]!;

  test("no shipped GPU noise uses the sine hash, and every caller goes through latticeHash", () => {
    for (const [name, src] of [["WGSL_CLOUD", WGSL_CLOUD], ["STANDARD_FRAGMENT_BODY", STANDARD_FRAGMENT_BODY], ["WATER_SHADER", WATER_SHADER], ["SKY_SHADER", SKY_SHADER]] as const) {
      const code = src.replace(/\/\/.*$/gm, ""); // comments may quote the old hash
      assert.ok(!/fract\(\s*sin\(/.test(code), `${name} still hashes with fract(sin(...))`);
    }
    assertContains(WGSL_CLOUD, "fn latticeHash(p: vec2<f32>, seed: u32) -> f32");
    assertContains(WGSL_CLOUD, "return latticeHash(p, bitcast<u32>(seed));");
    assertContains(STANDARD_FRAGMENT_BODY, "return latticeHash(p, 0x5317u);");
    assertContains(WATER_SHADER, "return latticeHash(p, 0x7a7eu);");
  });

  test("the sine hash it replaced turns one float32 step of its argument into a different value", () => {
    // What a reassociating / approximating compiler (Metal under WebKit's fast math) can do to h:
    // at the deck's default seed h ≈ 7.3e4, where one f32 step is ~0.0078 and ×43758 makes it ~340.
    const sineHash = (h: number): number => { const v = Math.sin(h) * 43758.5453123; return v - Math.floor(v); };
    let jumps = 0;
    for (let i = 0; i < 200; i++) {
      const h = Math.fround(127.1 * i + 311.7 * (i % 7) + 4242 * 17.13);
      const next = new Float32Array(new Uint32Array([f32Bits(h) + 1]).buffer)[0]!;
      if (Math.abs(sineHash(next) - sineHash(h)) > 0.1) jumps++;
    }
    assert.ok(jumps > 150, `one ulp moved the sine hash by > 0.1 in only ${jumps}/200 cells`);
  });

  test("latticeHash is a pure function of the integer cell and the seed bits, spread over [0, 1)", () => {
    const seed = f32Bits(4242);
    const bins = new Array<number>(16).fill(0);
    let n = 0;
    for (let y = -64; y < 64; y++) {
      for (let x = -64; x < 64; x++) {
        const v = latticeHash(x, y, seed);
        assert.ok(v >= 0 && v < 1);
        bins[Math.floor(v * 16)]!++;
        n++;
      }
    }
    for (const b of bins) assert.ok(Math.abs(b - n / 16) < (n / 16) * 0.15, `bin ${b} vs ${n / 16}`);
    // Neighbouring cells, seeds and far cells (a deck seen near the horizon) stay distinct.
    assert.notEqual(latticeHash(10, 20, seed), latticeHash(11, 20, seed));
    assert.notEqual(latticeHash(10, 20, seed), latticeHash(10, 20, f32Bits(4243)));
    assert.equal(latticeHash(-240000, 180000, seed), latticeHash(-240000, 180000, seed));
  });
});

await finish();
