/**
 * Mars showcase: the public-domain NASA Mars 2020 Perseverance model driving over the Phase 4
 * procedural Martian terrain under the Phase 8a Mars sky, with wheel-kick and ambient dust.
 *
 * Stack, all on the public `@forge/engine` API:
 * - terrain: the terrain demo's `TerrainWorld` preset (seed 42137, regolith textures, exp² dust
 *   haze) plus a one-shot `warmUpChunks` burst so the opening frame is a full disc, not a patch;
 * - sky: `MARS_ATMOSPHERE` through `forge.sky` with the horizon-coloured haze (same recipe as the
 *   terrain demo, quality raised to medium — this scene spends its budget on the rover up close);
 * - rover: `Vehicle` with the model's six hub positions (front + rear steer, all six driven, Mars
 *   gravity 3.72 m/s², aero off), posed by `VehicleSystem`; the GLB arrives async — a box-body
 *   placeholder drives until it lands, then the real body/wheel meshes swap in (`assets/glb.ts`
 *   reads `examples/assets/Perseverance.glb`, produced by `scripts/convert-perseverance.mjs`);
 * - dust: an ambient field that drifts around the camera and a wheel-kick puff emitted behind the
 *   rear hubs when the rover is moving — each a `ParticleWorld` driven by a SceneObject so the
 *   emitter follows the camera / chassis every engine frame.
 *
 * Controls mirror the vehicle playground: WASD / arrows + the on-screen stick, orbit camera with
 * `keyboard: false` (the scene owns those keys) that tracks the chassis via `followTarget`.
 */

import {
  AtmosphereModel,
  Camera,
  Color,
  type Engine,
  type Entity,
  GeneratorPipeline,
  HeightGenerator,
  CraterGenerator,
  ErosionGenerator,
  BiomeGenerator,
  ScatterGenerator,
  Light,
  MARS_ATMOSPHERE,
  Material,
  type ParticleModule,
  PARTICLE_FLOATS,
  P_AGE,
  P_FLAGS,
  P_MAX_LIFE,
  P_SIZE,
  ParticleWorld,
  Renderable,
  Scene,
  SizeOverLifeModule,
  TerrainWorld,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  createAtmosphere,
  createBox,
  createVehicleConfig,
  heightFunctionGround,
} from "@forge/engine";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";
import { loadGlb, type LoadedGlb } from "../assets/glb.js";
import {
  createMarsRegolithTextures,
  disposePbrTextureSet,
  type PbrTextureSet,
} from "../textures/procedural.js";
import type { DemoSceneHandle } from "./cubesScene.js";

export interface MarsShowcaseSceneHandle extends DemoSceneHandle {
  /** Gate-facing snapshot: model load state, dust counts and rover pose. */
  marsState(): {
    modelLoaded: boolean;
    modelError: string | null;
    wheelCount: number;
    contactWheels: number;
    ambientDust: number;
    kickDust: number;
    speed: number;
    x: number;
    y: number;
    z: number;
  };
}

/** Rover spawn on the terrain heightfield (placeOnGround drops it onto the surface). */
const SPAWN_X = -16;
const SPAWN_Z = 18;

/**
 * Hub centres measured from the converted GLB (`scripts/convert-perseverance.mjs` prints them):
 * front/rear track 2.18 m, middle axle slightly wider, radius 0.264 m — the real Perseverance
 * geometry. Front and rear axles steer (the middle pair is fixed), all six are driven.
 */
const WHEELS = [
  { name: "wheel_FL", x: -1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_FR", x: 1.091, z: 1.095, steered: true, driven: true, handbrake: false },
  { name: "wheel_ML", x: -1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_MR", x: 1.213, z: -0.09, steered: false, driven: true, handbrake: false },
  { name: "wheel_RL", x: -1.091, z: -1.165, steered: true, driven: true, handbrake: true },
  { name: "wheel_RR", x: 1.091, z: -1.165, steered: true, driven: true, handbrake: true },
] as const;

const WHEEL_RADIUS = 0.264;
const WHEEL_SPRING_RATE = (1025 * 3.72) / (6 * 0.05); // ~5 cm static sag across six wheels
const AMBIENT_DUST_SPRITES = 420;
const KICK_DUST_SPRITES = 500;

/** Grows a wheel puff across its life, then shrinks it away — the shared material has no
 * per-particle alpha (see docs/KNOWN-ISSUES.md), so dissipation rides on size instead. */
class DustPuffSizeModule implements ParticleModule {
  readonly name = "dustPuffSize";
  constructor(
    private readonly start: number,
    private readonly end: number,
  ) {}
  apply(state: Float32Array, index: number, _dt: number): void {
    const o = index * PARTICLE_FLOATS;
    if (state[o + P_FLAGS]! < 0.5) return;
    const maxLife = state[o + P_MAX_LIFE]!;
    if (!(maxLife > 0)) return;
    const t = Math.min(1, Math.max(0, state[o + P_AGE]! / maxLife));
    const grow = this.start + (this.end - this.start) * Math.min(1, t / 0.65);
    const shrink = t > 0.7 ? Math.max(0.03, 1 - (t - 0.7) / 0.3) : 1;
    state[o + P_SIZE] = grow * shrink;
  }
}

/** Dust motes that always spawn in a jittered slab around the camera. */
class AmbientDustField extends ParticleWorld {
  constructor(private readonly cameraEntity: Entity) {
    super({ name: "dust-ambient", capacity: AMBIENT_DUST_SPRITES, gravity: { x: 0, y: -0.3, z: 0 }, drag: 0.5, seed: 9 });
    const emitter = this.simulation.emitter;
    emitter.rate = 40;
    emitter.lifeMin = 4;
    emitter.lifeMax = 8;
    emitter.size = 0.1;
    emitter.cone = { direction: { x: 0, y: -1, z: 0 }, angle: 2.6, speedMin: 0.25, speedMax: 1.1 };
    emitter.color = { r: 1, g: 1, b: 1, a: 1 };
    this.simulation.modules.push(new SizeOverLifeModule(0.1, 0.01));
  }

  override update(context: Parameters<NonNullable<ParticleWorld["update"]>>[0], dt: number): void {
    const eye = this.cameraEntity.transform.position;
    const emitter = this.simulation.emitter;
    emitter.position.x = eye.x + (Math.random() - 0.5) * 56;
    emitter.position.y = eye.y + Math.random() * 10 - 3;
    emitter.position.z = eye.z + (Math.random() - 0.5) * 56;
    super.update(context, dt);
  }
}

/** Kick-up behind the rear hubs while the rover rolls: rate follows speed, direction the heading. */
class WheelKickDust extends ParticleWorld {
  constructor(private readonly sampleKick: () => { x: number; y: number; z: number; fx: number; fz: number; speed: number } | null) {
    super({ name: "dust-kick", capacity: KICK_DUST_SPRITES, gravity: { x: 0, y: -1.7, z: 0 }, drag: 1.1, seed: 11 });
    const emitter = this.simulation.emitter;
    emitter.rate = 0;
    emitter.lifeMin = 0.55;
    emitter.lifeMax = 1.2;
    emitter.size = 0.12;
    emitter.cone = { direction: { x: 0, y: 1, z: 0 }, angle: 0.55, speedMin: 1.6, speedMax: 4 };
    emitter.color = { r: 1, g: 1, b: 1, a: 1 };
    this.simulation.modules.push(new DustPuffSizeModule(0.1, 0.8));
  }

  override update(context: Parameters<NonNullable<ParticleWorld["update"]>>[0], dt: number): void {
    const kick = this.sampleKick();
    const emitter = this.simulation.emitter;
    if (kick && kick.speed > 0.7) {
      emitter.position.x = kick.x;
      emitter.position.y = kick.y;
      emitter.position.z = kick.z;
      // Back along the heading, tilted up: a rooster tail behind the wheels.
      const len = Math.hypot(kick.fx, 1.15, kick.fz) || 1;
      emitter.cone.direction.x = -kick.fx / len;
      emitter.cone.direction.y = 1.15 / len;
      emitter.cone.direction.z = -kick.fz / len;
      emitter.rate = 30 + Math.min(kick.speed / 7, 1) * 280;
    } else {
      emitter.rate = 0;
    }
    super.update(context, dt);
  }
}

export function buildMarsShowcaseScene(engine: Engine): MarsShowcaseSceneHandle {
  const scene = new Scene({ name: "mars-showcase" });

  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.0;
  scene.settings.bloom.intensity = 0.05;

  // Mars sky (terrain demo's recipe, medium quality — the horizon and the rover share the frame).
  const marsAtmosphere = createAtmosphere({}, MARS_ATMOSPHERE);
  scene.setSky({ atmosphere: marsAtmosphere, quality: "medium", sunIntensity: 20 });
  const sunDirection = new Vec3(200, 300, 200).normalize();
  const horizon = new AtmosphereModel(marsAtmosphere).horizonColor(sunDirection, 0, new Float64Array(3));
  scene.setFog("exp2", {
    density: 0.0014,
    color: new Color(horizon[0]!, horizon[1]!, horizon[2]!),
  });

  scene.settings.shadow.enabled = true;
  scene.settings.shadow.cascades = 3;
  scene.settings.shadow.mapSize = 2048;
  scene.settings.shadow.distance = 250;
  scene.settings.shadow.splitLambda = 0.7;

  // Terrain: the Phase 4 preset + warm-up burst so the first frame already shows the valley.
  const gpu = engine.gpu;
  let marsMaps: PbrTextureSet | null = createMarsRegolithTextures(gpu, 512);
  const terrainMat = new Material({
    label: "showcase-regolith",
    color: marsMaps ? Color.fromSrgbHex(0xffffff) : Color.fromSrgbHex(0xc25127),
    roughness: marsMaps ? 1.0 : 0.88,
    metallic: 0.04,
    tiling: marsMaps ? [16, 16] : undefined,
    albedoMap: marsMaps?.albedo ?? null,
    normalMap: marsMaps?.normal ?? null,
    metallicRoughnessMap: marsMaps?.metallicRoughness ?? null,
    normalScale: 1.6,
  });
  const heightOptions = {
    amplitude: 65,
    frequency: 1 / 260,
    octaves: 6,
    ridgeWeight: 0.45,
  };
  const pipeline = new GeneratorPipeline()
    .addStage(new HeightGenerator(heightOptions))
    .addStage(new CraterGenerator({ density: 0.5, minRadius: 18, maxRadius: 55, depthRatio: 0.32, rimRatio: 0.16 }))
    .addStage(new CraterGenerator({ density: 0.7, minRadius: 6, maxRadius: 16, depthRatio: 0.25, rimRatio: 0.12 }))
    .addStage(new ErosionGenerator({ iterations: 2, talusAngle: 0.65 }))
    .addStage(new BiomeGenerator())
    .addStage(new ScatterGenerator());
  const terrain = new TerrainWorld({
    seed: 42137,
    chunkSize: 128,
    chunkResolution: 33,
    viewDistance: 1024,
    maxLOD: 3,
    maxChunksLoaded: 220,
    maxGenerationsPerFrame: 2,
    warmUpChunks: 48,
    material: terrainMat,
    pipeline,
    heightOptions,
  });
  scene.add(terrain);

  // Sun + rust-coloured bounce fill (terrain demo's lights).
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(200, 300, 200));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 4.2;
  sun.castShadow = true;
  sun.setColor(1.0, 0.92, 0.8);
  sun.shadowBias = 0.001;
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  const fillEntity = scene.createTransformedEntity("ambient-fill", new Vec3(-200, -300, -200));
  const fill = new Light();
  fill.kind = "directional";
  fill.intensity = 0.8;
  fill.castShadow = false;
  fill.setColor(0.36, 0.2, 0.16);
  scene.world.addComponent(fillEntity.id, fill);
  fillEntity.transform.lookAt(new Vec3(0, 0, 0));

  // Camera: chase framing; `followTarget` tracks the chassis and the surface clamp glides over
  // the terrain (keyboard pan off — the scene binds WASD to the rover).
  const groundY = terrain.getHeightAt(SPAWN_X, SPAWN_Z);
  // Pin the sky's observer height to the surface the rover stands on. With `seaLevel` left at 0 the
  // atmosphere treats the camera as tens of metres above the virtual planet ground while the mesh
  // sits at `groundY`, and on tall phone viewports that mismatch reads as a flat beige disc with
  // the rover lost in the haze.
  scene.settings.sky.seaLevel = groundY;
  // Seed streaming focus on the spawn before the first engine update copies the camera — warm-up
  // then fills the disc under the rover instead of whatever default eye the orbit controller had.
  terrain.focusPosition.set(SPAWN_X, groundY, SPAWN_Z);
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(SPAWN_X - 8, groundY + 5, SPAWN_Z - 10));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.35;
  camera.far = 8000;
  scene.world.addComponent(cameraEntity.id, camera);
  // A touch more fill so the white rover and rusty regolith separate from the butterscotch sky on
  // devices that crush HDR highlights (iOS Safari WebGPU has been seen to present a haze-only frame
  // when the directional response is weak).
  scene.settings.ambientColor.set(0.22, 0.18, 0.14);
  scene.settings.ambientIntensity = 1.15;

  // ---------------------------------------------------------------- rover (six wheels)
  const ground = heightFunctionGround((x, z) => terrain.getHeightAt(x, z));
  const config = {
    ...createVehicleConfig({
      mass: 1025,
      gravity: 3.72,
      mu: 0.9,
      wheelRadius: WHEEL_RADIUS,
      wheelbase: 2.26,
      track: 2.18,
      cgToFront: 1.095,
      cgHeight: 0.54,
      springRate: WHEEL_SPRING_RATE,
      damperRate: 2 * Math.sqrt(WHEEL_SPRING_RATE * (1025 / 6)) * 0.55,
      aero: null,
      maxBrakeTorque: 3600,
    }),
    wheels: WHEELS.map((w) => ({
      x: w.x,
      z: w.z,
      steered: w.steered,
      driven: w.driven,
      handbrake: w.handbrake,
    })),
  };
  config.suspensionRest = 0.32;
  config.suspensionTravel = 0.16;
  config.maxSteerAngle = 0.62;
  const vehicle = new Vehicle(config);
  vehicle.position.x = SPAWN_X;
  vehicle.position.z = SPAWN_Z;
  vehicle.placeOnGround(ground);
  // Local Y that puts the model's ground plane on the terrain at equilibrium (≈ radius + rest − sag).
  const bodyOffsetY = terrain.getHeightAt(SPAWN_X, SPAWN_Z) - vehicle.position.y;

  scene.world.registerSystem(new VehicleSystem());

  const placeholderBodyMesh = createBox(gpu, { width: 1.5, height: 0.6, depth: 3.2 });
  const placeholderBodyMaterial = new Material({ label: "rover-placeholder", color: 0xd8d2c4, roughness: 0.55, metallic: 0.1 });
  const chassis = scene.createTransformedEntity(
    "rover-chassis",
    new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z),
  );
  const placeholderBody = new Renderable();
  placeholderBody.geometry = placeholderBodyMesh;
  placeholderBody.material = placeholderBodyMaterial;
  scene.world.addComponent(chassis.id, placeholderBody);

  const placeholderWheelMesh = createBox(gpu, { width: 0.3, height: 0.5, depth: 0.5 });
  const placeholderWheelMaterial = new Material({ label: "rover-wheel-placeholder", color: 0x4a4a4e, roughness: 0.8, metallic: 0.05 });
  const wheelRoots: Entity[] = [];
  const wheelIds: number[] = [];
  for (let i = 0; i < WHEELS.length; i++) {
    const wheel = scene.createTransformedEntity(`rover-${WHEELS[i]!.name}`, new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z));
    const renderable = new Renderable();
    renderable.geometry = placeholderWheelMesh;
    renderable.material = placeholderWheelMaterial;
    renderable.castShadow = true;
    scene.world.addComponent(wheel.id, renderable);
    wheelRoots.push(wheel);
    wheelIds.push(wheel.id);
  }

  const component = new VehicleComponent(vehicle, ground);
  component.wheelEntities = wheelIds;
  chassis.add(component);

  // ---------------------------------------------------------------- dust (ambient + wheel kick)
  const forward = (): { fx: number; fz: number } => ({ fx: Math.sin(vehicle.yaw), fz: Math.cos(vehicle.yaw) });
  const sampleKick = (): { x: number; y: number; z: number; fx: number; fz: number; speed: number } | null => {
    // Rear axle hubs: the wheels that throw the visible plume under throttle.
    const rear = vehicle.wheels[4];
    if (!rear) return null;
    const { fx, fz } = forward();
    return { x: rear.contactX - fx * 0.3, y: rear.contactY + 0.08, z: rear.contactZ - fz * 0.3, fx, fz, speed: vehicle.speed };
  };

  const ambientDust = new AmbientDustField(cameraEntity);
  scene.add(ambientDust);
  const kickDust = new WheelKickDust(sampleKick);
  scene.add(kickDust);

  const dustMesh = createBox(gpu, { width: 1, height: 1, depth: 1 });
  const ambientDustMaterial = Material.unlit({ label: "dust-ambient", color: 0xc4a17e, opacity: 0.11, transparent: true });
  const kickDustMaterial = Material.unlit({ label: "dust-kick", color: 0xd9c1a0, opacity: 0.5, transparent: true });
  const spawnSprites = (world: ParticleWorld, count: number, material: Material, prefix: string): void => {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const mote = scene.createTransformedEntity(`${prefix}-${i}`, new Vec3(0, -400, 0));
      const renderable = new Renderable();
      renderable.geometry = dustMesh;
      renderable.material = material;
      renderable.castShadow = false;
      renderable.receiveShadow = false;
      renderable.visible = false;
      scene.world.addComponent(mote.id, renderable);
      ids.push(mote.id);
    }
    world.spriteEntities = ids;
  };
  spawnSprites(ambientDust, AMBIENT_DUST_SPRITES, ambientDustMaterial, "dust-mote");
  spawnSprites(kickDust, KICK_DUST_SPRITES, kickDustMaterial, "dust-puff");

  // ---------------------------------------------------------------- NASA GLB (async swap-in)
  let modelLoaded = false;
  let modelError: string | null = null;
  let loaded: LoadedGlb | null = null;
  let disposed = false;

  const attachGlb = (glb: LoadedGlb): void => {
    // Body: drop the placeholder box, parent the model-root-space parts under the chassis with the
    // ground-plane offset (chassis sits at the CG, the model at its ground-centred origin).
    scene.world.removeComponent(chassis.id, Renderable);
    for (const part of glb.body) {
      const child = scene.createTransformedEntity(`rover-body-${part.name}`, new Vec3(0, bodyOffsetY, 0));
      chassis.addChild(child);
      child.transform.position = new Vec3(0, bodyOffsetY, 0);
      const renderable = new Renderable();
      renderable.geometry = part.geometry;
      renderable.material = part.material;
      renderable.castShadow = true;
      renderable.receiveShadow = true;
      scene.world.addComponent(child.id, renderable);
    }
    // Wheels: hub-centred parts become children of the system-posed wheel roots (identity local).
    const byName = new Map(glb.wheels.map((w) => [w.name, w]));
    for (let i = 0; i < WHEELS.length; i++) {
      const spec = WHEELS[i]!;
      const root = wheelRoots[i]!;
      const wheel = byName.get(spec.name);
      if (!wheel) continue;
      scene.world.removeComponent(root.id, Renderable);
      for (const part of wheel.parts) {
        const child = scene.createTransformedEntity(`rover-${spec.name}-part`, new Vec3(0, 0, 0));
        root.addChild(child);
        child.transform.position = new Vec3(0, 0, 0);
        const renderable = new Renderable();
        renderable.geometry = part.geometry;
        renderable.material = part.material;
        renderable.castShadow = true;
        renderable.receiveShadow = true;
        scene.world.addComponent(child.id, renderable);
      }
    }
  };

  const modelUrl = new URL("../../assets/Perseverance.glb", import.meta.url).href;
  loadGlb(gpu, modelUrl)
    .then((glb) => {
      if (disposed) {
        glb.dispose();
        return;
      }
      loaded = glb;
      modelLoaded = true;
      attachGlb(glb);
    })
    .catch((error: unknown) => {
      modelError = error instanceof Error ? error.message : String(error);
      console.error("mars showcase: rover model failed to load, keeping the placeholder", error);
    });

  // ---------------------------------------------------------------- input (playground pattern)
  const keys = new Set<string>();
  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const touch = attachVehicleTouch(document.getElementById("vehicle-touch"));

  return {
    scene,
    cameraEntity,
    controlsHint: "WASD / arrows drive · Space handbrake · Drag to orbit · Scroll zoom",
    camera: {
      target: new Vec3(SPAWN_X, groundY + 1.35, SPAWN_Z),
      // Keep the rover large enough to read immediately on laptop/phone-sized canvases; users can
      // still zoom out for a wider terrain view. Elevation stays modest so tall (portrait) viewports
      // show ground under the chassis instead of a sky-only beige slab.
      distance: 8.5,
      minDistance: 3.5,
      maxDistance: 120,
      azimuth: 0.55,
      elevation: 0.28,
      // Follow-cam clearance: 2 m used to hoist the orbit target above the chassis every frame and
      // tip the eye toward the horizon haze on phone aspect ratios.
      groundClearance: 0.85,
      groundHeight: (x, z) => terrain.getHeightAt(x, z),
      keyboard: false,
    },
    followTarget: () => ({ x: vehicle.position.x, y: vehicle.position.y + 1.35, z: vehicle.position.z }),
    update(): void {
      const pad = touch.sample();
      const keyThrottle = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
      const keyBrake = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
      const keySteer =
        (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      vehicle.input.throttle = Math.max(keyThrottle, pad.throttle);
      vehicle.input.brake = Math.max(keyBrake, pad.brake);
      vehicle.input.steer = Math.max(-1, Math.min(1, keySteer + pad.steer));
      vehicle.input.handbrake = keys.has("Space") ? 1 : 0;
    },
    overlay(): string {
      const gear = vehicle.gear === 0 ? "N" : String(vehicle.gear);
      const contact = vehicle.wheels.filter((w) => w.inContact).length;
      const model = modelLoaded ? "GLB ok" : modelError ? `GLB failed: ${modelError}` : "GLB loading…";
      return (
        `mars showcase · Perseverance 6/6 · ${model}\n` +
        `speed ${(vehicle.speed * 3.6).toFixed(1)} km/h  gear ${gear}  rpm ${vehicle.rpm.toFixed(0)}  wheels ${contact}/6\n` +
        `pos ${vehicle.position.x.toFixed(1)}, ${vehicle.position.y.toFixed(1)}, ${vehicle.position.z.toFixed(1)}  ` +
        `dust ${ambientDust.simulation.alive}+${kickDust.simulation.alive}  NASA/JPL-Caltech (public domain)`
      );
    },
    vehicleState: () => ({
      speed: vehicle.speed,
      rpm: vehicle.rpm,
      gear: vehicle.gear,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
    }),
    marsState: () => ({
      modelLoaded,
      modelError,
      wheelCount: vehicle.wheels.length,
      contactWheels: vehicle.wheels.filter((w) => w.inContact).length,
      ambientDust: ambientDust.simulation.alive,
      kickDust: kickDust.simulation.alive,
      speed: vehicle.speed,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
    }),
    dispose(): void {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      keys.clear();
      loaded?.dispose();
      loaded = null;
      placeholderBodyMesh.dispose();
      placeholderBodyMaterial.dispose();
      placeholderWheelMesh.dispose();
      placeholderWheelMaterial.dispose();
      dustMesh.dispose();
      ambientDustMaterial.dispose();
      kickDustMaterial.dispose();
      terrainMat.dispose();
      disposePbrTextureSet(marsMaps);
      marsMaps = null;
      scene.dispose();
    },
  };
}
