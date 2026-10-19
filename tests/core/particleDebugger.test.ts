/**
 * @suite core:particleDebugger
 * @group unit
 * @covers engine/src/debug/particleDebugger.ts
 * @covers engine/src/index.ts
 * @covers engine/src/particles/gpuSystem.ts
 * @covers engine/src/particles/gpuWorld.ts
 * @covers engine/src/particles/layout.ts
 * @covers engine/src/particles/simulation.ts
 * @covers engine/src/particles/world.ts
 * @covers engine/src/scene/scene.ts
 * @desc Phase 21.7 — bounded CPU-particle samples and GPU-safe particle diagnostics
 */

export const suite = {
  name: "core:particleDebugger",
  group: "unit",
  covers: [
    "engine/src/debug/particleDebugger.ts",
    "engine/src/index.ts",
    "engine/src/particles/gpuSystem.ts",
    "engine/src/particles/gpuWorld.ts",
    "engine/src/particles/layout.ts",
    "engine/src/particles/simulation.ts",
    "engine/src/particles/world.ts",
    "engine/src/scene/scene.ts",
  ],
  desc: "Phase 21.7 — bounded CPU-particle samples and GPU-safe particle diagnostics",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { drawParticleDebug, GpuParticleWorld, inspectParticles, particleDebugLines, ParticleComponent, ParticleWorld, Scene } from "@forge/engine";

group("particle debugger", () => {
  test("samples bounded CPU particles and forwards particle, velocity, and emitter lines", () => {
    const scene = new Scene({ name: "particle-debug" });
    const cpu = new ParticleWorld({ name: "spray-cpu", capacity: 8 });
    cpu.simulation.emitter.rate = 6;
    cpu.simulation.emitter.lifeMin = 2;
    cpu.simulation.emitter.lifeMax = 2;
    cpu.simulation.emitter.position.x = 4;
    cpu.simulation.emitter.position.y = 5;
    cpu.simulation.emitter.cone.direction.x = 1;
    cpu.simulation.emitter.cone.direction.y = 0;
    cpu.simulation.emitter.cone.direction.z = 0;
    cpu.simulation.step(0.5);
    scene.addObject(cpu);
    scene.addObject(new GpuParticleWorld({ name: "smoke-gpu", capacity: 64 }));

    const snapshot = inspectParticles(scene);
    assert.deepEqual([snapshot.cpuWorlds, snapshot.gpuWorlds, snapshot.worldCount], [1, 1, 2]);
    const cpuView = snapshot.worlds.find((world) => world.backend === "cpu")!;
    const gpuView = snapshot.worlds.find((world) => world.backend === "gpu")!;
    assert.deepEqual([cpuView.capacity, cpuView.alive, cpuView.sampledParticles.length], [8, 3, 3]);
    assert.deepEqual(cpuView.emitter?.position, [4, 5, 0]);
    assert.deepEqual(cpuView.emitter?.direction, [1, 0, 0]);
    assert.equal(gpuView.ready, false);
    assert.equal(gpuView.alive, null, "GPU positions are not read back for inspection");

    const lines = particleDebugLines(scene, { maxParticleSamples: 1 });
    assert.equal(lines.filter((line) => line.kind === "particle").length, 3);
    assert.equal(lines.filter((line) => line.kind === "velocity").length, 1);
    assert.equal(lines.filter((line) => line.kind === "emitter").length, 3);
    assert.equal(lines.filter((line) => line.kind === "emissionDirection").length, 1);
    const forwarded: number[] = [];
    assert.equal(drawParticleDebug(scene, (_start, _end, color) => forwarded.push(color), { showVelocity: false }), 13);
    assert.equal(forwarded.length, 13);
  });

  test("includes ECS ParticleComponents alongside scene-object worlds", () => {
    const scene = new Scene({ name: "particle-components" });
    const entity = scene.createEntity("ecs-emitter");
    const component = new ParticleComponent();
    entity.add(component);
    const snapshot = inspectParticles(scene);
    assert.equal(snapshot.cpuWorlds, 1);
    assert.equal(snapshot.worlds[0]!.entityId, entity.id);
    assert.equal(snapshot.worlds[0]!.name, `ParticleComponent@${entity.id}`);
  });

  test("applies world and slot-scan bounds without mutating simulation state", () => {
    const scene = new Scene({ name: "particle-debug-limits" });
    const cpu = new ParticleWorld({ name: "limited", capacity: 32 });
    cpu.simulation.emitter.rate = 30;
    cpu.simulation.emitter.lifeMin = 4;
    cpu.simulation.emitter.lifeMax = 4;
    cpu.simulation.step(0.5);
    scene.addObject(cpu);
    scene.addObject(new ParticleWorld({ name: "second", capacity: 4 }));
    const aliveBefore = cpu.simulation.alive;
    const sample = inspectParticles(scene, { maxWorlds: 1, maxParticleSamples: 2, scanBudget: 4 });
    assert.deepEqual([sample.worldCount, sample.worlds.length, sample.truncatedWorlds], [2, 1, true]);
    assert.equal(sample.worlds[0]!.sampledParticles.length, 2);
    assert.equal(sample.worlds[0]!.scannedSlots, 2);
    assert.equal(sample.worlds[0]!.truncatedParticles, true);
    assert.equal(cpu.simulation.alive, aliveBefore);
    assert.equal(inspectParticles(scene, { filter: "missing" }).worldCount, 0);
  });
});

finish();
