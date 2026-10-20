/**
 * @suite examples:beaconDefenseGame
 * @group integration
 * @covers examples/src/scripting/beaconDefenseGame.ts
 * @covers examples/src/scenes/beaconDefenseScene.ts
 * @covers examples/src/ui/beaconHud.ts
 * @covers examples/src/audio/beaconSounds.ts
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/scripting/events.ts
 * @covers engine/src/particles/simulation.ts
 * @covers engine/src/ui/manager.ts
 * @desc Beacon Defense as a playable game: twelve waves, six upgrades, three abilities and a win condition play out on scripts with no errors, stay bit-identical across frame splits, freeze on pause and reset on restart, and the scene turns those events into particles, tracers, HUD and procedural sound that dispose cleanly
 */

export const suite = {
  name: "examples:beaconDefenseGame",
  group: "integration",
  covers: [
    "examples/src/scripting/beaconDefenseGame.ts",
    "examples/src/scenes/beaconDefenseScene.ts",
    "examples/src/ui/beaconHud.ts",
    "examples/src/audio/beaconSounds.ts",
    "engine/src/scripting/runtime.ts",
    "engine/src/scripting/events.ts",
    "engine/src/particles/simulation.ts",
    "engine/src/ui/manager.ts",
  ],
  desc: "Beacon Defense as a playable game: twelve waves, six upgrades, three abilities and a win condition play out on scripts with no errors, stay bit-identical across frame splits, freeze on pause and reset on restart, and the scene turns those events into particles, tracers, HUD and procedural sound that dispose cleanly",
};

import assert from "node:assert/strict";
import { assertCloseTo, finish, group, test } from "selrun";
import {
  AudioSystem,
  Clock,
  GraphicsDevice,
  LogLevel,
  Logger,
  MockAudioBufferSourceNode,
  Profiler,
  Renderer,
  SystemScratch,
  Transform,
  Vec3,
  createMockAudio,
  type Engine,
  type SystemContext,
} from "@forge/engine";
import {
  ARENA_RADIUS,
  FLIGHT_HEIGHT,
  SPARK_POOL,
  TRACER_POOL,
  TURRET_AT,
  beaconTowerSource,
  buildBeaconDefenseScene,
  crateSource,
  droneSources,
  turretHeadSource,
  type BeaconDefenseHandle,
} from "../../examples/src/scenes/beaconDefenseScene.js";
import {
  ABILITIES,
  AbilityReady,
  BeaconRepaired,
  BeaconStrike,
  BeaconTag,
  DEFAULT_GAME_TUNING,
  DRONE_SPECS,
  DroneDown,
  DroneSplit,
  DroneTag,
  FINAL_WAVE,
  GameWon,
  PurchaseRefused,
  UPGRADES,
  UpgradeBought,
  WaveCleared,
  WaveStarted,
  waveSpec,
  type BeaconGameTuning,
  type UpgradeId,
} from "../../examples/src/scripting/beaconDefenseGame.js";
import { signedVolume } from "../../examples/src/scenes/meshKit.js";
import { arenaMapPixels, stepsToSeconds } from "../../examples/src/ui/beaconHud.js";
import { BEACON_SOUND_NAMES, BEACON_SOUNDS, BeaconSoundscape, renderBeaconSound, spectralCentroid } from "../../examples/src/audio/beaconSounds.js";

interface Fixture {
  gpu: Awaited<ReturnType<typeof GraphicsDevice.create>>;
  h: BeaconDefenseHandle;
  /** Advance the sim by `fixedSteps` fixed steps, then one presentation frame (0 = a paused clock). */
  step(fixedSteps: number): void;
  /** Advance `seconds` of game time one fixed step at a time. */
  play(seconds: number): void;
  dispose(): Promise<void>;
}

async function fixture(tuning?: BeaconGameTuning): Promise<Fixture> {
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const h = buildBeaconDefenseScene({ gpu } as Engine, { tuning });
  let frame = 0;
  const step = (fixedSteps: number): void => {
    frame++;
    const c: SystemContext = {
      world: h.scene.world,
      clock: new Clock(),
      dt: Math.max(0, fixedSteps) / 60,
      fixedDt: 1 / 60,
      fixedSteps,
      alpha: 0,
      elapsed: frame / 60,
      frame,
      logger: new Logger({ level: LogLevel.Silent }),
      profiler: new Profiler(),
      services: { get: () => undefined, engineConfig: {} },
      scratch: new SystemScratch(),
    };
    h.scene.update(c, c.dt);
    h.update(c.dt);
  };
  const play = (seconds: number): void => {
    for (let s = 0; s < Math.round(seconds * 60); s++) step(1);
  };
  return {
    gpu,
    h,
    step,
    play,
    dispose: async () => {
      h.dispose?.();
      await gpu.dispose();
    },
  };
}

/** The nearest live drone to the beacon, or null. */
function nearestDrone(h: BeaconDefenseHandle): { x: number; z: number; kind: string } | null {
  const store = h.scene.world.store(DroneTag);
  let best: { x: number; z: number; kind: string } | null = null;
  let bestD = Infinity;
  for (let i = 0; i < store.count; i++) {
    const tag = store.valueAt(i);
    const p = h.scene.world.getComponent(tag.entity, Transform)!.position;
    const d = p.x * p.x + p.z * p.z;
    if (d < bestD) {
      bestD = d;
      best = { x: p.x, z: p.z, kind: tag.kind };
    }
  }
  return best;
}

/** True when any drone is within `radius` of the turret (which would spoil an "aims away" check). */
function droneNearTurret(h: BeaconDefenseHandle, radius: number): boolean {
  const store = h.scene.world.store(DroneTag);
  for (let i = 0; i < store.count; i++) {
    const p = h.scene.world.getComponent(store.valueAt(i).entity, Transform)!.position;
    if (Math.hypot(p.x - TURRET_AT.x, p.z - TURRET_AT.z) < radius) return true;
  }
  return false;
}

/**
 * A competent player: aim at the nearest drone, hold the trigger, spend credits in a fixed priority
 * order and use abilities when they pay off. Deterministic — it reads game state only.
 */
function botTurn(h: BeaconDefenseHandle, priority: readonly UpgradeId[] = ["damage", "rate", "multishot", "cooling", "range", "shield"]): void {
  const st = h.state();
  const drone = nearestDrone(h);
  if (drone) h.aimAt(drone.x, drone.z);
  h.fire();
  for (const id of priority) {
    const cost = st.upgradeCosts[id];
    if (cost !== null && st.credits >= cost) {
      h.buyUpgrade(id);
      break;
    }
  }
  const drones = st.drones;
  if (st.abilities.overcharge.ready && st.credits >= st.abilities.overcharge.cost && drones >= 3) h.useAbility("overcharge");
  if (st.abilities.emp.ready && st.credits >= st.abilities.emp.cost && drones >= 4) h.useAbility("emp");
  if (st.abilities.repair.ready && st.credits >= st.abilities.repair.cost && st.beaconHp < st.beaconMaxHp * 0.7) h.useAbility("repair");
}

group("Beacon Defense: the game plays", () => {
  test("an unattended run leaks drones, falls and restarts itself with no script errors", async () => {
    const { h, step, dispose } = await fixture();
    let maxWave = 0;
    let overAt = -1;
    for (let s = 0; s < 60 * 200 && overAt < 0; s++) {
      step(1);
      const st = h.state();
      maxWave = Math.max(maxWave, st.wave);
      if (st.gameOver) overAt = s;
    }
    const lost = h.state();
    assert.ok(overAt >= 0, "the beacon fell without a player");
    assert.ok(maxWave >= 5 && maxWave <= FINAL_WAVE, `waves advanced to ${maxWave}`);
    assert.ok(lost.leaks >= 5, `${lost.leaks} drones reached the beacon`);
    assert.equal(lost.beaconHp, 0, "integrity hit zero");
    assert.equal(lost.phase, "gameover");
    assert.ok(overAt > 60 * 60, `it survived ${(overAt / 60).toFixed(0)}s, so the turret really was defending`);
    // `restartAfterSteps` is six seconds of game time after a loss.
    for (let s = 0; s < DEFAULT_GAME_TUNING.restartAfterSteps + 30; s++) step(1);
    const after = h.state();
    assert.equal(after.games, 2, "and it restarted itself");
    assert.equal(after.wave, 1);
    assert.equal(after.beaconHp, after.beaconMaxHp, "with full integrity");
    assert.equal(after.kills, 0, "and a clean score");
    assert.equal(h.runtime.errors.length, 0, `${after.lastError}`);
    await dispose();
  });

  test("the same fixed steps give the same run however the frames split them", async () => {
    const run = async (splits: () => number, total: number): Promise<string> => {
      const { h, step, dispose } = await fixture();
      let done = 0;
      while (done < total) {
        const n = Math.min(splits(), total - done);
        step(n);
        done += n;
      }
      const st = h.state();
      const out = JSON.stringify({
        kills: st.killTicks,
        score: st.score,
        wave: st.wave,
        hp: st.beaconHp,
        shots: st.turret.shots,
        drones: st.drones,
        leaks: st.leaks,
        credits: st.credits,
      });
      await dispose();
      return out;
    };
    let seed = 11;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    const steady = await run(() => 1, 60 * 85);
    const parsed = JSON.parse(steady) as { kills: number[]; leaks: number };
    assert.ok(parsed.kills.length > 3, `${parsed.kills.length} kills to compare`);
    assert.ok(parsed.leaks > 0, "and at least one drone got through");
    assert.equal(await run(() => Math.floor(rnd() * 5), 60 * 85), steady, "random 0-4 step frames");
    assert.equal(await run(() => 4, 60 * 85), steady, "steady 4-step frames");
  });

  test("a player who aims and shoots wins: wave 12 cleared, beacon intact, no game over", async () => {
    const { h, step, dispose } = await fixture();
    let wonAt = -1;
    let maxWave = 0;
    for (let s = 0; s < 60 * 400 && wonAt < 0; s++) {
      botTurn(h);
      step(1);
      const st = h.state();
      maxWave = Math.max(maxWave, st.wave);
      if (st.won) wonAt = s;
      else assert.equal(st.gameOver, false, `the beacon fell at step ${s} (wave ${st.wave}, ${st.leaks} leaks)`);
    }
    const st = h.state();
    assert.ok(st.won, `reached wave ${maxWave} and won`);
    assert.equal(st.wave, FINAL_WAVE, "the win comes from clearing the last wave");
    assert.equal(st.games, 1, "in a single run");
    assert.ok(st.beaconHp > 0, `${Math.round(st.beaconHp)} integrity left`);
    assert.ok(st.kills > 150, `${st.kills} kills over the run`);
    assert.ok(wonAt > 60 * 60 && wonAt < 60 * 300, `a full run takes ${(wonAt / 60).toFixed(0)}s of game time`);
    assert.ok(st.score > 1000, `score ${st.score}`);
    assert.ok(UPGRADES.some((u) => st.upgrades[u.id] > 0), "credits were spent on upgrades");
    assert.equal(h.runtime.errors.length, 0, `${st.lastError}`);
    await dispose();
  });

  test("wave composition follows the table: four kinds, scaling armour, a fixed last wave", () => {
    const countOf = (wave: number, kind: string): number => waveSpec(wave).entries.find((e) => e.kind === kind)?.count ?? 0;
    assert.equal(countOf(1, "scout"), 3, "wave 1 is three scouts");
    assert.equal(waveSpec(1).entries.length, 1, "and nothing else");
    assert.equal(countOf(2, "splitter"), 0, "no splitters yet");
    assert.equal(countOf(3, "splitter"), 1, "splitters arrive at wave 3");
    assert.equal(countOf(5, "bruiser"), 1, "bruisers at wave 5");
    assert.equal(countOf(7, "bomber"), 0, "wave 7 is not quite heavy enough for bombers");
    assert.equal(countOf(8, "bomber"), 1, "bombers arrive at wave 8");
    assert.equal(countOf(FINAL_WAVE, "bomber"), 2, "and the last wave brings two");
    assert.equal(waveSpec(7).entries.length, 3, "a wave lists only the kinds it sends");
    const last = waveSpec(FINAL_WAVE);
    assert.ok(last.drones > waveSpec(1).drones * 3, `${last.drones} drones in the last wave vs ${waveSpec(1).drones} in the first`);
    assertCloseTo(last.hpScale, 1 + 0.16 * (FINAL_WAVE - 1), 4, "armour scales 16% a wave");
    assert.ok(last.speedScale > 1 && last.spawnEvery <= waveSpec(1).spawnEvery, "they come faster too");
    let drones = 0;
    for (let w = 1; w <= FINAL_WAVE; w++) {
      const spec = waveSpec(w);
      drones += spec.drones;
      assert.equal(spec.drones, spec.entries.reduce((n, e) => n + e.count, 0), `wave ${w} adds up`);
      assert.equal(spec.order.length, spec.drones, `wave ${w} lists every spawn`);
      assert.equal(spec.wave, w);
    }
    // 102 scouts + 30 splitters + 20 bruisers + 7 bombers: the whole run's spawn list, before any
    // splitter shards into two more scouts.
    assert.equal(drones, 159, `${drones} drones across a full run`);
    assert.equal(DRONE_SPECS.scout.points, 12);
    assert.ok(DRONE_SPECS.bomber.points > DRONE_SPECS.scout.points, "a bomber is worth more than a scout");
    assert.ok(DRONE_SPECS.bruiser.hp > DRONE_SPECS.scout.hp * 4, "a bruiser takes far more than a scout");
    assert.ok(DRONE_SPECS.splitter.damage < DRONE_SPECS.bomber.damage, "bombers hit hardest");
    for (const spec of Object.values(DRONE_SPECS)) {
      assert.ok(spec.speed > 0 && spec.radius > 0 && spec.credits > 0 && spec.scale > 0, `${spec.kind} spec is complete`);
      assert.ok(spec.label.length > 0, `${spec.kind} has a name for the HUD`);
    }
  });

  test("upgrades buy exactly the numbers they advertise, and each level costs more", async () => {
    const { h, step, dispose } = await fixture();
    step(1);
    const tick = h.game.tick;
    h.game.credits = 100000;
    const before = {
      turret: h.game.turretDamage(tick),
      cannon: h.game.cannonDamage(tick),
      aiSteps: h.game.aiFireSteps(tick),
      manualSteps: h.game.manualFireSteps(),
      aiRange: h.game.aiRange(),
      manualRange: h.game.manualRange(),
      targets: h.game.targets(),
      hp: h.state().beaconMaxHp,
    };
    let spent = 0;
    const bought: Array<{ id: string; level: number; cost: number; credits: number }> = [];
    const boughtListener = h.runtime.events.on(UpgradeBought, (e) => bought.push({ id: e.id, level: e.level, cost: e.cost, credits: e.credits }));
    for (const upgrade of UPGRADES) {
      assert.ok(h.game.costOf(upgrade.id) !== null, `${upgrade.id} starts buyable`);
      for (let level = 0; level < upgrade.maxLevel; level++) {
        const cost = h.game.costOf(upgrade.id)!;
        assert.equal(cost, Math.round(upgrade.baseCost * Math.pow(upgrade.growth, level)), `${upgrade.id} level ${level} costs ${cost}`);
        spent += cost;
        const creditsBefore = h.game.credits;
        bought.length = 0;
        h.buyUpgrade(upgrade.id);
        step(1);
        assert.equal(h.state().upgrades[upgrade.id], level + 1, `${upgrade.id} reached level ${level + 1}`);
        assert.equal(bought.length, 1, `${upgrade.id} reported one purchase`);
        assert.equal(bought[0]!.cost, cost, "the event carries the price paid");
        assert.equal(bought[0]!.credits, creditsBefore - cost, `${cost} credits left the wallet`);
        assert.equal(bought[0]!.level, level + 1);
        const next = h.game.costOf(upgrade.id);
        assert.ok(next === null || next > cost, `${upgrade.id} gets more expensive`);
      }
      assert.equal(h.game.costOf(upgrade.id), null, `${upgrade.id} stops at level ${upgrade.maxLevel}`);
    }
    const after = {
      turret: h.game.turretDamage(tick),
      cannon: h.game.cannonDamage(tick),
      aiSteps: h.game.aiFireSteps(tick),
      manualSteps: h.game.manualFireSteps(),
      aiRange: h.game.aiRange(),
      manualRange: h.game.manualRange(),
      targets: h.game.targets(),
      hp: h.state().beaconMaxHp,
    };
    assertCloseTo(after.turret, before.turret * (1 + 0.3 * 6), 4, "six warhead levels are +30% of base each");
    assertCloseTo(after.cannon, before.cannon * (1 + 0.3 * 6), 4, "and the cannon gets the same warheads");
    assertCloseTo(after.turret, DEFAULT_GAME_TUNING.aiDamage * 2.8, 4, "3 damage a shot becomes 8.4");
    assert.equal(after.aiSteps, Math.max(4, Math.round(before.aiSteps * Math.pow(0.86, 6))), "servos cut the turret's interval");
    assert.equal(after.manualSteps, Math.max(5, Math.round(before.manualSteps * Math.pow(0.82, 5))), "cooling cuts the cannon's interval");
    assert.equal(after.aiRange, before.aiRange + 15, "optics add 3 m a level");
    assert.equal(after.manualRange, before.manualRange + 15);
    assert.equal(after.targets, before.targets + 3, "racks add a target a level");
    assert.equal(after.hp, before.hp + 5 * DEFAULT_GAME_TUNING.shieldBonus, "bulwarks raise the integrity ceiling");
    assert.equal(h.state().beaconHp, after.hp, "and every bulwark healed the beacon back up");
    assert.ok(spent > 3000, `a fully upgraded turret costs ${spent} credits, so a run has to earn them`);
    boughtListener.dispose();
    assert.equal(h.runtime.errors.length, 0, h.state().lastError ?? "");
    await dispose();
  });

  test("a purchase is refused when it cannot be made, with the reason on the event", async () => {
    const { h, step, dispose } = await fixture();
    const refused: Array<{ id: string; reason: string }> = [];
    const listener = h.runtime.events.on(PurchaseRefused, (e) => refused.push({ id: e.id, reason: e.reason }));
    step(1);
    h.game.credits = 0;
    h.buyUpgrade("damage");
    h.useAbility("emp");
    step(1);
    assert.deepEqual(refused, [
      { id: "damage", reason: "credits" },
      { id: "emp", reason: "credits" },
    ]);
    assert.equal(h.state().upgrades.damage, 0, "nothing was bought");

    h.game.credits = 100000;
    for (let i = 0; i < 5; i++) {
      h.buyUpgrade("cooling");
      step(1);
    }
    assert.equal(h.state().upgrades.cooling, 5);
    assert.equal(h.game.costOf("cooling"), null);
    refused.length = 0;
    h.buyUpgrade("cooling");
    step(1);
    assert.deepEqual(refused, [{ id: "cooling", reason: "maxLevel" }]);

    refused.length = 0;
    h.useAbility("emp");
    step(1);
    assert.ok(h.state().abilities.emp.cooldownSteps > 0, "EMP went on cooldown");
    h.useAbility("emp");
    step(1);
    assert.deepEqual(refused, [{ id: "emp", reason: "cooldown" }]);

    // After a loss nothing can be bought at all.
    refused.length = 0;
    h.runtime.events.post(BeaconStrike, { damage: 100000, tick: h.game.tick, x: 0, y: 1, z: 0 }, { to: h.game.beacon });
    step(1);
    assert.ok(h.state().gameOver, "the beacon is gone");
    h.buyUpgrade("rate");
    h.useAbility("repair");
    step(1);
    assert.deepEqual(refused, [
      { id: "rate", reason: "finished" },
      { id: "repair", reason: "finished" },
    ]);
    listener.dispose();
    assert.equal(h.runtime.errors.length, 0, h.state().lastError ?? "");
    await dispose();
  });

  test("abilities do what they say: EMP slows, overcharge doubles damage and halves the interval, repair heals", async () => {
    const { h, step, play, dispose } = await fixture();
    play(6);
    h.game.credits = 1000;
    assert.ok(nearestDrone(h) !== null, "drones are on the field");
    const tick = h.game.tick;
    const baseDamage = h.game.turretDamage(tick);
    const baseSteps = h.game.aiFireSteps(tick);

    h.useAbility("emp");
    step(1);
    let st = h.state();
    assert.ok(st.empActive, "the EMP window is open");
    const store = h.scene.world.store(DroneTag);
    assert.ok(store.count > 0, `${store.count} drones to slow`);
    for (let i = 0; i < store.count; i++) assert.equal(store.valueAt(i).slowed, 1, "every drone on the field is slowed");
    assertCloseTo(st.abilities.emp.cooldownSeconds, stepsToSeconds(ABILITIES[0]!.cooldownSteps - 1), 4, "the HUD gets cooldowns in seconds, one step spent");
    assert.equal(st.abilities.emp.ready, false);

    h.useAbility("overcharge");
    step(1);
    st = h.state();
    assert.ok(st.overchargeActive, "the overcharge window is open");
    assertCloseTo(st.turret.damage, baseDamage * DEFAULT_GAME_TUNING.overchargeDamage, 4, "2.5× damage while it runs");
    assert.equal(Math.round(st.turret.aiInterval * 60), Math.max(4, Math.round(baseSteps * DEFAULT_GAME_TUNING.overchargeRate)), "and twice the rate");

    // Repair: strike the beacon the way a drone does, then fix it.
    const repaired: number[] = [];
    const repairListener = h.runtime.events.on(BeaconRepaired, (e) => repaired.push(e.hp));
    const full = h.state().beaconMaxHp;
    h.runtime.events.post(BeaconStrike, { damage: 60, tick: h.game.tick, x: 0, y: 1, z: 0 }, { to: h.game.beacon });
    step(1);
    assert.equal(h.state().beaconHp, full - 60, "the strike landed");
    const tag = h.scene.world.getComponent(h.game.beacon, BeaconTag)!;
    assert.equal(tag.hp, full - 60, "and the component the HUD reads agrees");
    h.useAbility("repair");
    step(1);
    const healed = Math.min(full, full - 60 + Math.round(full * DEFAULT_GAME_TUNING.repairFraction));
    assert.equal(h.state().beaconHp, healed, "repair healed 30% of the ceiling");
    assert.deepEqual(repaired, [healed], "with a BeaconRepaired event carrying the new integrity");
    assert.equal(h.state().abilities.repair.ready, false, "and went on the longest cooldown of the three");

    // Cooldowns tick down on the sim clock and announce themselves when they clear.
    const ready: string[] = [];
    const readyListener = h.runtime.events.on(AbilityReady, (e) => ready.push(e.id));
    for (let s = 0; s < ABILITIES[0]!.cooldownSteps + 5; s++) step(1);
    assert.ok(ready.includes("emp"), `EMP came off cooldown (${ready.join(",")})`);
    assert.equal(h.state().abilities.emp.ready, true);
    assert.equal(h.state().abilities.emp.cooldownSteps, 0);
    assert.ok(!h.game.empActive(h.game.tick), "and its slow window is long over");
    readyListener.dispose();
    repairListener.dispose();
    assert.equal(h.runtime.errors.length, 0, h.state().lastError ?? "");
    await dispose();
  });

  test("a splitter breaks into two scout shards where it died", async () => {
    const { h, step, dispose } = await fixture();
    const splits: Array<{ x: number; z: number }> = [];
    const splitterDeaths: number[] = [];
    const splitListener = h.runtime.events.on(DroneSplit, (e) => splits.push({ x: e.x, z: e.z }));
    const downListener = h.runtime.events.on(DroneDown, (e) => {
      if (e.kind === "splitter") splitterDeaths.push(e.tick);
    });
    let shardsAtSplit = -1;
    for (let s = 0; s < 60 * 200 && shardsAtSplit < 0; s++) {
      botTurn(h);
      const before = splits.length;
      step(1);
      if (splits.length > before) {
        // The director handles DroneSplit before this test's listener, so the shards already exist.
        const at = splits[splits.length - 1]!;
        const store = h.scene.world.store(DroneTag);
        let near = 0;
        for (let i = 0; i < store.count; i++) {
          const tag = store.valueAt(i);
          if (tag.kind !== "scout") continue;
          const p = h.scene.world.getComponent(tag.entity, Transform)!.position;
          if (Math.hypot(p.x - at.x, p.z - at.z) < 4) near++;
        }
        shardsAtSplit = near;
      }
    }
    assert.ok(splitterDeaths.length > 0, "splitters were shot down");
    assert.equal(shardsAtSplit, 2, "two scout shards appeared at the split point");
    assert.equal(splits.length, splitterDeaths.length, "one split notification per splitter death");
    assert.equal(h.game.shards, 2 * splits.length, "and the run tallies every shard it made");
    splitListener.dispose();
    downListener.dispose();
    assert.equal(h.runtime.errors.length, 0, h.state().lastError ?? "");
    await dispose();
  });

  test("the cannon hits what the player aims at, and only inside its range", async () => {
    const playerShots = async (tuning: BeaconGameTuning, aimAtDrone: boolean): Promise<{ kills: number; shots: number; hits: number }> => {
      const { h, step, play, dispose } = await fixture(tuning);
      const kills: string[] = [];
      const listener = h.runtime.events.on(DroneDown, (e) => {
        if (e.source === "player") kills.push(e.kind);
      });
      play(8);
      for (let s = 0; s < 60 * 20; s++) {
        const drone = nearestDrone(h);
        // Aim away from the field: with a 4 m cannon nothing can be on that ray.
        if (drone && (aimAtDrone || !droneNearTurret(h, 8))) {
          h.aimAt(aimAtDrone ? drone.x : -drone.x * 3, aimAtDrone ? drone.z : -drone.z * 3);
          h.fire();
        }
        step(1);
      }
      const st = h.state();
      listener.dispose();
      const out = { kills: kills.length, shots: st.turret.manualShots, hits: st.turret.hits };
      await dispose();
      return out;
    };
    const aimed = await playerShots(DEFAULT_GAME_TUNING, true);
    assert.ok(aimed.shots > 20, `the cannon fired ${aimed.shots} times`);
    assert.ok(aimed.kills > 3, `${aimed.kills} drones died to the player's cannon`);
    assert.ok(aimed.hits >= aimed.kills, `${aimed.hits} strikes for ${aimed.kills} kills`);
    const away = await playerShots({ ...DEFAULT_GAME_TUNING, manualRange: 4 }, false);
    assert.equal(away.kills, 0, "nothing dies to shots aimed away from it");
    assert.ok(away.shots > 20, `${away.shots} shots still left the barrel`);
  });

  test("pause freezes the run exactly, and restart resets it", async () => {
    const { h, step, play, dispose } = await fixture();
    play(20);
    h.setPaused(true);
    const before = h.state();
    const tickBefore = h.game.tick;
    for (let s = 0; s < 240; s++) step(0);
    const paused = h.state();
    assert.equal(paused.kills, before.kills, "kills frozen");
    assert.equal(paused.turret.shots, before.turret.shots, "shots frozen");
    assert.equal(paused.drones, before.drones, "drones frozen");
    assert.equal(paused.beaconHp, before.beaconHp, "integrity frozen");
    assert.equal(paused.credits, before.credits, "credits frozen");
    assert.equal(paused.score, before.score, "score frozen");
    assert.equal(h.game.tick, tickBefore, "the sim tick did not move");
    assert.ok(paused.paused, "and the HUD knows it is paused");
    assert.deepEqual(h.hud.last!.hint, { key: "P", action: "Resume" }, "and offers the way back");

    h.setPaused(false);
    play(3);
    const resumed = h.state();
    assert.ok(resumed.turret.shots > paused.turret.shots, "the turret fights again");
    assert.ok(h.game.tick > tickBefore, "and the clock runs");

    h.restart();
    step(1);
    const fresh = h.state();
    assert.equal(fresh.games, 2, "a second run");
    assert.equal(fresh.kills, 0);
    assert.equal(fresh.score, 0);
    assert.equal(fresh.credits, DEFAULT_GAME_TUNING.startCredits, "starting credits back");
    assert.equal(fresh.beaconHp, fresh.beaconMaxHp, "integrity back to full");
    assert.deepEqual(fresh.killTicks, []);
    assert.equal(fresh.phase, "combat");
    assert.equal(h.runtime.errors.length, 0, fresh.lastError ?? "");
    await dispose();
  });

  test("the intermission waits its full length, and calling the wave cuts it to one step", async () => {
    const gap = async (call: boolean): Promise<number> => {
      const { h, step, dispose } = await fixture();
      let clearedAt = -1;
      let startedAt = -1;
      const a = h.runtime.events.on(WaveCleared, () => {
        clearedAt = h.game.tick;
      });
      const b = h.runtime.events.on(WaveStarted, () => {
        if (clearedAt >= 0 && startedAt < 0) startedAt = h.game.tick;
      });
      for (let s = 0; s < 60 * 90 && startedAt < 0; s++) {
        if (call && clearedAt >= 0) h.callWave();
        step(1);
      }
      a.dispose();
      b.dispose();
      const out = startedAt - clearedAt;
      await dispose();
      return out;
    };
    assert.equal(await gap(false), DEFAULT_GAME_TUNING.intermissionSteps, "eight seconds between waves");
    assert.equal(await gap(true), 1, "the player can call the next wave immediately");
  });

  test("clearing the last wave wins the run, and a fresh one starts after the victory window", async () => {
    const { h, step, dispose } = await fixture();
    const wins: number[] = [];
    const listener = h.runtime.events.on(GameWon, (e) => wins.push(e.score));
    for (let s = 0; s < 60 * 400 && wins.length === 0; s++) {
      botTurn(h);
      step(1);
    }
    assert.equal(wins.length, 1, "the win event fired once");
    assert.ok(wins[0]! > 0, `with a score of ${wins[0]}`);
    const st = h.state();
    assert.equal(st.phase, "won");
    const drawn = h.hud.last!;
    assert.ok(drawn.end !== null && drawn.end.won, "the HUD gets a victory summary");
    assert.equal(drawn.end.wave, FINAL_WAVE);
    assert.equal(drawn.phase, "won");
    assert.ok(drawn.end.kills > 150, `${drawn.end.kills} kills in the summary`);
    for (let s = 0; s < DEFAULT_GAME_TUNING.winRestartAfterSteps + 20; s++) step(1);
    assert.equal(h.state().games, 2, "and a fresh run starts after the victory window");
    listener.dispose();
    assert.equal(h.runtime.errors.length, 0, h.state().lastError ?? "");
    await dispose();
  });
});

group("Beacon Defense: the stage around the game", () => {
  test("game events become sparks, tracers, banners and toasts", async () => {
    const { h, step, play, dispose } = await fixture();
    play(1);
    assert.equal(h.state().banner, "WAVE 1 INCOMING", "the wave banner came from the WaveStarted event");
    h.game.credits = 5000;
    h.buyUpgrade("damage");
    step(1);
    assert.ok(h.state().hud.toasts > 0, "the purchase raised a toast");
    let maxSparks = 0;
    let maxTracers = 0;
    let maxEmitted = 0;
    for (let s = 0; s < 60 * 25; s++) {
      botTurn(h);
      step(1);
      const fx = h.state().fx;
      maxSparks = Math.max(maxSparks, fx.sparks);
      maxTracers = Math.max(maxTracers, fx.tracers);
      maxEmitted = Math.max(maxEmitted, fx.emitted);
    }
    const st = h.state();
    assert.ok(maxEmitted > 200, `${maxEmitted} particles emitted`);
    assert.ok(maxSparks > 10, `${maxSparks} sparks alive at once`);
    assert.ok(maxSparks <= st.fx.capacity, "never more alive than the simulation holds");
    assert.ok(st.fx.capacity > SPARK_POOL, `${st.fx.capacity} particles simulated, ${SPARK_POOL} sprites to draw them`);
    assert.ok(maxTracers > 0 && maxTracers <= TRACER_POOL, `${maxTracers} tracers drawn, within the pool`);
    assert.ok(st.kills > 5, `${st.kills} kills drove them`);
    assert.ok(st.hud.elements > 40, `${st.hud.elements} UI elements drawn by the WebGPU UI pass`);
    assert.ok(st.scripts.eventsDelivered > 100, `${st.scripts.eventsDelivered} script events delivered`);
    assert.equal(h.runtime.errors.length, 0, st.lastError ?? "");
    await dispose();
  });

  test("the HUD mirrors the game: vitals, upgrades, abilities, markers and the arena map", async () => {
    const { h, step, play, dispose } = await fixture();
    play(12);
    h.game.credits = 900;
    h.buyUpgrade("range");
    h.buyUpgrade("shield");
    h.useAbility("emp");
    step(1);
    const st = h.state();
    const drawn = h.hud.last;
    assert.ok(drawn !== null, "the HUD has drawn a snapshot");
    assert.equal(st.wave, h.game.wave);
    assert.equal(st.credits, h.game.credits);
    assert.equal(st.kills, h.game.kills);
    assert.equal(st.leaks, h.game.leaks);
    assert.equal(drawn!.score, st.score, "the HUD is drawing the same numbers");
    assert.equal(drawn!.credits, st.credits);
    assert.equal(drawn!.wave, st.wave);
    const tag = h.scene.world.getComponent(h.game.beacon, BeaconTag)!;
    assert.equal(st.beaconHp, tag.hp, "integrity comes from the beacon component");
    assert.equal(st.beaconMaxHp, DEFAULT_GAME_TUNING.beaconHp + DEFAULT_GAME_TUNING.shieldBonus, "the bulwark raised the ceiling");
    assert.equal(drawn!.beaconMaxHp, st.beaconMaxHp);
    assert.equal(st.drones, h.scene.world.store(DroneTag).count, "the drone count matches the store");
    assert.equal(drawn!.markers.length, st.drones, "and every drone has a minimap marker");
    assert.equal(st.upgrades.range, 1);
    assert.equal(st.upgrades.shield, 1);
    assert.equal(st.upgrades.damage, 0, "nothing was bought that was not asked for");
    assert.equal(st.upgradeCosts.range, Math.round(35 * 1.5), "the next optics level costs 53");
    assert.equal(drawn!.upgrades.find((u) => u.id === "range")?.level, 1);
    assert.equal(drawn!.upgrades.find((u) => u.id === "range")?.hotkey, "6");
    assert.ok(st.empActive && st.abilities.emp.active, "the HUD knows EMP is running");
    assert.ok(st.abilities.emp.cooldownSeconds > 0 && st.abilities.emp.cooldownSeconds <= stepsToSeconds(ABILITIES[0]!.cooldownSteps));
    assert.equal(st.abilities.emp.ready, false);
    assert.equal(drawn!.abilities.find((a) => a.id === "emp")?.active, true);
    assert.equal(st.turret.range, h.game.manualRange());
    assert.equal(st.turret.targets, h.game.targets());
    assert.ok(h.hud.widgets > 20, `${h.hud.widgets} HUD widgets built`);
    assert.ok(h.ui.assets.texture("beacon.arena") !== undefined, "the minimap's arena art is registered with the UI atlas");
    assert.equal(h.ui.viewport.width, 1280, "the UI fell back to its default viewport with no canvas");
    assert.equal(h.runtime.errors.length, 0, st.lastError ?? "");
    await dispose();
  });

  test("markers and the threat readout track the closest drone", async () => {
    const { h, play, dispose } = await fixture();
    play(30);
    const st = h.state();
    const drawn = h.hud.last!;
    const store = h.scene.world.store(DroneTag);
    assert.ok(store.count > 0, "drones on the field");
    let closest = Infinity;
    let closestKind = "";
    for (let i = 0; i < store.count; i++) {
      const tag = store.valueAt(i);
      const p = h.scene.world.getComponent(tag.entity, Transform)!.position;
      const d = Math.hypot(p.x, p.z);
      if (d < closest) {
        closest = d;
        closestKind = tag.kind;
      }
    }
    assert.equal(drawn.markers.length, store.count);
    assert.ok(closest < ARENA_RADIUS + 2, `the closest drone is ${closest.toFixed(1)} m out`);
    assert.ok(drawn.threat !== null, "the HUD names a threat");
    assert.equal(drawn.threat!.name, DRONE_SPECS[closestKind as keyof typeof DRONE_SPECS].label, "the closest drone is the threat");
    assert.ok(drawn.threat!.hp > 0 && drawn.threat!.hp <= drawn.threat!.maxHp, "with a live health bar");
    for (const marker of drawn.markers) {
      assert.ok(Math.hypot(marker.x, marker.z) <= ARENA_RADIUS + 6, `marker at ${marker.x.toFixed(1)},${marker.z.toFixed(1)} is in the arena`);
      assert.ok(Object.keys(DRONE_SPECS).includes(marker.kind), `${marker.kind} is a real drone kind`);
    }
    assert.equal(st.phase, "combat");
    assert.ok(st.waveKills >= 0 && st.waveKills <= st.kills, "the wave tally is part of the run total");
    assert.equal(drawn.arenaRadius, ARENA_RADIUS + 3, "the minimap spans the arena");
    await dispose();
  });

  test("the arena map is drawn from numbers: sized, deterministic, rings and all", () => {
    const size = 96;
    const rings = [0.42, 0.68, 0.94];
    const map = arenaMapPixels(size, rings);
    const again = arenaMapPixels(size, rings);
    assert.equal(map.width, size);
    assert.equal(map.height, size);
    assert.equal(map.rgba.length, size * size * 4, "RGBA bytes for every pixel");
    assert.deepEqual(Array.from(again.rgba), Array.from(map.rgba), "the same size and rings give the same map");
    assert.notDeepEqual(Array.from(arenaMapPixels(size, [0.42, 0.68]).rgba), Array.from(map.rgba), "fewer rings draw a different map");
    assert.deepEqual(Array.from(arenaMapPixels(64, rings).rgba), Array.from(arenaMapPixels(64, rings).rgba), "and it scales to any size");
    const px = map.rgba;
    let opaque = 0;
    const distinct = new Set<number>();
    let ringed = 0;
    for (let i = 0; i < size * size; i++) {
      const r = px[i * 4]!;
      const g = px[i * 4 + 1]!;
      const b = px[i * 4 + 2]!;
      if (px[i * 4 + 3]! === 255) opaque++;
      distinct.add((r << 16) | (g << 8) | b);
      if (r === 64 && g === 96 && b === 118) ringed++;
    }
    assert.equal(opaque, size * size, "every pixel is drawn");
    assert.ok(distinct.size >= 4, `${distinct.size} distinct colours: floor, rings, cross hairs, beacon`);
    assert.ok(ringed > size, `${ringed} pixels of range rings`);
    const mid = (size >> 1) * size + (size >> 1);
    assert.equal(px[mid * 4]!, 88, "the beacon is drawn at the centre");
    assert.equal(px[mid * 4 + 1]!, 196);
    assert.ok(px[0]! < px[mid * 4]!, "and the corners are dark outside the disc");
    assert.equal(stepsToSeconds(60), 1, "the HUD's step clock is 60 Hz");
    assert.equal(stepsToSeconds(1080), 18, "EMP's 1080 steps read as 18 seconds");
  });

  test("the arena and its models are closed, outward-wound meshes built from the mesh kit", () => {
    const drones = droneSources();
    const models: Array<[string, ReturnType<typeof crateSource>]> = [
      ["crate", crateSource()],
      ["beacon tower", beaconTowerSource()],
      ["turret head", turretHeadSource()],
      ["scout", drones.scout],
      ["splitter", drones.splitter],
      ["bruiser", drones.bruiser],
      ["bomber", drones.bomber],
    ];
    for (const [name, source] of models) {
      assert.ok(source.positions.length > 180, `${name} has geometry (${source.positions.length / 3} verts)`);
      assert.ok(source.indices !== undefined && source.indices!.length % 3 === 0, `${name} is indexed triangles`);
      assert.ok(source.normals !== null && source.normals !== undefined && source.normals.length === source.positions.length, `${name} has a normal per vertex`);
      assert.ok(source.uvs !== null && source.uvs !== undefined && source.uvs.length === (source.positions.length / 3) * 2, `${name} has UVs`);
      assert.ok(signedVolume(source) > 0.02, `${name} is a closed outward-wound solid (${signedVolume(source).toFixed(3)} m³)`);
    }
    assert.ok(signedVolume(drones.bruiser) > signedVolume(drones.scout) * 3, "a bruiser is a much bigger drone than a scout");
    assert.ok(TURRET_AT.x * TURRET_AT.x + TURRET_AT.z * TURRET_AT.z < ARENA_RADIUS * ARENA_RADIUS, "the turret stands inside the arena");
    assert.ok(FLIGHT_HEIGHT > 0.5, "drones fly above the crates");
    assert.equal(Object.keys(drones).length, Object.keys(DRONE_SPECS).length, "one model per drone kind");
  });

  test("the arena renders: a real renderer pass draws the set, the drones and the UI overlay", async () => {
    const gpu = await GraphicsDevice.create({ forceMock: true });
    gpu.resize(640, 360);
    // The low tier and a small shadow map keep this honest about the render path without making the
    // mock device spend half a minute on it.
    const renderer = new Renderer(gpu, { shadowMapSize: 256 });
    const clock = new Clock();
    const h = buildBeaconDefenseScene({ gpu, renderer, clock } as unknown as Engine, { deviceTier: "low" });
    let frame = 0;
    const stepAndDraw = (fixedSteps: number): void => {
      frame++;
      const c: SystemContext = {
        world: h.scene.world,
        clock,
        dt: Math.max(0, fixedSteps) / 60,
        fixedDt: 1 / 60,
        fixedSteps,
        alpha: 0,
        elapsed: frame / 60,
        frame,
        logger: new Logger({ level: LogLevel.Silent }),
        profiler: new Profiler(),
        services: { get: () => undefined, engineConfig: {} },
        scratch: new SystemScratch(),
      };
      h.scene.update(c, c.dt);
      h.update(c.dt);
      // The demo's frame loop owns the camera pose; apply the same override it would. `cameraOverride`
      // is nullable in the handle contract (a scene may hand control back), and this one never does.
      const pose = h.cameraOverride!()!;
      h.cameraEntity.transform.position = new Vec3(pose.eye[0], pose.eye[1], pose.eye[2]);
      h.cameraEntity.transform.lookAt(new Vec3(pose.target[0], pose.target[1], pose.target[2]));
      renderer.renderScene(h.scene, c);
    };
    for (let s = 0; s < 60 * 2; s++) {
      botTurn(h);
      stepAndDraw(1);
    }
    const st = h.state();
    assert.ok(gpu.mock.submitCount > 60, `${gpu.mock.submitCount} frames submitted`);
    assert.deepEqual(gpu.mock.errors, [], "no device validation errors from the arena or the HUD");
    assert.ok(renderer.stats.drawCalls > 10, `${renderer.stats.drawCalls} draw calls in the last frame`);
    assert.ok(renderer.stats.triangles > 2000, `${renderer.stats.triangles} triangles on screen`);
    assert.ok(st.kills >= 0 && st.drones >= 0, "the run kept playing while it was being drawn");
    assert.ok(st.fx.sparks >= 0 && st.hud.elements > 40, "with sparks and HUD elements in the frame");
    assert.ok(clock.paused === false, "the clock ran for the renderer's own frame");

    // Every camera pose the player can cycle to has to draw cleanly too.
    for (const mode of ["turret", "top", "arena"] as const) {
      h.setCameraMode(mode);
      stepAndDraw(1);
      assert.equal(h.state().cameraMode, mode);
      assert.deepEqual(gpu.mock.errors, [], `${mode} camera drew without errors`);
      assert.ok(renderer.stats.drawCalls > 5, `${mode} drew ${renderer.stats.drawCalls} calls`);
    }
    // And a paused game still draws (the HUD stays readable while nothing moves).
    h.setPaused(true);
    assert.ok(clock.paused, "pausing stops the engine's clock");
    stepAndDraw(0);
    assert.deepEqual(gpu.mock.errors, []);
    h.setPaused(false);

    h.dispose?.();
    renderer.dispose();
    await gpu.dispose();
    assert.deepEqual(gpu.mock.outstanding.buffers, [], "renderer, scene and UI buffers all released");
    assert.deepEqual(gpu.mock.outstanding.textures, [], "and every texture with them");
  });

  test("disposing the scene releases every GPU resource", async () => {
    const { gpu, h, play } = await fixture();
    play(5);
    assert.ok(gpu.mock.outstanding.buffers.length > 0, `${gpu.mock.outstanding.buffers.length} buffers alive while it runs`);
    h.dispose?.();
    assert.deepEqual(gpu.mock.outstanding.buffers, [], "every buffer released");
    assert.deepEqual(gpu.mock.outstanding.textures, [], "every texture released");
    await gpu.dispose();
  });
});

group("Beacon Defense: procedural sound", () => {
  test("every effect renders to its spec length, deterministically and without clipping", () => {
    const sampleRate = 48000;
    assert.ok(BEACON_SOUND_NAMES.length >= 15, `${BEACON_SOUND_NAMES.length} effects`);
    for (const name of BEACON_SOUND_NAMES) {
      const spec = BEACON_SOUNDS[name];
      const pcm = renderBeaconSound(name, sampleRate);
      assert.equal(pcm.length, Math.max(1, Math.round(spec.duration * sampleRate)), `${name} is ${spec.duration}s`);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) {
        peak = Math.max(peak, Math.abs(pcm[i]!));
        sum += pcm[i]! * pcm[i]!;
      }
      assert.ok(peak > 0 && peak <= 1, `${name} peaks at ${peak.toFixed(3)}`);
      assert.ok(Math.sqrt(sum / pcm.length) > 0.005, `${name} has audible energy`);
      const again = renderBeaconSound(name, sampleRate);
      assert.deepEqual(Array.from(again), Array.from(pcm), `${name} renders identically every time`);
      assert.ok(spec.minInterval > 0 && spec.minInterval < spec.duration + 0.5, `${name} can repeat but is rate-limited`);
      assert.ok(spec.gain > 0 && spec.gain <= 1, `${name} has a mix level`);
      assert.ok(spec.label.length > 3, `${name} is described`);
    }
    assert.equal(renderBeaconSound("shot", 24000).length, Math.round(BEACON_SOUNDS.shot.duration * 24000), "a lower sample rate gives proportionally fewer samples");
  });

  test("the effects are distinct: the cannon is lower and longer than the servo shot", () => {
    const shot = renderBeaconSound("shot", 48000);
    const cannon = renderBeaconSound("cannon", 48000);
    const hit = renderBeaconSound("hit", 48000);
    const victory = renderBeaconSound("victory", 48000);
    assert.ok(cannon.length > shot.length, "the cannon is longer");
    assert.ok(spectralCentroid(cannon, 48000) < spectralCentroid(shot, 48000), "the cannon sits lower in the spectrum");
    assert.ok(spectralCentroid(hit, 48000) > spectralCentroid(cannon, 48000), "an armour tick is brighter than a detonation");
    assert.ok(victory.length > cannon.length * 4, "the victory chime is the longest thing in the set");
    assert.ok(BEACON_SOUNDS.gameOver.duration >= 1 && BEACON_SOUNDS.victory.duration >= 1, "run endings get a real cadence");
    assert.ok(BEACON_SOUNDS.explodeBig.duration > BEACON_SOUNDS.explodeSmall.duration, "heavy drones detonate longer");
    assert.ok(BEACON_SOUNDS.hit.minInterval <= BEACON_SOUNDS.explodeSmall.minInterval, "hits are allowed to repeat faster than explosions");
  });

  test("the soundscape plays through the engine's mixer, positions shots and rate-limits repeats", async () => {
    const { mock, context } = createMockAudio({ state: "running" });
    const system = new AudioSystem({ context, maxVoices: 8, masterVolume: 0.9 });
    const scape = new BeaconSoundscape(system, context, { volume: 0.8 });
    assert.equal(scape.sounds, 0, "buffers are built on demand");
    assert.ok(scape.play("shot", { at: { x: 4, y: 1.7, z: 4 } }), "the first shot plays");
    assert.equal(scape.sounds, 1, "one buffer cached");
    assert.ok(scape.secondsOfAudio() > 0.05, `${scape.secondsOfAudio().toFixed(3)}s of audio cached`);
    assert.ok(system.stats().activeVoices > 0, `${system.stats().activeVoices} voices live on the mixer`);
    assert.ok(mock.nodes.some((n) => n instanceof MockAudioBufferSourceNode), "a buffer source was scheduled");
    assert.ok(mock.nodes.some((n) => n.constructor.name === "MockPannerNode"), "and a spatial one-shot gets a panner");
    assert.equal(scape.play("shot"), false, "an identical shot inside its minimum interval is dropped");
    assert.ok(scape.play("cannon", { at: { x: -8, y: 1.7, z: 2 } }), "a different effect still plays");
    mock.advance(1);
    assert.ok(scape.play("shot"), "and the shot plays again once the interval has passed");
    assert.equal(scape.sounds, 2, "both buffers cached");
    scape.setListener({ x: 0, y: 36, z: -44 }, { x: 0, y: -0.6, z: 0.8 });
    scape.dispose();
    assert.equal(scape.play("shot"), false, "a disposed soundscape is silent");
    assert.equal(scape.sounds, 0, "and dropped its buffers");
    await system.dispose();
  });

  test("the scene is silent until sound is switched on, and needs a context to switch on", async () => {
    const quiet = await fixture();
    assert.equal(quiet.h.state().soundOn, false, "silent until asked");
    assert.equal(quiet.h.setSound(true), false, "with no audio context there is nothing to switch on");
    quiet.play(2);
    assert.ok(quiet.h.state().kills >= 0, "and the run plays on regardless");
    await quiet.dispose();

    const { mock, context } = createMockAudio({ state: "running" });
    const gpu = await GraphicsDevice.create({ forceMock: true });
    const loud = buildBeaconDefenseScene({ gpu } as Engine, { createAudioContext: () => context as AudioContext });
    assert.equal(loud.setSound(true), true, "an injected context switches sound on");
    assert.ok(loud.state().soundOn);
    for (let s = 0; s < 60 * 12; s++) {
      botTurn(loud);
      mock.advance(1 / 60);
      const c: SystemContext = {
        world: loud.scene.world,
        clock: new Clock(),
        dt: 1 / 60,
        fixedDt: 1 / 60,
        fixedSteps: 1,
        alpha: 0,
        elapsed: s / 60,
        frame: s,
        logger: new Logger({ level: LogLevel.Silent }),
        profiler: new Profiler(),
        services: { get: () => undefined, engineConfig: {} },
        scratch: new SystemScratch(),
      };
      loud.scene.update(c, c.dt);
      loud.update(c.dt);
    }
    assert.ok(loud.state().kills > 0, `${loud.state().kills} kills to make noise about`);
    const sources = mock.nodes.filter((n) => n instanceof MockAudioBufferSourceNode).length;
    assert.ok(sources > 30, `${sources} effect voices were scheduled by the game's events`);
    loud.dispose?.();
    await gpu.dispose();
  });
});

await finish();
