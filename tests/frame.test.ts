/**
 * Frame structure produced by `Renderer` over the mock device (docs/VERIFICATION.md#tests).
 *
 * What these prove: the scene settings select the pass chain (HDR + bloom + tonemap, LDR direct,
 * shadows on/off, the analytic sky) and each chain runs with zero validation errors; off-screen
 * casters still reach the cascades; the sky pass depth-tests against a depth buffer the main pass
 * stored (and reverts to discarding it when the sky is off); a steady frame allocates no GPU
 * textures; a resize re-plans and retires the old shapes; everything the renderer created is
 * released by dispose(). The mock validates attachment formats,
 * bind-group signatures, dynamic offsets and view dimensions, so "no errors" is a real statement.
 */

import { describe, expect, it } from "vitest";
import { Camera, Color, createBox, createPlane, GraphicsDevice, Light, Material, Renderable, Renderer, Scene, Vec3, type RendererOptions } from "@forge/engine";

interface Fixture {
  device: GraphicsDevice;
  mock: GraphicsDevice["mock"];
  renderer: Renderer;
  scene: Scene;
  camera: Camera;
  sun: Light;
  dispose(): Promise<void>;
}

async function fixture(options: { width?: number; height?: number; renderer?: RendererOptions; extraBoxes?: Vec3[] } = {}): Promise<Fixture> {
  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(options.width ?? 320, options.height ?? 180);
  const mock = device.mock;
  const renderer = new Renderer(device, { shadowMapSize: 256, ...options.renderer });
  const scene = new Scene({ name: "frame-test" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x101520));
  scene.settings.shadow.mapSize = 256;

  const camEntity = scene.createTransformedEntity("camera", new Vec3(0, 3, -8));
  const camera = new Camera();
  camera.far = 100;
  scene.world.addComponent(camEntity.id, camera);
  camEntity.transform.lookAt(new Vec3(0, 0, 0));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(5, 10, -5));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = true;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const geometries = [createPlane(device, { width: 40, depth: 40 }), createBox(device, { size: 1.5 })];
  const materials = [new Material({ label: "ground", color: 0x334455 }), new Material({ label: "box", color: 0xff8800 })];
  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundR = new Renderable();
  groundR.geometry = geometries[0]!;
  groundR.material = materials[0]!;
  groundR.castShadow = false;
  scene.world.addComponent(ground.id, groundR);
  for (const [i, position] of [new Vec3(0, 0.75, 0), ...(options.extraBoxes ?? [])].entries()) {
    const e = scene.createTransformedEntity(`box${i}`, position);
    const r = new Renderable();
    r.geometry = geometries[1]!;
    r.material = materials[1]!;
    r.castShadow = true;
    scene.world.addComponent(e.id, r);
  }

  return {
    device,
    mock,
    renderer,
    scene,
    camera,
    sun,
    async dispose() {
      scene.dispose();
      renderer.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      await device.dispose();
      expect(mock.outstanding.buffers).toEqual([]);
      expect(mock.outstanding.textures).toEqual([]);
    },
  };
}

const labels = (f: Fixture) => f.mock.passes.map((p) => p.label);

describe("frame structure", () => {
  it("HDR: cascades, forward pass into rgba16float, a bloom chain and the tonemap resolve", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual([
      "forge.shadow.0",
      "forge.shadow.1",
      "forge.main",
      "forge.bloom.prefilter",
      "forge.bloom.down.2",
      "forge.bloom.down.3",
      "forge.bloom.up.2",
      "forge.bloom.up.1",
      "forge.tonemap",
    ]);
    const s = f.renderer.stats;
    expect(s.hdr).toBe(true);
    expect(s.bloomMips).toBe(3); // 180 px tall → 90, 45, 22 (next would be 11 < 16)
    expect(s.shadowCascades).toBe(2);
    expect(s.shadowsDrawn).toBe(2); // one caster batch × two cascades
    expect(s.drawCalls).toBe(2 + 6); // ground + box, then six fullscreen post draws
    expect(s.triangles).toBe(2 + 12); // post draws are not scene geometry
    expect(s.passes).toBe(9);
    expect(s.culledPasses).toBe(0);
    // Transients: atlas, hdr, depth, 3 bloom mips.
    expect(s.transientTextures).toBe(6);
    expect(s.physicalTextures).toBe(6);
    const main = f.mock.passes[2]!;
    expect(main.colorTargets[0]).toContain("rgba16float");
    expect(main.depthTarget).toContain("depth24plus");
    expect(f.mock.passes[8]!.colorTargets).toEqual(["swapchain"]);
    await f.dispose();
  });

  it("LDR: the forward pass writes the swapchain directly and no post pass exists", async () => {
    const f = await fixture();
    f.scene.settings.hdr = false;
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.main"]);
    expect(f.mock.passes[1]!.colorTargets).toEqual(["swapchain"]);
    expect(f.renderer.stats.hdr).toBe(false);
    expect(f.renderer.stats.bloomMips).toBe(0);
    await f.dispose();
  });

  it("bloom and shadows are individually switchable, and the quality profile caps the scene", async () => {
    const f = await fixture({ renderer: { shadowCascades: 2, shadowMapSize: 256 } });
    f.scene.settings.shadow.cascades = 4; // asks for 4; the profile allows 2
    f.scene.settings.shadow.mapSize = 2048; // asks for 2048; the profile allows 256
    f.scene.settings.bloom.enabled = false;
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.shadow.1", "forge.main", "forge.tonemap"]);
    expect(f.mock.passes[0]!.depthTarget).toContain("256x256x2");

    f.mock.passes.length = 0;
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.bloom.enabled = true;
    f.renderer.renderScene(f.scene);
    expect(labels(f).filter((l) => l.startsWith("forge.shadow."))).toEqual([]);
    expect(labels(f).filter((l) => l.startsWith("forge.bloom."))).toHaveLength(5);
    expect(f.renderer.stats.shadowCascades).toBe(0);

    f.mock.passes.length = 0;
    f.scene.settings.shadow.enabled = true;
    f.scene.settings.postProcessing = false; // kills bloom, keeps the HDR resolve
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.shadow.1", "forge.main", "forge.tonemap"]);

    f.mock.passes.length = 0;
    f.sun.castShadow = false; // no caster light → no cascades, even with shadows enabled
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.main", "forge.tonemap"]);
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("casters outside the view frustum still render into the cascades they intersect", async () => {
    // A box behind the camera's back is frustum-culled for the colour pass but sits well inside the
    // first cascade's light-space box, so it must still cast.
    const f = await fixture({ extraBoxes: [new Vec3(0, 0.75, -12)] });
    f.scene.settings.shadow.cascades = 1;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    const s = f.renderer.stats;
    expect(s.culled).toBe(1);
    expect(s.drawCalls - 6).toBe(2); // ground + visible box; the culled one is not drawn in forge.main
    expect(f.mock.passes[0]!.drawCalls).toBe(2); // ...but both boxes reach the shadow pass
    expect(s.shadowsDrawn).toBe(2);
    await f.dispose();
  });

  it("allocates no textures on a steady frame and rebuilds only what a resize changes", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 2;
    f.renderer.renderScene(f.scene);
    const created = f.mock.texturesCreated;
    const buffers = f.mock.buffersCreated;
    for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
    expect(f.mock.texturesCreated).toBe(created);
    expect(f.mock.buffersCreated).toBe(buffers);
    expect(f.renderer.stats.texturesCreated).toBe(0);

    // Resize: frame-sized transients (hdr, depth, bloom mips) are re-planned, the shadow atlas is not.
    // (200x120 shares no shape with the 320x180 frame; a half-size resize would re-use the old mips.)
    f.renderer.resize(200, 120);
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.bloomMips).toBe(2);
    expect(f.renderer.stats.texturesCreated).toBe(2 + 2);
    // The old shapes survive two idle frames (a toggle that flips back costs nothing), then go away.
    f.renderer.renderScene(f.scene);
    const outstandingBefore = f.mock.outstanding.textures.filter((t) => t.startsWith("rg.")).length;
    f.renderer.renderScene(f.scene);
    const outstandingAfter = f.mock.outstanding.textures.filter((t) => t.startsWith("rg.")).length;
    expect(outstandingBefore - outstandingAfter).toBe(2 + 3); // old hdr + depth + three 320x180 bloom mips
    expect(f.renderer.stats.texturesCreated).toBe(0);
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("switching HDR off and on and toggling shadows leaks nothing and stays valid", async () => {
    const f = await fixture();
    for (const [hdr, shadows] of [
      [true, true],
      [false, true],
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      f.scene.settings.hdr = hdr;
      f.scene.settings.shadow.enabled = shadows;
      for (let i = 0; i < 4; i++) f.renderer.renderScene(f.scene);
      expect(f.mock.errors, `hdr=${hdr} shadows=${shadows}`).toEqual([]);
    }
    expect(f.renderer.passNames).toContain("forge.tonemap");
    await f.dispose();
  });

  it("sky: a fullscreen pass after forge.main over the same target, depth bound read-only", async () => {
    const f = await fixture();
    f.scene.settings.shadow.cascades = 1;
    f.scene.setSky({ quality: "low" });
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual([
      "forge.shadow.0",
      "forge.main",
      "forge.sky",
      "forge.bloom.prefilter",
      "forge.bloom.down.2",
      "forge.bloom.down.3",
      "forge.bloom.up.2",
      "forge.bloom.up.1",
      "forge.tonemap",
    ]);
    const main = f.mock.passes[1]!;
    const sky = f.mock.passes[2]!;
    // The sky depth-tests against the scene depth, so forge.main must keep it (it discards otherwise).
    expect(main.depthStoreOp).toBe("store");
    expect(sky.depthStoreOp).toBe("read-only");
    expect(sky.depthTarget).toBe(main.depthTarget);
    expect(sky.colorTargets).toEqual(main.colorTargets);
    expect(sky.drawCalls).toBe(1);
    expect(sky.triangles).toBe(1);
    const s = f.renderer.stats;
    expect(s.sky).toBe(true);
    expect(s.drawCalls).toBe(2 + 1 + 6);
    expect(s.transientTextures).toBe(6); // the sky adds no texture: it draws into scene.hdr
    expect(s.passes).toBe(9);

    // Steady state: nothing is (re)created for the sky.
    const created = f.mock.texturesCreated;
    const buffers = f.mock.buffersCreated;
    for (let i = 0; i < 3; i++) f.renderer.renderScene(f.scene);
    expect(f.mock.texturesCreated).toBe(created);
    expect(f.mock.buffersCreated).toBe(buffers);
    expect(f.renderer.stats.texturesCreated).toBe(0);

    // LDR: the sky writes the swapchain directly, after the forward pass.
    f.mock.passes.length = 0;
    f.scene.settings.hdr = false;
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.main", "forge.sky"]);
    expect(f.mock.passes[2]!.colorTargets).toEqual(["swapchain"]);
    expect(f.mock.passes[1]!.depthStoreOp).toBe("store");

    // Off again (a solid background): no sky pass, and the depth buffer goes back to being discarded.
    f.mock.passes.length = 0;
    f.scene.setBackgroundColor(0x102030);
    f.renderer.renderScene(f.scene);
    expect(labels(f)).toEqual(["forge.shadow.0", "forge.main"]);
    expect(f.mock.passes[1]!.depthStoreOp).toBe("discard");
    expect(f.renderer.stats.sky).toBe(false);

    // The quality profile can cap the march or veto the pass regardless of the scene.
    f.scene.setSky({ quality: "high" });
    f.renderer.renderScene(f.scene);
    expect(f.renderer.stats.skySamples).toBe(32);
    const capped = new Renderer(f.device, { shadowMapSize: 256, skyQuality: "low" });
    capped.renderScene(f.scene);
    expect(capped.stats.sky).toBe(true);
    expect(capped.stats.skySamples).toBe(8);
    capped.dispose();
    const vetoed = new Renderer(f.device, { shadowMapSize: 256, sky: false });
    f.mock.passes.length = 0;
    vetoed.renderScene(f.scene);
    expect(labels(f)).not.toContain("forge.sky");
    expect(vetoed.stats.skySamples).toBe(0);
    vetoed.dispose();
    expect(f.mock.errors).toEqual([]);
    await f.dispose();
  });

  it("sky: the sun comes from the settings, then the per-frame override, then the directional light", async () => {
    const f = await fixture();
    f.scene.settings.shadow.enabled = false;
    f.scene.settings.hdr = false;
    f.scene.setSky({ sunDirection: new Vec3(0, 2, 0) });
    expect(f.scene.settings.sky.sunDirection!.y).toBe(1); // normalised copy
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(labels(f)).toEqual(["forge.main", "forge.sky"]);
    // A one-frame override is consumed by the next frame and does not persist.
    f.renderer.setSkyOverride({ exposure: 0.5, quality: "high" });
    f.renderer.renderScene(f.scene);
    expect(f.renderer.skyOverride).toBeNull();
    expect(f.scene.settings.sky.exposure).toBe(1);
    // Without an explicit direction the first directional light is the sun; without any light a
    // default is used — both must render cleanly.
    f.scene.settings.sky.sunDirection = null;
    f.renderer.renderScene(f.scene);
    f.scene.world.removeComponent(f.sun.entity, Light);
    f.renderer.renderScene(f.scene);
    expect(f.mock.errors).toEqual([]);
    expect(f.renderer.passNames).toContain("forge.sky");
    await f.dispose();
  });

  it("a frame without a camera clears the swapchain and still counts as rendered", async () => {
    const device = await GraphicsDevice.create({ forceMock: true });
    const renderer = new Renderer(device, { shadowMapSize: 256 });
    const scene = new Scene({ name: "empty" });
    renderer.renderScene(scene);
    expect(device.mock.passes.map((p) => p.label)).toEqual(["forge.clear"]);
    expect(renderer.framesRendered).toBe(1);
    expect(device.mock.errors).toEqual([]);
    scene.dispose();
    renderer.dispose();
    await device.dispose();
    expect(device.mock.outstanding.textures).toEqual([]);
  });
});
