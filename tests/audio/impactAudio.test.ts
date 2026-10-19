/**
 * @suite audio:impactAudio
 * @group integration
 * @covers engine/src/audio/impact.ts
 * @covers engine/src/audio/particles.ts
 * @covers engine/src/audio/index.ts
 * @covers engine/src/physics/world.ts
 * @desc Phase 20.8 particle / impact audio: the physics contact listener reports hits and slides without changing the simulation; impacts, scrapes, materials and sizes come from real collisions; particle births, flow and ground hits come from a stepping ParticleSimulation; the WebAudio graphs play and cap them
 */

export const suite = {
  name: "audio:impactAudio",
  group: "integration",
  covers: [
    "engine/src/audio/impact.ts",
    "engine/src/audio/particles.ts",
    "engine/src/audio/index.ts",
    "engine/src/physics/world.ts",
  ],
  desc: "Phase 20.8 particle / impact audio: the physics contact listener reports hits and slides without changing the simulation; impacts, scrapes, materials and sizes come from real collisions; particle births, flow and ground hits come from a stepping ParticleSimulation; the WebAudio graphs play and cap them",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  BoxShape,
  CapsuleShape,
  IMPACT_MATERIALS,
  IMPACT_MATERIAL_SOUND,
  ImpactSoundAnalyzer,
  ImpactSoundscape,
  ParticleSimulation,
  ParticleSoundAnalyzer,
  ParticleSoundscape,
  PhysicsWorld,
  PlaneShape,
  RigidBody,
  SphereShape,
  Vec3,
  impactMaterial,
  impactSize,
  impactVoice,
  particleSoundLevels,
  scrapeVoice,
  setImpactMaterial,
  type ContactReport,
  type ImpactEvent,
} from "@forge/engine";
import { end, fakeAudioContext, type FakeNode, type FakeParam } from "../support/fakeAudio.js";

const DT = 1 / 60;

function ground(world: PhysicsWorld): RigidBody {
  return world.addBody(new RigidBody({ type: "static", shape: new PlaneShape(new Vec3(0, 1, 0), 0) }));
}

function box(world: PhysicsWorld, y: number, mass = 20, extra: Partial<ConstructorParameters<typeof RigidBody>[0]> = {}): RigidBody {
  return world.addBody(new RigidBody({ shape: new BoxShape(0.4, 0.4, 0.4), mass, position: { x: 0, y, z: 0 }, restitution: 0.3, ...extra }));
}

/** Step a world with an analyzer, one physics step per frame, collecting every frame's impacts. */
function run(world: PhysicsWorld, frames: number, analyzer = new ImpactSoundAnalyzer(world)) {
  const events: Array<ImpactEvent & { frame: number }> = [];
  const scrapes: Array<{ frame: number; speed: number; level: number }> = [];
  for (let f = 0; f < frames; f++) {
    world.stepOnce(DT);
    analyzer.update();
    for (const e of analyzer.events) events.push({ ...e, frame: f });
    for (const s of analyzer.scrapes) scrapes.push({ frame: f, speed: s.speed, level: s.level });
  }
  return { analyzer, events, scrapes };
}

group("physics contact listener", () => {
  test("none by default; a listener only reads — a pile of bodies ends in the identical snapshot with and without one", () => {
    const build = (): PhysicsWorld => {
      const w = new PhysicsWorld({ fixedDt: DT });
      ground(w);
      for (let i = 0; i < 6; i++) box(w, 0.5 + i * 0.9, 10 + i, { position: { x: (i % 2) * 0.3, y: 0.5 + i * 0.9, z: (i % 3) * 0.2 } });
      w.addBody(new RigidBody({ shape: new SphereShape(0.3), mass: 5, position: { x: 2, y: 3, z: 0 }, linearVelocity: { x: -2, y: 0, z: 0 } }));
      return w;
    };
    const quiet = build();
    assert.equal(quiet.contactListener, null);
    const heard = build();
    let reports = 0;
    heard.contactListener = () => reports++;
    const analyzer = new ImpactSoundAnalyzer(heard);
    for (let i = 0; i < 240; i++) {
      quiet.stepOnce(DT);
      heard.stepOnce(DT);
      analyzer.update();
    }
    assert.ok(reports > 100, `reports ${reports}`);
    assert.equal(JSON.stringify(heard.snapshot()), JSON.stringify(quiet.snapshot()));
    assert.ok(!("contactListener" in heard.snapshot().world), "the listener is not world state");
  });

  test("a dropped box reports its approach speed (≈ √(2gh)), the contact point and normal, and the solver's impulse", () => {
    const w = new PhysicsWorld({ fixedDt: DT });
    const floor = ground(w);
    const crate = box(w, 0.4 + 2);
    const first: ContactReport[] = [];
    w.contactListener = (r) => { if (first.length === 0) first.push({ ...r }); };
    for (let i = 0; i < 60 && first.length === 0; i++) w.stepOnce(DT);
    const r = first[0]!;
    assert.ok(r.bodyA === floor && r.bodyB === crate);
    const expected = Math.sqrt(2 * 9.81 * 2);
    assert.ok(Math.abs(r.closingSpeed - expected) < expected * 0.12, `closing ${r.closingSpeed} vs ${expected}`);
    assert.deepEqual([r.nx, r.ny, r.nz], [0, 1, 0]);
    assert.ok(Math.abs(r.y) < 0.1 && r.contacts >= 1 && r.dt === DT);
    // The impulse stops (most of) the 20 kg box: ≈ m·v·(1 + e).
    assert.ok(r.impulse > 20 * expected * 0.8, `impulse ${r.impulse}`);
  });
});

group("impacts", () => {
  test("a box at rest makes no impacts; a drop makes one, louder from higher and for a heavier box", () => {
    const rest = new PhysicsWorld({ fixedDt: DT });
    ground(rest);
    box(rest, 0.4);
    assert.equal(run(rest, 180).events.length, 0, "resting contact is not a hit");
    const drop = (h: number, mass: number): ImpactEvent => {
      const w = new PhysicsWorld({ fixedDt: DT });
      ground(w);
      box(w, 0.4 + h, mass);
      return run(w, 120).events[0]!;
    };
    const low = drop(0.3, 20), high = drop(2, 20), light = drop(2, 2);
    assert.ok(low && high && light);
    assert.ok(high.strength > low.strength && high.speed > low.speed);
    assert.ok(high.strength > light.strength, "the same fall with a tenth of the mass is quieter");
    assert.ok(Math.abs(high.energy - 0.5 * 20 * high.speed * high.speed) < 1e-6, "½·m·v² against static ground");
    assert.equal(high.materialA, "dirt", "a plane is ground");
    assert.equal(high.materialB, "wood", "an untagged dynamic body");
    assert.equal(high.sizeA, Infinity);
    assert.ok(Math.abs(high.sizeB - 0.8) < 1e-9);
  });

  test("a bounce is a second hit; the cooldown keeps one hit per pair per contact", () => {
    const w = new PhysicsWorld({ fixedDt: DT });
    ground(w);
    w.addBody(new RigidBody({ shape: new SphereShape(0.3), mass: 4, position: { x: 0, y: 2.3, z: 0 }, restitution: 0.6 }));
    const { events } = run(w, 240);
    assert.ok(events.length >= 2, `hits ${events.map((e) => `${e.frame}:${e.speed.toFixed(2)}`).join(" ")}`);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i]!.frame - events[i - 1]!.frame >= 5, "no chatter inside the cooldown");
      assert.ok(events[i]!.speed < events[i - 1]!.speed, "each bounce is slower");
    }
  });

  test("a pile landing at once is capped per frame, loudest first, and the drop is counted", () => {
    const w = new PhysicsWorld({ fixedDt: DT });
    ground(w);
    for (let i = 0; i < 30; i++) {
      w.addBody(new RigidBody({ shape: new SphereShape(0.2), mass: 1 + i, position: { x: (i % 6) * 1.2, y: 1.2, z: Math.floor(i / 6) * 1.2 } }));
    }
    const analyzer = new ImpactSoundAnalyzer(w, { maxEventsPerFrame: 8 });
    let maxFrame = 0;
    for (let f = 0; f < 60; f++) {
      w.stepOnce(DT);
      analyzer.update();
      maxFrame = Math.max(maxFrame, analyzer.events.length);
      for (let i = 1; i < analyzer.events.length; i++) assert.ok(analyzer.events[i - 1]!.strength >= analyzer.events[i]!.strength);
    }
    assert.equal(maxFrame, 8);
    assert.ok(analyzer.dropped >= 22, `30 spheres land in the same step (dropped ${analyzer.dropped})`);
  });
});

group("scrapes", () => {
  test("a box sliding to a stop scrapes at its own speed and falls silent when it stops; it is not an impact", () => {
    const w = new PhysicsWorld({ fixedDt: DT });
    ground(w);
    const crate = w.addBody(new RigidBody({ shape: new BoxShape(0.4, 0.4, 0.4), mass: 20, position: { x: 0, y: 0.4, z: 0 }, linearVelocity: { x: 6, y: 0, z: 0 }, friction: 0.5 }));
    const analyzer = new ImpactSoundAnalyzer(w);
    const samples: Array<{ v: number; speed: number; level: number }> = [];
    let impacts = 0;
    for (let f = 0; f < 120; f++) {
      w.stepOnce(DT);
      analyzer.update();
      impacts += analyzer.events.length;
      const s = analyzer.scrapes[0];
      samples.push({ v: crate.linearVelocity.x, speed: s?.speed ?? 0, level: s?.level ?? 0 });
    }
    assert.equal(impacts, 0);
    // The first frames load the contact (the box settles onto the plane) before it reads as loaded.
    const sliding = samples.slice(3).filter((s) => s.v > 0.5);
    assert.ok(sliding.length > 30);
    for (const s of sliding) assert.ok(Math.abs(s.speed - s.v) < 0.1, `scrape ${s.speed} vs body ${s.v}`);
    for (let i = 10; i < sliding.length; i++) assert.ok(sliding[i]!.level <= sliding[i - 1]!.level + 1e-9, "quieter as it slows");
    assert.ok(samples.slice(-20).every((s) => s.level === 0), "silent once stopped");
  });
});

group("materials and voices", () => {
  test("material from the callback, then the tag, then the shape; sizes from the shape", () => {
    const w = new PhysicsWorld({ fixedDt: DT });
    const floor = ground(w);
    const rock = w.addBody(new RigidBody({ type: "static", shape: new BoxShape(1, 1, 1) }));
    const crate = box(w, 3);
    const pole = w.addBody(new RigidBody({ shape: new CapsuleShape(0.1, 0.9), mass: 2 }));
    const a = new ImpactSoundAnalyzer(w);
    assert.equal(a.materialFor(floor), "dirt");
    assert.equal(a.materialFor(rock), "rock");
    assert.equal(a.materialFor(crate), "wood");
    setImpactMaterial(crate, "metal");
    assert.equal(impactMaterial(crate), "metal");
    assert.equal(a.materialFor(crate), "metal");
    assert.equal(new ImpactSoundAnalyzer(w, { materialOf: (b) => (b === crate ? "glass" : undefined) }).materialFor(crate), "glass");
    setImpactMaterial(crate, undefined);
    assert.equal(a.materialFor(crate), "wood");
    assert.ok(!JSON.stringify(w.snapshot()).includes("metal"), "the tag is not body state");
    assert.ok(Math.abs(impactSize(crate) - 0.8) < 1e-9);
    assert.ok(Math.abs(impactSize(pole) - 2) < 1e-9, "capsule tip to tip");
    assert.equal(impactSize(floor), Infinity);
    for (const m of IMPACT_MATERIALS) assert.ok(IMPACT_MATERIAL_SOUND[m], m);
  });

  test("voices: metal rings longer than wood, ground does not ring, small objects ring higher, harder hits are brighter, soft ground thuds", () => {
    const hit = (p: Partial<ImpactEvent>): ImpactEvent => ({ x: 0, y: 0, z: 0, strength: 0.6, speed: 4, energy: 100, materialA: "dirt", materialB: "wood", sizeA: Infinity, sizeB: 0.8, bodyA: 1, bodyB: 2, ...p });
    const wood = impactVoice(hit({})), metal = impactVoice(hit({ materialB: "metal" }));
    assert.equal(wood.modes.length, IMPACT_MATERIAL_SOUND.wood.modes.length, "only the box rings");
    assert.ok(metal.modes[0]!.decay > wood.modes[0]!.decay * 4);
    const small = impactVoice(hit({ sizeB: 0.2 }));
    assert.ok(small.modes[0]!.frequency > wood.modes[0]!.frequency * 1.8);
    const soft = impactVoice(hit({ strength: 0.1 })), hard = impactVoice(hit({ strength: 1 }));
    assert.ok(hard.gain > soft.gain && hard.transientFrequency > soft.transientFrequency);
    assert.ok(hard.modes[2]!.gain / hard.modes[0]!.gain > soft.modes[2]!.gain / soft.modes[0]!.gain, "upper modes come up");
    const onRock = impactVoice(hit({ materialA: "rock" })), onSnow = impactVoice(hit({ materialA: "snow" }));
    assert.ok(onSnow.transientFrequency < onRock.transientFrequency);
    const both = impactVoice(hit({ materialA: "metal", sizeA: 1.5 }));
    assert.equal(both.modes.length, IMPACT_MATERIAL_SOUND.metal.modes.length + IMPACT_MATERIAL_SOUND.wood.modes.length, "two bodies both ring");
    const scrape = (speed: number) => scrapeVoice({ key: 1, x: 0, y: 0, z: 0, speed, level: 0.8, materialA: "dirt", materialB: "metal" });
    assert.ok(scrape(4).frequency > scrape(1).frequency && scrape(1).gain > 0);
  });

  test("attach chains an existing listener and detach restores it", () => {
    const w = new PhysicsWorld({ fixedDt: DT });
    ground(w);
    box(w, 1.5);
    let mine = 0;
    const own = (): void => { mine++; };
    w.contactListener = own;
    const a = new ImpactSoundAnalyzer(w);
    let heard = 0;
    for (let f = 0; f < 60; f++) {
      w.stepOnce(DT);
      heard += a.update().events.length;
    }
    assert.ok(mine > 0 && heard >= 1, `mine ${mine} heard ${heard}`);
    a.dispose();
    assert.equal(w.contactListener, own);
  });
});

group("particles", () => {
  const shower = (seed = 3): ParticleSimulation => {
    const sim = new ParticleSimulation({ capacity: 3000, seed });
    sim.emitter.rate = 600;
    sim.emitter.position = { x: 0, y: 1, z: 0 };
    return sim;
  };

  test("births, flow and ground hits follow the simulation; hits land at the fall speed", () => {
    const sim = shower();
    const a = new ParticleSoundAnalyzer(sim, { kind: "debris" });
    const states = [];
    for (let f = 0; f < 150; f++) {
      sim.step(DT);
      states.push({ ...a.update(DT) });
    }
    assert.ok(states.every((s) => s.births === 10), "600/s at 60 Hz");
    assert.ok(Math.abs(states[0]!.birthRate - 600) < 1e-6);
    assert.equal(states[149]!.alive, sim.alive);
    const firstHit = states.findIndex((s) => s.hits > 0);
    // Launched up at 5–8 m/s from 1 m: nothing lands for ~1 s.
    assert.ok(firstHit > 45 && firstHit < 120, `first hit frame ${firstHit}`);
    const landing = states.slice(firstHit).filter((s) => s.hits > 0);
    assert.ok(landing.length > 10);
    for (const s of landing) {
      assert.ok(s.hitSpeed > 4 && s.hitSpeed < 14, `hit speed ${s.hitSpeed}`);
      assert.ok(Math.abs(s.hitY) < 1e-6, "hits are placed on the ground");
    }
    const quiet = particleSoundLevels(states[5]!), busy = particleSoundLevels(states[140]!);
    assert.ok(busy.hissGain > quiet.hissGain);
    assert.equal(quiet.grains, 0);
    assert.ok(busy.grains > 0 && busy.grainGain > 0);
    assert.ok(particleSoundLevels({ ...states[140]!, hits: 400 }).grains === 12, "grains are capped");
  });

  test("raised ground is hit sooner; a burst of births is an event; reading never changes the simulation", () => {
    const flat = shower(), raised = shower();
    const af = new ParticleSoundAnalyzer(flat), ar = new ParticleSoundAnalyzer(raised, { groundAt: () => 0.8 });
    let ff = -1, fr = -1;
    for (let f = 0; f < 150; f++) {
      flat.step(DT);
      raised.step(DT);
      if (ff < 0 && af.update(DT).hits > 0) ff = f;
      if (fr < 0 && ar.update(DT).hits > 0) fr = f;
    }
    assert.ok(fr >= 0 && fr < ff, `${fr} < ${ff}`);
    const control = shower();
    for (let f = 0; f < 150; f++) control.step(DT);
    assert.deepEqual(Array.from(raised.state), Array.from(control.state), "the analyzed run matches an unobserved one");

    const sim = new ParticleSimulation({ capacity: 500, seed: 9 });
    sim.emitter.rate = 0;
    const a = new ParticleSoundAnalyzer(sim, { kind: "sparks", burstBirths: 50 });
    sim.step(DT);
    assert.equal(a.update(DT).burst, false);
    sim.emitter.rate = 200 / DT;
    sim.step(DT);
    const s = a.update(DT);
    assert.ok(s.burst && s.births === 200);
    assert.ok(particleSoundLevels(s).burstGain > 0.5);
    assert.equal(s.hits, 0, "particles born this frame have not fallen");
  });
});

group("soundscapes", () => {
  const hit: ImpactEvent = { x: 1, y: 0, z: 2, strength: 0.8, speed: 5, energy: 300, materialA: "dirt", materialB: "metal", sizeA: Infinity, sizeB: 0.6, bodyA: 1, bodyB: 2 };

  test("impacts: one oscillator per mode plus a transient, positioned, capped, and released when they end", () => {
    const { ctx, nodes } = fakeAudioContext();
    const scape = new ImpactSoundscape(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { maxVoices: 2, scrapeVoices: 2 });
    const built = nodes.length;
    scape.play([hit]);
    const created = nodes.slice(built);
    const oscillators = created.filter((n) => n.kind === "oscillator");
    assert.equal(oscillators.length, IMPACT_MATERIAL_SOUND.metal.modes.length);
    assert.equal(created.filter((n) => n.kind === "buffer").length, 1);
    const panner = created.find((n) => n.kind === "panner")!;
    // Engine z = 2 is Web Audio z = −2 (left- vs right-handed; spatial.ts).
    assert.deepEqual([(panner.positionX as FakeParam).value, (panner.positionZ as FakeParam).value], [1, -2]);
    assert.equal(scape.activeVoices, 1);
    scape.play([hit, hit]);
    assert.equal(scape.activeVoices, 2);
    assert.equal(scape.skipped, 1);
    for (const n of nodes.slice(built)) if (n.kind === "oscillator" || n.kind === "buffer") end(n);
    assert.equal(scape.activeVoices, 0, "every voice released after its parts ended");

    scape.setScrapes([{ key: 1, x: 0, y: 0, z: 0, speed: 3, level: 0.7, materialA: "dirt", materialB: "metal" }]);
    const slotGains = nodes.slice(0, built).filter((n) => n.kind === "gain" && (n.gain as FakeParam).targets.length > 0).map((n) => (n.gain as FakeParam).targets.at(-1)!);
    assert.ok(slotGains.some((g) => g > 0) && slotGains.includes(0), "one slot sounds, the other fades");
    scape.dispose();
    const after = nodes.length;
    scape.play([hit]);
    assert.equal(nodes.length, after);
  });

  test("particles: the hiss follows the levels and each hit is one grain", () => {
    const { ctx, nodes } = fakeAudioContext();
    const scape = new ParticleSoundscape(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode);
    const built = nodes.length;
    const state = { kind: "debris" as const, births: 10, birthRate: 600, alive: 500, meanSpeed: 6, x: 0, y: 1, z: 0, hits: 5, hitSpeed: 7, hitX: 0.5, hitY: 0, hitZ: -1, burst: false };
    const l = scape.set(state, DT);
    assert.equal(l.grains, 5);
    assert.equal(nodes.slice(built).filter((n: FakeNode) => n.kind === "buffer").length, 5);
    const hiss = nodes.slice(0, built).filter((n) => n.kind === "gain").map((n) => (n.gain as FakeParam).targets.at(-1));
    assert.ok(hiss.includes(l.hissGain));
    scape.dispose();
  });
});

finish();
