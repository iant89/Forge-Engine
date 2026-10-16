/**
 * Beacon Defense — the Phase 18 exit-criterion game: a complete gameplay loop written only as
 * scripts against the public API (`@forge/engine`), with no engine changes.
 *
 * Waves of drones close in on a beacon; a turret shoots the nearest one in range; drones that reach
 * the beacon damage it; when it falls the game is over and restarts after a pause.
 *
 *  - WaveDirector  a "sim" coroutine: announce a wave, spawn its drones a fixed number of steps
 *                  apart, wait until the field is clear, rest, next wave (Phase 18.3).
 *  - Drone         moves on onFixedUpdate (deterministic), takes `DroneHit` on its own entity
 *                  channel, posts `DroneDown` when destroyed, emits `BeaconHit` on arrival (18.1, 18.4).
 *  - Turret        a repeating "sim" timer picks the nearest drone and emits `DroneHit` to it (18.2).
 *  - Beacon        takes `BeaconHit`, flashes on a "render" timer, emits `GameOver` once (18.2, 18.4).
 *  - Scoreboard    listens to everything for the HUD and restarts the game after a game over.
 *
 * All gameplay runs on the fixed-step clock and reads positions from the `Transform` components
 * (not world matrices, which refresh once per frame), so the same fixed steps give the same game
 * however the frames split them (pinned by tests/examples/beaconDefense.test.ts). The scene supplies meshes and
 * materials (the only GPU-facing part) through `BeaconDefenseAssets`.
 */

import {
  Component,
  Renderable,
  Script,
  ScriptComponent,
  Transform,
  Wait,
  defineEvent,
  registerComponent,
  type EntityId,
  type Geometry,
  type Material,
  type ScriptContext,
  type ScriptEntity,
} from "@forge/engine";

/** What the scene hands the scripts: the meshes and materials drones are drawn with. */
export interface BeaconDefenseAssets {
  droneGeometry: Geometry;
  droneMaterial: Material;
}

export interface BeaconDefenseTuning {
  /** Turret shot interval in fixed steps. */
  fireSteps: number;
  /** Damage per shot. */
  damage: number;
  range: number;
  /** Drone spawn radius around the beacon. */
  spawnRadius: number;
  beaconHp: number;
}

export const DEFAULT_TUNING: BeaconDefenseTuning = { fireSteps: 18, damage: 1, range: 15, spawnRadius: 22, beaconHp: 20 };

// --------------------------------------------------------------------------------------- events

export const DroneHit = defineEvent<{ damage: number }>("DroneHit");
export const DroneDown = defineEvent<{ points: number; tick: number }>("DroneDown");
export const BeaconHit = defineEvent<{ damage: number }>("BeaconHit");
export const WaveStarted = defineEvent<{ wave: number; drones: number }>("WaveStarted");
export const GameOver = defineEvent<void>("GameOver");
export const GameRestart = defineEvent<void>("GameRestart");

/** Marks drones so the turret and the director can find them. */
export class DroneTag extends Component {
  static readonly typeName = "BeaconDefenseDrone";
}
registerComponent(DroneTag as never, { name: "BeaconDefenseDrone" });

const TINT_HIT = 0xffffe0a0;

// --------------------------------------------------------------------------------------- scripts

export class Drone extends Script {
  hp: number;
  readonly speed: number;
  readonly points: number;

  constructor(private readonly beacon: EntityId, wave: number) {
    super();
    this.hp = 2 + wave;
    this.speed = 1.8 + 0.2 * wave;
    this.points = 10 * wave;
  }

  override onCreate(): void {
    this.on(DroneHit, (hit, c) => {
      this.hp -= hit.damage;
      const r = c.entity.get(Renderable);
      if (r) {
        r.tint = TINT_HIT;
        this.after(0.08, () => (r.tint = 0), { clock: "render" });
      }
      if (this.hp <= 0) {
        this.post(DroneDown, { points: this.points, tick: c.time.tick });
        c.entity.destroy();
      }
    }, { entity: this.entity! });
  }

  override onFixedUpdate(c: ScriptContext): void {
    const t = c.entity.get(Transform);
    if (!t) return;
    const target = c.world.getComponent(this.beacon, Transform)!.position;
    const dx = target.x - t.position.x;
    const dz = target.z - t.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.4) {
      this.emit(BeaconHit, { damage: 1 }, { to: this.beacon });
      c.entity.destroy();
      return;
    }
    const step = Math.min(d, this.speed * c.time.dt);
    t.setPosition(t.position.x + (dx / d) * step, 1 + 0.25 * Math.sin(c.time.tick * 0.08 + this.points), t.position.z + (dz / d) * step);
  }
}

export class Turret extends Script {
  shots = 0;
  constructor(private readonly tuning: BeaconDefenseTuning) {
    super();
  }

  override onCreate(): void {
    this.every(0, (c) => this.fire(c), { steps: this.tuning.fireSteps });
  }

  fire(c: ScriptContext): void {
    const me = c.entity.get(Transform)!.position;
    const drones = c.world.store(DroneTag);
    let best: EntityId | null = null;
    let bestD = this.tuning.range;
    for (let i = 0; i < drones.count; i++) {
      const id = drones.valueAt(i).entity;
      const p = c.world.getComponent(id, Transform)!.position;
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      // Ties go to the lower id, so the choice never depends on store order.
      if (d < bestD || (d === bestD && best !== null && id < best)) {
        bestD = d;
        best = id;
      }
    }
    if (best === null) return;
    this.shots++;
    this.emit(DroneHit, { damage: this.tuning.damage }, { to: best });
  }
}

export class Beacon extends Script {
  hp: number;
  down = false;
  constructor(private readonly tuning: BeaconDefenseTuning) {
    super();
    this.hp = tuning.beaconHp;
  }

  override onCreate(c: ScriptContext): void {
    this.on(BeaconHit, (hit, cc) => {
      if (this.down) return;
      this.hp = Math.max(0, this.hp - hit.damage);
      const r = cc.entity.get(Renderable);
      if (r) {
        r.tint = 0xffff4040;
        this.after(0.15, () => (r.tint = 0), { clock: "render" });
      }
      if (this.hp === 0) {
        this.down = true;
        this.emit(GameOver, undefined);
      }
    }, { entity: c.entity });
    this.on(GameRestart, () => {
      this.hp = this.tuning.beaconHp;
      this.down = false;
    });
  }
}

export class WaveDirector extends Script {
  wave = 0;
  spawned = 0;
  constructor(
    private readonly beacon: EntityId,
    private readonly assets: BeaconDefenseAssets,
    private readonly tuning: BeaconDefenseTuning,
  ) {
    super();
  }

  override onCreate(): void {
    this.begin();
    this.on(GameOver, () => this.stopCoroutines());
    this.on(GameRestart, () => {
      this.wave = 0;
      this.begin();
    });
  }

  private begin(): void {
    const self = this;
    this.startCoroutine(function* (c) {
      for (;;) {
        self.wave++;
        const count = 2 + self.wave;
        // Posted, not emitted: the first wave starts inside onCreate, before scripts created after
        // the director (the scoreboard) have subscribed; a queued event reaches them next phase.
        self.post(WaveStarted, { wave: self.wave, drones: count });
        for (let i = 0; i < count; i++) {
          self.spawn(c, i, count);
          yield Wait.steps(36);
        }
        yield Wait.until(() => c.world.store(DroneTag).count === 0);
        yield Wait.seconds(2);
      }
    }, { clock: "sim", name: "waves" });
  }

  private spawn(c: ScriptContext, index: number, count: number): void {
    // Deterministic placement: evenly around the ring, rotated per wave.
    const angle = (index / count) * Math.PI * 2 + this.wave * 0.7;
    const r = this.tuning.spawnRadius;
    const e: ScriptEntity = c.world.createEntity(`drone-${this.wave}-${index}`);
    e.add(new Transform()).setPosition(Math.cos(angle) * r, 1, Math.sin(angle) * r);
    const body = new Renderable();
    body.geometry = this.assets.droneGeometry;
    body.material = this.assets.droneMaterial;
    e.add(body);
    e.add(new DroneTag());
    e.add(new ScriptComponent(new Drone(this.beacon, this.wave)));
    this.spawned++;
  }
}

export class Scoreboard extends Script {
  score = 0;
  kills = 0;
  wave = 0;
  gameOver = false;
  games = 1;
  /** Tick of every kill, for determinism checks. */
  readonly killTicks: number[] = [];

  constructor(private readonly restartAfterSeconds: number) {
    super();
  }

  override onCreate(): void {
    this.on(DroneDown, (e) => {
      this.score += e.points;
      this.kills++;
      this.killTicks.push(e.tick);
    });
    this.on(WaveStarted, (e) => (this.wave = e.wave));
    this.on(GameOver, (_e, c) => {
      this.gameOver = true;
      // Clear the field, then restart after a pause (sim clock: the restart is deterministic too).
      const drones = c.world.store(DroneTag).liveValues();
      for (const d of drones) c.world.destroyEntity(d.entity);
      this.after(this.restartAfterSeconds, () => {
        this.gameOver = false;
        this.score = 0;
        this.kills = 0;
        this.games++;
        this.emit(GameRestart, undefined);
      });
    });
  }
}
