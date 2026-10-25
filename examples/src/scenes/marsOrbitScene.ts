/**
 * Mars Orbit Explorer (`?scene=mars-orbit`): the whole planet from orbit, and the ground anywhere on it.
 *
 * You start in orbit with Mars turning under you. **Drag** (mouse or touch) to spin it — it carries
 * inertia, and after ~4 s of rest the planet resumes its own rotation. **Double-click / double-tap** the
 * globe to fly down to that latitude/longitude and stand on the ground there (the same ported Mars
 * generator as the other Mars scenes); the **Return to orbit** button, `Esc`, or double-clicking the sky
 * flies back up. The season runs
 * (Ls 0–360, faster than real time) and the weather follows it: water-ice clouds, dust storms (local,
 * regional, planet-encircling), polar-cap frost, dust-devil fields. On the ground the same weather is
 * what you see overhead — a dust storm is a butterscotch sky and a dim sun, a dust-devil field is
 * columns on the plain, a cold basin has frost in the morning.
 *
 * **Where the work lives.** Everything generated or simulated is engine code, documented in
 * `docs/PLANET-ORBIT.md`:
 * - `environment/planetFrame` (lat/lon ↔ direction, site frames, picking, the orbit/season/clock maths),
 *   `planetSpin` (drag, inertia, idle auto-spin, flights), `planetWeather` (events → clouds/dust/frost,
 *   polar caps, ground weather);
 * - `terrain/mars/globeSampler` + `rendering/planetGlobe` (the baked globe and its cloud shell);
 * - `particles/DustDevilField` (the ground dust devils), `WeatherSystem`, `DayNightCycle`, the sky pass.
 * This scene holds its own scripting only — the event table (`marsOrbitEvents.ts`), the camera policy
 * (`marsOrbitMath.ts`), the props and the HUD.
 *
 * **The frame.** The sky pass and aerial perspective want the planet centre straight below the camera,
 * so the globe sits at (0, −R, 0), the camera stays on the +Y axis looking down, and *dragging rotates
 * the planet, not the camera*. A site on the planet is brought under the camera, where the globe's
 * tangent plane coincides with the ground world's — which is what makes the dive seamless.
 */
import {
  Camera,
  Color,
  DayNightCycle,
  DustDevilField,
  type DeviceTier,
  type Engine,
  type Entity,
  LayeredTerrainMaterial,
  Light,
  MARS_ATMOSPHERE,
  MARS_ORBIT,
  PlanetGlobe,
  PlanetSpinController,
  PlanetWeatherSystem,
  Quat,
  Ray,
  RayHit,
  Renderable,
  Scene,
  TerrainWorld,
  Vec3,
  WeatherSystem,
  adviseMarsTile,
  classifyDeviceTier,
  createAtmosphere,
  createMarsGlobeSampler,
  createMarsPipeline,
  createPlanetWeatherSample,
  directionToLatLon,
  latLonToDirection,
  marsSurfaceLayers,
  pickPlanetDirection,
  planetGroundWeather,
  planetOrientationForSite,
  planetSiteBasis,
  planetSunDirection,
  rotateByQuat,
  rotateByQuatInverse,
  solarLongitudeDeg,
  solsForLocalHours,
  solsForSolarLongitude,
  localSolarHours,
  readDeviceCapabilityHints,
  type PlanetWeatherSample,
  type WeatherState,
} from "@forge/engine";
import { GestureRecogniser } from "../controls/gestures.js";
import { TouchDiagnostics } from "../diag/touchDiagnostics.js";
import { createMarsSurfaceTextures } from "../textures/procedural.js";
import type { DemoSceneHandle } from "./cubesScene.js";
import { createMarsOrbitAtlas, type MarsOrbitAtlasInfo } from "./marsOrbitAtlas.js";
import { MARS_ORBIT_DESTINATIONS, MARS_ORBIT_EVENTS } from "./marsOrbitEvents.js";
import { MARS_LANDMARK_KIND_LABEL, MARS_LANDMARKS, type MarsLandmark } from "./marsOrbitLandmarks.js";
import {
  ORBIT_VIEW_PITCH,
  clamp,
  entryHaze,
  groundViewQuaternion,
  lerpLog,
  orbitAltitudeRange,
  orbitClipPlanes,
  orbitFitAltitude,
  orbitFacing,
  projectOrbitPoint,
  detailFocusRadius,
  descentFogDensity,
  descentGroundHeight,
  ENTRY_SWAP_ALTITUDE,
  groundPointerDirection,
  isSkyPick,
  pixelRay,
  smoothstep,
} from "./marsOrbitMath.js";

export type MarsOrbitMode = "orbit" | "dive" | "ground" | "ascend";

export interface MarsOrbitSceneOptions {
  /** The canvas that receives the pointer gestures. */
  canvas: HTMLElement;
  deviceTier?: DeviceTier;
  /** Starting season (solar longitude, degrees). Default 150. */
  startLs?: number;
  /** Open diagnostics (`?touchdiag=1`). */
  diagnostics?: boolean;
  /** Milliseconds per frame the globe may spend baking (`?mobake=`); for slow or headless renderers. */
  bakeBudgetMs?: number;
  /** `false` turns the zoomed-in detail patch off (`?modetail=0`, for A/B comparisons). Default on. */
  detail?: boolean;
  /** Ground draw distance as a multiple of the tier's (`?modraw=1|2|4`); default the viewer's last choice, else 1. */
  drawDistance?: number;
  /** Skip the descent animation (tests): `diveTo` lands immediately. */
  instantTransitions?: boolean;
  /**
   * Real elevation (MOLA): `?mola=phone|tablet|desktop` forces an atlas size, `off` keeps the procedural
   * planet; anything else (or omitted) picks the size from the tier and the device.
   */
  mola?: string | null;
  /** Directory URL of the atlas (`manifest.json` + face files); default `<BASE_URL>mars/mola/`. */
  atlasBaseUrl?: string;
  /** Fetch used for the atlas (tests). */
  atlasFetch?: typeof fetch;
}

export interface MarsOrbitState {
  mode: MarsOrbitMode;
  phase: string;
  /** Orbit altitude (orbit) or height above ground (ground), metres. */
  altitude: number;
  ls: number;
  sols: number;
  localHours: number;
  /** Where the camera is looking at on the planet (orbit: the sub-camera point), degrees. */
  subCameraLatDeg: number;
  subCameraLonDeg: number;
  site: { latDeg: number; lonDeg: number } | null;
  globeReady: boolean;
  globeProgress: number;
  globeBakedColumns: number;
  /** Ground terrain draw distance: the multiple of the tier's distance, and metres. */
  drawDistance: { scale: number; metres: number };
  /** Landmark markers: switched on, the ids drawn on screen now, and the one whose card is open. */
  landmarks: { on: boolean; visible: string[]; selected: string | null };
  /** The zoomed-in detail patch: shown, baking, and the shown cap radius in degrees. */
  globeDetail: { visible: boolean; busy: boolean; radiusDeg: number };
  autoSpin: number;
  spinPhase: string;
  inertia: number;
  gesture: string;
  pointers: number;
  haze: number;
  seasonRate: number;
  activeEvents: { id: string; kind: string; intensity: number }[];
  weather: PlanetWeatherSample | null;
  devils: number;
  terrainReadyChunks: number;
  terrainChunks: number;
  frost: number;
  diagnosticsVisible: boolean;
  /** Real-elevation atlas: status, size chosen and why, what has been fetched. */
  atlas: MarsOrbitAtlasInfo;
  tier: DeviceTier;
}

export interface MarsOrbitHandle extends DemoSceneHandle {
  marsOrbitState(): MarsOrbitState;
  /** Fly to the ground at a latitude/longitude (what a double-tap does). `hours`/`ls` also set the time. */
  diveTo(latDeg: number, lonDeg: number, options?: { hours?: number; ls?: number }): void;
  returnToOrbit(): void;
  /** Spin the planet so a place faces the camera (orbit only). */
  focusOn(latDeg: number, lonDeg: number): void;
  setSolarLongitude(lsDeg: number): void;
  setLocalHours(hours: number): void;
  /** Sols of season per real second (0 pauses). */
  setSeasonRate(solsPerSecond: number): void;
  setDiagnostics(visible: boolean): void;
  /** Multiply the orbit altitude (zoom). */
  zoomOrbit(factor: number): void;
  /** Ground draw distance as a multiple of the tier's terrain view distance (1, 2 or 4; capped per tier). */
  setDrawDistance(scale: number): void;
  /** Pick the planet under a screen position (CSS px): lat/lon or null if the ray misses. */
  pickAt(clientX: number, clientY: number): { latDeg: number; lonDeg: number } | null;
}

interface TierConfig {
  mesh: [number, number];
  texture: number;
  passes: number[];
  /** Sampling passes when real elevation is available: the finest is much finer, since sampling is cheap. */
  realPasses: number[];
  cloudTexture: number;
  cloudMesh: [number, number];
  viewDistance: number;
  visibleChunks: number;
  devils: number;
  shadowMap: number;
  cascades: number;
  surfaceTexture: number;
  bakeBudgetMs: number;
  /** Zoomed-in detail patch: texture size and mesh quads across it. */
  detailTexture: number;
  detailQuads: number;
}

const TIERS: Record<DeviceTier, TierConfig> = {
  low: { mesh: [160, 80], texture: 512, passes: [60, 120, 240], realPasses: [60, 120, 240, 480], cloudTexture: 256, cloudMesh: [96, 48], viewDistance: 2048, visibleChunks: 120, devils: 2, shadowMap: 1024, cascades: 2, surfaceTexture: 128, bakeBudgetMs: 2, detailTexture: 512, detailQuads: 96 },
  medium: { mesh: [256, 128], texture: 1024, passes: [90, 180, 360], realPasses: [90, 180, 360, 720], cloudTexture: 512, cloudMesh: [128, 64], viewDistance: 3072, visibleChunks: 180, devils: 3, shadowMap: 2048, cascades: 3, surfaceTexture: 256, bakeBudgetMs: 3, detailTexture: 1024, detailQuads: 160 },
  high: { mesh: [384, 192], texture: 2048, passes: [90, 180, 360], realPasses: [90, 180, 360, 720, 1080], cloudTexture: 1024, cloudMesh: [192, 96], viewDistance: 5120, visibleChunks: 260, devils: 4, shadowMap: 2048, cascades: 3, surfaceTexture: 256, bakeBudgetMs: 4, detailTexture: 1536, detailQuads: 192 },
};

/** The same four tints the other Mars scenes use, so one planet looks like one planet. */
const SURFACE_TINTS = [0xc9784f, 0x5c5046, 0xd1a06b, 0x9a6549] as const;

const DEG = Math.PI / 180;
const R = MARS_ATMOSPHERE.planetRadius;
const ORBIT_FOV = 40 * DEG;
const GROUND_FOV = 62 * DEG;
/** Base exp2 fog density on the ground at the tier's draw distance (thinned in proportion as it grows). */
const GROUND_FOG_DENSITY = 0.0014;
/** Extra fog at full dust storm, and per unit of rain (the weather's own default), at eye height. */
const GROUND_STORM_FOG_DENSITY = 0.0026;
const GROUND_RAIN_FOG_DENSITY = 0.02;
/** Ground draw-distance choices, as multiples of the tier's terrain view distance. */
const DRAW_DISTANCES = [
  { scale: 1, label: "Normal" },
  { scale: 2, label: "Far" },
  { scale: 4, label: "Very far" },
] as const;
const DRAW_STORAGE_KEY = "forge.marsOrbit.drawDistance";

/** Displacement multiplier of the globe's relief (orbit-scale relief is otherwise invisible). */
const GLOBE_EXAGGERATION = 2.2;

/** Altitude at which the globe and the ground world swap (softened by the dust veil), metres. */
const SWAP_ALTITUDE = ENTRY_SWAP_ALTITUDE;
/** The planet turns the site under the camera first; then the camera falls. */
const DIVE_ORBIT_SECONDS = 2.8;
/** The fall, orbit altitude to eye height, timed as one log-height ease across the swap. */
const DIVE_FALL_SECONDS = 7;
const DIVE_GROUND_SECONDS = 4.2;
/** Real seconds per sol while standing on the ground. */
const GROUND_SOL_SECONDS = 300;
const EYE_HEIGHT = 1.7;
const MAX_GROUND_HEIGHT = 700;
/** Season speed: sols of season per real second (the planet turns at its own, much slower, pace). */
const DEFAULT_SEASON_RATE = 2.2;
const SEASON_RATES = [0, 1, 4] as const;

const HAZE_COLOUR = "rgb(206,152,98)";

interface SiteState {
  latDeg: number;
  lonDeg: number;
  /** Elevation of the site origin above the reference sphere, metres (the ground world's y datum). */
  elevation: number;
  quat: Quat;
}

export function buildMarsOrbitScene(engine: Engine | null, options: MarsOrbitSceneOptions): MarsOrbitHandle {
  const canvas = options.canvas;
  const gpu = engine?.gpu ?? null;
  const tier: DeviceTier =
    options.deviceTier ??
    (gpu ? classifyDeviceTier(readDeviceCapabilityHints(undefined, engine!.gpu.adapter as unknown as Parameters<typeof readDeviceCapabilityHints>[1])).tier : "medium");
  const cfg = TIERS[tier];
  const instant = options.instantTransitions === true;

  const scene = new Scene({ name: "mars-orbit" });
  scene.settings.hdr = true;
  scene.settings.exposure = 1.0;
  scene.settings.toneMapping = "aces";
  scene.settings.bloom.enabled = true;
  scene.settings.bloom.threshold = 1.2;
  scene.settings.bloom.intensity = 0.05;
  scene.settings.shadow.enabled = false;

  // ------------------------------------------------------------------ sky / atmosphere
  const marsAtmosphere = createAtmosphere({}, MARS_ATMOSPHERE);
  scene.setSky({ atmosphere: marsAtmosphere, quality: tier === "low" ? "low" : "medium", sunIntensity: 20, aerialPerspective: true, seaLevel: 0, multiScattering: true });
  scene.settings.clouds.enabled = false;

  // ------------------------------------------------------------------ lights
  const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 1000, 0));
  const sun = new Light();
  sun.kind = "directional";
  sun.castShadow = false;
  sun.shadowBias = 0.001;
  sun.followRotation = false;
  scene.world.addComponent(sunEntity.id, sun);
  const fillEntity = scene.createTransformedEntity("ambient-fill", new Vec3(-200, -300, -200));
  const fill = new Light();
  fill.kind = "directional";
  fill.castShadow = false;
  fill.setColor(0.36, 0.2, 0.16);
  fill.intensity = 0;
  scene.world.addComponent(fillEntity.id, fill);

  // ------------------------------------------------------------------ the planet (engine systems)
  const sampler = createMarsGlobeSampler();
  const planet = new PlanetWeatherSystem({ events: MARS_ORBIT_EVENTS, radiusM: R, seed: 1337, sols: 0 });
  const startLs = clamp(options.startLs ?? 150, 0, 359.9);
  let sols = Math.floor(solsForSolarLongitude(MARS_ORBIT, startLs));

  // Open over the volcano/canyon side of the planet with the sun ~40° off the centre line.
  const START_LAT = 12;
  const START_LON = 78;
  const spin = new PlanetSpinController({ idleDelaySeconds: 4, autoSpinRadPerSecond: 0.1 });
  const startQuat = planetOrientationForSite(START_LAT, START_LON, 0, new Quat());
  spin.setOrientation(startQuat);
  // frac(sols) sets the subsolar longitude (−360·frac): put it 40° east of the start meridian.
  sols += (((-(START_LON + 40) / 360) % 1) + 1) % 1;
  spin.onSpin = (radians) => {
    if (mode === "orbit" || mode === "dive") sols += radians / (2 * Math.PI);
  };
  planet.setSols(sols);

  // Real elevation: the globe samples the atlas, so it is created once the base level is in (or the load
  // failed / is off, in which case it is the procedural planet exactly as before). Nothing is drawn of the
  // planet until then; the status line says why.
  const atlasCtl = createMarsOrbitAtlas({
    mola: options.mola ?? null,
    tier,
    baseUrl: options.atlasBaseUrl,
    fetchImpl: options.atlasFetch,
    cache: gpu ? undefined : null,
  });
  const atlasInfo = atlasCtl.info;

  let globe: PlanetGlobe | null = null;
  let globeEntity: Entity | null = null;
  let cloudEntity: Entity | null = null;
  let detailEntity: Entity | null = null;
  let globeShown = true;
  function createGlobe(): void {
    if (!gpu || globe) return;
    const real = sampler.hasRealElevation;
    globe = new PlanetGlobe(gpu, {
      sampler,
      radius: R,
      label: "mars-globe",
      meshSegments: cfg.mesh,
      textureWidth: cfg.texture,
      gridPasses: real ? cfg.realPasses : cfg.passes,
      elevationExaggeration: GLOBE_EXAGGERATION,
      // Real relief is subtler at orbit scale than the procedural model's: boost the baked shading.
      reliefStrength: real ? 36 : undefined,
      reliefGain: real ? 1.6 : undefined,
      cloudTextureWidth: cfg.cloudTexture,
      cloudSegments: cfg.cloudMesh,
      cloudAltitude: 52e3,
      detailTextureSize: options.detail === false ? 0 : cfg.detailTexture,
      detailMeshQuads: cfg.detailQuads,
    });
    globe.setSurfaceOverlay(planet.caps.overlay(() => planet.ls));
    globe.setAtmosphereFill(planet.fillAtmosphere);
    globeEntity = scene.createTransformedEntity("mars-globe", new Vec3(0, -R, 0));
    const gr = new Renderable();
    gr.geometry = globe.surfaceGeometry;
    gr.material = globe.surfaceMaterial;
    gr.castShadow = false;
    gr.receiveShadow = false;
    scene.world.addComponent(globeEntity.id, gr);
    cloudEntity = scene.createTransformedEntity("mars-clouds", new Vec3(0, -R, 0));
    const cr = new Renderable();
    cr.geometry = globe.cloudGeometry;
    cr.material = globe.cloudMaterial;
    cr.transparent = true;
    cr.castShadow = false;
    cr.receiveShadow = false;
    scene.world.addComponent(cloudEntity.id, cr);
    if (globe.detailGeometry && globe.detailMaterial) {
      // The zoomed-in patch: same frame as the globe, shown while the globe has one baked.
      detailEntity = scene.createTransformedEntity("mars-globe-detail", new Vec3(0, -R, 0));
      const dr = new Renderable();
      dr.geometry = globe.detailGeometry;
      dr.material = globe.detailMaterial;
      dr.castShadow = false;
      dr.receiveShadow = false;
      dr.visible = false;
      scene.world.addComponent(detailEntity.id, dr);
    }
    if (mode === "ground" || (mode === "dive" && phase !== "dive: approach")) setGlobeVisible(false);
  }
  let disposedScene = false;
  const setGlobeVisible = (visible: boolean): void => {
    globeShown = visible;
    syncDetailVisible();
    for (const e of [globeEntity, cloudEntity]) {
      if (!e) continue;
      const r = scene.world.getComponent(e.id, Renderable);
      if (r) r.visible = visible;
    }
  };

  /** The detail patch shows with the globe, once one is baked. */
  function syncDetailVisible(): void {
    if (!detailEntity || !globe) return;
    const r = scene.world.getComponent(detailEntity.id, Renderable);
    if (r) r.visible = globeShown && globe.detailVisible;
  }

  /** Point the globe's detail patch at the ground under the orbit camera (off when zoomed out). */
  const detailUp = new Vec3();
  function focusGlobeDetail(): void {
    if (!globe || !globe.ready) return;
    const radius = detailFocusRadius(R, orbitAlt, ORBIT_FOV, aspect());
    if (radius <= 0) {
      globe.clearDetailFocus();
      return;
    }
    // The camera looks down +Y onto the planet; the planet-fixed point under it is that axis un-spun.
    rotateByQuatInverse(spin.orientation, detailUp.set(0, 1, 0), scratchA);
    globe.setDetailFocus(scratchA.x, scratchA.y, scratchA.z, radius);
  }

  // ------------------------------------------------------------------ camera
  const cameraEntity = scene.createTransformedEntity("camera", new Vec3(0, 12e6, 0));
  const camera = new Camera();
  camera.fovY = ORBIT_FOV;
  scene.world.addComponent(cameraEntity.id, camera);

  const viewport = (): { w: number; h: number } => ({ w: canvas.clientWidth || 1280, h: canvas.clientHeight || 720 });
  const aspect = (): number => {
    const { w, h } = viewport();
    return w / Math.max(1, h);
  };

  let mode: MarsOrbitMode = "orbit";
  let phase = "orbit";
  /** Orbit zoom: multiple of the fit altitude. */
  let zoom = 1;
  let orbitAlt = orbitFitAltitude(R, ORBIT_FOV, aspect());
  let seasonRate = DEFAULT_SEASON_RATE;
  let seasonAccumulator = 0;
  let hazeAlpha = 0;

  // Ground state
  let site: SiteState | null = null;
  let yaw = 0.7;
  let pitch = -0.08;
  let groundHeight = EYE_HEIGHT;
  let camX = 0;
  let camZ = 0;
  let groundY = 0;
  let terrain: TerrainWorld | null = null;
  let layered: LayeredTerrainMaterial | null = null;
  let apron: ReturnType<LayeredTerrainMaterial["toMaterial"]> | null = null;
  let maps: ReturnType<typeof createMarsSurfaceTextures> | null = null;
  let devils: DustDevilField | null = null;
  let solar: DayNightCycle | null = null;
  let weather: WeatherSystem | null = null;
  let groundWeatherTimer = 0;
  /** Bumped by every dive; a late atlas fetch only builds the ground for the dive that asked. */
  let groundToken = 0;
  /** True while a dive waits for the finest atlas faces under the site before building the terrain. */
  let groundPending = false;
  const sample = createPlanetWeatherSample();
  const weatherState: WeatherState = { windSpeed: 3.5, windDirection: 0.7, gust: 0.1, temperatureC: -50, humidity01: 0.04, precipitation01: 0, storm01: 0, cloudCoverage: 0.04 };
  let frost = 0;

  // dive bookkeeping
  let diveT = 0;
  /** Seconds into the fall (it starts once the planet has turned the site under the camera). */
  let fallT = 0;
  /** `fallT` at the swap: the ground side's share of the fall runs from here to `DIVE_FALL_SECONDS`. */
  let fallSwapT = 0;
  let diveAlt0 = 0;
  let diveHeight0 = 0;
  let divePitch0 = ORBIT_VIEW_PITCH;
  let diveYaw0 = 0;
  let diveDirection: "down" | "up" = "down";
  let ascendYaw = 0;

  // reusable scratch
  const tmpQ = new Quat();
  const scratchA = new Vec3();
  const scratchB = new Vec3();
  const pickOrigin = new Vec3();
  const pickDir = new Vec3();
  const pickOut = new Vec3();
  const centre = new Vec3(0, -R, 0);
  const sunPF = new Vec3();
  const sunWorld = new Vec3();
  const viewQuat: [number, number, number, number] = [0, 0, 0, 1];
  const latLon = { latDeg: 0, lonDeg: 0 };

  const ls = (): number => solarLongitudeDeg(MARS_ORBIT, sols);
  const orbitRotation = (): [number, number, number, number] => groundViewQuaternion(0, ORBIT_VIEW_PITCH, viewQuat);

  // ------------------------------------------------------------------ interaction
  let lastDragTime = 0;
  let gestureLabel = "idle";
  let diagnostics: TouchDiagnostics | null = null;

  /** Planet-fixed direction under a screen point (orbit camera), or null if not over the planet. */
  const pickWorldDirection = (clientX: number, clientY: number, out: Vec3): boolean => {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = viewport();
    const ray = pixelRay(clientX - rect.left, clientY - rect.top, w, h, ORBIT_FOV);
    // orbit camera basis: right (1,0,0), up (0,0,1), forward (0,-1,0)
    pickDir.set(ray.x, -ray.z, ray.y);
    pickOrigin.set(0, orbitAlt, 0);
    return pickPlanetDirection(pickOrigin, pickDir, centre, R, out);
  };

  /** Ground view: true when the pointer is over the sky (no loaded terrain along the ray, above the horizon). */
  const skyRay = new Ray();
  const skyHit = new RayHit();
  const pointerOnSky = (clientX: number, clientY: number): boolean => {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = viewport();
    const dir = groundPointerDirection(clientX - rect.left, clientY - rect.top, w, h, camera.fovY, yaw, pitch);
    skyRay.setFrom(scratchA.set(camX, groundY + groundHeight, camZ), dir, camera.far);
    skyHit.reset();
    const hit = terrain !== null && terrain.raycast(skyRay, skyHit);
    return isSkyPick(dir.y, hit);
  };

  const pointerLatLon = (clientX: number, clientY: number): { latDeg: number; lonDeg: number } | null => {
    if (!pickWorldDirection(clientX, clientY, pickOut)) return null;
    rotateByQuatInverse(spin.orientation, pickOut, scratchA);
    directionToLatLon(scratchA, latLon);
    return { latDeg: latLon.latDeg, lonDeg: latLon.lonDeg };
  };

  const gestures = new GestureRecogniser(
    {
      dragStart: (x, y, t) => {
        lastDragTime = t;
        if (mode === "orbit") {
          const hit = pickWorldDirection(x, y, pickOut);
          spin.beginDrag(hit ? pickOut : null);
          if (!hit) spin.beginDrag(pickOut); // clamped to the limb: still grabs
        }
      },
      drag: (x, y, t) => {
        if (mode === "orbit") {
          pickWorldDirection(x, y, pickOut);
          spin.dragTo(pickOut, Math.max(1e-3, (t - lastDragTime) / 1000));
          lastDragTime = t;
        } else if (mode === "ground") {
          const prev = lastGroundPointer;
          if (prev) {
            yaw += (x - prev.x) * 0.0042;
            pitch = clamp(pitch + (y - prev.y) * 0.0042, -1.45, 1.45);
          }
          lastGroundPointer = { x, y };
        }
      },
      dragEnd: (_t, cancelled) => {
        lastGroundPointer = null;
        if (mode === "orbit") {
          if (cancelled) spin.cancelDrag();
          else spin.endDrag();
        }
      },
      doubleTap: (x, y) => {
        // On the ground, double-clicking the sky flies back up (the same as Return to orbit / Esc).
        if (mode === "ground") {
          if (pointerOnSky(x, y)) returnToOrbit();
          return;
        }
        if (mode !== "orbit") return;
        const hit = pointerLatLon(x, y);
        if (hit) diveTo(hit.latDeg, hit.lonDeg);
      },
      pinchStart: () => {
        if (mode === "orbit") spin.cancelDrag();
      },
      pinch: (ratio) => zoomBy(1 / ratio),
    },
    {},
  );
  let lastGroundPointer: { x: number; y: number } | null = null;
  gestures.onEvent = (name, detail) => {
    gestureLabel = `${name} ${detail}`.trim();
    diagnostics?.gesture(name, detail);
  };

  const zoomBy = (factor: number): void => {
    if (mode === "orbit") {
      const fit = orbitFitAltitude(R, ORBIT_FOV, aspect());
      const range = orbitAltitudeRange(fit);
      zoom = clamp((orbitAlt * factor) / fit, range.min / fit, range.max / fit);
      spin.touch();
    } else if (mode === "ground") {
      groundHeight = clamp(groundHeight * factor, EYE_HEIGHT, MAX_GROUND_HEIGHT);
    }
  };

  const abort = new AbortController();
  const sig = abort.signal;
  const now = (e: Event): number => (e as PointerEvent).timeStamp || performance.now();
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    if (mode === "ground" && gestures.pointerCount === 0) lastGroundPointer = null;
    gestures.pointerDown(e.pointerId, e.clientX, e.clientY, now(e));
  }, { signal: sig });
  canvas.addEventListener("pointermove", (e) => gestures.pointerMove(e.pointerId, e.clientX, e.clientY, now(e)), { signal: sig });
  canvas.addEventListener("pointerup", (e) => gestures.pointerUp(e.pointerId, e.clientX, e.clientY, now(e)), { signal: sig });
  canvas.addEventListener("pointercancel", (e) => gestures.pointerCancel(e.pointerId, now(e)), { signal: sig });
  canvas.addEventListener("lostpointercapture", (e) => gestures.pointerCancel(e.pointerId, now(e)), { signal: sig });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    zoomBy(Math.exp(px * 0.0015));
  }, { signal: sig, passive: false });
  // Safari: stop the page itself pinch-zooming under a pinch on the canvas.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    canvas.addEventListener(type, (e) => e.preventDefault(), { signal: sig });
  }
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    keys.add(e.key.toLowerCase());
    if (e.key === "Escape" && (mode === "ground" || mode === "dive")) returnToOrbit();
  }, { signal: sig });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()), { signal: sig });
  window.addEventListener("blur", () => keys.clear(), { signal: sig });

  // ------------------------------------------------------------------ HUD
  const css = document.createElement("style");
  css.textContent = `
    #mo-hud{position:fixed;inset:0;pointer-events:none;z-index:14;font:13px/1.35 system-ui,sans-serif;color:#f4ece4}
    #mo-hud *{box-sizing:border-box}
    #mo-haze{position:fixed;inset:0;pointer-events:none;z-index:13;opacity:0}
    .mo-panel{pointer-events:auto;background:rgba(14,10,8,.62);border:1px solid rgba(255,210,170,.16);border-radius:12px;padding:10px 12px;backdrop-filter:blur(6px)}
    #mo-right{position:absolute;right:12px;top:64px;width:min(300px,64vw);display:flex;flex-direction:column;gap:8px;align-items:stretch}
    #mo-top h1{font-size:15px;margin:0 0 4px;letter-spacing:.02em}
    #mo-top .mo-sub{opacity:.78;font-size:12px}
    #mo-events{margin-top:6px;display:grid;gap:3px}
    .mo-ev{display:grid;grid-template-columns:1fr 54px;gap:6px;align-items:center;font-size:12px;cursor:pointer;border-radius:6px;padding:1px 4px}
    .mo-ev:hover{background:rgba(255,200,150,.12)}
    .mo-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}
    .mo-bar>i{display:block;height:100%;background:#e9b27a}
    .mo-bar.ice>i{background:#cfe3f7}.mo-bar.dust>i{background:#d9985a}.mo-bar.frost>i{background:#f3f6fb}
    #mo-bottom{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;width:max-content;max-width:min(96vw,780px)}
    .mo-btn{pointer-events:auto;cursor:pointer;border:1px solid rgba(255,214,176,.35);background:rgba(34,22,16,.78);color:#fbeee0;border-radius:9px;padding:9px 13px;font:600 13px system-ui,sans-serif;touch-action:manipulation;-webkit-tap-highlight-color:transparent;min-height:40px}
    .mo-btn:hover{background:rgba(70,44,30,.86)}.mo-btn.on{background:rgba(160,96,50,.85)}
    #mo-return{display:none;font-size:15px;padding:11px 16px;background:rgba(150,82,40,.92)}
    #mo-slider{display:flex;align-items:center;gap:8px}
    #mo-slider input{width:min(34vw,180px);accent-color:#e9a566}
    #mo-ground{display:none;font-size:12px}
    #mo-dest{pointer-events:auto;background:rgba(34,22,16,.78);color:#fbeee0;border:1px solid rgba(255,214,176,.35);border-radius:9px;padding:9px;font:600 13px system-ui,sans-serif;min-height:40px}
    #mo-marks{position:absolute;left:0;top:0;pointer-events:none;overflow:hidden}
    .mo-mark{position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;width:16px;height:16px;padding:0;border-radius:50%;border:2px solid rgba(255,255,255,.92);background:var(--k);box-shadow:0 0 0 3px rgba(0,0,0,.28),0 1px 6px rgba(0,0,0,.5);touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    .mo-mark::before{content:"";position:absolute;inset:-10px;border-radius:50%}
    .mo-mark:hover,.mo-mark:focus-visible,.mo-mark.sel{outline:none;box-shadow:0 0 0 3px rgba(0,0,0,.28),0 0 0 6px rgba(255,236,214,.55)}
    .mo-mark .lbl{display:none;position:absolute;left:14px;top:50%;transform:translateY(-50%);white-space:nowrap;font:600 12px system-ui,sans-serif;color:#fff7ee;text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,.9);pointer-events:none}
    .mo-mark:hover .lbl,.mo-mark:focus-visible .lbl,.mo-mark.sel .lbl,#mo-marks.labels .lbl{display:block}
    #mo-card{display:none;position:absolute;left:12px;bottom:120px;width:min(330px,calc(100vw - 24px))}
    #mo-card .mo-kind{font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.75;padding-right:36px}
    #mo-card h2{font-size:16px;margin:2px 0 2px}
    #mo-card .mo-coords{font-size:12px;opacity:.75;margin-bottom:6px}
    #mo-card p{margin:0 0 10px}
    #mo-card .mo-actions{display:flex;gap:8px}
    #mo-card-close{position:absolute;right:6px;top:6px;z-index:2;min-height:0;padding:4px 9px;font-size:14px}
    @media (max-width:640px){#mo-card{bottom:auto;top:52px;left:6px;width:calc(100vw - 12px - min(260px,58vw) - 12px)}}
    @media (max-width:640px){#mo-right{top:52px;width:min(260px,58vw)}#mo-events .mo-ev:nth-child(n+4){display:none}#mo-bottom{left:6px;right:64px;transform:none;width:auto;max-width:none;bottom:92px;gap:6px}#mo-slider{flex:1 1 100%;justify-content:center}#mo-slider input{width:26vw}.mo-btn{padding:8px 10px}}
  `;
  document.head.appendChild(css);
  const hud = document.createElement("div");
  hud.id = "mo-hud";
  hud.innerHTML = `
    <div id="mo-marks"></div>
    <div id="mo-card" class="mo-panel" role="dialog" aria-live="polite" aria-labelledby="mo-card-name">
      <button id="mo-card-close" class="mo-btn" type="button" aria-label="Close">×</button>
      <div class="mo-kind" id="mo-card-kind"></div>
      <h2 id="mo-card-name"></h2>
      <div class="mo-coords" id="mo-card-coords"></div>
      <p id="mo-card-desc"></p>
      <div class="mo-actions">
        <button class="mo-btn" id="mo-card-fly" type="button">Fly there</button>
        <button class="mo-btn" id="mo-card-show" type="button">Centre view</button>
      </div>
    </div>
    <div id="mo-right">
      <button id="mo-return" class="mo-btn" type="button">⬆ Return to orbit</button>
      <div id="mo-top" class="mo-panel">
        <h1>Mars Orbit Explorer</h1>
        <div class="mo-sub" id="mo-season"></div>
        <div class="mo-sub" id="mo-status"></div>
        <div id="mo-events"></div>
      </div>
      <div id="mo-ground" class="mo-panel"></div>
    </div>
    <div id="mo-bottom" class="mo-panel">
      <div id="mo-slider"><label for="mo-ls">Season</label><input id="mo-ls" type="range" min="0" max="359" step="1" value="${Math.round(startLs)}"><span id="mo-ls-val"></span></div>
      <button class="mo-btn" id="mo-rate" type="button">Season ▶ 1×</button>
      <div id="mo-hours" style="display:none;align-items:center;gap:8px"><label for="mo-h">Time</label><input id="mo-h" type="range" min="0" max="24" step="0.1" value="14" style="width:min(34vw,180px);accent-color:#e9a566"><span id="mo-h-val"></span></div>
      <select id="mo-dest" aria-label="Fly to"><option value="">Fly to…</option>${MARS_ORBIT_DESTINATIONS.map((d) => `<option value="${d.id}">${d.label}</option>`).join("")}</select>
      <button class="mo-btn on" id="mo-landmarks" type="button" aria-pressed="true">Landmarks</button>
      <button class="mo-btn" id="mo-draw" type="button" style="display:none">Draw distance: Normal</button>
      <button class="mo-btn" id="mo-diag" type="button">Touch diagnostics</button>
    </div>`;
  document.body.appendChild(hud);
  const haze = document.createElement("div");
  haze.id = "mo-haze";
  haze.style.background = `radial-gradient(ellipse at 50% 60%, ${HAZE_COLOUR}, rgb(176,118,76) 90%)`;
  document.body.appendChild(haze);
  const $ = <T extends HTMLElement>(id: string): T => hud.querySelector<T>(`#${id}`)!;
  const elSeason = $("mo-season");
  const elStatus = $("mo-status");
  const elEvents = $("mo-events");
  const elReturn = $<HTMLButtonElement>("mo-return");
  const elGround = $("mo-ground");
  const elLs = $<HTMLInputElement>("mo-ls");
  const elLsVal = $("mo-ls-val");
  const elRate = $<HTMLButtonElement>("mo-rate");
  const elHoursWrap = $("mo-hours");
  const elHours = $<HTMLInputElement>("mo-h");
  const elHoursVal = $("mo-h-val");
  const elDest = $<HTMLSelectElement>("mo-dest");
  const elDiag = $<HTMLButtonElement>("mo-diag");
  const elDraw = $<HTMLButtonElement>("mo-draw");
  const elMarks = $("mo-marks");
  const elCard = $("mo-card");
  const elLandmarks = $<HTMLButtonElement>("mo-landmarks");

  // ------------------------------------------------------------------ landmarks
  // Markers for well-known places (marsOrbitLandmarks.ts), drawn over the globe in orbit; clicking one
  // opens a card that says what it is and why it is famous, with Fly there / Centre view.
  const KIND_COLOUR: Readonly<Record<MarsLandmark["kind"], string>> = {
    volcano: "#ff8a5c", canyon: "#ffd166", basin: "#8ecae6", plain: "#c9b2ec", landing: "#7bdc8a", polar: "#f4f8ff",
  };
  const landmarkDirs = MARS_LANDMARKS.map((l) => latLonToDirection(l.latDeg, l.lonDeg, new Vec3()));
  const markEls = MARS_LANDMARKS.map((l) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mo-mark";
    b.hidden = true;
    b.dataset.landmark = l.id;
    b.style.setProperty("--k", KIND_COLOUR[l.kind]);
    b.setAttribute("aria-label", `${l.name} (${MARS_LANDMARK_KIND_LABEL[l.kind]})`);
    const label = document.createElement("span");
    label.className = "lbl";
    label.textContent = l.name;
    b.appendChild(label);
    elMarks.appendChild(b);
    return b;
  });
  let landmarksOn = true;
  let selectedLandmark: MarsLandmark | null = null;
  const visibleLandmarks: string[] = [];
  const markWorld = new Vec3();
  const formatLatLon = (lat: number, lon: number): string => {
    const e = ((lon % 360) + 360) % 360;
    const lonText = e > 180 ? `${(360 - e).toFixed(1)}° W` : `${e.toFixed(1)}° E`;
    return `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}, ${lonText}`;
  };
  function selectLandmark(id: string | null): void {
    selectedLandmark = id ? MARS_LANDMARKS.find((l) => l.id === id) ?? null : null;
    markEls.forEach((el, i) => el.classList.toggle("sel", MARS_LANDMARKS[i] === selectedLandmark));
    const l = selectedLandmark;
    elCard.style.display = l && mode === "orbit" ? "block" : "none";
    if (!l) return;
    $("mo-card-kind").textContent = MARS_LANDMARK_KIND_LABEL[l.kind];
    $("mo-card-name").textContent = l.name;
    $("mo-card-coords").textContent = formatLatLon(l.latDeg, l.lonDeg);
    $("mo-card-desc").textContent = l.description;
  }
  function setLandmarksOn(on: boolean): void {
    landmarksOn = on;
    elLandmarks.classList.toggle("on", on);
    elLandmarks.setAttribute("aria-pressed", String(on));
    if (!on) selectLandmark(null);
    updateLandmarks();
  }
  /** Place the markers over the globe: front side only, faded toward the limb. */
  function updateLandmarks(): void {
    const show = landmarksOn && mode === "orbit" && globe !== null;
    elMarks.style.display = show ? "" : "none";
    visibleLandmarks.length = 0;
    if (!show) return;
    const rect = canvas.getBoundingClientRect();
    const { w, h } = viewport();
    elMarks.style.left = `${rect.left}px`;
    elMarks.style.top = `${rect.top}px`;
    elMarks.style.width = `${w}px`;
    elMarks.style.height = `${h}px`;
    // Names on every marker once zoomed in (they no longer crowd each other); otherwise on hover/focus.
    elMarks.classList.toggle("labels", orbitAlt < orbitFitAltitude(R, ORBIT_FOV, aspect()) * 0.45);
    for (let i = 0; i < MARS_LANDMARKS.length; i++) {
      const l = MARS_LANDMARKS[i]!;
      const el = markEls[i]!;
      rotateByQuat(spin.orientation, landmarkDirs[i]!, markWorld);
      const r = R + (globe?.elevationAt(l.latDeg, l.lonDeg) ?? 0) * GLOBE_EXAGGERATION;
      const px = markWorld.x * r;
      const py = markWorld.y * r - R;
      const pz = markWorld.z * r;
      const facing = orbitFacing(markWorld.x, markWorld.y, markWorld.z, px, py, pz, orbitAlt);
      const p = projectOrbitPoint(px, py, pz, orbitAlt, ORBIT_FOV, w, h);
      const on = facing > 0.12 && p.inFront && p.x >= -12 && p.x <= w + 12 && p.y >= -12 && p.y <= h + 12;
      el.hidden = !on;
      if (!on) continue;
      el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-50%)`;
      el.style.opacity = Math.min(1, (facing - 0.12) * 4).toFixed(2);
      visibleLandmarks.push(l.id);
    }
  }
  elMarks.addEventListener("click", (e) => {
    const mark = (e.target as HTMLElement).closest<HTMLElement>("[data-landmark]");
    if (mark) selectLandmark(selectedLandmark?.id === mark.dataset.landmark ? null : mark.dataset.landmark ?? null);
  }, { signal: sig });
  elLandmarks.addEventListener("click", () => setLandmarksOn(!landmarksOn), { signal: sig });
  $("mo-card-close").addEventListener("click", () => selectLandmark(null), { signal: sig });
  $("mo-card-fly").addEventListener("click", () => {
    const l = selectedLandmark;
    if (!l) return;
    selectLandmark(null);
    diveTo(l.latDeg, l.lonDeg);
  }, { signal: sig });
  $("mo-card-show").addEventListener("click", () => {
    if (selectedLandmark) focusOn(selectedLandmark.latDeg, selectedLandmark.lonDeg);
  }, { signal: sig });

  elReturn.addEventListener("click", () => returnToOrbit(), { signal: sig });
  elLs.addEventListener("input", () => setSolarLongitude(Number(elLs.value)), { signal: sig });
  elHours.addEventListener("input", () => setLocalHours(Number(elHours.value)), { signal: sig });
  elRate.addEventListener("click", () => {
    const i = SEASON_RATES.findIndex((r) => r === Math.round(seasonRate / DEFAULT_SEASON_RATE));
    const next = SEASON_RATES[(i + 1) % SEASON_RATES.length]!;
    setSeasonRate(next * DEFAULT_SEASON_RATE);
  }, { signal: sig });
  elDiag.addEventListener("click", () => setDiagnostics(!(diagnostics?.visible ?? false)), { signal: sig });
  elDraw.addEventListener("click", () => {
    const choices = DRAW_DISTANCES.filter((d) => d.scale <= maxDrawScale);
    const i = choices.findIndex((d) => d.scale === drawScale);
    setDrawScale(choices[(i + 1) % choices.length]!.scale);
  }, { signal: sig });
  elDest.addEventListener("change", () => {
    const d = MARS_ORBIT_DESTINATIONS.find((x) => x.id === elDest.value);
    elDest.value = "";
    if (d) diveTo(d.latDeg, d.lonDeg, { hours: d.hours, ls: d.ls });
  }, { signal: sig });
  elEvents.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ev]");
    if (!row) return;
    const def = MARS_ORBIT_EVENTS.find((x) => x.id === row.dataset.ev);
    if (def) {
      if (mode === "orbit") focusOn(def.latDeg, def.lonDeg);
    }
  }, { signal: sig });

  diagnostics = new TouchDiagnostics({
    target: canvas,
    visible: options.diagnostics === true,
    extra: () => [
      `scene mode ${mode} (${phase}) · gesture ${gestures.mode} · pointers ${gestures.pointerCount}`,
      `spin ${spin.phase} · inertia ${spin.inertiaSpeed.toFixed(2)} rad/s · idle ${spin.idleSeconds.toFixed(1)} s`,
      `last: ${gestureLabel}`,
    ],
  });
  elDiag.classList.toggle("on", diagnostics.visible);

  // ------------------------------------------------------------------ time / season
  const localHours = (): number => (site ? localSolarHours(site.lonDeg, sols) : 12);

  function setSolarLongitude(lsDeg: number): void {
    const base = solsForSolarLongitude(MARS_ORBIT, clamp(lsDeg, 0, 359.99));
    sols = Math.floor(base) + (sols - Math.floor(sols));
    planet.setSols(sols);
    markSeasonChanged(true);
  }

  function setLocalHours(hours: number): void {
    if (!site) return;
    sols = solsForLocalHours(site.lonDeg, ((hours % 24) + 24) % 24, sols);
    planet.setSols(sols);
    groundWeatherTimer = 0;
  }

  function setSeasonRate(solsPerSecond: number): void {
    seasonRate = Math.max(0, solsPerSecond);
    const mult = Math.round(seasonRate / DEFAULT_SEASON_RATE);
    elRate.textContent = mult === 0 ? "Season ⏸" : `Season ▶ ${mult}×`;
  }

  let lastOverlayLs = Number.NaN;
  function markSeasonChanged(force = false): void {
    const l = ls();
    if (force || !(Math.abs(l - lastOverlayLs) < 1.2)) {
      lastOverlayLs = l;
      globe?.invalidateOverlay();
    }
  }

  // ------------------------------------------------------------------ sun
  /** The sun's direction in the planet-fixed frame now. */
  const updateSunPF = (): Vec3 => {
    planetSunDirection(MARS_ORBIT, sols, sunPF);
    return sunPF;
  };

  function applyOrbitLighting(): void {
    updateSunPF();
    rotateByQuat(spin.orientation, sunPF, sunWorld);
    const sky = scene.settings.sky;
    if (sky.sunDirection) sky.sunDirection.set(sunWorld.x, sunWorld.y, sunWorld.z);
    else sky.sunDirection = new Vec3(sunWorld.x, sunWorld.y, sunWorld.z);
    sun.direction.set(-sunWorld.x, -sunWorld.y, -sunWorld.z);
    sun.color.set(1.0, 0.95, 0.88);
    sun.intensity = 5.2;
  }

  /** The sun in the site's east/up/north frame, which is the ground world's axes. */
  function groundSun(out: Vec3): Vec3 {
    if (!site) return out.set(0, 1, 0);
    updateSunPF();
    const b = planetSiteBasis(site.latDeg, site.lonDeg, 0);
    return out.set(
      sunPF.x * b.east.x + sunPF.y * b.east.y + sunPF.z * b.east.z,
      sunPF.x * b.up.x + sunPF.y * b.up.y + sunPF.z * b.up.z,
      sunPF.x * b.north.x + sunPF.y * b.north.y + sunPF.z * b.north.z,
    );
  }

  // ------------------------------------------------------------------ draw distance
  const maxDrawScale = cfg.viewDistance <= 2048 ? 2 : 4; // the low tier stops at "Far": 4x is 16x the chunks
  const storedScale = ((): number | null => {
    try { return Number(globalThis.localStorage?.getItem(DRAW_STORAGE_KEY) ?? "") || null; } catch { return null; }
  })();
  let drawScale = [1, 2, 4].includes(options.drawDistance ?? storedScale ?? 1) ? Math.min(maxDrawScale, options.drawDistance ?? storedScale ?? 1) : 1;
  /** Angular radius of ground (and its atlas faces) the terrain may reach at the current draw distance. */
  const groundRadiusRad = (): number => (cfg.viewDistance * drawScale * 1.6 + 10e3) / R;
  /**
   * Ground fog for the camera's height. Every part of it thins with height on a dive: the base haze
   * (itself thinned with the draw distance) and the weather's storm and rain haze. They are all
   * scaled by the factor that keeps the haziest state at one fog depth from above
   * (`descentFogDensity`).
   */
  const groundFogDensity = (): number => (GROUND_FOG_DENSITY / drawScale) * groundFogScale();
  const groundFogScale = (): number => {
    const worst = GROUND_FOG_DENSITY / drawScale + GROUND_STORM_FOG_DENSITY;
    return descentFogDensity(worst, groundHeight) / worst;
  };
  let lastFogDensity = -1;
  function pushGroundFog(force: boolean): void {
    if (!weather) return;
    const d = groundFogDensity();
    if (!force && Math.abs(d - lastFogDensity) <= lastFogDensity * 0.02) return;
    lastFogDensity = d;
    const k = groundFogScale();
    weather.stormFogDensity = GROUND_STORM_FOG_DENSITY * k;
    weather.rainFogDensity = GROUND_RAIN_FOG_DENSITY * k;
    weather.setBaseFogDensity(d);
  }
  function setDrawScale(scale: number): void {
    drawScale = Math.min(maxDrawScale, scale);
    try { globalThis.localStorage?.setItem(DRAW_STORAGE_KEY, String(drawScale)); } catch { /* private mode */ }
    terrain?.setViewDistance(cfg.viewDistance * drawScale);
    pushGroundFog(true);
    // Farther ground may reach atlas faces that are not loaded yet: fetch them, then rebuild once.
    if (site && mode === "ground") {
      const token = groundToken;
      void atlasCtl.loadGround(terrainSiteDir, groundRadiusRad()).then(() => { if (token === groundToken) maybeUpgradeTerrain(); });
    }
    syncDrawButton();
  }
  queueMicrotask(() => syncDrawButton());
  function syncDrawButton(): void {
    const d = DRAW_DISTANCES.find((x) => x.scale === drawScale) ?? DRAW_DISTANCES[0];
    elDraw.textContent = `Draw distance: ${d.label}`;
    elDraw.title = `${((cfg.viewDistance * drawScale) / 1000).toFixed(1)} km`;
  }

  // ------------------------------------------------------------------ ground world
  // The terrain's tiles are generated over time from whatever atlas faces are loaded *then*: a terrain
  // that outlives the arrival of the finer faces under its site would mix two height levels, tens of
  // metres apart on a volcano flank (its skirts standing up as walls along the seams). So remember the
  // level it was built from, and rebuild it once if a finer one arrives (`maybeUpgradeTerrain`).
  let terrainAtlasSig = "";
  const terrainSiteDir = new Vec3();
  /** Which atlas faces cover the ground out to the draw distance, and at what resolution. */
  const groundAtlasSignature = (): string => {
    const atlas = atlasCtl.atlas;
    if (!atlas) return "";
    const levels = [...atlas.resolutions].sort((a, b) => b - a);
    return atlas.facesNear(terrainSiteDir.x, terrainSiteDir.y, terrainSiteDir.z, groundRadiusRad())
      .map((f) => `${f}:${levels.find((res) => atlas.hasFace(f, res)) ?? 0}`)
      .join(",");
  };
  let groundTile: { tile: { chunkSize: number; resolution: number }; advice: ReturnType<typeof adviseMarsTile> } | null = null;
  function makeTerrain(s: SiteState): TerrainWorld {
    const { tile, advice } = groundTile!;
    latLonToDirection(s.latDeg, s.lonDeg, terrainSiteDir);
    terrainAtlasSig = groundAtlasSignature();
    const world = new TerrainWorld({
      seed: 1337,
      chunkSize: tile.chunkSize,
      chunkResolution: tile.resolution,
      viewDistance: cfg.viewDistance,
      maxLOD: 3,
      visibleChunks: cfg.visibleChunks,
      generationsPerFrame: 1,
      uploadsPerFrame: 2,
      warmUpChunks: 9,
      skirtDepth: advice.ok ? advice.recommendedSkirtDepth : 32,
      syncGeneration: false,
      pipeline: createMarsPipeline({ site: { name: "orbit-site", description: "chosen on the globe", latDeg: s.latDeg, lonDeg: s.lonDeg, headingDeg: 0 }, heightAtlas: atlasCtl.atlas }),
      material: apron!,
      layeredMaterial: layered!,
    });
    // Built at the tier's distance (its budgets are the base), then drawn at the chosen one.
    if (drawScale !== 1) world.setViewDistance(cfg.viewDistance * drawScale);
    return world;
  }

  /** Rebuild the terrain if finer (or more) atlas faces under it arrived after it was built. */
  function maybeUpgradeTerrain(): void {
    const atlas = atlasCtl.atlas;
    if (!terrain || !site || !atlas || !groundTile) return;
    if (groundAtlasSignature() === terrainAtlasSig) return;
    scene.removeObject(terrain);
    terrain.dispose();
    site.elevation = sampler.sample(terrainSiteDir.x, terrainSiteDir.y, terrainSiteDir.z, { elevation: 0, r: 0, g: 0, b: 0 }).elevation;
    terrain = makeTerrain(site);
    scene.add(terrain);
  }

  function buildGround(s: SiteState): void {
    const tile = (() => {
      const wanted = { chunkSize: 256, resolution: 33 };
      return adviseMarsTile(wanted.chunkSize, wanted.resolution).ok ? wanted : { chunkSize: 128, resolution: 33 };
    })();
    const advice = adviseMarsTile(tile.chunkSize, tile.resolution);
    maps = gpu ? createMarsSurfaceTextures(gpu, cfg.surfaceTexture) : null;
    layered = new LayeredTerrainMaterial({
      label: "mars-orbit-layers",
      layers: marsSurfaceLayers().map((layer, i) => ({ ...layer, color: Color.fromSrgbHex(SURFACE_TINTS[i]!) })),
      maps: maps ?? undefined,
    });
    apron = layered.toMaterial();
    groundTile = { tile, advice };
    terrain = makeTerrain(s);
    scene.add(terrain);

    solar = new DayNightCycle({
      name: "marsOrbitSolar",
      latitude: s.latDeg,
      longitude: s.lonDeg,
      year: 2000,
      dayOfYear: 80,
      timeOfDay: 14,
      timeScale: 0,
      atmosphere: marsAtmosphere,
      sun,
      sunIntensity: 4.2,
      ambientScale: 0.72,
      nightAmbient: new Color(0.012, 0.009, 0.018),
      driveAmbient: true,
      driveFog: true,
      driveSky: true,
      schedules: [({ daylight }) => { fill.intensity = 0.16 + daylight * 0.64; }],
    });
    solar.externalSunDirection = new Vec3(0, 1, 0);

    weather = new WeatherSystem({
      name: "marsOrbitWeather",
      seed: 1337,
      initial: weatherState,
      target: weatherState,
      stormFogDensity: GROUND_STORM_FOG_DENSITY,
      humidityTurbidity: 1,
      stormTurbidity: 4.5,
      minimumSunLight: 0.25,
      minimumAmbientLight: 0.55,
      driveSurface: false,
      driveVehicles: false,
      driveWater: false,
    });

    devils = new DustDevilField({
      name: "mars-orbit-devils",
      count: cfg.devils,
      seed: 0xd0575,
      groundHeight: (x, z) => terrain?.getHeightAt(x, z) ?? groundY,
    });
  }

  /**
   * Hand the scene to the ground world, at the swap (under the entry haze): its sun clock, weather and
   * devils start driving the sky, fog and lighting, and the ground's settings replace the orbit view's.
   * Until then only the terrain is attached (it streams in the background), so the approach keeps the
   * orbit look — applying the ground's exp2 fog at the double-tap turned the globe into a flat disc of
   * fog colour hundreds of kilometres away.
   */
  function attachGroundSystems(): void {
    if (solar && !solar.scene) scene.add(solar);
    if (weather && !weather.scene) scene.add(weather);
    if (devils && !devils.scene) scene.add(devils);
    applyGroundSettings();
    pushGroundFog(true);
    if (solar) solar.externalSunDirection!.copyFrom(groundSun(scratchB));
    solar?.apply();
  }

  function destroyGround(): void {
    // Systems not attached yet (a return before the swap) are disposed here rather than by the scene.
    if (devils) { if (!scene.removeObject(devils)) devils.dispose?.(); devils = null; }
    if (weather) { if (!scene.removeObject(weather)) weather.dispose?.(); weather = null; }
    if (solar) { solar.externalSunDirection = null; if (!scene.removeObject(solar)) solar.dispose?.(); solar = null; }
    if (terrain) { scene.removeObject(terrain); terrain.dispose(); terrain = null; }
    layered?.dispose();
    layered = null;
    apron?.dispose();
    apron = null;
    maps?.albedo.dispose();
    maps?.normal.dispose();
    maps?.metallicRoughness.dispose();
    maps = null;
    scene.settings.surface.snow = 0;
    frost = 0;
  }

  /** Orbit-view scene settings (also the state after returning). */
  function applyOrbitSettings(): void {
    scene.settings.shadow.enabled = false;
    scene.settings.clouds.enabled = false;
    scene.settings.sky.aerialPerspective = true;
    scene.setFog("none");
    scene.settings.exposure = 1.0;
    // Seen from space the dust column is a thin veil, not the ground's haze: less Mie, more Rayleigh gives
    // the blue limb orbiters see, and the terrain keeps its contrast through the aerial perspective.
    const sky = scene.settings.sky;
    sky.mie = 0.28;
    sky.rayleigh = 5.5;
    sky.multiScattering = false;
    scene.settings.ambientColor.set(0.03, 0.02, 0.018);
    scene.settings.ambientIntensity = 1;
    fill.intensity = 0;
    scene.settings.surface.snow = 0;
  }

  function applyGroundSettings(): void {
    scene.settings.shadow.enabled = true;
    scene.settings.shadow.cascades = cfg.cascades;
    scene.settings.shadow.mapSize = cfg.shadowMap;
    scene.settings.shadow.distance = 260;
    scene.settings.shadow.splitLambda = 0.7;
    scene.settings.sky.aerialPerspective = false;
    scene.settings.sky.mie = 1;
    scene.settings.sky.rayleigh = 1;
    scene.settings.sky.multiScattering = true;
    scene.setFog("exp2", { density: groundFogDensity() });
    scene.settings.exposure = 0.95;
    // Water-ice cloud deck high over the site: its coverage is the weather's ice-cloud cover.
    scene.setClouds({ enabled: true, coverage: 0.05, density: 0.55, height: 9000, thickness: 3500, scale: 0.00016, layers: 2, silverLining: 0.6, surfaceShadows: true, shadowStrength: 0.6 });
    sun.castShadow = true;
  }

  /** Refresh the ground weather from the planet's weather at the site (call a few times a second). */
  function updateGroundWeather(snap: boolean): void {
    if (!site || !weather) return;
    planet.sample(site.latDeg, site.lonDeg, sample);
    const hours = localHours();
    planetGroundWeather(sample, hours, weatherState);
    if (snap) weather.snapTo(weatherState);
    else weather.setTarget(weatherState);
    if (devils) {
      // Devils need sun on the ground: activity falls with the sun's elevation.
      const elevation = groundSun(scratchB).y;
      devils.activity = clamp(sample.devilActivity * smoothstep(0.06, 0.4, elevation), 0, 1);
      const heading = weather.state.windDirection;
      devils.windX = weather.state.windSpeed * Math.sin(heading);
      devils.windZ = weather.state.windSpeed * Math.cos(heading);
      devils.focusX = camX;
      devils.focusZ = camZ;
    }
    // Frost is a morning thing: the sun sublimates it off by mid-morning.
    const sunElevation = groundSun(scratchB).y;
    const target = sample.frost * (1 - smoothstep(0.02, 0.32, sunElevation));
    frost += (target - frost) * (snap ? 1 : 0.35);
    scene.settings.surface.snow = clamp(frost * 0.5, 0, 0.5);
  }

  // ------------------------------------------------------------------ transitions
  function siteFor(latDeg: number, lonDeg: number): SiteState {
    const q = planetOrientationForSite(latDeg, lonDeg, 0, new Quat());
    latLonToDirection(latDeg, lonDeg, scratchA);
    const elevation = sampler.sample(scratchA.x, scratchA.y, scratchA.z, { elevation: 0, r: 0, g: 0, b: 0 }).elevation;
    return { latDeg, lonDeg, elevation, quat: q };
  }

  function diveTo(latDeg: number, lonDeg: number, opts: { hours?: number; ls?: number } = {}): void {
    if (mode !== "orbit") return;
    if (opts.ls !== undefined) setSolarLongitude(opts.ls);
    site = siteFor(latDeg, ((lonDeg + 180) % 360 + 360) % 360 - 180);
    if (opts.hours !== undefined) setLocalHours(opts.hours);
    spin.touch();
    // Real elevation, finest level: the ground's tiles are generated once, so the atlas faces under the
    // site must be in before the terrain is built. The orbit approach (2.8 s) usually covers the fetch;
    // otherwise the dive waits at the end of the approach, and gives up waiting after 12 s.
    const token = ++groundToken;
    const siteDir = latLonToDirection(site.latDeg, site.lonDeg, new Vec3());
    const groundRadius = groundRadiusRad();
    const buildNow = (): void => {
      if (!site) return;
      // Faces may have arrived since `siteFor` read the base level.
      site.elevation = sampler.sample(siteDir.x, siteDir.y, siteDir.z, { elevation: 0, r: 0, g: 0, b: 0 }).elevation;
      groundY = site.elevation;
      buildGround(site);
      groundPending = false;
      // The ground's sky, fog and sun take over at the swap (attachGroundSystems), not here.
      if (mode === "dive" && phase === "dive: descent") attachGroundSystems();
    };
    groundPending = false;
    if (!instant && !atlasCtl.groundReady(siteDir, groundRadius)) {
      groundPending = true;
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 12000));
      const load = atlasCtl.loadGround(siteDir, groundRadius);
      void Promise.race([load, timeout]).then(() => {
        if (token === groundToken && mode === "dive" && groundPending) buildNow();
      });
      // If the wait gave up, rebuild the terrain from the finer faces when they do arrive (once).
      void load.then(() => { if (token === groundToken) maybeUpgradeTerrain(); });
    } else {
      if (instant) void atlasCtl.loadGround(siteDir, groundRadius).then(() => { if (token === groundToken) maybeUpgradeTerrain(); });
      buildNow();
    }
    // The ground world's sun is the planet's, expressed in the site frame; the cycle is only the clock.
    mode = "dive";
    diveDirection = "down";
    phase = "dive: approach";
    diveT = 0;
    fallT = 0;
    diveAlt0 = orbitAlt;
    camX = 0;
    camZ = 0;
    groundY = site.elevation;
    yaw = 0.7;
    pitch = -0.08;
    groundHeight = EYE_HEIGHT;
    spin.animateTo(site.quat, instant ? 0.001 : DIVE_ORBIT_SECONDS);
    if (instant) {
      orbitAlt = SWAP_ALTITUDE;
      spin.update(0.01);
      swapToGround();
      finishDive();
    }
  }

  function swapToGround(): void {
    phase = "dive: descent";
    diveT = 0;
    fallSwapT = fallT;
    divePitch0 = ORBIT_VIEW_PITCH;
    diveYaw0 = 0;
    setGlobeVisible(false);
    measureBackdropSink();
    attachGroundSystems();
    scene.settings.sky.seaLevel = site?.elevation ?? 0;
    // The orbit camera stood SWAP_ALTITUDE above the datum; the ground camera is placed above the site.
    groundHeight = descentGroundHeight(SWAP_ALTITUDE, site?.elevation ?? 0);
    updateGroundWeather(true);
  }

  function finishDive(): void {
    mode = "ground";
    phase = "ground";
    hideGlobeBackdrop();
    groundHeight = EYE_HEIGHT;
    yaw = diveYaw0 + 0.7;
    pitch = -0.08;
    groundWeatherTimer = 0;
    updateGroundWeather(true);
    syncHud();
  }

  function returnToOrbit(): void {
    if (mode !== "ground" && mode !== "dive") return;
    if (mode === "dive" && diveDirection === "up") return;
    mode = "ascend";
    // Leaving mid-dive cancels a pending wait for atlas faces (and ignores the fetch's late completion).
    groundPending = false;
    groundToken++;
    diveDirection = "up";
    phase = "ascend: climb";
    diveT = 0;
    diveHeight0 = Math.max(groundHeight, EYE_HEIGHT);
    divePitch0 = pitch;
    ascendYaw = yaw;
    measureBackdropSink();
    spin.touch();
    if (instant) {
      swapToOrbit();
      finishAscend();
    }
  }

  function swapToOrbit(): void {
    phase = "ascend: orbit";
    diveT = 0;
    hideGlobeBackdrop();
    setGlobeVisible(true);
    applyOrbitSettings();
    scene.settings.sky.seaLevel = 0;
    orbitAlt = SWAP_ALTITUDE;
    destroyGround();
  }

  function finishAscend(): void {
    mode = "orbit";
    phase = "orbit";
    orbitAlt = orbitFitAltitude(R, ORBIT_FOV, aspect()) * zoom;
    spin.touch();
    syncHud();
  }

  function focusOn(latDeg: number, lonDeg: number): void {
    if (mode !== "orbit") return;
    const q = planetOrientationForSite(latDeg, lonDeg, 0, new Quat());
    spin.animateTo(q, 1.6);
  }

  // ------------------------------------------------------------------ frame
  const hazeTarget = (): number => {
    if (mode === "orbit") return 0;
    if (mode === "dive") return diveDirection === "down" && phase.endsWith("approach") ? entryHaze(orbitAlt, false) : entryHaze(groundHeight, true);
    if (mode === "ascend") return phase.endsWith("orbit") ? entryHaze(orbitAlt, false) : entryHaze(groundHeight, true);
    return 0;
  };

  let hudTimer = 0;
  function syncHud(): void {
    const l = ls();
    elSeason.textContent = `Ls ${l.toFixed(0)}° · sol ${Math.floor(sols)} · ${seasonName(l)}`;
    elLsVal.textContent = `${l.toFixed(0)}°`;
    if (document.activeElement !== elLs) elLs.value = String(Math.round(l) % 360);
    const inGround = mode === "ground" || mode === "dive" || mode === "ascend";
    elReturn.style.display = mode === "ground" || (mode === "dive" && phase.includes("descent")) ? "block" : "none";
    elGround.style.display = mode === "ground" ? "block" : "none";
    elHoursWrap.style.display = mode === "ground" ? "flex" : "none";
    elDraw.style.display = mode === "ground" ? "" : "none";
    elDest.style.display = mode === "orbit" ? "" : "none";
    elLandmarks.style.display = mode === "orbit" ? "" : "none";
    if (mode !== "orbit" && selectedLandmark) selectLandmark(null);
    if (mode === "ground" && site) {
      const hrs = localHours();
      elHoursVal.textContent = clockText(hrs);
      if (document.activeElement !== elHours) elHours.value = String(hrs);
      const w = sample;
      elGround.innerHTML =
        `<b>${site.latDeg.toFixed(1)}°, ${site.lonDeg.toFixed(1)}°</b> · elev ${(site.elevation / 1000).toFixed(1)} km<br>` +
        `local time ${clockText(hrs)} · Ls ${l.toFixed(0)}°<br>` +
        `${describeWeather(w)}<br>` +
        `wind ${weather?.state.windSpeed.toFixed(0) ?? "?"} m/s · ${weather?.state.temperatureC.toFixed(0) ?? "?"} °C` +
        (devils && devils.activity > 0.05 ? ` · devils ${devils.state().alive}` : "") +
        (frost > 0.05 ? " · frost" : "");
    }
    // Status line
    if (atlasInfo.status === "loading" && !globe) elStatus.textContent = "loading elevation data…";
    else if (groundPending) elStatus.textContent = `loading terrain detail (${atlasInfo.size})…`;
    else if (globe && !globe.ready) elStatus.textContent = `baking surface ${Math.round(globe.progress * 100)}%`;
    else if (inGround && mode !== "ground") elStatus.textContent = phase;
    else elStatus.textContent = mode === "orbit" ? `altitude ${(orbitAlt / 1000).toFixed(0)} km` : "";
    // Events
    const active = planet.activeEvents(0.05).slice(0, 6);
    const html = active
      .map((a) => `<div class="mo-ev" data-ev="${a.def.id}" title="${a.def.label ?? a.def.id}"><span>${a.def.label ?? a.def.id}</span><span class="mo-bar ${barClass(a.def.kind)}"><i style="width:${Math.round(a.intensity * 100)}%"></i></span></div>`)
      .join("");
    if (html !== lastEventsHtml) {
      lastEventsHtml = html;
      elEvents.innerHTML = html || '<div class="mo-sub">Quiet season</div>';
    }
  }
  let lastEventsHtml = "";

  let lastAtmRefresh = -1;
  let simTime = 0;

  function update(dtRaw: number): void {
    const dt = clamp(dtRaw, 0, 0.1);
    simTime += dt;
    // The globe bakes progressively, a few ms per frame; faster while it is the only thing on screen.
    if (globe && mode !== "ground") {
      // Once baked, a detail patch bake gets the tier's budget; otherwise the globe only refreshes layers.
      const budget = globe.ready
        ? (globe.detailBusy ? (options.bakeBudgetMs ?? cfg.bakeBudgetMs * 2) : 1.5)
        : (options.bakeBudgetMs ?? cfg.bakeBudgetMs * (mode === "orbit" ? 1.6 : 0.8));
      globe.update(budget);
    }

    // season clock: whole-sol jumps keep the time of day continuous
    if (mode === "orbit" || mode === "dive") {
      seasonAccumulator += seasonRate * dt;
      if (seasonAccumulator >= 1) {
        const n = Math.floor(seasonAccumulator);
        seasonAccumulator -= n;
        sols += n;
      }
    } else if (mode === "ground") {
      // The ground clock: one sol in five minutes, so a day/night cycle is watchable.
      sols += dt / GROUND_SOL_SECONDS;
    }
    planet.setSols(sols);
    markSeasonChanged();

    spin.update(dt);

    switch (mode) {
      case "orbit":
        updateOrbit(dt);
        break;
      case "dive":
        updateDive(dt);
        break;
      case "ground":
        updateGround(dt);
        break;
      case "ascend":
        updateAscend(dt);
        break;
    }

    // Planet transforms: the globe turns with the spin controller.
    if (mode === "orbit" || (mode === "dive" && phase.endsWith("approach")) || (mode === "ascend" && phase.endsWith("orbit"))) {
      for (const e of [globeEntity, cloudEntity, detailEntity]) if (e) e.transform.rotation = tmpQ.copyFrom(spin.orientation);
      focusGlobeDetail();
      syncDetailVisible();
      applyOrbitLighting();
      // Cloud layer refresh: at most ~2/s, sliced across frames by the globe.
      if (globe && !globe.atmosphereBusy && simTime - lastAtmRefresh > 0.45 && planet.needsAtmosphereRefresh(0.25)) {
        lastAtmRefresh = simTime;
        planet.markRefreshed();
        globe.invalidateAtmosphere();
      }
    }

    updateLandmarks();

    // Entry haze.
    const target = hazeTarget();
    hazeAlpha += (target - hazeAlpha) * (1 - Math.exp(-dt * 12));
    haze.style.opacity = hazeAlpha < 0.004 ? "0" : hazeAlpha.toFixed(3);

    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.2;
      syncHud();
    }
    diagnostics?.tick(performance.now());
  }

  function setOrbitCamera(): void {
    const fit = orbitFitAltitude(R, ORBIT_FOV, aspect());
    const range = orbitAltitudeRange(fit);
    const target = clamp(fit * zoom, range.min, range.max);
    orbitAlt += (target - orbitAlt) * (instant ? 1 : 0.35);
    camera.fovY = ORBIT_FOV;
    const clip = orbitClipPlanes(R, orbitAlt);
    camera.near = clip.near;
    camera.far = clip.far;
    scene.settings.sky.seaLevel = 0;
  }

  function updateOrbit(_dt: number): void {
    setOrbitCamera();
  }

  const ease = (u: number): number => u * u * (3 - 2 * u);

  /** Altitude above the datum `fallT` seconds into the fall: one log-height ease from orbit to eye height. */
  const fallAltitude = (): number => lerpLog(diveAlt0, EYE_HEIGHT, ease(clamp(fallT / DIVE_FALL_SECONDS, 0, 1)));

  function updateDive(dt: number): void {
    diveT += dt;
    if (phase.endsWith("approach")) {
      // Turn first: the altitude holds while the spin brings the site under the camera; then fall.
      if (!spin.isAnimating) fallT += dt;
      let altitude = fallAltitude();
      if (altitude <= SWAP_ALTITUDE && groundPending) {
        // Still waiting for the site's atlas faces: hover at the swap until they arrive.
        fallT -= dt;
        altitude = Math.max(SWAP_ALTITUDE, fallAltitude());
      }
      orbitAlt = Math.max(altitude, SWAP_ALTITUDE);
      camera.fovY = ORBIT_FOV;
      const clip = orbitClipPlanes(R, orbitAlt);
      camera.near = clip.near;
      camera.far = clip.far;
      scene.settings.sky.seaLevel = 0;
      if (altitude <= SWAP_ALTITUDE && !groundPending) swapToGround();
      return;
    }
    // descent through the ground world's atmosphere, on the same fall clock
    fallT += dt;
    const u = clamp((fallT - fallSwapT) / Math.max(0.1, DIVE_FALL_SECONDS - fallSwapT), 0, 1);
    groundHeight = Math.max(EYE_HEIGHT, descentGroundHeight(fallAltitude(), site?.elevation ?? 0));
    pitch = divePitch0 + (-0.08 - divePitch0) * smoothstep(0.45, 1, u);
    yaw = diveYaw0 + 0.7 * smoothstep(0.4, 1, u);
    placeGroundCamera(dt, true);
    placeGlobeBackdrop();
    if (u >= 1) finishDive();
  }

  /**
   * Below the swap the globe stays drawn as a backdrop under the terrain, so a falling camera sees real
   * ground to the horizon and not just the terrain's few-kilometre disc. In the site frame the globe sits
   * where the orbit view had it (centre `−R`, site up), lowered so its exaggerated relief stays under the
   * terrain: by the site's own exaggeration plus `backdropSink`, the most it rises above the site
   * anywhere on the disc (sampled at the detail patch's resolution, which is what is drawn). It eases down from the swap so the hand-over does not jump, and hides once the
   * terrain and the fog fill the view.
   */
  let backdropSink = 0;
  const backdropBasis = { up: new Vec3(), east: new Vec3(), north: new Vec3() };
  function measureBackdropSink(): void {
    if (!site) return;
    const b = planetSiteBasis(site.latDeg, site.lonDeg, 0, backdropBasis);
    const reach = cfg.viewDistance * drawScale;
    let rise = 0;
    for (const f of [0.35, 0.7, 1]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const x = Math.cos(a) * reach * f;
        const z = Math.sin(a) * reach * f;
        scratchA.set(b.up.x * R + b.east.x * x + b.north.x * z, b.up.y * R + b.east.y * x + b.north.y * z, b.up.z * R + b.east.z * x + b.north.z * z);
        scratchA.normalize();
        rise = Math.max(rise, sampler.elevation(scratchA.x, scratchA.y, scratchA.z) - site.elevation);
      }
    }
    backdropSink = rise * GLOBE_EXAGGERATION + 400;
  }

  let backdropShown = false;
  function placeGlobeBackdrop(): void {
    if (!globe || !globeEntity || !site) return;
    const show = globe.ready && groundHeight > Math.max(1500, 0.6 * cfg.viewDistance * drawScale);
    if (show) {
      const lower = (site.elevation * (GLOBE_EXAGGERATION - 1) + backdropSink) * (1 - smoothstep(SWAP_ALTITUDE / 3, SWAP_ALTITUDE, groundHeight));
      for (const e of [globeEntity, detailEntity]) {
        if (!e) continue;
        e.transform.position = scratchB.set(0, -R - lower, 0);
        e.transform.rotation = tmpQ.copyFrom(site.quat);
      }
      // The detail patch follows the falling camera, as it does an orbit zoom.
      const radius = detailFocusRadius(R, groundHeight, camera.fovY, aspect());
      if (radius > 0) {
        latLonToDirection(site.latDeg, site.lonDeg, scratchA);
        globe.setDetailFocus(scratchA.x, scratchA.y, scratchA.z, radius);
      }
    }
    if (show === backdropShown && !show) return;
    backdropShown = show;
    // The base sphere's facets are far coarser than a crater: over a basin floor its surface sits kilometres
    // above the real ground, so a camera falling to the floor ends up inside it. Below the swap only the
    // detail patch, meshed at the patch's own resolution, is drawn once it is baked.
    const gr = scene.world.getComponent(globeEntity.id, Renderable);
    if (gr) gr.visible = show && !globe.detailVisible;
    const dr = detailEntity ? scene.world.getComponent(detailEntity.id, Renderable) : null;
    if (dr) dr.visible = show && globe.detailVisible;
  }

  /** Put the globe back where the orbit view keeps it (and hidden, until `setGlobeVisible`). */
  function hideGlobeBackdrop(): void {
    backdropShown = false;
    for (const e of [globeEntity, detailEntity]) {
      if (!e) continue;
      e.transform.position = scratchB.set(0, -R, 0);
      const r = scene.world.getComponent(e.id, Renderable);
      if (r) r.visible = false;
    }
  }

  function updateAscend(dt: number): void {
    diveT += dt;
    if (phase.endsWith("climb")) {
      const u = clamp(diveT / DIVE_GROUND_SECONDS, 0, 1);
      groundHeight = lerpLog(diveHeight0, descentGroundHeight(SWAP_ALTITUDE, site?.elevation ?? 0), ease(u));
      pitch = divePitch0 + (ORBIT_VIEW_PITCH - divePitch0) * smoothstep(0.1, 0.8, u);
      yaw = ascendYaw * (1 - smoothstep(0.1, 0.9, u));
      camX *= 1 - smoothstep(0.1, 0.9, u) * 0.2;
      camZ *= 1 - smoothstep(0.1, 0.9, u) * 0.2;
      placeGroundCamera(dt, true);
      placeGlobeBackdrop();
      if (u >= 1) {
        // Back to the globe at the site, still under the haze.
        const q = site?.quat;
        swapToOrbit();
        if (q) spin.setOrientation(q);
      }
      return;
    }
    const u = clamp(diveT / (DIVE_ORBIT_SECONDS * 0.9), 0, 1);
    const fit = orbitFitAltitude(R, ORBIT_FOV, aspect());
    orbitAlt = lerpLog(SWAP_ALTITUDE, fit * zoom, ease(u));
    camera.fovY = ORBIT_FOV;
    const clip = orbitClipPlanes(R, orbitAlt);
    camera.near = clip.near;
    camera.far = clip.far;
    if (u >= 1) finishAscend();
  }

  function updateGround(dt: number): void {
    // walk: WASD / arrows, relative to the view heading
    let fwd = 0;
    let right = 0;
    if (keys.has("w") || keys.has("arrowup")) fwd += 1;
    if (keys.has("s") || keys.has("arrowdown")) fwd -= 1;
    if (keys.has("d") || keys.has("arrowright")) right += 1;
    if (keys.has("a") || keys.has("arrowleft")) right -= 1;
    if (fwd !== 0 || right !== 0) {
      const speed = (keys.has("shift") ? 40 : 12) + groundHeight * 0.4;
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      camX += (sy * fwd + cy * right) * speed * dt;
      camZ += (cy * fwd - sy * right) * speed * dt;
    }
    placeGroundCamera(dt, false);
    // ground weather ~3×/s
    groundWeatherTimer -= dt;
    if (groundWeatherTimer <= 0) {
      groundWeatherTimer = 0.35;
      updateGroundWeather(false);
    }
  }

  function placeGroundCamera(dt: number, transitional: boolean): void {
    const th = terrain && terrain.chunks.size > 0 ? terrain.getHeightAt(camX, camZ) : groundY;
    // The terrain height under a camera outside the loaded disc is an approximation: smooth it.
    const targetY = Number.isFinite(th) ? th : groundY;
    groundY += (targetY - groundY) * (1 - Math.exp(-dt * (transitional ? 3 : 8)));
    if (!Number.isFinite(groundY) || !site) groundY = site?.elevation ?? 0;
    camera.fovY = ORBIT_FOV + (GROUND_FOV - ORBIT_FOV) * smoothstep(5e4, 2e3, groundHeight) * 1;
    if (groundHeight > 5e4) camera.fovY = ORBIT_FOV;
    camera.near = clamp(groundHeight * 0.01, 0.3, 4000);
    camera.far = Math.max(6000, groundHeight * 12, cfg.viewDistance * drawScale * 1.6);
    scene.settings.sky.seaLevel = groundY;
    pushGroundFog(false);
    sunToSceneGround();
  }

  const lastGroundSun = new Vec3();
  let lastObserverHeight = -1;
  function sunToSceneGround(): void {
    if (!solar || !site) return;
    groundSun(scratchB);
    // The sun's colour follows the camera's height too: white above the dust on a dive, butterscotch below.
    const observer = clamp(groundHeight, 0, SWAP_ALTITUDE);
    const climbed = Math.abs(observer - lastObserverHeight) > Math.max(25, lastObserverHeight * 0.03);
    if (scratchB.dot(lastGroundSun) < 0.99999 || climbed) {
      lastGroundSun.copyFrom(scratchB);
      lastObserverHeight = observer;
      solar.externalSunDirection!.copyFrom(scratchB);
      solar.observerHeight = observer;
      solar.apply();
      weather?.apply();
    }
  }

  // ------------------------------------------------------------------ handle
  const eyeArr: [number, number, number] = [0, 0, 0];
  const tgtArr: [number, number, number] = [0, 0, 0];

  const cameraOverride = (): { eye: [number, number, number]; target: [number, number, number]; rotation?: [number, number, number, number] } => {
    if (mode === "orbit" || (mode === "dive" && phase.endsWith("approach")) || (mode === "ascend" && phase.endsWith("orbit"))) {
      eyeArr[0] = 0;
      eyeArr[1] = orbitAlt;
      eyeArr[2] = 0;
      return { eye: eyeArr, target: tgtArr, rotation: orbitRotation() };
    }
    eyeArr[0] = camX;
    eyeArr[1] = groundY + groundHeight;
    eyeArr[2] = camZ;
    return { eye: eyeArr, target: tgtArr, rotation: groundViewQuaternion(yaw, pitch, viewQuat) };
  };

  function setDiagnostics(visible: boolean): void {
    diagnostics?.setVisible(visible);
    elDiag.classList.toggle("on", visible);
  }

  const handleState = (): MarsOrbitState => {
    const dirPF = rotateByQuatInverse(spin.orientation, scratchA.set(0, 1, 0), scratchB);
    directionToLatLon(dirPF, latLon);
    return {
      mode,
      phase,
      altitude: mode === "orbit" || phase.endsWith("approach") || phase.endsWith("orbit") ? orbitAlt : groundHeight,
      ls: ls(),
      sols,
      localHours: localHours(),
      subCameraLatDeg: latLon.latDeg,
      subCameraLonDeg: latLon.lonDeg,
      site: site ? { latDeg: site.latDeg, lonDeg: site.lonDeg } : null,
      globeReady: globe?.ready ?? false,
      globeProgress: globe?.progress ?? 0,
      globeBakedColumns: globe?.bakedColumns ?? 0,
      drawDistance: { scale: drawScale, metres: cfg.viewDistance * drawScale },
      landmarks: { on: landmarksOn, visible: [...visibleLandmarks], selected: selectedLandmark?.id ?? null },
      globeDetail: { visible: globe?.detailVisible ?? false, busy: globe?.detailBusy ?? false, radiusDeg: globe?.detailRadiusDeg ?? 0 },
      atlas: { ...atlasInfo },
      autoSpin: spin.autoSpinBlend,
      spinPhase: spin.phase,
      inertia: spin.inertiaSpeed,
      gesture: gestures.mode,
      pointers: gestures.pointerCount,
      haze: hazeAlpha,
      seasonRate,
      activeEvents: planet.activeEvents(0.02).map((a) => ({ id: a.def.id, kind: a.def.kind, intensity: a.intensity })),
      weather: mode === "ground" ? { ...sample } : null,
      devils: devils?.state().alive ?? 0,
      terrainReadyChunks: terrain ? [...terrain.chunks.values()].filter((c) => c.state === "ready").length : 0,
      terrainChunks: terrain?.chunks.size ?? 0,
      frost,
      diagnosticsVisible: diagnostics?.visible ?? false,
      tier,
    };
  };

  // initial HUD
  setSeasonRate(seasonRate);
  markSeasonChanged(true);
  applyOrbitSettings();
  applyOrbitLighting();
  syncHud();
  // Open at the framing the first frame will use.
  orbitAlt = orbitFitAltitude(R, ORBIT_FOV, aspect());

  if (atlasInfo.status === "off") {
    createGlobe();
  } else {
    void atlasCtl.ready.then(() => {
      if (disposedScene) return;
      if (atlasCtl.atlas && atlasInfo.status === "ready") sampler.setAtlas(atlasCtl.atlas);
      createGlobe();
    });
  }

  return {
    scene,
    cameraEntity,
    camera: { pointerInput: false, keyboard: false, minDistance: 1, maxDistance: 1e9 },
    controlsHint: "Drag: spin the planet · click a marker: what it is · double-click / double-tap: land there (on the ground: the sky to fly back up) · wheel / pinch: zoom · Esc: back to orbit · T: touch diagnostics",
    cameraOverride,
    overlay: () => {
      const s = handleState();
      return (
        `mars orbit: ${s.mode}${s.phase !== s.mode ? ` (${s.phase})` : ""} · Ls ${s.ls.toFixed(0)}° · ` +
        `${s.mode === "orbit" ? `alt ${(s.altitude / 1000).toFixed(0)} km` : `h ${s.altitude.toFixed(0)} m`} · ` +
        `globe ${globe ? (s.globeReady ? `${s.globeBakedColumns} cols` : `${Math.round(s.globeProgress * 100)}%`) : "n/a"} · ` +
        `elev ${s.atlas.status === "off" ? "procedural" : `${s.atlas.size}${s.atlas.resolution ? ` ${s.atlas.resolution}²` : ""} ${s.atlas.status}`} · ` +
        `tier ${tier} · spin ${s.spinPhase}`
      );
    },
    update,
    marsOrbitState: handleState,
    diveTo,
    returnToOrbit,
    focusOn,
    setSolarLongitude,
    setLocalHours,
    setSeasonRate,
    setDiagnostics,
    zoomOrbit: (factor) => zoomBy(factor),
    setDrawDistance: (scale) => { if ([1, 2, 4].includes(scale)) setDrawScale(scale); },
    pickAt: (x, y) => (mode === "orbit" ? pointerLatLon(x, y) : null),
    dispose: () => {
      disposedScene = true;
      atlasCtl.dispose();
      abort.abort();
      destroyGround();
      diagnostics?.dispose();
      hud.remove();
      haze.remove();
      css.remove();
      globe?.dispose();
    },
  };
}

// ------------------------------------------------------------------------------------- HUD helpers

function seasonName(ls: number): string {
  const l = ((ls % 360) + 360) % 360;
  if (l < 90) return "N spring";
  if (l < 180) return "N summer · aphelion";
  if (l < 270) return "N autumn · dust season";
  return "N winter";
}

function clockText(hours: number): string {
  const h = ((hours % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function barClass(kind: string): string {
  return kind === "ice-cloud" ? "ice" : kind === "frost" ? "frost" : "dust";
}

function describeWeather(s: PlanetWeatherSample): string {
  const bits: string[] = [];
  if (s.dust > 0.6) bits.push("dust storm");
  else if (s.dust > 0.25) bits.push("hazy with dust");
  else if (s.dust > 0.08) bits.push("light dust haze");
  if (s.iceCloud > 0.35) bits.push("ice clouds");
  else if (s.iceCloud > 0.12) bits.push("thin ice cloud");
  if (s.devilActivity > 0.4) bits.push("dust devils");
  if (s.cap > 0.2) bits.push("polar cap");
  if (s.frost > 0.2) bits.push("frost");
  return bits.length ? bits.join(" · ") : "clear";
}
