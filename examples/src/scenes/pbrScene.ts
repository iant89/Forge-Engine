/**
 * Phase 2 Scene: PBR Material & Lighting Showcase.
 *
 * Demonstrates:
 * - Cook-Torrance PBR shading across the Metallic × Roughness spectrum.
 * - Tangent-space Normal Mapping + Albedo + Metallic-Roughness textures.
 * - Multiple light types: Directional (shadowed), Point (orbiting), and Spot (focused cone).
 * - Emissive materials with dynamic intensity.
 * - Variety of primitives: Spheres, Torus, Box, Cylinder, and Ground Plane.
 */
import {
  Camera,
  Color,
  type Engine,
  Light,
  Material,
  Quat,
  Renderable,
  Scene,
  Vec3,
  createBox,
  createCylinder,
  createPlane,
  createSphere,
  createTorus,
  type Geometry,
} from "@forge/engine";
import { createCobblestoneTextures, createSciFiPanelTextures, type PbrTextureSet } from "../textures/procedural.js";
import type { DemoSceneHandle } from "./cubesScene.js";

export function buildPbrScene(engine: Engine): DemoSceneHandle {
  const scene = new Scene({ name: "pbr-showcase" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x050810));
  scene.settings.hdr = false;
  scene.settings.exposure = 1.2;

  const allocatedGeometries: Geometry[] = [];
  const allocatedTextures: PbrTextureSet[] = [];
  const allocatedMaterials: Material[] = [];

  // Ground plane
  const groundMesh = createPlane(engine.gpu, { width: 60, depth: 60, segmentsX: 10, segmentsZ: 10 });
  allocatedGeometries.push(groundMesh);
  const groundMat = new Material({
    label: "ground",
    color: 0x4e5a6a,
    roughness: 0.85,
    metallic: 0.1,
  });
  allocatedMaterials.push(groundMat);
  const ground = scene.createTransformedEntity("ground", new Vec3(0, 0, 0));
  const groundR = new Renderable();
  groundR.geometry = groundMesh;
  groundR.material = groundMat;
  groundR.castShadow = false;
  scene.world.addComponent(ground.id, groundR);

  // Geometry primitives
  const sphereMesh = createSphere(engine.gpu, { radius: 0.65, widthSegments: 36, heightSegments: 24 });
  const torusMesh = createTorus(engine.gpu, { radius: 0.8, tube: 0.28 });
  const boxMesh = createBox(engine.gpu, { width: 1.1, height: 1.1, depth: 1.1 });
  const cylMesh = createCylinder(engine.gpu, { radiusTop: 0.55, radiusBottom: 0.55, height: 1.2 });
  allocatedGeometries.push(sphereMesh, torusMesh, boxMesh, cylMesh);

  // ---------------------------------------------------------------- PBR Grid (Metallic x Roughness)
  // 5 roughness levels x 3 metallic levels
  const roughnessSteps = [0.05, 0.25, 0.5, 0.75, 0.95];
  const rows = [
    { label: "Dielectric (Blue)", color: 0x2277bb, metallic: 0.0, z: -2.4 },
    { label: "Metal (Gold)", color: 0xd4af37, metallic: 1.0, z: 0.0 },
    { label: "Semi-Metal (Copper)", color: 0xc86a45, metallic: 0.6, z: 2.4 },
  ];

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx]!;
    for (let cIdx = 0; cIdx < roughnessSteps.length; cIdx++) {
      const roughness = roughnessSteps[cIdx]!;
      const x = (cIdx - 2) * 1.8;
      const y = 1.0;
      const z = row.z;

      const entity = scene.createTransformedEntity(`sphere-${rIdx}-${cIdx}`, new Vec3(x, y, z));
      const mat = new Material({
        label: `${row.label}-r${(roughness * 100).toFixed(0)}`,
        color: row.color,
        metallic: row.metallic,
        roughness,
      });
      allocatedMaterials.push(mat);

      const renderable = new Renderable();
      renderable.geometry = sphereMesh;
      renderable.material = mat;
      renderable.castShadow = true;
      scene.world.addComponent(entity.id, renderable);
    }
  }

  // ---------------------------------------------------------------- Textured Feature Objects
  // 1. Cobblestone textured sphere (left feature)
  const cobbleTex = createCobblestoneTextures(engine.gpu, 256);
  allocatedTextures.push(cobbleTex);
  const cobbleMat = new Material({
    label: "cobblestone-pbr",
    albedoMap: cobbleTex.albedo,
    normalMap: cobbleTex.normal,
    metallicRoughnessMap: cobbleTex.metallicRoughness,
    normalScale: 1.2,
  });
  allocatedMaterials.push(cobbleMat);

  const cobbleEntity = scene.createTransformedEntity("cobble-sphere", new Vec3(-5.5, 1.2, 0));
  const cobbleR = new Renderable();
  cobbleR.geometry = sphereMesh;
  cobbleR.material = cobbleMat;
  cobbleR.castShadow = true;
  scene.world.addComponent(cobbleEntity.id, cobbleR);

  // 2. Sci-Fi Hull Plate Torus (right feature)
  const scifiTex = createSciFiPanelTextures(engine.gpu, 256);
  allocatedTextures.push(scifiTex);
  const scifiMat = new Material({
    label: "scifi-panel-pbr",
    albedoMap: scifiTex.albedo,
    normalMap: scifiTex.normal,
    metallicRoughnessMap: scifiTex.metallicRoughness,
    normalScale: 1.0,
  });
  allocatedMaterials.push(scifiMat);

  const scifiEntity = scene.createTransformedEntity("scifi-torus", new Vec3(5.5, 1.2, 0));
  const scifiR = new Renderable();
  scifiR.geometry = torusMesh;
  scifiR.material = scifiMat;
  scifiR.castShadow = true;
  scene.world.addComponent(scifiEntity.id, scifiR);

  // 3. Emissive Core Box (front accent)
  const emissiveMat = new Material({
    label: "emissive-core",
    color: 0x0a1020,
    emissive: 0x00d4ff,
    emissiveStrength: 2.5,
    roughness: 0.2,
    metallic: 0.8,
  });
  allocatedMaterials.push(emissiveMat);

  const emissiveEntity = scene.createTransformedEntity("emissive-cube", new Vec3(0, 0.7, 5.0));
  const emissiveR = new Renderable();
  emissiveR.geometry = boxMesh;
  emissiveR.material = emissiveMat;
  emissiveR.castShadow = true;
  scene.world.addComponent(emissiveEntity.id, emissiveR);

  // ---------------------------------------------------------------- Lights
  // Directional Sun angled from upper right front (similar to Phase 1's lit ground angle)
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(7, 14, -8));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 5.0;
  sun.castShadow = true;
  sun.setColor(1.0, 0.98, 0.92);
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Orbiting Point Light 1 (Cyan / Electric Blue)
  const point1Entity = scene.createTransformedEntity("point-cyan", new Vec3(0, 2.0, 0));
  const point1 = new Light();
  point1.kind = "point";
  point1.intensity = 16.0;
  point1.range = 16;
  point1.setColor(0.15, 0.85, 1.0);
  scene.world.addComponent(point1Entity.id, point1);

  // Orbiting Point Light 2 (Warm Amber / Gold)
  const point2Entity = scene.createTransformedEntity("point-amber", new Vec3(0, 2.0, 0));
  const point2 = new Light();
  point2.kind = "point";
  point2.intensity = 14.0;
  point2.range = 16;
  point2.setColor(1.0, 0.55, 0.15);
  scene.world.addComponent(point2Entity.id, point2);

  // Spot Light (Focused top-down cone illuminating center gold row)
  const spotEntity = scene.createTransformedEntity("spot", new Vec3(0, 6.5, 0));
  const spot = new Light();
  spot.kind = "spot";
  spot.intensity = 15.0;
  spot.range = 16;
  spot.innerCone = 0.5;
  spot.outerCone = 0.85;
  spot.setColor(1.0, 1.0, 1.0);
  scene.world.addComponent(spotEntity.id, spot);
  spotEntity.transform.lookAt(new Vec3(0, 1, 0));

  // ---------------------------------------------------------------- Camera
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 5.5, -11));
  const camera = new Camera();
  camera.fovY = Math.PI / 3.5; // ~51 degrees vertical FOV for natural perspective
  camera.near = 0.1;
  camera.far = 150;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 1.2, 0));

  // ---------------------------------------------------------------- Animation loop
  let time = 0;
  const cobbleRotAxis = new Vec3(0, 1, 0.2).normalize();
  const scifiRotAxis = new Vec3(0.5, 1, 0).normalize();

  const update = (dt: number): void => {
    time += dt;

    // Orbit Point Light 1 (Cyan) in a circle around the grid
    const p1Radius = 4.2;
    const p1Speed = 0.9;
    point1Entity.transform.position = new Vec3(
      Math.sin(time * p1Speed) * p1Radius,
      1.8 + Math.sin(time * 1.5) * 0.6,
      Math.cos(time * p1Speed) * p1Radius * 0.7,
    );

    // Orbit Point Light 2 (Amber) in an inclined orbit opposite direction
    const p2Radius = 3.8;
    const p2Speed = -0.75;
    point2Entity.transform.position = new Vec3(
      Math.sin(time * p2Speed) * p2Radius,
      2.0 + Math.cos(time * 1.2) * 0.6,
      Math.cos(time * p2Speed) * p2Radius * 0.7,
    );

    // Slowly rotate featured textured objects so grazing light moves across normals
    const cobbleT = cobbleEntity.transform;
    const cobbleDelta = Quat.fromAxisAngle(cobbleRotAxis, 0.4 * dt);
    cobbleT.rotation = cobbleDelta.multiply(cobbleT.rotation).normalize();

    const scifiT = scifiEntity.transform;
    const scifiDelta = Quat.fromAxisAngle(scifiRotAxis, 0.5 * dt);
    scifiT.rotation = scifiDelta.multiply(scifiT.rotation).normalize();

    // Pulse emissive cube
    const pulse = Math.sin(time * 3.0) * 0.5 + 0.5;
    emissiveMat.emissiveStrength = 1.5 + pulse * 3.0;
  };

  const dispose = (): void => {
    for (const g of allocatedGeometries) g.dispose();
    for (const t of allocatedTextures) {
      t.albedo.dispose();
      t.normal.dispose();
      t.metallicRoughness.dispose();
    }
    scene.dispose();
  };

  return { scene, cameraEntity, update, dispose };
}
