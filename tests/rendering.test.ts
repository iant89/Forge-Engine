/**
 * Tests for Renderer and scene rendering over the mock WebGPU device.
 *
 * Verifies that Renderer.renderScene produces correct draw calls, exercises
 * shadow and color passes, respects frustum culling, records zero WebGPU
 * validation errors, and releases all GPU resources on dispose without leaks.
 */

import { describe, expect, it } from "vitest";
import {
  Camera,
  Color,
  createBox,
  createPlane,
  GraphicsDevice,
  Light,
  Material,
  Renderable,
  Renderer,
  Scene,
  Vec3,
} from "@forge/engine";

describe("Renderer with mock WebGPU device", () => {
  it("renders a scene with camera, light, and geometry with zero validation errors", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "render-test" });
    scene.setBackgroundColor(Color.fromSrgbHex(0x101520));

    // Camera
    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 3, -8));
    const camera = new Camera();
    camera.fovY = Math.PI / 3;
    camera.near = 0.1;
    camera.far = 100;
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    // Directional light (shadow caster)
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
    const sun = new Light();
    sun.kind = "directional";
    sun.intensity = 2.0;
    sun.castShadow = true;
    scene.world.addComponent(sunEntity.id, sun);
    sunEntity.transform.lookAt(new Vec3(0, 0, 0));

    // Ground plane
    const groundEntity = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
    const groundMesh = createPlane(device, { width: 20, depth: 20 });
    const groundMat = new Material({ label: "ground-mat", color: 0x334455, roughness: 0.8 });
    const groundRenderable = new Renderable();
    groundRenderable.geometry = groundMesh;
    groundRenderable.material = groundMat;
    groundRenderable.castShadow = false;
    scene.world.addComponent(groundEntity.id, groundRenderable);

    // Box
    const boxEntity = scene.createTransformedEntity("cube", new Vec3(0, 1, 0));
    const boxMesh = createBox(device, { width: 1.5, height: 1.5, depth: 1.5 });
    const boxMat = new Material({ label: "cube-mat", color: 0xff4422, roughness: 0.4 });
    const boxRenderable = new Renderable();
    boxRenderable.geometry = boxMesh;
    boxRenderable.material = boxMat;
    boxRenderable.castShadow = true;
    scene.world.addComponent(boxEntity.id, boxRenderable);

    // Render frame
    renderer.renderScene(scene);

    // Assertions on frame execution
    expect(renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);
    expect(renderer.stats.triangles).toBeGreaterThanOrEqual(12);
    expect(mock.drawCalls).toBeGreaterThanOrEqual(1);
    expect(mock.errors).toHaveLength(0);
    mock.assertClean();

    // Default settings: HDR on, three cascades, depth prepass + SSAO. The frame is one shadow pass
    // per cascade, the depth prepass, the SSAO estimate and its two blur passes, the forward pass
    // into the HDR target and the tonemap resolve into the swapchain (the 1x1 mock surface is too
    // small for a bloom chain, so none is declared).
    const passLabels = mock.passes.map((p) => p.label);
    expect(passLabels).toEqual([
      "forge.shadow.0",
      "forge.shadow.1",
      "forge.shadow.2",
      "forge.prepass",
      "forge.ssao",
      "forge.ssao.blur.h",
      "forge.ssao.blur.v",
      "forge.main",
      "forge.tonemap",
    ]);
    expect(renderer.passNames).toEqual(passLabels);
    expect(renderer.stats.shadowCascades).toBe(3);
    expect(renderer.stats.shadowsDrawn).toBe(3); // the cube, once per cascade (the ground does not cast)
    expect(renderer.stats.hdr).toBe(true);
    expect(mock.passes[0]!.depthTarget).toContain("depth24plus");
    expect(renderer.stats.depthPrepass).toBe(true);
    expect(renderer.stats.ssao).toBe(true);
    expect(mock.passes[7]!.colorTargets[0]).toContain("rgba16float");
    expect(mock.passes[8]!.colorTargets[0]).toBe("swapchain");

    // Clean teardown and leak check
    scene.dispose();
    renderer.dispose();
    groundMesh.dispose();
    groundMat.dispose();
    boxMesh.dispose();
    boxMat.dispose();
    await device.dispose();

    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("camera and light lookAt reach the frame: view faces the target, sun direction points at it", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "lookat" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 3.4, -9.5));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0.8, 0));

    const sunEntity = scene.createTransformedEntity("sun", new Vec3(7, 13, -7));
    const sun = new Light();
    scene.world.addComponent(sunEntity.id, sun);
    sunEntity.transform.lookAt(new Vec3(0, 0, 0));

    const boxEntity = scene.createTransformedEntity("cube", new Vec3(0, 0.9, 0));
    const box = new Renderable();
    box.geometry = createBox(device);
    box.material = new Material({ label: "m", color: 0xffffff });
    scene.world.addComponent(boxEntity.id, box);

    renderer.renderScene(scene);

    // The cube sits at the camera's target: it must be in front of the camera, centred, not culled.
    const inView = camera.view.transformPoint(new Vec3(0, 0.8, 0), new Vec3());
    expect(Math.abs(inView.x)).toBeLessThan(1e-4);
    expect(Math.abs(inView.y)).toBeLessThan(1e-4);
    expect(inView.z).toBeCloseTo(Math.hypot(3.4 - 0.8, 9.5), 3);
    expect(renderer.stats.culled).toBe(0);
    expect(renderer.stats.drawCalls).toBeGreaterThanOrEqual(1);

    // The light's travel direction is from the sun toward its lookAt target (downward, toward -X/+Z).
    const expected = new Vec3(-7, -13, 7).normalize();
    expect(sun.direction.x).toBeCloseTo(expected.x, 4);
    expect(sun.direction.y).toBeCloseTo(expected.y, 4);
    expect(sun.direction.z).toBeCloseTo(expected.z, 4);

    scene.dispose();
    renderer.dispose();
    box.geometry.dispose();
    box.material.dispose();
    await device.dispose();
  });

  it("derives camera projection aspect ratio from device surface when aspectOverride is 0", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    device.resize(800, 600);
    expect(device.aspect).toBeCloseTo(4 / 3, 5);

    const renderer = new Renderer(device);
    const scene = new Scene({ name: "aspect-test" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -5));
    const camera = new Camera();
    camera.fovY = Math.PI / 3;
    expect(camera.aspectOverride).toBe(0);
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    renderer.renderScene(scene);

    // In setPerspective, m[0] = f / aspect and m[5] = f, so m[5] / m[0] == aspect
    const computedAspect = camera.projection.m[5]! / camera.projection.m[0]!;
    expect(computedAspect).toBeCloseTo(4 / 3, 4);

    scene.dispose();
    renderer.dispose();
    await device.dispose();
  });

  it("handles empty scenes by clearing the frame without errors", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "empty-scene" });

    // Render empty scene (no camera or entities)
    renderer.renderScene(scene);
    expect(renderer.stats.drawCalls).toBe(0);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("culls objects outside the camera frustum", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "cull-scene" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -10));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    // In front of camera
    const inFront = scene.createTransformedEntity("in-front", new Vec3(0, 0, 0));
    const boxMesh = createBox(device, { width: 1, height: 1, depth: 1 });
    const mat = new Material({ label: "mat", color: 0x00ff00 });
    const r1 = new Renderable();
    r1.geometry = boxMesh;
    r1.material = mat;
    scene.world.addComponent(inFront.id, r1);

    // Behind camera (z = -20 while camera looks towards +z from z = -10)
    const behind = scene.createTransformedEntity("behind", new Vec3(0, 0, -20));
    const r2 = new Renderable();
    r2.geometry = boxMesh;
    r2.material = mat;
    scene.world.addComponent(behind.id, r2);

    renderer.renderScene(scene);

    expect(renderer.stats.culled).toBeGreaterThanOrEqual(1);
    expect(r1.isVisible).toBe(true);
    expect(r2.isVisible).toBe(false);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    boxMesh.dispose();
    mat.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("draws debug lines and releases debug buffers on dispose", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "debug-scene" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -5));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    renderer.drawLine(new Vec3(0, 0, 0), new Vec3(1, 1, 1), 0xff00ff00);
    renderer.renderScene(scene);

    expect(renderer.stats.debugLines).toBe(1);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });

  it("debugBounds draws AABBs for in-view AND frustum-culled renderables, and cleans up", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const mock = device.mock;
    const renderer = new Renderer(device);
    const scene = new Scene({ name: "bounds-scene" });

    const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 0, -10));
    const camera = new Camera();
    scene.world.addComponent(camEntity.id, camera);
    camEntity.transform.lookAt(new Vec3(0, 0, 0));

    const boxMesh = createBox(device, { width: 1, height: 1, depth: 1 });
    const mat = new Material({ label: "mat", color: 0x00ff00 });
    const inFront = scene.createTransformedEntity("in-front", new Vec3(0, 0, 0));
    const r1 = new Renderable();
    r1.geometry = boxMesh;
    r1.material = mat;
    scene.world.addComponent(inFront.id, r1);
    // Behind the camera: frustum-culled, but the bounds overlay must still mark where it sits.
    const behind = scene.createTransformedEntity("behind", new Vec3(0, 0, -30));
    const r2 = new Renderable();
    r2.geometry = boxMesh;
    r2.material = mat;
    scene.world.addComponent(behind.id, r2);

    renderer.debugBounds = true;
    renderer.renderScene(scene);
    expect(renderer.stats.debugBounds).toBe(2);

    renderer.debugBounds = false;
    renderer.renderScene(scene);
    expect(renderer.stats.debugBounds).toBe(0);
    mock.assertClean();

    scene.dispose();
    renderer.dispose();
    boxMesh.dispose();
    mat.dispose();
    await device.dispose();
    expect(mock.outstanding.buffers).toHaveLength(0);
    expect(mock.outstanding.textures).toHaveLength(0);
  });
});
