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

    // Verify both shadow and main color passes were executed
    const passLabels = mock.passes.map((p) => p.label);
    expect(passLabels).toHaveLength(2);
    expect(mock.passes[0]!.label).toBe("forge.shadow");
    expect(mock.passes[1]!.label).toBe("forge.main");

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
});
