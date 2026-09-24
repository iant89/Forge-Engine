/**
 * Phase 6 playground. A flat pad runs into a 12° ramp (the same angle the slope-traversal test uses).
 *
 * `VehicleSystem` is registered once on this scene's world and is the only thing that calls
 * `vehicle.step`. `update` writes `vehicle.input` and nothing else — a second step here would
 * double-integrate. Orbit keyboard pan is off (`camera.keyboard: false`) because both listeners sit
 * on `window` and WASD would otherwise pan the camera instead of driving.
 */

import {
  Camera,
  Color,
  type Engine,
  type GroundQuery,
  type GroundSample,
  Light,
  Material,
  Quat,
  Renderable,
  Scene,
  Vec3,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  createBox,
  createPlane,
  createVehicleConfig,
} from "@forge/engine";
import type { DemoSceneHandle } from "./cubesScene.js";
import { attachVehicleTouch } from "../controls/vehicleTouch.js";

const RAMP_START = 18;
const RAMP_ANGLE = (12 * Math.PI) / 180;
const RAMP_DEPTH = 40;

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

  // Once. The world's TransformSystem is already registered; this runs before it.
  scene.world.registerSystem(new VehicleSystem());

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

  const wheelMesh = createBox(engine.gpu, { width: 0.32, height: 0.68, depth: 0.68 });
  const wheelMaterial = new Material({ label: "wheel", color: 0x6b7280, roughness: 0.65, metallic: 0.08 });
  const wheelIds: number[] = [];
  for (let i = 0; i < 4; i++) {
    const wheel = scene.createTransformedEntity(`wheel-${i}`, new Vec3(vehicle.position.x, vehicle.position.y, vehicle.position.z));
    const renderable = new Renderable();
    renderable.geometry = wheelMesh;
    renderable.material = wheelMaterial;
    scene.world.addComponent(wheel.id, renderable);
    wheelIds.push(wheel.id);
  }

  const component = new VehicleComponent(vehicle, ground);
  component.wheelEntities = wheelIds;
  body.add(component);

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
      return `speed ${(vehicle.speed * 3.6).toFixed(1)} km/h  gear ${gear}  rpm ${vehicle.rpm.toFixed(0)}${park}\npos ${vehicle.position.x.toFixed(1)}, ${vehicle.position.y.toFixed(1)}, ${vehicle.position.z.toFixed(1)}`;
    },
    vehicleState: () => ({
      speed: vehicle.speed,
      rpm: vehicle.rpm,
      gear: vehicle.gear,
      x: vehicle.position.x,
      y: vehicle.position.y,
      z: vehicle.position.z,
      parkingBrake: parkingBrake ? 1 : 0,
    }),
    dispose(): void {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      touch.dispose();
      keys.clear();
      bodyMesh.dispose();
      cabinMesh.dispose();
      wheelMesh.dispose();
      postMesh.dispose();
      padMesh.dispose();
      rampMesh.dispose();
      scene.dispose();
    },
  };
}
