/**
 * Phase 6 playground. A flat pad runs into a 12° ramp (the same angle the slope-traversal test uses).
 *
 * `VehicleSystem` is registered once on this scene's world and is the only thing that calls
 * `vehicle.step`. `update` writes `vehicle.input` and nothing else — a second step here would
 * double-integrate. Orbit keyboard pan is off (`camera.keyboard: false`) because both listeners sit
 * on `window` and WASD would otherwise pan the camera instead of driving.
 *
 * Since Phase 16.6 the wheels are mechanical assemblies rather than one box per corner: a hub
 * carrier that rides the suspension travel, a steering knuckle that yaws with the wheel's own
 * Ackermann angle, an axle that rolls at the odometer the tire integrated, and an arm + damper that
 * track the hub. `MechanicalSystem` poses them from `VehicleWheelSource` telemetry, so the geometry
 * this file builds is a hierarchy while the physics stays exactly the model the other suites pin —
 * the vehicle is still stepped once, in `VehicleSystem`.
 */

import {
  Camera,
  Color,
  type Engine,
  type Entity,
  type GroundQuery,
  type GroundSample,
  Light,
  Material,
  type MechanicalChannelSource,
  MechanicalRig,
  MechanicalRigComponent,
  MechanicalSystem,
  Quat,
  Renderable,
  Scene,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  VehicleWheelSource,
  createBox,
  createCylinder,
  createPlane,
  createVehicleConfig,
  createVehicleWheelRig,
  wheelChannelName,
  wheelHubRestPosition,
  type WheelRigMounts,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";

const RAMP_START = 18;
const RAMP_ANGLE = (12 * Math.PI) / 180;
const RAMP_DEPTH = 40;

/** Tire width (the cylinder's height once it is laid on its side). */
const WHEEL_WIDTH = 0.26;
/** Grouser blocks around the tire: what makes the spin readable on a smooth cylinder. */
const CLEAT_COUNT = 14;
/** Wheel-nut blocks on the outboard face — the second spin tell, and cheap. */
const BOLT_COUNT = 8;

function playgroundGround(): GroundQuery {
  const slope = Math.tan(RAMP_ANGLE);
  const invLen = 1 / Math.hypot(slope, 1);
  return {
    sample(_x: number, z: number, out: GroundSample): void {
      if (z < RAMP_START) {
        out.height = 0;
        out.nx = 0;
        out.ny = 1;
        out.nz = 0;
        return;
      }
      out.height = (z - RAMP_START) * slope;
      out.nx = 0;
      out.ny = invLen;
      out.nz = -slope * invLen;
    },
  };
}

export function buildVehiclePlaygroundScene(engine: Engine): DemoSceneHandle {
  const scene = new Scene({ name: "vehicle-playground" });
  scene.setBackgroundColor(Color.fromSrgbHex(0x0b1016));
  scene.settings.hdr = true;
  scene.settings.exposure = 1.1;
  scene.settings.bloom.enabled = false;
  scene.settings.shadow.distance = 80;

  // Once each. The world's TransformSystem is already registered; these run before it.
  scene.world.registerSystem(new VehicleSystem());
  scene.world.registerSystem(new MechanicalSystem());

  const ground = playgroundGround();
  const heightScratch: GroundSample = { height: 0, nx: 0, ny: 1, nz: 0 };
  const heightAt = (x: number, z: number): number => {
    ground.sample(x, z, heightScratch);
    return heightScratch.height;
  };

  const padMesh = createPlane(engine.gpu, { width: 48, depth: 48 });
  const pad = scene.createTransformedEntity("pad", new Vec3(0, 0, -6));
  const padRenderable = new Renderable();
  padRenderable.geometry = padMesh;
  padRenderable.material = new Material({ label: "pad", color: 0x3d4a56, roughness: 0.92, metallic: 0 });
  padRenderable.castShadow = false;
  scene.world.addComponent(pad.id, padRenderable);

  // Plane is centered on its entity. Rx(-θ) lifts the +Z edge; the entity origin is placed so the
  // -Z edge sits on the pad at z = RAMP_START, y = 0, which is the ground query's kink.
  const rampMesh = createPlane(engine.gpu, { width: 16, depth: RAMP_DEPTH });
  const half = RAMP_DEPTH * 0.5;
  const ramp = scene.createTransformedEntity(
    "ramp",
    new Vec3(0, half * Math.sin(RAMP_ANGLE), RAMP_START + half * Math.cos(RAMP_ANGLE)),
  );
  ramp.transform.rotation = new Quat().setEulerComponents(-RAMP_ANGLE, 0, 0);
  const rampRenderable = new Renderable();
  rampRenderable.geometry = rampMesh;
  rampRenderable.material = new Material({ label: "ramp", color: 0x5a4638, roughness: 0.88, metallic: 0 });
  rampRenderable.castShadow = false;
  scene.world.addComponent(ramp.id, rampRenderable);

  const postMesh = createBox(engine.gpu, { width: 0.25, height: 1.4, depth: 0.25 });
  const postMaterial = new Material({ label: "post", color: 0xe0b040, roughness: 0.45, metallic: 0.05 });
  for (const z of [0, 12, 28, 42]) {
    const post = scene.createTransformedEntity(`post-${z}`, new Vec3(-8, heightAt(-8, z) + 0.7, z));
    const renderable = new Renderable();
    renderable.geometry = postMesh;
    renderable.material = postMaterial;
    scene.world.addComponent(post.id, renderable);
  }

  const vehicle = new Vehicle(createVehicleConfig());
  vehicle.position.z = 6;
  vehicle.placeOnGround(ground);

  // Narrower than the track so the wheels are visible from the chase camera. The box is centred
  // on the CG; a cabin child sits on top of it. Neither changes the sim.
  const bodyMesh = createBox(engine.gpu, { width: 1.35, height: 0.48, depth: 4.2 });
  const body = scene.createTransformedEntity("chassis", new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z));
  const bodyRenderable = new Renderable();
  bodyRenderable.geometry = bodyMesh;
  bodyRenderable.material = new Material({ label: "body", color: 0xc2410c, roughness: 0.35, metallic: 0.12 });
  scene.world.addComponent(body.id, bodyRenderable);

  const cabinMesh = createBox(engine.gpu, { width: 1.2, height: 0.42, depth: 1.7 });
  const cabin = scene.createTransformedEntity("cabin", new Vec3(0, 0.45, -0.25));
  body.addChild(cabin);
  cabin.transform.position = new Vec3(0, 0.45, -0.25);
  const cabinRenderable = new Renderable();
  cabinRenderable.geometry = cabinMesh;
  cabinRenderable.material = new Material({ label: "cabin", color: 0x7c2d12, roughness: 0.4, metallic: 0.05 });
  scene.world.addComponent(cabin.id, cabinRenderable);

  // ---------------------------------------------------------------- wheel assemblies (Phase 16.6)
  // Geometry is shared between the four corners; only the entities differ.
  const wheelRadius = vehicle.config.wheelRadius;
  const tyreMesh = createCylinder(engine.gpu, {
    radiusTop: wheelRadius,
    radiusBottom: wheelRadius,
    height: WHEEL_WIDTH,
    radialSegments: 20,
    capped: true,
  });
  const rimMesh = createCylinder(engine.gpu, {
    radiusTop: wheelRadius * 0.62,
    radiusBottom: wheelRadius * 0.62,
    height: WHEEL_WIDTH * 0.72,
    radialSegments: 16,
    capped: true,
  });
  const cleatMesh = createBox(engine.gpu, { width: WHEEL_WIDTH + 0.01, height: 0.045, depth: 0.075 });
  const boltMesh = createBox(engine.gpu, { width: 0.03, height: 0.05, depth: 0.05 });
  const uprightMesh = createBox(engine.gpu, { width: 0.1, height: 0.24, depth: 0.16 });
  const linkMesh = createBox(engine.gpu, { width: 0.07, height: 0.05, depth: 1 }); // depth set per wheel
  const shockMesh = createBox(engine.gpu, { width: 0.05, height: 0.05, depth: 1 });

  const tyreMaterial = new Material({ label: "tyre", color: 0x1d2126, roughness: 0.92, metallic: 0 });
  const rimMaterial = new Material({ label: "rim", color: 0xb6bdc6, roughness: 0.34, metallic: 0.85 });
  const cleatMaterial = new Material({ label: "cleat", color: 0x0f1113, roughness: 1, metallic: 0 });
  const boltMaterial = new Material({ label: "wheel-nut", color: 0x8a939c, roughness: 0.4, metallic: 0.8 });
  const uprightMaterial = new Material({ label: "upright", color: 0x4b5563, roughness: 0.55, metallic: 0.35 });
  const linkMaterial = new Material({ label: "suspension-arm", color: 0xc2683a, roughness: 0.5, metallic: 0.25 });
  const shockMaterial = new Material({ label: "damper", color: 0xd9dde2, roughness: 0.35, metallic: 0.7 });

  /** Add a renderable part: geometry + material on a fresh child of `parent`. */
  const part = (name: string, parent: Entity, geometry: ReturnType<typeof createBox>, material: Material, at: Vec3, rotation?: Quat): Entity => {
    const entity = scene.createTransformedEntity(name, at);
    parent.addChild(entity);
    entity.transform.position = at;
    if (rotation) entity.transform.rotation = rotation;
    const renderable = new Renderable();
    renderable.geometry = geometry;
    renderable.material = material;
    renderable.castShadow = true;
    renderable.receiveShadow = true;
    scene.world.addComponent(entity.id, renderable);
    return entity;
  };

  // The tire's cylinder axis is +Y; a −90° Z rotation lays it along the axle's local +X.
  const layCylinder = new Quat().setAxisAngle(new Vec3(0, 0, 1), -Math.PI / 2);
  const rest = new Vec3();
  const mounts: WheelRigMounts[] = [];
  const rig = new MechanicalRig(scene.world);

  for (let i = 0; i < vehicle.wheels.length; i++) {
    const wheel = vehicle.wheels[i]!;
    const side = wheel.x < 0 ? -1 : 1;
    wheelHubRestPosition(vehicle, i, rest);

    // Hub carrier: authored at full droop, driven along +Y by the suspension compression.
    const hub = scene.createTransformedEntity(`wheel-${i}-hub`, rest.clone());
    body.addChild(hub);
    hub.transform.position = rest.clone();

    // Steering knuckle (the wheel's own Ackermann angle) — the upright geometry yaws with it.
    const knuckle = scene.createTransformedEntity(`wheel-${i}-knuckle`, new Vec3(0, 0, 0));
    hub.addChild(knuckle);
    knuckle.transform.position = new Vec3(0, 0, 0);
    part(
      `wheel-${i}-upright`,
      knuckle,
      uprightMesh,
      uprightMaterial,
      new Vec3(-side * (WHEEL_WIDTH * 0.5 + 0.07), 0, 0),
    );

    // Axle: spins at the tire's odometer (sign-flipped on the left by the rig).
    const axle = scene.createTransformedEntity(`wheel-${i}-axle`, new Vec3(0, 0, 0));
    knuckle.addChild(axle);
    axle.transform.position = new Vec3(0, 0, 0);
    part(`wheel-${i}-tyre`, axle, tyreMesh, tyreMaterial, new Vec3(0, 0, 0), layCylinder);
    part(`wheel-${i}-rim`, axle, rimMesh, rimMaterial, new Vec3(0, 0, 0), layCylinder);
    for (let c = 0; c < CLEAT_COUNT; c++) {
      const angle = (c / CLEAT_COUNT) * Math.PI * 2;
      part(
        `wheel-${i}-cleat-${c}`,
        axle,
        cleatMesh,
        cleatMaterial,
        new Vec3(0, wheelRadius * Math.cos(angle), wheelRadius * Math.sin(angle)),
        new Quat().setAxisAngle(new Vec3(1, 0, 0), angle),
      );
    }
    for (let b = 0; b < BOLT_COUNT; b++) {
      const angle = (b / BOLT_COUNT) * Math.PI * 2;
      const radius = wheelRadius * 0.4;
      part(
        `wheel-${i}-bolt-${b}`,
        axle,
        boltMesh,
        boltMaterial,
        new Vec3(side * (WHEEL_WIDTH * 0.5 + 0.02), radius * Math.cos(angle), radius * Math.sin(angle)),
        new Quat().setAxisAngle(new Vec3(1, 0, 0), angle),
      );
    }

    // Trailing arm: hinged inboard of the hub, link authored along +Z, aimed at the hub carrier.
    // A link that reaches the hub has to telescope (the model moves the hub along the body up-axis,
    // not on the arm's arc), which is what the joint's `stretch` does.
    const pivotX = rest.x;
    const pivotY = -0.02;
    const pivotZ = rest.z - Math.sign(rest.z) * 0.52;
    const arm = scene.createTransformedEntity(`wheel-${i}-arm`, new Vec3(pivotX, pivotY, pivotZ));
    body.addChild(arm);
    arm.transform.position = new Vec3(pivotX, pivotY, pivotZ);
    const armLength = Math.hypot(rest.x - pivotX, -vehicle.config.suspensionRest - pivotY, rest.z - pivotZ);
    const armLink = part(`wheel-${i}-arm-link`, arm, linkMesh, linkMaterial, new Vec3(0, 0, armLength * 0.5));
    armLink.transform.scale = new Vec3(1, 1, armLength);

    // Damper: from the body's lower shoulder down to the hub; the same aim solve, always
    // telescoping. It stays in the wheel's own plane (the same x as the hub) because the joint is a
    // hinge about X: a lateral offset could not be reached by a 1-DOF link.
    const shockX = rest.x;
    const shockY = 0.04;
    const shockZ = rest.z + Math.sign(rest.z) * 0.06;
    const shock = scene.createTransformedEntity(`wheel-${i}-shock`, new Vec3(shockX, shockY, shockZ));
    body.addChild(shock);
    shock.transform.position = new Vec3(shockX, shockY, shockZ);
    const shockLength = Math.hypot(rest.x - shockX, -vehicle.config.suspensionRest - shockY, rest.z - shockZ);
    const shockRod = part(`wheel-${i}-shock-rod`, shock, shockMesh, shockMaterial, new Vec3(0, 0, shockLength * 0.5));
    shockRod.transform.scale = new Vec3(1, 1, shockLength);

    mounts.push({ travel: hub.id, steer: knuckle.id, spin: axle.id, arm: arm.id, shock: shock.id });
  }

  // One rig for all four corners, driven from wheel telemetry by the mechanical system. Joint order
  // per wheel is travel → steer → spin → arm → shock, so the two links solve against the carrier
  // pose from the same frame (see `createVehicleWheelRig`).
  createVehicleWheelRig(rig, vehicle, mounts);

  const vehicleSource = new VehicleWheelSource(vehicle);
  /** Gate/test seam: pose the rig from fixed values instead of telemetry (deterministic pixels). */
  let wheelOverride: { steer: number; travel: number; spin: number } | null = null;
  const source: MechanicalChannelSource = {
    writeChannels(target) {
      vehicleSource.writeChannels(target);
      if (wheelOverride) {
        for (let i = 0; i < vehicle.wheels.length; i++) {
          // Only the steered corners yaw: the rear knuckles stay straight, which is what the
          // per-wheel Ackermann solve does and what the gate asserts on the posed values.
          target.setChannel(wheelChannelName("wheel", i, "steer"), vehicle.wheels[i]!.steered ? wheelOverride.steer : 0);
          target.setChannel(wheelChannelName("wheel", i, "travel"), wheelOverride.travel);
          target.setChannel(wheelChannelName("wheel", i, "spin"), wheelOverride.spin);
        }
      }
    },
  };

  const component = new VehicleComponent(vehicle, ground);
  body.add(component);
  body.add(new MechanicalRigComponent(rig, source));

  // The parking brake is a *state*: tapped on the pad or pressed on P, and it stays engaged until
  // the same button releases it. The touch pad's lamp is driven from here, not by the button.
  let parkingBrake = false;
  const setParkingBrake = (on: boolean): void => {
    parkingBrake = on;
    touch.setPark(parkingBrake);
  };

  const keys = new Set<string>();
  const onKeyDown = (event: KeyboardEvent): void => {
    keys.add(event.code);
    if (event.code === "KeyP" && !event.repeat) setParkingBrake(!parkingBrake);
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const touch = attachVehicleTouch(document.getElementById("vehicle-touch"), {
    onParkToggle: () => setParkingBrake(!parkingBrake),
  });

  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(-8, 4.5, -4));
  const camera = new Camera();
  camera.fovY = Math.PI / 3;
  camera.near = 0.1;
  camera.far = 400;
  scene.world.addComponent(cameraEntity.id, camera);
  cameraEntity.transform.lookAt(new Vec3(0, 1, 6));

  const sunEntity = scene.createTransformedEntity("sun", new Vec3(12, 18, -10));
  const sun = new Light();
  sun.kind = "directional";
  sun.intensity = 5;
  sun.castShadow = true;
  sun.cascades = 3;
  sun.setColor(1, 0.97, 0.9);
  scene.world.addComponent(sunEntity.id, sun);
  sunEntity.transform.lookAt(new Vec3(0, 0, 0));

  /** Posed joint values in mount order: travel, steer, spin per wheel, then the two links. */
  const mechanicalState = (): {
    joints: number;
    channels: number;
    values: number[];
    steer: number[];
    travel: number[];
    spin: number[];
    saturated: boolean[];
  } => {
    const steer: number[] = [];
    const travel: number[] = [];
    const spin: number[] = [];
    const saturated: boolean[] = [];
    for (let i = 0; i < vehicle.wheels.length; i++) {
      // The *posed* values, not the raw channels: this is what the geometry holds after the rig's
      // ratio/clamp/slew, which is what a gate should compare the pixels against.
      steer.push(rig.valueOf(wheelChannelName("wheel", i, "steer")));
      travel.push(rig.valueOf(wheelChannelName("wheel", i, "travel")));
      spin.push(rig.valueOf(wheelChannelName("wheel", i, "spin")));
      saturated.push(rig.saturatedChannel(wheelChannelName("wheel", i, "steer")));
    }
    const values: number[] = [];
    for (let joint = 0; joint < rig.jointCount; joint++) values.push(rig.valueAt(joint));
    return { joints: rig.jointCount, channels: rig.channelCount, values, steer, travel, spin, saturated };
  };

  return {
    scene,
    cameraEntity,
    controlsHint:
      "WASD / arrows drive · Space handbrake · P parking brake · Drag to orbit · Scroll zoom · camera follows",
    camera: {
      target: new Vec3(0, 1.6, 6),
      distance: 12,
      minDistance: 4,
      maxDistance: 40,
      azimuth: 0.7,
      elevation: 0.42,
      groundHeight: heightAt,
      groundClearance: 1.5,
      keyboard: false,
    },
    followTarget: () => ({ x: vehicle.position.x, y: vehicle.position.y + 1.2, z: vehicle.position.z }),
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
      vehicle.input.parkingBrake = parkingBrake ? 1 : 0;
    },
    overlay(): string {
      const gear = vehicle.gear === 0 ? "N" : String(vehicle.gear);
      const park = parkingBrake ? "  PARK" : "";
      const front = rig.valueOf(wheelChannelName("wheel", 0, "steer"));
      const compression = Math.max(...vehicle.wheels.map((w) => w.compression));
      const spin = rig.valueOf(wheelChannelName("wheel", 0, "spin"));
      return (
        `speed ${(vehicle.speed * 3.6).toFixed(1)} km/h  gear ${gear}  rpm ${vehicle.rpm.toFixed(0)}${park}\n` +
        `pos ${vehicle.position.x.toFixed(1)}, ${vehicle.position.y.toFixed(1)}, ${vehicle.position.z.toFixed(1)}\n` +
        `rig ${rig.jointCount} joints · steer ${((front * 180) / Math.PI).toFixed(0)}° · ` +
        `travel ${(compression * 1000).toFixed(0)} mm · odometer ${spin.toFixed(1)} rad`
      );
    },
    vehicleState: () => ({
      speed: vehicle.speed,
      rpm: vehicle.rpm,
      gear: vehicle.gear,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
      parkingBrake: parkingBrake ? 1 : 0,
      mechanical: mechanicalState(),
    }),
    /** Gate hook: fixed wheel values (or `null` for telemetry) so pixel A/Bs are deterministic. */
    setWheelOverride: (override: { steer: number; travel: number; spin: number } | null) => {
      wheelOverride = override;
    },
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      keys.clear();
      bodyMesh.dispose();
      cabinMesh.dispose();
      postMesh.dispose();
      padMesh.dispose();
      rampMesh.dispose();
      tyreMesh.dispose();
      rimMesh.dispose();
      cleatMesh.dispose();
      boltMesh.dispose();
      uprightMesh.dispose();
      linkMesh.dispose();
      shockMesh.dispose();
      scene.dispose();
    },
  };
}
