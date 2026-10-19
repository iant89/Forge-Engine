/**
 * @suite audio:spatialAudio
 * @group unit
 * @covers engine/src/audio/spatial.ts
 * @covers engine/src/audio/source.ts
 * @covers engine/src/audio/system.ts
 * @covers engine/src/audio/index.ts
 * @desc Phase 20.1 spatial audio: engine (left-handed) positions reach Web Audio (right-handed) without mirroring left and right, CPU twins of the spec's panning, distance and cone, Doppler, air absorption and occlusion, the per-voice spatializer and the band-800 listener/emitter ECS system
 */

export const suite = {
  name: "audio:spatialAudio",
  group: "unit",
  covers: [
    "engine/src/audio/spatial.ts",
    "engine/src/audio/source.ts",
    "engine/src/audio/system.ts",
    "engine/src/audio/index.ts",
  ],
  desc: "Phase 20.1 spatial audio: engine (left-handed) positions reach Web Audio (right-handed) without mirroring left and right, CPU twins of the spec's panning, distance and cone, Doppler, air absorption and occlusion, the per-voice spatializer and the band-800 listener/emitter ECS system",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AudioEmitterComponent,
  AudioListenerComponent,
  AudioSystem,
  Clock,
  EntityWorld,
  Logger,
  OCCLUSION_CUTOFF,
  OCCLUSION_FLOOR,
  Mat4,
  Profiler,
  SpatialAudioSource,
  SpatialAudioSystem,
  SystemScratch,
  Transform,
  airAbsorptionCutoff,
  coneGain,
  distanceGain,
  dopplerRatio,
  equalPowerGains,
  listenerFromMatrix,
  pannerAzimuth,
  propagationDelay,
  setAudioListener,
  toAudioSpace,
  type SystemContext,
} from "@forge/engine";
import { fakeAudioContext, type FakeNode, type FakeParam } from "../support/fakeAudio.js";

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
const LISTENER = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };

group("handedness", () => {
  test("a camera looking down +Z hears +X on the right — converted, not mirrored", () => {
    assert.deepEqual(toAudioSpace({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: -3 });
    assert.ok(close(pannerAzimuth(LISTENER, { x: 5, y: 0, z: 0 }), 90), "right");
    assert.ok(close(pannerAzimuth(LISTENER, { x: -5, y: 0, z: 0 }), -90), "left");
    assert.ok(close(pannerAzimuth(LISTENER, { x: 0, y: 0, z: 5 }), 0), "ahead");
    const right = equalPowerGains(pannerAzimuth(LISTENER, { x: 5, y: 0, z: 1 }));
    assert.ok(right.right > 0.9 && right.left < 0.45);
    // Turn the camera to face +X (yaw +90°, +Z toward +X): what was ahead-right is now ahead.
    const turned = { position: { x: 0, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } };
    assert.ok(close(pannerAzimuth(turned, { x: 5, y: 0, z: 0 }), 0));
    assert.ok(close(pannerAzimuth(turned, { x: 0, y: 0, z: -5 }), 90), "−Z is to the right of a camera facing +X");
  });

  test("the listener and panner writers negate z; a camera's world matrix gives position, +Z forward and +Y up", () => {
    const { ctx } = fakeAudioContext();
    setAudioListener(ctx as unknown as BaseAudioContext, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 });
    const l = ctx.listener;
    assert.deepEqual([l.positionX.value, l.positionY.value, l.positionZ.value], [1, 2, -3]);
    assert.deepEqual([l.forwardX.value, l.forwardY.value, l.forwardZ.value], [0, 0, -1], "engine forward is Web Audio's default forward");
    // Yaw +90° about +Y at (4, 5, 6), column-major: X → (0, 0, −1), Y → +Y, Z → (1, 0, 0).
    const m = new Mat4([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 4, 5, 6, 1]);
    const pose = listenerFromMatrix(m.elements());
    assert.deepEqual([pose.position.x, pose.position.y, pose.position.z], [4, 5, 6]);
    assert.ok(close(pose.forward.x, 1, 1e-6) && close(pose.forward.z, 0, 1e-6), "yaw +90° turns +Z toward +X");
    assert.ok(close(pose.up.y, 1, 1e-6));
    // AudioSystem.setListener goes through the same writer.
    const audio = new AudioSystem({ context: ctx as unknown as AudioContext });
    audio.setListener({ position: { x: 0, y: 0, z: 7 }, forward: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } });
    assert.equal(l.positionZ.value, -7);
  });
});

group("spec twins and propagation", () => {
  test("distance models follow the Web Audio formulas", () => {
    assert.equal(distanceGain("inverse", 1, 1, 100, 1), 1);
    assert.ok(close(distanceGain("inverse", 10, 1, 100, 1), 0.1));
    assert.ok(close(distanceGain("inverse", 10, 2, 100, 0.5), 2 / (2 + 0.5 * 8)));
    assert.ok(close(distanceGain("linear", 50, 0, 100, 1), 0.5));
    assert.equal(distanceGain("linear", 500, 1, 100, 1), 0);
    assert.ok(close(distanceGain("exponential", 4, 1, 100, 2), 1 / 16));
    assert.equal(distanceGain("inverse", 0.2, 1), 1, "inside the reference distance is full level");
  });

  test("cone: full inside, outer gain outside, linear between", () => {
    const at = { x: 0, y: 0, z: 0 }, fwd = { x: 0, y: 0, z: 1 };
    assert.equal(coneGain(at, fwd, { x: 0, y: 0, z: 5 }, 60, 180, 0.2), 1);
    assert.ok(close(coneGain(at, fwd, { x: 0, y: 0, z: -5 }, 60, 180, 0.2), 0.2));
    const side = coneGain(at, fwd, { x: 5, y: 0, z: 0 }, 60, 240, 0.2); // 90°: halfway from 30° to 120°
    assert.ok(close(side, 1 - (60 / 90) * 0.8));
    assert.equal(coneGain(at, fwd, { x: 0, y: 0, z: -5 }), 1, "omnidirectional by default");
  });

  test("Doppler raises an approaching source and lowers a receding one; air absorption darkens distance; sound takes time", () => {
    const src = { x: 0, y: 0, z: 0 }, ear = { x: 100, y: 0, z: 0 }, still = { x: 0, y: 0, z: 0 };
    const toward = dopplerRatio(src, { x: 30, y: 0, z: 0 }, ear, still);
    assert.ok(close(toward, 343 / (343 - 30)));
    assert.ok(close(dopplerRatio(src, { x: -30, y: 0, z: 0 }, ear, still), 343 / 373));
    assert.ok(close(dopplerRatio(src, still, ear, { x: -20, y: 0, z: 0 }), 363 / 343), "a listener moving toward the source");
    assert.equal(dopplerRatio(src, { x: 0, y: 0, z: 30 }, ear, still), 1, "crossing, not approaching");
    assert.ok(close(dopplerRatio(src, { x: 30, y: 0, z: 0 }, ear, still, 343, 0.5), 343 / (343 - 15)));
    assert.equal(dopplerRatio(src, { x: 1000, y: 0, z: 0 }, ear, still), 4, "clamped near the sound barrier");
    assert.equal(airAbsorptionCutoff(0), 20_000);
    assert.ok(close(airAbsorptionCutoff(350), 10_000));
    assert.equal(airAbsorptionCutoff(10_000), 1500);
    assert.ok(close(propagationDelay(343), 1));
  });
});

group("voices", () => {
  test("a spatial voice chains gain → low-pass → panner, at the converted position", () => {
    const { ctx, nodes } = fakeAudioContext();
    const audio = new AudioSystem({ context: ctx as unknown as AudioContext });
    const built = nodes.length;
    const voice = audio.play(ctx.createBuffer(1, 800, 8000) as unknown as AudioBuffer, { spatial: true, position: { x: 2, y: 0, z: 5 } });
    const made = nodes.slice(built);
    const panner = made.find((n) => n.kind === "panner")!;
    const filter = made.find((n) => n.kind === "filter")!;
    assert.equal((panner.positionZ as FakeParam).value, -5);
    assert.equal(filter.type, "lowpass");
    assert.ok((filter.connected as FakeNode[]).includes(panner));
    assert.ok((voice.gain as unknown as FakeNode).connected.includes(filter));
    const flat = audio.play(ctx.createBuffer(1, 800, 8000) as unknown as AudioBuffer);
    assert.equal(flat.filter, undefined);
    assert.equal(flat.panner, undefined);
  });

  test("SpatialAudioSource: velocity from motion drives Doppler; distance drives the cutoff; occlusion settles smoothly", () => {
    const { ctx } = fakeAudioContext();
    const audio = new AudioSystem({ context: ctx as unknown as AudioContext });
    const voice = audio.play(ctx.createBuffer(1, 800, 8000) as unknown as AudioBuffer, { spatial: true, loop: true });
    const s = new SpatialAudioSource(voice, {}, 1.5);
    const ear = { x: 0, y: 0, z: 0 };
    s.update(1 / 60, { x: 0, y: 0, z: 200 }, ear);
    assert.equal(s.doppler, 1, "no velocity on the first frame");
    s.update(1 / 60, { x: 0, y: 0, z: 199.5 }, ear); // 30 m/s toward the listener
    assert.ok(close(s.velocity.z, -30, 1e-6));
    assert.ok(close(s.doppler, 343 / 313, 1e-6));
    const rate = voice.source.playbackRate as unknown as FakeParam;
    assert.ok(close(rate.targets.at(-1)!, 1.5 * s.doppler, 1e-9), "base rate × Doppler");
    assert.ok(close(s.cutoff, airAbsorptionCutoff(199.5), 1e-6));
    const cutoffs: number[] = [];
    for (let i = 0; i < 60; i++) {
      s.update(1 / 60, { x: 0, y: 0, z: 199.5 }, ear, undefined, 1);
      cutoffs.push(s.cutoff);
    }
    assert.ok(s.occlusion > 0.99, `occlusion ${s.occlusion}`);
    for (let i = 1; i < cutoffs.length; i++) assert.ok(cutoffs[i]! <= cutoffs[i - 1]! + 1e-9, "darkens monotonically, no step");
    assert.ok(close(s.cutoff, OCCLUSION_CUTOFF, 5), "fully occluded → the voice's occluded cutoff");
    const gain = (voice.gain as unknown as { gain: FakeParam }).gain;
    assert.ok(close(gain.targets.at(-1)!, OCCLUSION_FLOOR, 0.01), "and its occluded gain floor");
    const off = new SpatialAudioSource(audio.play(ctx.createBuffer(1, 800, 8000) as unknown as AudioBuffer, { spatial: true }), { doppler: 0, airAbsorption: 0 });
    off.update(1 / 60, { x: 0, y: 0, z: 10 }, ear);
    off.update(1 / 60, { x: 0, y: 0, z: 0 }, ear);
    assert.equal(off.doppler, 1);
    assert.equal(off.cutoff, 24_000, "no air absorption: open at Nyquist");
  });
});

function context(world: EntityWorld, dt = 1 / 60): SystemContext {
  return {
    world,
    clock: new Clock(),
    dt,
    fixedDt: dt,
    fixedSteps: 1,
    alpha: 0,
    elapsed: 0,
    frame: 1,
    logger: new Logger(),
    profiler: new Profiler(),
    services: { get: () => undefined, engineConfig: {} },
    scratch: new SystemScratch(),
  };
}

group("ECS", () => {
  test("band 800: the listener follows its entity, an emitter starts once its clip is ready, follows its entity and is occluded on request", () => {
    const { ctx, nodes } = fakeAudioContext();
    const audio = new AudioSystem({ context: ctx as unknown as AudioContext });
    const world = new EntityWorld();
    const ears = world.createEntity("camera");
    ears.add(new Transform()).setPosition(0, 1.7, -4);
    ears.add(new AudioListenerComponent());
    let clip: ReturnType<typeof ctx.createBuffer> | null = null;
    const car = world.createEntity("car");
    const carT = car.add(new Transform());
    carT.setPosition(3, 0, 10);
    const emitter = car.add(new AudioEmitterComponent(() => (clip ? { buffer: clip as unknown as AudioBuffer, duration: 0.1, channels: 1, sampleRate: 8000 } : null), { loop: true, volume: 0.8 }));
    let walls = 0;
    emitter.occlusion = () => (walls++, 1);
    const system = new SpatialAudioSystem(audio);
    assert.equal(system.order, 800);
    world.registerSystem(system);
    const frame = (): void => {
      world.updateTransforms(new SystemScratch().changedTransformSlots);
      world.runSystems(context(world));
    };
    frame();
    assert.equal(emitter.playing, null, "no clip yet");
    assert.equal(ctx.listener.positionZ.value, 4, "listener at engine z = −4");
    clip = ctx.createBuffer(1, 800, 8000);
    frame();
    const voice = emitter.playing!;
    assert.ok(voice);
    assert.equal(system.active, 1);
    assert.ok(walls >= 1);
    carT.setPosition(3, 0, 11);
    frame();
    const panner = voice.panner as unknown as FakeNode;
    assert.equal((panner.positionZ as FakeParam).value, -11);
    const before = nodes.length;
    frame();
    assert.equal(nodes.length, before, "a steady frame creates no nodes");
    world.removeComponent(car.id, AudioEmitterComponent);
    assert.equal(emitter.playing, null, "detaching stops the voice");
    ctx.state = "suspended";
    clip = ctx.createBuffer(1, 800, 8000);
    const parked = world.createEntity("parked");
    parked.add(new Transform());
    const quiet = parked.add(new AudioEmitterComponent(() => ({ buffer: clip as unknown as AudioBuffer, duration: 0.1, channels: 1, sampleRate: 8000 })));
    frame();
    assert.equal(quiet.playing, null, "nothing starts before the context runs");
  });
});

finish();
