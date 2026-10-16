/**
 * @suite examples:beaconDefense
 * @group integration
 * @covers examples/src/scripting/beaconDefense.ts
 * @covers examples/src/scenes/scriptingScene.ts
 * @covers engine/src/scripting/runtime.ts
 * @covers engine/src/scripting/script.ts
 * @covers engine/src/scripting/events.ts
 * @covers engine/src/scripting/timers.ts
 * @covers engine/src/scripting/coroutines.ts
 * @covers engine/src/scene/components/index.ts
 * @desc Phase 18 exit criterion: Beacon Defense, a complete game written only as scripts against the public API, plays waves to a game over and restart with no script errors, is deterministic across frame splits, and hot-reloads its turret mid-game
 */

export const suite = {
  name: "examples:beaconDefense",
  group: "integration",
  covers: [
    "examples/src/scripting/beaconDefense.ts",
    "examples/src/scenes/scriptingScene.ts",
    "engine/src/scripting/runtime.ts",
    "engine/src/scripting/script.ts",
    "engine/src/scripting/events.ts",
    "engine/src/scripting/timers.ts",
    "engine/src/scripting/coroutines.ts",
    "engine/src/scene/components/index.ts",
  ],
  desc: "Phase 18 exit criterion: Beacon Defense, a complete game written only as scripts against the public API, plays waves to a game over and restart with no script errors, is deterministic across frame splits, and hot-reloads its turret mid-game",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { Clock, GraphicsDevice, LogLevel, Logger, Profiler, SystemScratch, type Engine, type ScriptContext, type SystemContext } from "@forge/engine";
import { buildScriptingScene, type ScriptingSceneHandle } from "../../examples/src/scenes/scriptingScene.js";
import { DEFAULT_TUNING, DroneHit, DroneTag, Turret } from "../../examples/src/scripting/beaconDefense.js";

async function game(): Promise<{ h: ScriptingSceneHandle; step: (fixedSteps: number) => void; dispose: () => Promise<void> }> {
  const gpu = await GraphicsDevice.create({ forceMock: true });
  const h = buildScriptingScene({ gpu } as Engine);
  let frame = 0;
  const step = (fixedSteps: number): void => {
    frame++;
    const c: SystemContext = {
      world: h.scene.world,
      clock: new Clock(),
      dt: Math.max(fixedSteps, 1) / 60,
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
  };
  return {
    h,
    step,
    dispose: async () => {
      h.dispose?.();
      await gpu.dispose();
    },
  };
}

group("Beacon Defense (Phase 18 exit criterion)", () => {
  test("a whole game runs on scripts alone: waves, kills, a game over and a restart, no script errors", async () => {
    const { h, step, dispose } = await game();
    let maxWave = 0;
    let sawGameOver = false;
    let maxDrones = 0;
    step(1);
    assert.equal(h.state().wave, 1, "wave 1 reaches the scoreboard even though it starts before the scoreboard subscribes");
    for (let s = 1; s < 60 * 95; s++) {
      step(1);
      const st = h.state();
      maxWave = Math.max(maxWave, st.wave);
      maxDrones = Math.max(maxDrones, st.drones);
      if (st.gameOver) sawGameOver = true;
    }
    const st = h.state();
    assert.ok(maxWave >= 5, `waves advance (reached ${maxWave})`);
    assert.ok(maxDrones >= 3, "drones were spawned by the director's coroutine");
    assert.ok(st.shots > 50, `the turret's timer fired (${st.shots} shots)`);
    assert.ok(st.killTicks.length > 10, `drones were shot down (${st.killTicks.length})`);
    assert.ok(sawGameOver, "the beacon fell");
    assert.equal(st.games, 2, "and the game restarted itself");
    assert.equal(h.runtime.errors.length, 0, `no script errors (${st.lastError})`);
    const stats = st.scripts;
    assert.ok(stats.scriptsCreated > 20 && stats.timersFired > 50 && stats.eventsDelivered > 50 && stats.coroutinesCancelled >= 1);
    await dispose();
  });

  test("the same fixed steps give the same game however the frames split them", async () => {
    const run = async (splits: () => number, total: number): Promise<string> => {
      const { h, step, dispose } = await game();
      let done = 0;
      while (done < total) {
        const n = Math.min(splits(), total - done);
        step(n);
        done += n;
      }
      const st = h.state();
      await dispose();
      return JSON.stringify({ kills: st.killTicks, score: st.score, wave: st.wave, hp: st.beaconHp, shots: st.shots, drones: st.drones });
    };
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    const steady = await run(() => 1, 60 * 40);
    assert.equal(await run(() => Math.floor(rnd() * 5), 60 * 40), steady);
    assert.equal(await run(() => 4, 60 * 40), steady);
  });

  test("hot reload: the turret's code changes mid-game, its data and slot stay", async () => {
    const { h, step, dispose } = await game();
    for (let s = 0; s < 60 * 20; s++) step(1);
    const before = h.state();
    // A new version of the turret: same data, a different `fire` (three times the damage).
    class Turret2 extends Turret {
      constructor() {
        super(DEFAULT_TUNING);
      }
      override fire(c: ScriptContext): void {
        const drones = c.world.store(DroneTag);
        if (drones.count === 0) return;
        this.shots++;
        this.emit(DroneHit, { damage: 3 }, { to: drones.valueAt(0).entity });
      }
    }
    h.runtime.define("Turret", Turret as never);
    const report = h.runtime.reload("Turret", Turret2);
    assert.deepEqual(report, { replaced: 1, failed: 0 });
    const kills0 = h.state().killTicks.length;
    for (let s = 0; s < 60 * 20; s++) step(1);
    const after = h.state();
    assert.ok(after.shots > before.shots, "the shot counter carried over and kept counting");
    assert.ok(after.killTicks.length - kills0 > 0);
    assert.equal(h.runtime.errors.length, 0, `${after.lastError}`);
    assert.equal(after.scripts.scriptsReloaded, 1);
    await dispose();
  });
});

await finish();
