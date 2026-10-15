/**
 * @suite environment:environment17_5
 * @group unit
 * @covers engine/src/environment/water.ts
 * @covers engine/src/environment/ocean.ts
 * @covers engine/src/rendering/pipeline.ts
 * @covers engine/src/rendering/renderer.ts
 * @covers engine/src/rendering/shaders/water.ts
 * @covers engine/src/rendering/uniforms.ts
 * @covers engine/src/scene/scene.ts
 * @desc Environment (Phase 17.5): screen-space water — refraction, depth absorption, contact foam and SSR passes
 */

export const suite = {
  name: "environment:environment17_5",
  group: "unit",
  covers: [
    "engine/src/environment/water.ts",
    "engine/src/environment/ocean.ts",
    "engine/src/rendering/pipeline.ts",
    "engine/src/rendering/renderer.ts",
    "engine/src/rendering/shaders/water.ts",
    "engine/src/rendering/uniforms.ts",
    "engine/src/scene/scene.ts",
  ],
  desc: "Environment (Phase 17.5): screen-space water — refraction, depth absorption, contact foam and SSR passes",
};

import assert from "node:assert/strict";
import { assertCloseTo, assertContains, assertNotContains, finish, group, test } from "selrun";
import {
  AABB,
  Camera,
  Geometry,
  GraphicsDevice,
  Light,
  Material,
  RENDERING_STRUCTS,
  Renderable,
  Renderer,
  Scene,
  Vec3,
  WATER_BINDINGS,
  WATER_GRAB_SHADER,
  WATER_SHADER,
  WaterSurface,
  createBox,
  intersectionFoam,
  waterGridSource,
  waterScreenSpaceForTier,
  waterTransmittance,
} from "@forge/engine";

async function fixture(cameraY = 6) {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(320, 180);
  const mock = device.mock;
  const renderer = new Renderer(device, { shadowMapSize: 256 });
  const scene = new Scene({ name: "ss-water" });
  scene.settings.shadow.mapSize = 256;
  const camEntity = scene.createTransformedEntity("camera", new Vec3(0, cameraY, -8));
  const camera = new Camera();
  camera.far = 600;
  scene.world.addComponent(camEntity.id, camera);
  camEntity.transform.lookAt(new Vec3(0, 0, 0));
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
  const sun = new Light();
  sun.kind = "directional";
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));
  const surface = new WaterSurface({ level: 0, size: 400 });
  scene.add(surface);
  const grid = waterGridSource(400, 16, 1);
  const geometry = Geometry.create(device, { positions: grid.positions, normals: grid.normals, uvs: grid.uvs, indices: grid.indices, bounds: new AABB(new Vec3(...grid.boundsMin), new Vec3(...grid.boundsMax)) });
  const material = new Material({ label: "water", technique: "water" });
  surface.renderable!.geometry = geometry;
  surface.renderable!.material = material;
  // A rock through the surface: the intersection the contact foam and refraction act on.
  const rockGeometry = createBox(device, { width: 2, height: 4, depth: 2 });
  const rockMaterial = new Material({ label: "rock", color: 0x777777 });
  const rock = scene.createTransformedEntity("rock", new Vec3(0, 0, 0));
  const r = new Renderable();
  r.geometry = rockGeometry;
  r.material = rockMaterial;
  scene.world.addComponent(rock.id, r);
  return {
    mock,
    renderer,
    scene,
    async dispose() {
      scene.dispose();
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      rockGeometry.dispose();
      rockMaterial.dispose();
      await device.dispose();
      assert.deepEqual(mock.outstanding.buffers, []);
      assert.deepEqual(mock.outstanding.textures, []);
    },
  };
}

group("17.5 CPU reference", () => {
  test("measured: Beer–Lambert transmittance of the default absorption", () => {
    const k: [number, number, number] = [0.35, 0.075, 0.045];
    const one = waterTransmittance(k, 1);
    const five = waterTransmittance(k, 5);
    assertCloseTo(one[0], Math.exp(-0.35), 9);
    // Red is gone by 5 m (≈ 17 %), blue-green carries (≈ 69 % / 80 %): water turns cyan with depth.
    assert.ok(five[0] < 0.2 && five[1] > 0.65 && five[2] > 0.78, five.join(","));
    assert.deepEqual(waterTransmittance(k, 0), [1, 1, 1]);
    assert.deepEqual(waterTransmittance(k, -3), [1, 1, 1]);
  });
  test("contact foam is full at the intersection and gone past the band", () => {
    assertCloseTo(intersectionFoam(0, 0.6), 1, 9);
    assertCloseTo(intersectionFoam(0.3, 0.6), 0.5, 9);
    assertCloseTo(intersectionFoam(0.6, 0.6), 0, 9);
    assert.equal(intersectionFoam(0.1, 0), 0);
  });
  test("tier mapping and defaults (opt-in)", () => {
    assert.equal(waterScreenSpaceForTier("low"), "off");
    assert.equal(waterScreenSpaceForTier("medium"), "refraction");
    assert.equal(waterScreenSpaceForTier("high"), "full");
    const s = new Scene();
    assert.equal(s.settings.water.screenSpace, "off");
    s.setWater({ screenSpace: "full", absorption: [0.5, 0.1, 0.05], intersectionFoam: 0.9 });
    const c = new Scene();
    c.applySerialized(JSON.parse(JSON.stringify(s.serialize())));
    assert.equal(c.settings.water.screenSpace, "full");
    assert.deepEqual(c.settings.water.absorption, [0.5, 0.1, 0.05]);
    assertCloseTo(c.settings.water.intersectionFoam, 0.9, 9);
  });
});

group("17.5 shader + layout contract", () => {
  test("WaterUniforms carry the mode and absorption; group 2 adds the grab textures", () => {
    assert.equal(RENDERING_STRUCTS.WaterUniforms.offsetOf("screenA"), 432);
    assert.equal(RENDERING_STRUCTS.WaterUniforms.offsetOf("absorption"), 448);
    assert.equal(WATER_BINDINGS.grabColor.binding, 1);
    assert.equal(WATER_BINDINGS.grabDepth.binding, 2);
    assertContains(WATER_SHADER, "var grabColor: texture_2d<f32>");
    assertContains(WATER_SHADER, "refract(-V, N, 0.75)");
    assertContains(WATER_SHADER, "exp(-water.absorption.rgb * column)");
    assertContains(WATER_SHADER, "water.screenA.x > 1.5");
    assertContains(WATER_GRAB_SHADER, "texture_depth_2d");
  });
});

group("17.5 frame graph (mock device)", () => {
  test("off: water draws in forge.main and no grab runs", async () => {
    const f = await fixture();
    f.renderer.renderScene(f.scene);
    assert.deepEqual(f.mock.errors, []);
    assertNotContains(f.renderer.passNames, "forge.water.grab");
    assertNotContains(f.renderer.passNames, "forge.water");
    await f.dispose();
  });
  for (const mode of ["refraction", "full"] as const) {
    test(`${mode}: grab after the sky, water after the grab, zero validation errors`, async () => {
      const f = await fixture();
      f.scene.setWater({ screenSpace: mode });
      f.renderer.renderScene(f.scene);
      f.renderer.renderScene(f.scene);
      assert.deepEqual(f.mock.errors, []);
      const names = [...f.renderer.passNames];
      const sky = names.indexOf("forge.sky");
      const grab = names.indexOf("forge.water.grab");
      const water = names.indexOf("forge.water");
      assert.ok(sky >= 0 && grab > sky && water > grab, names.join(" "));
      await f.dispose();
    });
  }
  test("LDR and underwater frames fall back to the forge.main water", async () => {
    const f = await fixture();
    f.scene.setWater({ screenSpace: "full" });
    f.scene.settings.hdr = false;
    f.renderer.renderScene(f.scene);
    assertNotContains(f.renderer.passNames, "forge.water");
    await f.dispose();
    const u = await fixture(-3);
    u.scene.setWater({ screenSpace: "full" });
    u.renderer.renderScene(u.scene);
    assert.deepEqual(u.mock.errors, []);
    assertNotContains(u.renderer.passNames, "forge.water");
    await u.dispose();
  });
});

await finish();
