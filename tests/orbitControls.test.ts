/**
 * OrbitControls — the demo camera controller.
 *
 * The bug these pin: the controller shipped with one hard-coded zoom range (2..50 m) for every
 * scene, so the terrain preset (120 m out, a 2 km world) was outside its own limits. The first wheel
 * event snapped the distance to 50 m and then clamped the eye to the surface, which read as "cannot
 * zoom, camera stuck at ground level, usually under the map". Each property below is one of the
 * guarantees the fix rests on.
 */
import { describe, expect, it } from "vitest";
import { Camera, Scene, TerrainTile, TerrainWorld, Vec3, type Engine, type Entity } from "@forge/engine";
import { OrbitControls, type OrbitCameraSetup } from "../examples/src/controls/orbitControls.js";
import { buildTerrainScene } from "../examples/src/scenes/terrainScene.js";
import {
  MARS_CHASE_AZIMUTH,
  MARS_CHASE_DISTANCE,
  MARS_CHASE_ELEVATION,
  MARS_CHASE_GROUND_CLEARANCE,
  MARS_CHASE_LOOK_OFFSET_Y,
  MARS_CHASE_MIN_DISTANCE,
} from "../examples/src/scenes/marsShowcaseScene.js";

/** The controller only touches `addEventListener`/`clientHeight`/pointer capture, so a stub beats jsdom. */
function stubCanvas(height = 720): HTMLElement {
  return {
    clientHeight: height,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLElement;
}

function harness(setup: OrbitCameraSetup = {}): { entity: Entity; scene: Scene; controls: OrbitControls } {
  const scene = new Scene({ name: "orbit-controls-test" });
  const entity = scene.createTransformedEntity("camera", new Vec3(0, 0, 0));
  entity.add(new Camera());
  const controls = new OrbitControls(entity, stubCanvas()).configure(setup);
  return { entity, scene, controls };
}

/** Local +Z of the camera's world matrix — where the camera looks (engine convention, `setLookAt`). */
function cameraForward(entity: Entity, scene: Scene): Vec3 {
  scene.world.updateTransforms([], true);
  const m = entity.transform.worldMatrix;
  return new Vec3(m[8]!, m[9]!, m[10]!);
}

describe("OrbitControls - zoom range", () => {
  it("clamps a preset distance into the scene's limits", () => {
    // The low-limit case that broke the terrain demo: a 120 m preset with the default 50 m cap.
    const { controls } = harness({ distance: 120 });
    expect(controls.distance).toBe(50);

    // With the scene's own limits the preset survives untouched.
    const configured = harness({ distance: 120, minDistance: 6, maxDistance: 1200 });
    expect(configured.controls.distance).toBe(120);
  });

  it("zooms out from the starting distance instead of snapping to a limit", () => {
    const { controls } = harness({ distance: 420, minDistance: 6, maxDistance: 1200 });
    const start = controls.distance;
    controls.zoomBy(120); // one wheel notch away from the target
    expect(controls.distance).toBeGreaterThan(start);
    expect(controls.distance).toBeLessThan(controls.maxDistance);
  });

  it("is exponential and bounded at both ends", () => {
    const { controls } = harness({ distance: 100, minDistance: 5, maxDistance: 1000 });

    controls.zoomBy(1000);
    expect(controls.distance).toBe(1000);
    controls.zoomBy(-100000);
    expect(controls.distance).toBe(5);

    // Symmetric in log space: zooming in by the same amount returns to the original distance.
    controls.distance = 100;
    controls.zoomBy(500);
    expect(controls.distance).toBeGreaterThan(100);
    controls.zoomBy(-500);
    expect(controls.distance).toBeCloseTo(100, 6);
  });

  it("scales by wheel delta mode, so a line-scrolling device is not 16x slower", () => {
    const pixels = harness({ distance: 100, minDistance: 5, maxDistance: 10000 });
    const lines = harness({ distance: 100, minDistance: 5, maxDistance: 10000 });
    pixels.controls.zoomBy(16); // one "line" worth of pixels, already normalised
    lines.controls.zoomByFactor(Math.exp(16 * lines.controls.zoomSpeed));
    expect(lines.controls.distance).toBeCloseTo(pixels.controls.distance, 6);
  });
});

describe("OrbitControls - pan", () => {
  it("moves the target in the camera's basis, not along fixed world axes", () => {
    // Looking down +Z (azimuth 0 at the far side of the target): right = +X, up = +Y.
    const { controls } = harness({ distance: 20, azimuth: 0, elevation: 0, minDistance: 1, maxDistance: 100 });
    const startX = controls.target.x;
    controls.panBy(100, 0, 720);
    expect(controls.target.x).toBeLessThan(startX); // dragging right moves the world right
    const xDelta = Math.abs(controls.target.x - startX);
    // Screen-accurate: worldPerPixel = 2·distance·tan(fovY/2) / viewportHeight.
    const expected = (2 * 20 * Math.tan(Math.PI / 6)) / 720;
    expect(xDelta).toBeCloseTo(100 * expected, 6);
    expect(controls.target.z).toBeCloseTo(0, 6);

    // Rotated 90°, the same drag must move the target along Z instead.
    const rotated = harness({ distance: 20, azimuth: Math.PI / 2, elevation: 0, minDistance: 1, maxDistance: 100 });
    rotated.controls.panBy(100, 0, 720);
    expect(Math.abs(rotated.controls.target.z)).toBeCloseTo(100 * expected, 6);
    expect(rotated.controls.target.x).toBeCloseTo(0, 6);
  });

  it("keeps the pan scale tied to the viewport height", () => {
    const tall = harness({ distance: 20, azimuth: 0, elevation: 0, minDistance: 1, maxDistance: 100 });
    const short = harness({ distance: 20, azimuth: 0, elevation: 0, minDistance: 1, maxDistance: 100 });
    tall.controls.panBy(100, 0, 720);
    short.controls.panBy(100, 0, 360);
    expect(Math.abs(short.controls.target.x)).toBeCloseTo(2 * Math.abs(tall.controls.target.x), 6);
  });

  it("follows the cursor: dragging down moves the target up", () => {
    const { controls } = harness({ distance: 20, azimuth: 0, elevation: 0, minDistance: 1, maxDistance: 100 });
    controls.panBy(0, 100, 720);
    expect(controls.target.y).toBeGreaterThan(0);
  });
});

describe("OrbitControls - orbit", () => {
  it("clamps elevation to the configured range", () => {
    const { controls } = harness({ minElevation: -1, maxElevation: 1 });
    controls.orbitBy(0, 1000);
    expect(controls.elevation).toBe(1);
    controls.orbitBy(0, -10000);
    expect(controls.elevation).toBe(-1);
  });

  it("orbits the scene with the cursor (drag right rotates the camera left)", () => {
    const { controls } = harness({ distance: 20, azimuth: 0, elevation: 0 });
    controls.orbitBy(100, 0);
    expect(controls.azimuth).toBeLessThan(0);
  });
});

describe("OrbitControls - ground constraint", () => {
  const plateau: OrbitCameraSetup = {
    distance: 40,
    azimuth: 0.3,
    elevation: 0.2,
    minDistance: 6,
    maxDistance: 400,
    groundHeight: () => 50,
    groundClearance: 4,
  };

  it("holds the orbit target above the surface", () => {
    const { controls } = harness(plateau);
    expect(controls.target.y).toBeGreaterThanOrEqual(54);
  });

  it("never leaves the eye below the surface, at any zoom or elevation", () => {
    const { controls } = harness(plateau);

    for (const zoom of [-100000, -500, 0, 500, 100000]) {
      controls.zoomBy(zoom);
      controls.update();
      expect(controls.eyePosition().y).toBeGreaterThanOrEqual(54);
    }

    controls.orbitBy(0, 100000); // look straight down
    controls.update();
    expect(controls.eyePosition().y).toBeGreaterThanOrEqual(54);

    controls.orbitBy(0, -200000); // and from underneath
    controls.update();
    expect(controls.eyePosition().y).toBeGreaterThanOrEqual(54);
  });

  it("stops a pan that would bury the target", () => {
    const { controls } = harness(plateau);
    controls.panBy(0, -100000, 720); // drag the world up: the target is driven down into the hill
    expect(controls.target.y).toBeGreaterThanOrEqual(54);
    expect(controls.eyePosition().y).toBeGreaterThanOrEqual(54);
  });

  it("orients the camera at the orbit target", () => {
    const { entity, scene, controls } = harness({ distance: 30, azimuth: 0.7, elevation: 0.3, target: new Vec3(0, 5, 0) });
    const forward = cameraForward(entity, scene);
    const toTarget = new Vec3().copyFrom(controls.target).sub(controls.eyePosition()).normalize();
    expect(forward.length()).toBeCloseTo(1, 5);
    expect(forward.x * toTarget.x + forward.y * toTarget.y + forward.z * toTarget.z).toBeCloseTo(1, 5);
  });
});

describe("Terrain demo camera preset", () => {
  const terrainHarness = (): { handle: ReturnType<typeof buildTerrainScene>; controls: OrbitControls } => {
    // The terrain scene never touches the engine while building (geometry is uploaded lazily once the
    // chunk manager is attached to a scene), so a null engine is enough to exercise its preset.
    const handle = buildTerrainScene(null as unknown as Engine);
    const controls = new OrbitControls(handle.cameraEntity, stubCanvas()).configure(handle.camera ?? {});
    return { handle, controls };
  };

  it("starts inside its own zoom range, with room to zoom out", () => {
    const { handle, controls } = terrainHarness();
    const preset = handle.camera!;
    expect(preset.distance!).toBeGreaterThan(preset.minDistance!);
    expect(preset.distance!).toBeLessThan(preset.maxDistance!);
    // The old hard-coded range could not express the scene at all: 120 m start, 50 m cap.
    expect(preset.maxDistance!).toBeGreaterThan(1000);
    expect(controls.distance).toBe(preset.distance);

    // Wheel away from the target: the camera actually gets further away.
    const startDistance = controls.distance;
    controls.zoomBy(240);
    expect(controls.distance).toBeGreaterThan(startDistance);
    handle.dispose?.();
  });

  it("keeps the camera above the terrain at every zoom level", () => {
    const { handle, controls } = terrainHarness();
    const terrain = handle.scene.object<TerrainWorld>("TerrainWorld")!;
    expect(terrain).toBeDefined();

    for (const zoom of [-100000, -2000, -240, 240, 240, 100000]) {
      controls.zoomBy(zoom);
      controls.update();
      const eye = controls.eyePosition();
      expect(eye.y).toBeGreaterThanOrEqual(terrain.getHeightAt(eye.x, eye.z) + 4 - 1e-6);
      expect(controls.state().altitude!).toBeGreaterThanOrEqual(4 - 1e-6);
    }
    handle.dispose?.();
  });

  it("answers elevation queries with the surface the mesh is built from, not the bare noise", () => {
    const { handle } = terrainHarness();
    const terrain = handle.scene.object<TerrainWorld>("TerrainWorld")!;
    const size = terrain.chunkSize;
    const resolution = terrain.chunkResolution;

    // Cell (0,0) is the demo's starting framing; (-2,0) is a cell where the crater and erosion
    // stages actually move the grid (up to ~26 m on this seed), which is the case that used to
    // bury the camera: the ground clamp sampled the bare noise while the mesh had a crater in it.
    let worstGeneratorDelta = 0;
    for (const [cx, cz] of [[0, 0], [-2, 0]] as const) {
      const tile = new TerrainTile({ cx, cz, size, resolution }, terrain.pipeline, terrain.seed);
      expect(terrain.chunks.get(`${cx}:${cz}:0`)?.tile).toBeUndefined(); // nothing resident

      for (let j = 1; j < resolution - 1; j += 5) {
        for (let i = 1; i < resolution - 1; i += 5) {
          const x = cx * size + (i / (resolution - 1)) * size;
          const z = cz * size + (j / (resolution - 1)) * size;
          const surface = tile.heightmap.getHeight(x, z);
          // The query answers with the generated surface, not with the bare `HeightGenerator`.
          expect(terrain.getHeightAt(x, z)).toBeCloseTo(surface, 6);
          worstGeneratorDelta = Math.max(
            worstGeneratorDelta,
            Math.abs(terrain.heightGenerator.sampleHeight(x, z, terrain.seed) - surface),
          );
        }
      }
    }
    expect(worstGeneratorDelta).toBeGreaterThan(5);
    handle.dispose?.();
  });
});


describe("Mars showcase chase framing", () => {
  it("places the eye behind and above the chassis with the look vector pointing slightly down", () => {
    const groundY = 24.2;
    const vehicleY = groundY + 0.53; // placeOnGround hang ≈ radius + rest − sag
    const lookY = vehicleY + MARS_CHASE_LOOK_OFFSET_Y;
    const { controls } = harness({
      target: new Vec3(0, lookY, 0),
      distance: MARS_CHASE_DISTANCE,
      azimuth: MARS_CHASE_AZIMUTH,
      elevation: MARS_CHASE_ELEVATION,
      minDistance: MARS_CHASE_MIN_DISTANCE,
      maxDistance: 120,
      groundClearance: MARS_CHASE_GROUND_CLEARANCE,
      groundHeight: () => groundY,
      keyboard: false,
    });
    const eye = controls.eyePosition();
    expect(eye.y).toBeGreaterThan(lookY); // above the look-at
    expect(eye.z).toBeLessThan(0); // behind at azimuth ~0.55 (eye toward -Z)
    // Looking from eye to chassis CG must pitch down (chassis below look-at would still be in view).
    const toChassisY = vehicleY - eye.y;
    expect(toChassisY).toBeLessThan(0);
    // Surface clamp must not hoist the look-at above the chassis mid-point.
    controls.update();
    expect(controls.target.y).toBeCloseTo(lookY, 5);
    expect(controls.target.y).toBeLessThan(vehicleY + 1.0);
  });

  it("keeps the chassis CG near the vertical centre of a portrait 60° FOV, not the lower third", () => {
    const groundY = 24.2;
    const vehicleY = groundY + 0.53;
    const lookY = vehicleY + MARS_CHASE_LOOK_OFFSET_Y;
    const { controls } = harness({
      target: new Vec3(0, lookY, 0),
      distance: MARS_CHASE_DISTANCE,
      azimuth: MARS_CHASE_AZIMUTH,
      elevation: MARS_CHASE_ELEVATION,
      minDistance: MARS_CHASE_MIN_DISTANCE,
      maxDistance: 120,
      groundClearance: MARS_CHASE_GROUND_CLEARANCE,
      groundHeight: () => groundY,
    });
    const eye = controls.eyePosition();
    const fovY = Math.PI / 3;
    // View-space Y of chassis CG relative to look direction, as NDC y (portrait aspect cancels for y).
    const forwardX = controls.target.x - eye.x;
    const forwardY = controls.target.y - eye.y;
    const forwardZ = controls.target.z - eye.z;
    const fl = Math.hypot(forwardX, forwardY, forwardZ) || 1;
    const fx = forwardX / fl;
    const fy = forwardY / fl;
    const fz = forwardZ / fl;
    // Camera basis: right = normalize(cross(forward, worldUp))? RH look-at uses z=eye-target.
    const zx = eye.x - controls.target.x;
    const zy = eye.y - controls.target.y;
    const zz = eye.z - controls.target.z;
    const zl = Math.hypot(zx, zy, zz) || 1;
    const zX = zx / zl;
    const zY = zy / zl;
    const zZ = zz / zl;
    // right = normalize(cross(worldUp, z))
    let rX = 1 * zZ - 0 * zY;
    let rY = 0 * zX - 0 * zZ;
    let rZ = 0 * zY - 1 * zX;
    const rl = Math.hypot(rX, rY, rZ) || 1;
    rX /= rl; rY /= rl; rZ /= rl;
    // up = cross(z, right)
    const uX = zY * rZ - zZ * rY;
    const uY = zZ * rX - zX * rZ;
    const uZ = zX * rY - zY * rX;
    const toCgX = 0 - eye.x;
    const toCgY = vehicleY - eye.y;
    const toCgZ = 0 - eye.z;
    const depth = -(toCgX * zX + toCgY * zY + toCgZ * zZ);
    const vy = toCgX * uX + toCgY * uY + toCgZ * uZ;
    const ndcY = vy / (depth * Math.tan(fovY / 2));
    // Old framing put chassis around ndcY ≈ -0.25 (lower third). New framing must be closer to 0.
    expect(ndcY).toBeGreaterThan(-0.2);
    expect(ndcY).toBeLessThan(0.05);
    void fx; void fy; void fz;
  });
});
