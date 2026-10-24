/**
 * Beacon Defense — the full game behind `?scene=beacon`.
 *
 * The Phase 18 exit criterion (`examples/src/scripting/beaconDefense.ts`, `?scene=scripting`) proves a
 * game *can* be written as scripts. This one is the game: twelve waves of four drone types closing on a
 * beacon, a turret that fights on its own, and a player who aims it, fires a manual cannon, spends
 * credits on six upgrades and triggers three abilities with cooldowns. Clear wave 12 to win; lose when
 * the beacon's integrity reaches zero.
 *
 * Everything here is gameplay, and gameplay is scripts against the public API only:
 *
 *  - `WaveDirector`  a "sim" coroutine: announce a wave, spawn its composition a fixed number of steps
 *                    apart, wait for the field to clear, pay the bonus, hold an intermission the player
 *                    spends credits in (or cuts short with `CallWave`), then the next wave. It also owns
 *                    the meshes, so it is the only script that creates entities — shards included.
 *  - `Drone`         moves on `onFixedUpdate`, takes `DroneHit` on its own entity channel, mirrors its
 *                    health into a `DroneTag` the HUD reads, splits (splitters) or detonates on the
 *                    beacon, and posts `DroneDown` when it dies.
 *  - `Turret`        aims at the player's pointer while there is one and at the nearest drone when there
 *                    is not; an AI servo fires on its own cadence and `PlayerFire` fires the hitscan the
 *                    player aimed. Both read their numbers from `GameState`, so upgrades and overcharge
 *                    change the weapons without the turret knowing how.
 *  - `Beacon`        integrity, reinforcement, repair, the damage flash, and the game-over condition.
 *  - `GameState`     score, credits, kills, upgrades, ability cooldowns and the active-effect windows:
 *                    the one place the rules live, and the source of every number the HUD shows.
 *
 * Determinism follows the same rule the exit criterion pins: gameplay reads `Transform` components and
 * runs on the fixed-step clock ("sim" timers and coroutines), never on frame time or a wall clock, so
 * the same fixed steps give the same game however the frames split them. Presentation — particles,
 * tracers, sound, the HUD — lives in the scene and listens to the events these scripts post.
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
  type ScriptWorld,
} from "@forge/engine";

// ====================================================================================== enemies

export type DroneKind = "scout" | "splitter" | "bruiser" | "bomber";

export const DRONE_KINDS: readonly DroneKind[] = Object.freeze(["scout", "splitter", "bruiser", "bomber"]);

export interface DroneSpec {
  readonly kind: DroneKind;
  readonly label: string;
  /** Health at wave 1, before `waveSpec().hpScale`. */
  readonly hp: number;
  /** Metres per second at wave 1, before `waveSpec().speedScale`. */
  readonly speed: number;
  readonly points: number;
  readonly credits: number;
  /** Aim and arrival radius, in metres. */
  readonly radius: number;
  /** Integrity lost when this drone reaches the beacon. */
  readonly damage: number;
  /** Model scale multiplier. */
  readonly scale: number;
  readonly blurb: string;
}

export const DRONE_SPECS: Readonly<Record<DroneKind, DroneSpec>> = Object.freeze({
  scout: {
    kind: "scout",
    label: "Scout",
    hp: 3,
    speed: 3.6,
    points: 12,
    credits: 7,
    radius: 0.6,
    damage: 4,
    scale: 0.9,
    blurb: "Fast, fragile, comes in numbers.",
  },
  splitter: {
    kind: "splitter",
    label: "Splitter",
    hp: 6,
    speed: 2.6,
    points: 20,
    credits: 11,
    radius: 0.75,
    damage: 5,
    scale: 1.05,
    blurb: "Breaks into two scouts when it dies.",
  },
  bruiser: {
    kind: "bruiser",
    label: "Bruiser",
    hp: 16,
    speed: 1.7,
    points: 45,
    credits: 20,
    radius: 1.05,
    damage: 12,
    scale: 1.4,
    blurb: "Slow and armoured; soaks the AI servo.",
  },
  bomber: {
    kind: "bomber",
    label: "Bomber",
    hp: 10,
    speed: 2.2,
    points: 60,
    credits: 28,
    radius: 0.95,
    damage: 22,
    scale: 1.25,
    blurb: "One leak hurts. Kill it early.",
  },
});

// ======================================================================================== waves

/** Clearing this wave wins the run. */
export const FINAL_WAVE = 12;

export interface WaveEntry {
  readonly kind: DroneKind;
  readonly count: number;
}

export interface WaveSpec {
  readonly wave: number;
  readonly entries: readonly WaveEntry[];
  /** Spawn order: the entries flattened kind by kind, so the sequence never depends on a map. */
  readonly order: readonly DroneKind[];
  readonly drones: number;
  /** Fixed steps between spawns. */
  readonly spawnEvery: number;
  readonly hpScale: number;
  readonly speedScale: number;
}

/**
 * The wave table, computed rather than authored: composition grows by kind as waves unlock, health and
 * speed scale with the wave, and the spawn interval tightens. Pure and deterministic, so a test can ask
 * what wave 7 contains without playing it.
 */
export function waveSpec(wave: number): WaveSpec {
  const w = Math.max(1, Math.floor(wave));
  const entries: WaveEntry[] = [{ kind: "scout", count: 2 + w }];
  // Splitters from wave 3, bruisers from 5, bombers from 8 — a kind joins the wave list only once
  // its formula is past zero, so `entries` reads as "the kinds this wave actually sends".
  const push = (kind: DroneKind, count: number): void => {
    if (count > 0) entries.push({ kind, count });
  };
  if (w >= 3) push("splitter", Math.floor((w - 1) / 2));
  if (w >= 5) push("bruiser", Math.floor((w - 3) / 2));
  if (w >= 7) push("bomber", Math.floor((w - 5) / 3));
  const order: DroneKind[] = [];
  for (const entry of entries) for (let i = 0; i < entry.count; i++) order.push(entry.kind);
  return {
    wave: w,
    entries,
    order,
    drones: order.length,
    spawnEvery: Math.max(14, 42 - 2 * w),
    hpScale: 1 + 0.16 * (w - 1),
    speedScale: 1 + 0.045 * (w - 1),
  };
}

// ===================================================================================== upgrades

export type UpgradeId = "damage" | "rate" | "range" | "multishot" | "shield" | "cooling";

export interface UpgradeDef {
  readonly id: UpgradeId;
  readonly name: string;
  readonly maxLevel: number;
  readonly baseCost: number;
  /** Multiplicative cost growth per level already bought. */
  readonly growth: number;
  readonly hotkey: string;
  readonly blurb: string;
}

export const UPGRADES: readonly UpgradeDef[] = Object.freeze([
  { id: "damage", name: "Warhead", maxLevel: 6, baseCost: 45, growth: 1.55, hotkey: "4", blurb: "+30% turret and cannon damage per level." },
  { id: "rate", name: "Servo", maxLevel: 6, baseCost: 50, growth: 1.6, hotkey: "5", blurb: "The AI turret fires 14% faster per level." },
  { id: "range", name: "Optics", maxLevel: 5, baseCost: 35, growth: 1.5, hotkey: "6", blurb: "+3 m of reach for both weapons per level." },
  { id: "multishot", name: "Rack", maxLevel: 3, baseCost: 110, growth: 2.0, hotkey: "7", blurb: "Every shot hits one more target." },
  { id: "shield", name: "Bulwark", maxLevel: 5, baseCost: 60, growth: 1.7, hotkey: "8", blurb: "+25 beacon integrity, repaired on purchase." },
  { id: "cooling", name: "Cooling", maxLevel: 5, baseCost: 40, growth: 1.55, hotkey: "9", blurb: "The manual cannon recovers 18% faster per level." },
]);

export const UPGRADE_BY_ID: Readonly<Record<UpgradeId, UpgradeDef>> = Object.freeze(
  Object.fromEntries(UPGRADES.map((u) => [u.id, u])) as Record<UpgradeId, UpgradeDef>,
);

/** Credits to go from `level` to `level + 1`; `null` once the upgrade is maxed. */
export function upgradeCost(def: UpgradeDef, level: number): number | null {
  if (level >= def.maxLevel) return null;
  return Math.round(def.baseCost * Math.pow(def.growth, level));
}

// ===================================================================================== abilities

export type AbilityId = "emp" | "overcharge" | "repair";

export interface AbilityDef {
  readonly id: AbilityId;
  readonly name: string;
  /** Glyph name from the engine UI's built-in icon set. */
  readonly icon: string;
  readonly hotkey: string;
  readonly cost: number;
  readonly cooldownSteps: number;
  readonly blurb: string;
}

export const ABILITIES: readonly AbilityDef[] = Object.freeze([
  { id: "emp", name: "EMP pulse", icon: "lightning", hotkey: "1", cost: 30, cooldownSteps: 1080, blurb: "Every drone crawls at 35% speed for 5 s." },
  { id: "overcharge", name: "Overcharge", icon: "swords", hotkey: "2", cost: 45, cooldownSteps: 1440, blurb: "2.5× damage at twice the fire rate for 6 s." },
  { id: "repair", name: "Field repair", icon: "heart", hotkey: "3", cost: 40, cooldownSteps: 1800, blurb: "Restores 30% of the beacon's integrity." },
]);

export const ABILITY_BY_ID: Readonly<Record<AbilityId, AbilityDef>> = Object.freeze(
  Object.fromEntries(ABILITIES.map((a) => [a.id, a])) as Record<AbilityId, AbilityDef>,
);

// ======================================================================================= tuning

export interface BeaconGameTuning {
  readonly beaconHp: number;
  /** Drones detonate this far from the beacon's axis. */
  readonly beaconRadius: number;
  readonly spawnRadius: number;
  /** AI servo: fixed steps between shots, damage, reach, and simultaneous targets. */
  readonly aiFireSteps: number;
  readonly aiDamage: number;
  readonly aiRange: number;
  readonly aiTargets: number;
  /** The player's manual cannon: a hitscan along the aim ray. */
  readonly manualFireSteps: number;
  readonly manualDamage: number;
  readonly manualRange: number;
  /** Lateral tolerance of the hitscan, added to each drone's radius. */
  readonly shotTolerance: number;
  readonly startCredits: number;
  /** Intermission length in fixed steps, and the wave-clear bonus (`base + perWave * wave`). */
  readonly intermissionSteps: number;
  readonly waveClearBonus: number;
  readonly waveClearPerWave: number;
  /** Steps without aim input before the AI takes the barrel back. */
  readonly aimHoldSteps: number;
  readonly empSlow: number;
  readonly empSteps: number;
  readonly overchargeSteps: number;
  readonly overchargeDamage: number;
  readonly overchargeRate: number;
  readonly repairFraction: number;
  readonly shieldBonus: number;
  readonly restartAfterSteps: number;
  readonly winRestartAfterSteps: number;
}

export const DEFAULT_GAME_TUNING: BeaconGameTuning = Object.freeze({
  beaconHp: 120,
  beaconRadius: 2.4,
  spawnRadius: 34,
  aiFireSteps: 26,
  aiDamage: 3,
  aiRange: 22,
  aiTargets: 1,
  manualFireSteps: 20,
  manualDamage: 6,
  manualRange: 30,
  shotTolerance: 0.55,
  startCredits: 60,
  intermissionSteps: 480,
  waveClearBonus: 25,
  waveClearPerWave: 8,
  aimHoldSteps: 150,
  empSlow: 0.35,
  empSteps: 300,
  overchargeSteps: 360,
  overchargeDamage: 2.5,
  overchargeRate: 0.5,
  repairFraction: 0.3,
  shieldBonus: 25,
  restartAfterSteps: 360,
  winRestartAfterSteps: 600,
});

// ======================================================================================= events

export type ShotSource = "ai" | "player";

export const DroneHit = defineEvent<{ damage: number; source: ShotSource }>("GameDroneHit");
export const DroneDown = defineEvent<{
  kind: DroneKind;
  points: number;
  credits: number;
  tick: number;
  x: number;
  y: number;
  z: number;
  source: ShotSource;
}>("GameDroneDown");
/** A drone reached the beacon: no points, and integrity is gone. */
export const DroneLeaked = defineEvent<{ kind: DroneKind; damage: number; tick: number; x: number; y: number; z: number }>("GameDroneLeaked");
/** A drone detonating on the beacon. Entity-channel, so only the beacon hears it. */
export const BeaconStrike = defineEvent<{ damage: number; tick: number; x: number; y: number; z: number }>("GameBeaconStrike");
export const BeaconDamaged = defineEvent<{ damage: number; hp: number; maxHp: number; tick: number; x: number; y: number; z: number }>("GameBeaconDamaged");
/** Repair, and optionally raise the ceiling. Entity-channel: the beacon owns its integrity. */
export const BeaconRepair = defineEvent<{ amount: number; reinforce: number; fraction?: number }>("GameBeaconRepair");
export const BeaconRepaired = defineEvent<{ amount: number; hp: number; maxHp: number; tick: number }>("GameBeaconRepaired");
export const ShotFired = defineEvent<{
  source: ShotSource;
  damage: number;
  hits: number;
  tick: number;
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  reach: number;
}>("GameShotFired");
export const WaveStarted = defineEvent<{ wave: number; drones: number; hpScale: number }>("GameWaveStarted");
export const WaveCleared = defineEvent<{ wave: number; bonus: number; tick: number }>("GameWaveCleared");
export const GameOver = defineEvent<{ wave: number; score: number; kills: number; tick: number }>("GameOverRun");
export const GameWon = defineEvent<{ score: number; kills: number; tick: number }>("GameWonRun");
export const GameRestart = defineEvent<void>("GameRestartRun");
/** A splitter broke apart: the director spawns the shards, because it owns the assets. */
export const DroneSplit = defineEvent<{ x: number; z: number; wave: number; tick: number }>("GameDroneSplit");

// Host → game. Posted, never emitted: input arrives between script phases and must be queued.
export const PlayerAim = defineEvent<{ x: number; z: number }>("PlayerAim");
export const PlayerFire = defineEvent<void>("PlayerFire");
export const BuyUpgrade = defineEvent<{ id: UpgradeId }>("BuyUpgrade");
export const UseAbility = defineEvent<{ id: AbilityId }>("UseAbility");
/** Skip the rest of the intermission and start the next wave now. */
export const CallWave = defineEvent<void>("CallWave");

// Game → host: feedback the scripts cannot produce themselves (sound, toasts, screen shake).
export const UpgradeBought = defineEvent<{ id: UpgradeId; level: number; cost: number; credits: number }>("UpgradeBought");
export const AbilityUsed = defineEvent<{ id: AbilityId; tick: number }>("AbilityUsed");
export const PurchaseRefused = defineEvent<{ id: string; reason: "credits" | "maxLevel" | "cooldown" | "finished" }>("PurchaseRefused");
export const AbilityReady = defineEvent<{ id: AbilityId }>("AbilityReady");

// =================================================================================== components

/** Mirrors a drone's state so the HUD (minimap, target frame) reads components, not scripts. */
export class DroneTag extends Component {
  static readonly typeName = "BeaconGameDrone";
  kind: DroneKind = "scout";
  hp = 1;
  maxHp = 1;
  radius = 0.6;
  points = 0;
  /** 1 while the EMP is holding this drone, so the HUD can colour it differently. */
  slowed = 0;
}
registerComponent(DroneTag as never, { name: "BeaconGameDrone" });

export class TurretTag extends Component {
  static readonly typeName = "BeaconGameTurret";
  yaw = 0;
  shots = 0;
}
registerComponent(TurretTag as never, { name: "BeaconGameTurret" });

export class BeaconTag extends Component {
  static readonly typeName = "BeaconGameBeacon";
  hp = 0;
  maxHp = 0;
  down = 0;
}
registerComponent(BeaconTag as never, { name: "BeaconGameBeacon" });

/** What the scene hands the scripts: the meshes and materials drones are drawn with. */
export interface DroneAssets {
  readonly geometry: Geometry;
  readonly material: Material;
}

export interface BeaconGameAssets {
  readonly drones: Readonly<Record<DroneKind, DroneAssets>>;
}

export interface DroneSpawnRequest {
  kind: DroneKind;
  x: number;
  z: number;
  /** The wave whose armour and speed scaling this drone inherits. */
  wave: number;
  hpScale: number;
  speedScale: number;
  name: string;
  /** Shards are tallied separately from the wave's own spawn list. */
  shard?: boolean;
}

/**
 * Create one drone: transform, body, tag and its script. Both the wave director and a dying splitter
 * spawn through here, so a shard exists in the same fixed step as the death that made it — which is
 * what keeps the wave-clear check (`no drones left`) independent of how the frame split its steps.
 */
export function spawnDrone(
  world: ScriptWorld,
  beacon: EntityId,
  game: GameState,
  assets: BeaconGameAssets,
  tuning: BeaconGameTuning,
  req: DroneSpawnRequest,
): ScriptEntity {
  const e = world.createEntity(req.name);
  e.add(new Transform()).setPosition(req.x, DRONE_FLIGHT_HEIGHT, req.z);
  const drone = assets.drones[req.kind];
  const body = new Renderable();
  body.geometry = drone.geometry;
  body.material = drone.material;
  body.castShadow = true;
  e.add(body);
  e.add(new DroneTag());
  e.add(new ScriptComponent(new Drone(beacon, game, assets, req.kind, req.wave, req.hpScale, req.speedScale, tuning)));
  if (req.shard) game.shards++;
  return e;
}

/** Drones fly at this height; the scene aims the player's cannon onto the same plane. */
export const DRONE_FLIGHT_HEIGHT = 1.35;

const TINT_HIT = 0xfffff0b0;
const TINT_SLOWED = 0xff9fd8ff;

// ======================================================================================== scripts

/**
 * The rules: score, credits, kills, upgrades, ability cooldowns and the active-effect windows. Every
 * other script asks this one what the numbers are, so an upgrade or an overcharge changes the whole
 * game from one place.
 */
export class GameState extends Script {
  /** Where repair and reinforcement go; the scene sets this before the scripts are attached. */
  beacon: EntityId = 0 as EntityId;
  score = 0;
  credits: number;
  kills = 0;
  leaks = 0;
  wave = 0;
  games = 1;
  gameOver = false;
  won = false;
  aiShots = 0;
  manualShots = 0;
  /** Tick of every kill, so a determinism check can compare runs exactly. */
  readonly killTicks: number[] = [];
  readonly upgrades: Record<UpgradeId, number> = { damage: 0, rate: 0, range: 0, multishot: 0, shield: 0, cooling: 0 };
  /** Steps of cooldown left per ability. */
  readonly cooldowns: Record<AbilityId, number> = { emp: 0, overcharge: 0, repair: 0 };
  /** Tick at which each active effect ends; `-1` while it is not running. */
  empUntil = -1;
  overchargeUntil = -1;
  /** Tick at which the intermission ends; `-1` while a wave is on the field. */
  intermissionUntil = -1;
  callWave = false;
  /** The fixed-step tick the game is on: the HUD reads the derived numbers at this tick. */
  tick = 0;
  /** Splitters' shards, on top of the waves' own spawn lists. */
  shards = 0;

  constructor(readonly tuning: BeaconGameTuning = DEFAULT_GAME_TUNING) {
    super();
    this.credits = tuning.startCredits;
  }

  override onCreate(): void {
    this.on(DroneDown, (e) => {
      this.score += e.points;
      this.credits += e.credits;
      this.kills++;
      this.killTicks.push(e.tick);
    });
    this.on(DroneLeaked, () => {
      this.leaks++;
    });
    this.on(ShotFired, (e) => {
      if (e.source === "ai") this.aiShots++;
      else this.manualShots++;
    });
    this.on(WaveStarted, (e) => {
      this.wave = e.wave;
      this.intermissionUntil = -1;
      this.callWave = false;
    });
    this.on(WaveCleared, (e, c) => {
      this.credits += e.bonus;
      this.intermissionUntil = c.time.tick + this.tuning.intermissionSteps;
    });
    this.on(CallWave, () => {
      this.callWave = true;
    });
    this.on(BuyUpgrade, (e) => this.buy(e.id));
    this.on(UseAbility, (e, c) => this.useAbility(e.id, c));
    this.on(BeaconDamaged, (e) => {
      if (e.hp > 0 || this.finished) return;
      this.gameOver = true;
      this.emit(GameOver, { wave: this.wave, score: this.score, kills: this.kills, tick: e.tick });
      this.after(0, () => this.restartIfStillOver(), { steps: this.tuning.restartAfterSteps, clock: "sim" });
    });
    this.on(GameWon, () => {
      if (this.finished) return;
      this.won = true;
      this.after(0, () => this.restartIfStillOver(), { steps: this.tuning.winRestartAfterSteps, clock: "sim" });
    });
    this.on(GameRestart, () => this.reset());
  }

  override onFixedUpdate(c: ScriptContext): void {
    this.tick = c.time.tick;
    if (this.finished) return;
    for (const ability of ABILITIES) {
      const left = this.cooldowns[ability.id];
      if (left <= 0) continue;
      const next = left - 1;
      this.cooldowns[ability.id] = next;
      if (next === 0) this.emit(AbilityReady, { id: ability.id });
    }
  }

  private restartIfStillOver(): void {
    if (!this.finished) return;
    this.emit(GameRestart, undefined);
  }

  private reset(): void {
    this.score = 0;
    this.credits = this.tuning.startCredits;
    this.kills = 0;
    this.leaks = 0;
    this.wave = 0;
    this.gameOver = false;
    this.won = false;
    this.aiShots = 0;
    this.manualShots = 0;
    this.killTicks.length = 0;
    this.shards = 0;
    this.empUntil = -1;
    this.overchargeUntil = -1;
    this.intermissionUntil = -1;
    this.callWave = false;
    for (const u of UPGRADES) this.upgrades[u.id] = 0;
    for (const a of ABILITIES) this.cooldowns[a.id] = 0;
    this.games++;
  }

  // ----------------------------------------------------------------------------- derived numbers

  get finished(): boolean {
    return this.gameOver || this.won;
  }

  empActive(tick: number): boolean {
    return tick < this.empUntil;
  }

  overchargeActive(tick: number): boolean {
    return tick < this.overchargeUntil;
  }

  private damageScale(tick: number): number {
    return (1 + 0.3 * this.upgrades.damage) * (this.overchargeActive(tick) ? this.tuning.overchargeDamage : 1);
  }

  turretDamage(tick: number): number {
    return this.tuning.aiDamage * this.damageScale(tick);
  }

  cannonDamage(tick: number): number {
    return this.tuning.manualDamage * this.damageScale(tick);
  }

  aiFireSteps(tick: number): number {
    const base = this.tuning.aiFireSteps * Math.pow(0.86, this.upgrades.rate);
    const over = this.overchargeActive(tick) ? this.tuning.overchargeRate : 1;
    return Math.max(4, Math.round(base * over));
  }

  manualFireSteps(): number {
    return Math.max(5, Math.round(this.tuning.manualFireSteps * Math.pow(0.82, this.upgrades.cooling)));
  }

  aiRange(): number {
    return this.tuning.aiRange + 3 * this.upgrades.range;
  }

  manualRange(): number {
    return this.tuning.manualRange + 3 * this.upgrades.range;
  }

  /** Simultaneous targets: the AI's spread and the cannon's pierce. */
  targets(): number {
    return this.tuning.aiTargets + this.upgrades.multishot;
  }

  costOf(id: UpgradeId): number | null {
    return upgradeCost(UPGRADE_BY_ID[id], this.upgrades[id]);
  }

  // ------------------------------------------------------------------------------------ commands

  private buy(id: UpgradeId): void {
    if (this.finished) {
      this.emit(PurchaseRefused, { id, reason: "finished" });
      return;
    }
    const def = UPGRADE_BY_ID[id];
    const level = this.upgrades[id];
    const cost = upgradeCost(def, level);
    if (cost === null) {
      this.emit(PurchaseRefused, { id, reason: "maxLevel" });
      return;
    }
    if (this.credits < cost) {
      this.emit(PurchaseRefused, { id, reason: "credits" });
      return;
    }
    this.credits -= cost;
    this.upgrades[id] = level + 1;
    this.emit(UpgradeBought, { id, level: level + 1, cost, credits: this.credits });
    if (id === "shield") this.emit(BeaconRepair, { amount: this.tuning.shieldBonus, reinforce: this.tuning.shieldBonus }, { to: this.beacon });
  }

  private useAbility(id: AbilityId, c: ScriptContext): void {
    if (this.finished) {
      this.emit(PurchaseRefused, { id, reason: "finished" });
      return;
    }
    const def = ABILITY_BY_ID[id];
    if (this.cooldowns[id] > 0) {
      this.emit(PurchaseRefused, { id, reason: "cooldown" });
      return;
    }
    if (this.credits < def.cost) {
      this.emit(PurchaseRefused, { id, reason: "credits" });
      return;
    }
    this.credits -= def.cost;
    this.cooldowns[id] = def.cooldownSteps;
    const tick = c.time.tick;
    if (id === "emp") this.empUntil = tick + this.tuning.empSteps;
    else if (id === "overcharge") this.overchargeUntil = tick + this.tuning.overchargeSteps;
    else this.emit(BeaconRepair, { amount: 0, reinforce: 0, fraction: this.tuning.repairFraction }, { to: this.beacon });
    this.emit(AbilityUsed, { id, tick });
  }
}

/** The beacon's integrity: damage, reinforcement, repair, and the game-over condition. */
export class Beacon extends Script {
  hp: number;
  maxHp: number;
  down = false;

  constructor(
    private readonly tuning: BeaconGameTuning = DEFAULT_GAME_TUNING,
  ) {
    super();
    this.hp = tuning.beaconHp;
    this.maxHp = tuning.beaconHp;
  }

  override onCreate(c: ScriptContext): void {
    this.sync(c);
    this.on(BeaconStrike, (hit, cc) => this.strike(hit, cc), { entity: c.entity });
    this.on(BeaconRepair, (fix, cc) => this.repair(fix, cc), { entity: c.entity });
    this.on(GameRestart, (_e, cc) => {
      this.maxHp = this.tuning.beaconHp;
      this.hp = this.maxHp;
      this.down = false;
      this.sync(cc);
    });
  }

  private strike(hit: { damage: number; tick: number; x: number; y: number; z: number }, c: ScriptContext): void {
    if (this.down) return;
    this.hp = Math.max(0, this.hp - hit.damage);
    this.sync(c);
    const r = c.entity.get(Renderable);
    if (r) {
      r.tint = 0xffff5a4a;
      this.after(0.2, () => (r.tint = 0), { clock: "render" });
    }
    this.emit(BeaconDamaged, { damage: hit.damage, hp: this.hp, maxHp: this.maxHp, tick: hit.tick, x: hit.x, y: hit.y, z: hit.z });
    if (this.hp === 0) this.down = true;
  }

  private repair(fix: { amount: number; reinforce: number; fraction?: number }, c: ScriptContext): void {
    if (this.down) return;
    if (fix.reinforce > 0) this.maxHp += fix.reinforce;
    const amount = fix.fraction !== undefined ? Math.round(this.maxHp * fix.fraction) : fix.amount;
    if (amount <= 0) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.sync(c);
    this.emit(BeaconRepaired, { amount, hp: this.hp, maxHp: this.maxHp, tick: c.time.tick });
    const r = c.entity.get(Renderable);
    if (r) {
      r.tint = 0xff9dffc8;
      this.after(0.25, () => (r.tint = 0), { clock: "render" });
    }
  }

  private sync(c: ScriptContext): void {
    const tag = c.entity.get(BeaconTag);
    if (!tag) return;
    tag.hp = this.hp;
    tag.maxHp = this.maxHp;
    tag.down = this.down ? 1 : 0;
  }
}

export class Drone extends Script {
  hp: number;
  maxHp: number;
  readonly speed: number;
  readonly spec: DroneSpec;
  private readonly phase: number;

  constructor(
    private readonly beacon: EntityId,
    private readonly game: GameState,
    private readonly assets: BeaconGameAssets,
    kind: DroneKind,
    private readonly wave: number,
    hpScale: number,
    speedScale: number,
    private readonly tuning: BeaconGameTuning = DEFAULT_GAME_TUNING,
  ) {
    super();
    this.spec = DRONE_SPECS[kind];
    this.maxHp = Math.max(1, Math.round(this.spec.hp * hpScale));
    this.hp = this.maxHp;
    this.speed = this.spec.speed * speedScale;
    // A deterministic per-drone phase from the wave and the spec: no RNG in gameplay.
    this.phase = (wave * 1.7 + this.spec.points * 0.013) % (Math.PI * 2);
  }

  override onCreate(c: ScriptContext): void {
    const tag = c.entity.get(DroneTag);
    if (tag) {
      tag.kind = this.spec.kind;
      tag.hp = this.hp;
      tag.maxHp = this.maxHp;
      tag.radius = this.spec.radius;
      tag.points = this.spec.points;
    }
    const body = c.entity.get(Renderable);
    if (body) body.castShadow = true;
    const s = this.spec.scale;
    c.entity.get(Transform)?.setScale(s, s, s);
    this.on(DroneHit, (hit, cc) => this.hurt(hit, cc), { entity: c.entity });
  }

  private hurt(hit: { damage: number; source: ShotSource }, c: ScriptContext): void {
    if (this.hp <= 0) return;
    this.hp -= hit.damage;
    const tag = c.entity.get(DroneTag);
    if (tag) tag.hp = Math.max(0, this.hp);
    const r = c.entity.get(Renderable);
    if (r) {
      r.tint = TINT_HIT;
      this.after(0.07, () => (r.tint = tag?.slowed ? TINT_SLOWED : 0), { clock: "render" });
    }
    if (this.hp > 0) return;
    const p = c.entity.get(Transform)!.position;
    this.post(DroneDown, {
      kind: this.spec.kind,
      points: this.spec.points,
      credits: this.spec.credits,
      tick: c.time.tick,
      x: p.x,
      y: p.y,
      z: p.z,
      source: hit.source,
    });
    if (this.spec.kind === "splitter") {
      // Born in this same step, not from a posted event: the wave-clear check must never see a
      // moment when the field looks empty between a splitter dying and its shards arriving.
      const d = Math.hypot(p.x, p.z) || 1;
      for (const side of [-1, 1] as const) {
        spawnDrone(c.world, this.beacon, this.game, this.assets, this.tuning, {
          kind: "scout",
          // Two scouts shoulder out from the death point, tangential to the beacon.
          x: p.x + (-p.z / d) * 1.2 * side,
          z: p.z + (p.x / d) * 1.2 * side,
          wave: this.wave,
          hpScale: this.maxHp / Math.max(1, this.spec.hp),
          speedScale: this.speed / this.spec.speed,
          name: `shard-${c.time.tick}-${side < 0 ? "a" : "b"}`,
          shard: true,
        });
      }
      this.post(DroneSplit, { x: p.x, z: p.z, wave: this.wave, tick: c.time.tick });
    }
    c.entity.destroy();
  }

  override onFixedUpdate(c: ScriptContext): void {
    const t = c.entity.get(Transform);
    if (!t) return;
    const tick = c.time.tick;
    const slowed = this.game.empActive(tick);
    const tag = c.entity.get(DroneTag);
    if (tag) tag.slowed = slowed ? 1 : 0;
    const target = c.world.getComponent(this.beacon, Transform)!.position;
    const dx = target.x - t.position.x;
    const dz = target.z - t.position.z;
    const d = Math.hypot(dx, dz);
    const stopAt = this.tuning.beaconRadius + this.spec.radius;
    if (d <= stopAt) {
      this.emit(BeaconStrike, { damage: this.spec.damage, tick, x: t.position.x, y: t.position.y, z: t.position.z }, { to: this.beacon });
      this.post(DroneLeaked, { kind: this.spec.kind, damage: this.spec.damage, tick, x: t.position.x, y: t.position.y, z: t.position.z });
      c.entity.destroy();
      return;
    }
    const speed = this.speed * (slowed ? this.game.tuning.empSlow : 1);
    const step = Math.min(d - stopAt, speed * c.time.dt);
    const nx = dx / d;
    const nz = dz / d;
    // Drones hold rotor height and bob; the bob is a function of the tick, so it stays deterministic.
    const y = DRONE_FLIGHT_HEIGHT + 0.28 * Math.sin(tick * 0.09 + this.phase) + (this.spec.kind === "bruiser" ? 0.35 : 0);
    t.setPosition(t.position.x + nx * step, y, t.position.z + nz * step);
    // Face the beacon: local +Z is forward, so the yaw is atan2(dx, dz).
    t.setRotationEuler(0, Math.atan2(nx, nz), 0);
  }
}

/**
 * The turret: one weapon platform, two triggers. The AI servo picks the nearest drones in range and
 * fires on a cadence the upgrades and overcharge change; the player's cannon is a hitscan along the aim
 * ray with its own cooldown. The barrel follows the player's aim while it is fresh and falls back to the
 * AI's target after `aimHoldSteps` without input.
 */
export class Turret extends Script {
  aimX = 0;
  aimZ = 1;
  shots = 0;
  manualShots = 0;
  hits = 0;
  /** Tick of the last aim input; `-1` before the player has touched it. */
  private aimTick = -1;
  private aiCooldown = 0;
  private manualCooldown = 0;
  private fireRequested = false;

  constructor(
    private readonly game: GameState,
    private readonly tuning: BeaconGameTuning = DEFAULT_GAME_TUNING,
  ) {
    super();
  }

  override onCreate(c: ScriptContext): void {
    this.on(PlayerAim, (aim, cc) => {
      this.aimX = aim.x;
      this.aimZ = aim.z;
      this.aimTick = cc.time.tick;
    });
    this.on(PlayerFire, () => {
      this.fireRequested = true;
    });
    this.on(GameRestart, () => {
      this.aiCooldown = 0;
      this.manualCooldown = 0;
      this.fireRequested = false;
      this.aimTick = -1;
    });
    const p = c.entity.get(Transform)!.position;
    this.aimX = p.x;
    this.aimZ = p.z + 1;
  }

  override onFixedUpdate(c: ScriptContext): void {
    if (this.game.finished) return;
    const tick = c.time.tick;
    const t = c.entity.get(Transform)!;
    const me = t.position;
    if (this.aiCooldown > 0) this.aiCooldown--;
    if (this.manualCooldown > 0) this.manualCooldown--;

    const targets = this.pickTargets(c, me.x, me.z, this.game.targets());
    const playerAiming = this.aimTick >= 0 && tick - this.aimTick < this.tuning.aimHoldSteps;
    let dirX = this.aimX - me.x;
    let dirZ = this.aimZ - me.z;
    if (!playerAiming && targets.length > 0) {
      const p = c.world.getComponent(targets[0]!.id, Transform)!.position;
      dirX = p.x - me.x;
      dirZ = p.z - me.z;
    }
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) {
      const yaw = Math.atan2(dirX / len, dirZ / len);
      t.setRotationEuler(0, yaw, 0);
      const tag = c.entity.get(TurretTag);
      if (tag) tag.yaw = yaw;
    }

    if (this.aiCooldown === 0 && targets.length > 0) {
      this.aiCooldown = this.game.aiFireSteps(tick);
      const damage = this.game.turretDamage(tick);
      // The turret's own salvo is hitscan: it locks onto the nearest drones in range, so the damage
      // lands on exactly the targets the tracer is drawn to.
      for (const target of targets) this.emit(DroneHit, { damage, source: "ai" }, { to: target.id });
      this.shoot(c, me, targets, damage, Math.min(this.game.aiRange(), this.distanceTo(c, me, targets[0]!.id)), "ai");
    }
    if (!this.fireRequested) return;
    this.fireRequested = false;
    if (this.manualCooldown > 0) return;
    this.manualCooldown = this.game.manualFireSteps();
    const ux = len > 1e-4 ? dirX / len : 0;
    const uz = len > 1e-4 ? dirZ / len : 1;
    const ray = this.pickAlongRay(c, me, ux, uz, this.game.manualRange());
    for (const target of ray) this.emit(DroneHit, { damage: this.game.cannonDamage(tick), source: "player" }, { to: target.id });
    this.manualShots++;
    this.shoot(c, me, ray, this.game.cannonDamage(tick), this.game.manualRange(), "player", ux, uz);
  }

  private shoot(
    c: ScriptContext,
    me: { x: number; y: number; z: number },
    targets: readonly { id: EntityId }[],
    damage: number,
    reach: number,
    source: ShotSource,
    dirX?: number,
    dirZ?: number,
  ): void {
    this.shots++;
    this.hits += targets.length;
    let ux = dirX;
    let uz = dirZ;
    let distance = reach;
    if (ux === undefined || uz === undefined) {
      const p = targets.length > 0 ? c.world.getComponent(targets[0]!.id, Transform)!.position : null;
      const dx = p ? p.x - me.x : 0;
      const dz = p ? p.z - me.z : 1;
      const d = Math.hypot(dx, dz) || 1;
      ux = dx / d;
      uz = dz / d;
      distance = Math.min(reach, d);
    }
    this.post(ShotFired, { source, damage, hits: targets.length, tick: c.time.tick, x: me.x, y: me.y, z: me.z, dirX: ux, dirZ: uz, reach: distance });
  }

  private distanceTo(c: ScriptContext, me: { x: number; z: number }, id: EntityId): number {
    const p = c.world.getComponent(id, Transform)!.position;
    return Math.hypot(p.x - me.x, p.z - me.z);
  }

  /** The `limit` nearest drones inside the AI's range, ties broken by id so store order cannot matter. */
  private pickTargets(c: ScriptContext, x: number, z: number, limit: number): Array<{ id: EntityId; d: number }> {
    const range = this.game.aiRange();
    const drones = c.world.store(DroneTag);
    const found: Array<{ id: EntityId; d: number }> = [];
    for (let i = 0; i < drones.count; i++) {
      const tag = drones.valueAt(i);
      const p = c.world.getComponent(tag.entity, Transform)!.position;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d <= range) found.push({ id: tag.entity, d });
    }
    found.sort((a, b) => (a.d === b.d ? a.id - b.id : a.d - b.d));
    return found.slice(0, Math.max(1, limit));
  }

  /** Every drone within `shotTolerance` of the aim ray, nearest first, capped by `targets()`. */
  private pickAlongRay(c: ScriptContext, me: { x: number; z: number }, dirX: number, dirZ: number, range: number): Array<{ id: EntityId }> {
    const drones = c.world.store(DroneTag);
    const along: Array<{ id: EntityId; at: number }> = [];
    for (let i = 0; i < drones.count; i++) {
      const tag = drones.valueAt(i);
      const p = c.world.getComponent(tag.entity, Transform)!.position;
      const rx = p.x - me.x;
      const rz = p.z - me.z;
      const at = rx * dirX + rz * dirZ;
      if (at < 0 || at > range) continue;
      // Perpendicular distance in XZ: |r × d| with d unit.
      if (Math.abs(rx * dirZ - rz * dirX) > tag.radius + this.tuning.shotTolerance) continue;
      along.push({ id: tag.entity, at });
    }
    along.sort((a, b) => (a.at === b.at ? a.id - b.id : a.at - b.at));
    return along.slice(0, this.game.targets());
  }
}

/**
 * Waves: announce, spawn the composition a fixed number of steps apart, wait for the field to clear,
 * report the clear, hold an intermission, next wave — and after `FINAL_WAVE`, the win.
 */
export class WaveDirector extends Script {
  wave = 0;
  spawned = 0;
  private running = false;

  constructor(
    private readonly beacon: EntityId,
    private readonly game: GameState,
    private readonly assets: BeaconGameAssets,
    private readonly tuning: BeaconGameTuning = DEFAULT_GAME_TUNING,
  ) {
    super();
  }

  override onCreate(): void {
    this.on(GameOver, () => {
      this.running = false;
      this.stopCoroutines();
    });
    this.on(GameRestart, () => {
      this.wave = 0;
      this.begin();
    });
    this.begin();
  }

  private begin(): void {
    if (this.running) return;
    this.running = true;
    const self = this;
    this.startCoroutine(
      function* (c) {
        for (;;) {
          self.wave++;
          const spec = waveSpec(self.wave);
          // Posted, not emitted: wave 1 starts inside onCreate, before scripts created after the
          // director have subscribed; a queued event reaches them in the next phase.
          self.post(WaveStarted, { wave: self.wave, drones: spec.drones, hpScale: spec.hpScale });
          for (let i = 0; i < spec.order.length; i++) {
            self.spawn(c, spec.order[i]!, i, spec);
            yield Wait.steps(spec.spawnEvery);
          }
          yield Wait.until(() => c.world.store(DroneTag).count === 0);
          if (self.wave >= FINAL_WAVE) {
            self.post(GameWon, { score: self.game.score, kills: self.game.kills, tick: c.time.tick });
            self.running = false;
            return;
          }
          self.post(WaveCleared, { wave: self.wave, bonus: self.tuning.waveClearBonus + self.tuning.waveClearPerWave * self.wave, tick: c.time.tick });
          // The intermission is the director's own deadline: nothing else can end it early except the
          // player calling the wave, so a HUD countdown cannot accidentally stall the coroutine.
          const resumeAt = c.time.tick + self.tuning.intermissionSteps;
          yield Wait.until(() => self.game.callWave || c.time.tick >= resumeAt);
          self.game.callWave = false;
        }
      },
      { clock: "sim", name: "waves" },
    );
  }

  private spawn(c: ScriptContext, kind: DroneKind, index: number, spec: WaveSpec): void {
    // Deterministic placement: evenly around the ring, rotated per wave, staggered in depth.
    const angle = (index / Math.max(1, spec.drones)) * Math.PI * 2 + spec.wave * 0.7;
    const r = this.tuning.spawnRadius + (index % 3) * 1.5;
    this.create(c, kind, Math.cos(angle) * r, Math.sin(angle) * r, spec, `drone-${spec.wave}-${index}`);
  }

  private create(c: ScriptContext, kind: DroneKind, x: number, z: number, spec: WaveSpec, name: string): void {
    spawnDrone(c.world, this.beacon, this.game, this.assets, this.tuning, {
      kind,
      x,
      z,
      wave: spec.wave,
      hpScale: spec.hpScale,
      speedScale: spec.speedScale,
      name,
    });
    this.spawned++;
  }
}
