/**
 * The Phase 19.5 verification session: a complete vehicle session, built the same way on every
 * JavaScript engine, so a recording made on one replays to the same state hashes on all of them.
 *
 * It is the offroad demo's simulation without its renderer: a closed gravel track carved into a
 * hillside (`TrackTerrain`), the weather-driven ground under it (`TrackWeatherGround`: moisture, mud,
 * snow and per-surface grip), `WeatherSystem` going from clear through rain into a thunderstorm and
 * then snow, `LightningSystem`, `DayNightCycle` running at 120× (the sun drives the melt), the raycast
 * car with a physics chassis, and rigid-body crates on the course for it to hit. A scripted driver in
 * the input band follows the centreline (throttle, brake, steer, handbrake, reverse) and changes the
 * weather on a timetable, so recording needs no human.
 *
 * Every number the simulation computes goes through exact arithmetic or `DMath`; nothing here reads
 * wall time or `Math.random`. `tests/replay/crossEngine.test.ts` replays the committed recording
 * (`tests/replay/fixtures/vehicle-session.replay.json`) in Node, `npm run check:replay-engines` replays
 * it under JavaScriptCore (Bun), and the `?scene=replay-verify` page replays it in whichever browser
 * opens it.
 */

import {
  ColliderComponent,
  DMath,
  DayNightCycle,
  ForgeJSPhysics,
  HeightfieldShape,
  LightningSystem,
  ManualClock,
  PhysicsSystem,
  Profiler,
  Logger,
  ReplayRecorder,
  RigidBodyComponent,
  Rng,
  Scene,
  SceneObject,
  System,
  SystemScratch,
  TrackSpline,
  TrackTerrain,
  TrackWeatherGround,
  Transform,
  Vehicle,
  VehicleComponent,
  VehicleSystem,
  WeatherSystem,
  createMeltEnvironment,
  createVehicleChassis,
  createVehicleConfig,
  fbm2,
  heightFunctionGround,
  sampleMeltEnvironment,
  setWorldSurfaceGripField,
  vehicleInputChannel,
  type Clock,
  type ReplayChannel,
  type ReplayRecording,
  type SystemContext,
  type TickResult,
  type TrackProjection,
  type WeatherState,
} from "@forge/engine";

export const VERIFY_FIXED_DT = 1 / 60;
/** Frames the session settles (crates land, suspension rests) before recording starts. */
export const VERIFY_SETTLE_FRAMES = 45;

const COURSE = [
  { x: -12, z: -150 }, { x: -34, z: -118 }, { x: -44, z: -80 }, { x: -28, z: -42 }, { x: -44, z: -2 },
  { x: -30, z: 38 }, { x: -50, z: 78 }, { x: -36, z: 118 }, { x: -46, z: 158 }, { x: -28, z: 198 },
  { x: 0, z: 228 }, { x: 34, z: 226 }, { x: 56, z: 196 }, { x: 42, z: 156 }, { x: 62, z: 116 },
  { x: 46, z: 76 }, { x: 66, z: 36 }, { x: 50, z: -4 }, { x: 64, z: -44 }, { x: 46, z: -84 },
  { x: 40, z: -124 }, { x: 18, z: -156 },
];
const START_S = 10;

const CLEAR: Partial<WeatherState> = { cloudCoverage: 0.15, precipitation01: 0, storm01: 0, temperatureC: 14, windSpeed: 2, humidity01: 0.5 };
const RAIN: Partial<WeatherState> = { cloudCoverage: 0.85, precipitation01: 0.7, storm01: 0.2, temperatureC: 9, windSpeed: 6, humidity01: 0.9 };
const STORM: Partial<WeatherState> = { cloudCoverage: 1, precipitation01: 1, storm01: 1, temperatureC: 7, windSpeed: 14, gust: 0.6, humidity01: 1 };
const SNOW: Partial<WeatherState> = { cloudCoverage: 0.9, precipitation01: 0.8, storm01: 0, temperatureC: -4, windSpeed: 5, humidity01: 0.85 };

/** The hillside the track is carved into: engine noise plus `DMath` (never `Math.sin`). */
function hillside(x: number, z: number): number {
  const climb = 0.085 * z + 0.04 * x;
  const knolls = 7 * fbm2(x / 70, z / 70, 3707, { octaves: 3 });
  const ridges = 2.2 * DMath.sin(z / 23 + DMath.sin(x / 41) * 1.3);
  return climb + knolls + ridges;
}

/** Runs the weather ground's moisture/melt step as part of the scene update (the demo does it per frame). */
class WeatherGroundStep extends SceneObject {
  readonly name = "verify.ground";
  private readonly env = createMeltEnvironment();
  constructor(
    private readonly weather: WeatherSystem,
    readonly ground: TrackWeatherGround,
  ) {
    super();
  }
  override update(_c: SystemContext, dt: number): void {
    sampleMeltEnvironment(this.scene!, this.weather, this.env);
    this.ground.update(dt, this.env);
  }
  override saveState(): Record<string, unknown> {
    // Hash the ground the car drives on: standing water, soil moisture (mud) and snow.
    const f = this.ground.field;
    return { water: Array.from(f.water), moisture: Array.from(f.moisture), snow: Array.from(f.snow) };
  }
}

/**
 * The player: follows the centreline with a look-ahead steer, brakes into the tight corners, uses the
 * handbrake and reverse on a timetable, and walks the weather through its states. It runs in the
 * input band (order 50), before the replay input point, so a recording captures what it wrote.
 */
class ScriptedDriver extends System {
  readonly name = "verify.driver";
  override readonly order = 50;
  frame = 0;
  private readonly proj: TrackProjection = { s: 0, lateral: 0, dist: Infinity, index: -1 };
  private readonly ahead = { x: 0, z: 0, tx: 0, tz: 1 };
  constructor(
    private readonly vehicle: Vehicle,
    private readonly spline: TrackSpline,
    private readonly weather: WeatherSystem,
  ) {
    super();
  }
  private setWeather(now: Partial<WeatherState>, next: Partial<WeatherState>): void {
    this.weather.snapTo(now);
    this.weather.setTarget(next);
  }
  update(): void {
    const f = this.frame++;
    const v = this.vehicle;
    const i = v.input;
    // The weather jumps between states (its own drift takes minutes) and then drifts toward the next.
    if (f === 120) this.setWeather(RAIN, STORM);
    if (f === 420) this.setWeather(STORM, STORM);
    if (f === 780) this.setWeather(SNOW, SNOW);
    this.spline.project(v.position.x, v.position.z, this.proj);
    this.spline.sampleAt(this.proj.s + 9 + v.speed * 0.6, this.ahead);
    const want = DMath.atan2(this.ahead.x - v.position.x, this.ahead.z - v.position.z);
    let err = want - v.yaw;
    err = DMath.atan2(DMath.sin(err), DMath.cos(err));
    i.steer = Math.max(-1, Math.min(1, err * 2.2 - this.proj.lateral * 0.05));
    const target = 14 - 9 * Math.min(1, Math.abs(err) * 1.8);
    if (f >= 560 && f < 620) {
      // A reverse manoeuvre: stop, back up, go again.
      v.selectGear(f < 590 ? -1 : 1);
      i.throttle = f < 590 ? 0.5 : 0;
      i.brake = f < 590 ? 0 : 0.6;
      i.steer = -0.3;
      i.handbrake = 0;
      return;
    }
    if (f === 620) v.selectGear(1);
    i.throttle = v.speed < target ? Math.min(1, (target - v.speed) * 0.35 + 0.25) : 0;
    i.brake = v.speed > target + 2 ? Math.min(1, (v.speed - target) * 0.2) : 0;
    i.handbrake = f % 300 >= 250 && f % 300 < 262 ? 1 : 0;
  }
}

export interface VerificationSession {
  scene: Scene;
  vehicle: Vehicle;
  weather: WeatherSystem;
  driver: ScriptedDriver;
  track: TrackTerrain;
  ground: TrackWeatherGround;
  crates: RigidBodyComponent[];
  channels: ReplayChannel[];
}

/** Build the session. Deterministic: the same build gives the same state on every engine. */
export function buildVerificationSession(): VerificationSession {
  const scene = new Scene({ name: "replay-verify" });
  const spline = new TrackSpline(COURSE, { closed: true, step: 0.5 });
  const track = new TrackTerrain(hillside, spline, {
    roadHalfWidth: 2.2,
    shoulder: 0.45,
    bermWidth: 2.6,
    bermHeight: 0.8,
    blendWidth: 7,
    bedSmoothing: 34,
    rutDepth: 0.06,
    rutOffset: 0.8,
    rutWidth: 0.32,
    seed: 37,
  });
  const heightAt = (x: number, z: number): number => track.heightAt(x, z);
  const ground = heightFunctionGround(heightAt, 0.2);

  const backend = new ForgeJSPhysics({ gravity: { x: 0, y: -9.81, z: 0 } });
  backend.setHeightfield(new HeightfieldShape({ sampleHeight: heightAt }));
  scene.world.registerSystem(new PhysicsSystem({ world: backend.world }));
  scene.world.registerSystem(new VehicleSystem());

  const vehicle = new Vehicle(
    createVehicleConfig({ mass: 1250, wheelbase: 2.35, track: 1.45, wheelRadius: 0.36, cgHeight: 0.55, mu: 1.0, rollingResistance: 0.03, maxBrakeTorque: 3200 }),
  );
  vehicle.config.suspensionRest = 0.36;
  vehicle.config.suspensionTravel = 0.22;
  const start = spline.sampleAt(START_S, { x: 0, z: 0, tx: 0, tz: 1 });
  vehicle.position.set(start.x, 0, start.z);
  vehicle.yaw = DMath.atan2(start.tx, start.tz);
  vehicle.placeOnGround(ground);
  const chassis = createVehicleChassis(vehicle, backend);
  const car = scene.world.createEntity("car");
  const t = new Transform();
  t.setPosition(vehicle.position.x, vehicle.position.y, vehicle.position.z);
  car.add(t);
  const vc = new VehicleComponent(vehicle, ground);
  vc.chassisBody = chassis;
  vc.chassisWorld = backend.world;
  car.add(vc);

  // Crates on the course, a little ahead of the start and off the racing line, for contacts.
  const crates: RigidBodyComponent[] = [];
  const rng = new Rng(19);
  for (let k = 0; k < 6; k++) {
    const c = spline.sampleAt(START_S + 30 + k * 11, { x: 0, z: 0, tx: 0, tz: 1 });
    const lateral = (rng.nextFloat() - 0.5) * 3;
    const x = c.x + c.tz * lateral;
    const z = c.z - c.tx * lateral;
    const e = scene.world.createEntity(`crate${k}`);
    const tr = new Transform();
    tr.setPosition(x, heightAt(x, z) + 0.6 + k * 0.1, z);
    e.add(tr);
    const rb = new RigidBodyComponent();
    rb.bodyType = "dynamic";
    rb.mass = 30 + k * 5;
    e.add(rb);
    const col = new ColliderComponent();
    col.setBox(0.45, 0.45, 0.45);
    e.add(col);
    crates.push(rb);
  }

  const cycle = new DayNightCycle({ name: "dayNight", latitude: 39, dayOfYear: 289, timeOfDay: 13.5, timeScale: 120, driveAmbient: true, driveFog: true, driveSky: true });
  scene.add(cycle);
  cycle.apply();
  const weather = new WeatherSystem({ name: "weather", seed: 3710, initial: CLEAR, target: CLEAR });
  weather.driveVehicles = false; // grip comes from the track ground below
  scene.add(weather);
  scene.add(new LightningSystem({ name: "lightning", seed: 77, rate: 1.5, areaRadius: 120 }));
  const trackGround = new TrackWeatherGround(track, { resolution: 48, timeScale: 30 });
  trackGround.surface = weather.surface;
  setWorldSurfaceGripField(scene.world, (x, z) => trackGround.gripAt(x, z));
  scene.add(new WeatherGroundStep(weather, trackGround));

  const driver = new ScriptedDriver(vehicle, spline, weather);
  scene.world.registerSystem(driver);
  return { scene, vehicle, weather, driver, track, ground: trackGround, crates, channels: [vehicleInputChannel("car", vehicle)] };
}

/** A headless frame context, as the engine builds it, for `scene.update`. */
export function headlessContext(scene: Scene, clock: Clock, tick: TickResult): SystemContext {
  return {
    world: scene.world,
    clock,
    dt: clock.deltaTime,
    fixedDt: clock.fixedDeltaTime,
    fixedSteps: tick.fixedSteps,
    alpha: tick.alpha,
    elapsed: clock.elapsedTime,
    frame: clock.frameIndex,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  } as unknown as SystemContext;
}

/** One frame: advance `clock` by `wallDt` and update the scene with the result. */
export function stepFrame(scene: Scene, clock: ManualClock, wallDt: number): void {
  const tick = clock.advance(wallDt);
  const c = headlessContext(scene, clock, tick);
  scene.update(c, c.dt);
}

/** Bring a fresh build to where recording starts. */
export function settleVerificationSession(s: VerificationSession): void {
  const clock = new ManualClock({ fixedDeltaTime: VERIFY_FIXED_DT });
  for (let i = 0; i < VERIFY_SETTLE_FRAMES; i++) stepFrame(s.scene, clock, VERIFY_FIXED_DT);
}

/**
 * Record `frames` frames of the scripted session under an uneven, seeded frame rate (0–3 fixed steps
 * per frame), the way a real device's frame times wander.
 */
export function recordVerificationSession(frames: number, options: { seed?: number; hashEvery?: number } = {}): { recording: ReplayRecording; session: VerificationSession } {
  const s = buildVerificationSession();
  settleVerificationSession(s);
  const recorder = new ReplayRecorder(s.scene, { channels: s.channels, hashEvery: options.hashEvery ?? 60, meta: { session: "forge.verify.vehicle", frames } });
  recorder.start();
  const rng = new Rng(options.seed ?? 2026);
  const clock = new ManualClock({ fixedDeltaTime: VERIFY_FIXED_DT });
  for (let i = 0; i < frames; i++) stepFrame(s.scene, clock, 0.004 + rng.nextFloat() * 0.045);
  return { recording: recorder.stop(), session: s };
}
