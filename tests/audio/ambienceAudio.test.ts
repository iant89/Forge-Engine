/**
 * @suite audio:ambienceAudio
 * @group unit
 * @covers engine/src/audio/ambience.ts
 * @covers engine/src/environment/soundInput.ts
 * @covers engine/src/audio/index.ts
 * @desc Phase 20.5/20.6 environmental and weather audio: the weather and the ground's memory of it (wind, rain on wet ground and puddles, snowfall vs snow cover), the sun and the temperature (birds with a dawn chorus, crickets at Dolbear's rate) and the listener's situation (facing, underwater, indoors, reflective surroundings) drive the ambience; the soundscape applies it, schedules birds and swaps quantised reverb impulses
 */

export const suite = {
  name: "audio:ambienceAudio",
  group: "unit",
  covers: [
    "engine/src/audio/ambience.ts",
    "engine/src/environment/soundInput.ts",
    "engine/src/audio/index.ts",
  ],
  desc: "Phase 20.5/20.6 environmental and weather audio: the weather and the ground's memory of it (wind, rain on wet ground and puddles, snowfall vs snow cover), the sun and the temperature (birds with a dawn chorus, crickets at Dolbear's rate) and the listener's situation (facing, underwater, indoors, reflective surroundings) drive the ambience; the soundscape applies it, schedules birds and swaps quantised reverb impulses",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  EnvironmentSoundscape,
  WEATHER_PRESETS,
  ambienceLevels,
  ambienceSoundInput,
  birdActivity,
  createAmbienceInput,
  createReverbImpulse,
  createSurfaceWeather,
  cricketChirpRate,
  environmentReverb,
  stepSurfaceWeather,
  type AmbienceInput,
  type WeatherState,
} from "@forge/engine";
import { end, fakeAudioContext, type FakeNode, type FakeParam } from "../support/fakeAudio.js";

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
const level = (overrides: Partial<AmbienceInput>) => ambienceLevels(createAmbienceInput(overrides));

group("from the simulation", () => {
  test("the adapter splits precipitation into rain and snowfall by temperature and carries the ground state", () => {
    const warm: WeatherState = { ...WEATHER_PRESETS.rain, temperatureC: 12 };
    const cold: WeatherState = { ...WEATHER_PRESETS.rain, temperatureC: -4 };
    const surface = { wetness: 0.6, puddles: 0.2, snow: 0.9 };
    const a = ambienceSoundInput(warm, surface, { sunElevationDeg: -10, listenerYaw: 1, underwater: true, enclosure: 2, surf: 0.5 });
    assert.ok(close(a.rain, warm.precipitation01) && a.snowfall === 0);
    assert.deepEqual([a.wetness, a.puddles, a.snowCover], [0.6, 0.2, 0.9]);
    assert.deepEqual([a.sunElevationDeg, a.listenerYaw, a.underwater, a.enclosure, a.surf], [-10, 1, true, 1, 0.5], "context passes through, clamped");
    const b = ambienceSoundInput(cold, createSurfaceWeather());
    assert.ok(b.rain === 0 && close(b.snowfall, cold.precipitation01));
    const typed: AmbienceInput = b; // the environment's plain data is the audio input
    assert.equal(typed.sunElevationDeg, 30);
  });

  test("rain falling on ground the weather has wetted and flooded sounds louder and brighter; on snow cover, duller", () => {
    const storm = WEATHER_PRESETS.storm;
    const dry = ambienceLevels(ambienceSoundInput(storm, createSurfaceWeather()));
    const ground = createSurfaceWeather();
    for (let t = 0; t < 1800; t++) stepSurfaceWeather(ground, storm, 1); // 30 min of storm
    assert.ok(ground.wetness > 0.9 && ground.puddles > 0.3, JSON.stringify(ground));
    const soaked = ambienceLevels(ambienceSoundInput(storm, ground));
    assert.ok(soaked.rainGain > dry.rainGain && soaked.rainFrequency > dry.rainFrequency + 500, `${dry.rainFrequency} → ${soaked.rainFrequency}`);
    const onSnow = ambienceLevels(ambienceSoundInput(storm, { wetness: 0, puddles: 0, snow: 1 }));
    assert.ok(onSnow.rainGain < dry.rainGain && onSnow.rainFrequency < dry.rainFrequency);
    // Falling snow makes no rain noise at all.
    const blizzard = ambienceLevels(ambienceSoundInput({ ...storm, temperatureC: -8 }, createSurfaceWeather()));
    assert.equal(blizzard.rainGain, 0);
    assert.ok(blizzard.windGain > dry.windGain * 0.99, "the wind still blows");
  });
});

group("weather (20.6)", () => {
  test("wind rises with speed and gusts, and is heard from the side it comes from", () => {
    const calm = level({ windSpeed: 2, gust: 0.1 }), gale = level({ windSpeed: 30, gust: 0.8 });
    assert.ok(gale.windGain > calm.windGain * 4 && gale.windFrequency > calm.windFrequency && gale.howlGain > calm.howlGain * 10);
    // Wind blowing toward −X (direction −90°) comes from +X: the right of a listener facing +Z.
    const fromRight = level({ windSpeed: 15, windDirection: -Math.PI / 2, listenerYaw: 0 });
    assert.ok(fromRight.windPan > 0.6, `pan ${fromRight.windPan}`);
    assert.ok(close(level({ windSpeed: 15, windDirection: -Math.PI / 2, listenerYaw: Math.PI }).windPan, -fromRight.windPan, 1e-9), "turn around: it comes from the left");
    assert.ok(Math.abs(level({ windSpeed: 15, windDirection: Math.PI, listenerYaw: 0 }).windPan) < 1e-9, "a headwind is centred");
  });

  test("snow cover and walls muffle the outdoor bed; under a roof rain becomes drumming; underwater only a rumble is left", () => {
    const open = level({ rain: 0.8 });
    const snowy = level({ rain: 0.8, snowCover: 1 });
    assert.ok(snowy.outdoorCutoff < open.outdoorCutoff * 0.5 && snowy.outdoorGain < open.outdoorGain);
    const inside = level({ rain: 0.8, enclosure: 1 });
    assert.ok(inside.outdoorCutoff < 1500 && inside.rainGain < open.rainGain * 0.4 && inside.roofGain > 0.4);
    assert.equal(open.roofGain, 0);
    const under = level({ rain: 0.8, sunElevationDeg: 10, underwater: true });
    assert.deepEqual([under.outdoorCutoff, under.birdGain, under.insectGain, under.roofGain], [350, 0, 0, 0]);
    assert.ok(under.underwaterGain > 0);
    assert.ok(level({ storm: 1, surf: 1 }).surfGain > level({ storm: 0, surf: 1 }).surfGain);
  });
});

group("environment (20.5)", () => {
  test("birds: silent at night, a dawn chorus, steady by day — and quiet in rain, gales and frost", () => {
    assert.equal(birdActivity(-12), 0);
    const dawn = birdActivity(4), noon = birdActivity(60), dusk = birdActivity(-3);
    assert.ok(dawn > noon && noon > 0.5 && dusk > 0 && dusk < dawn, `${dusk} ${dawn} ${noon}`);
    const fine = level({ sunElevationDeg: 4, temperatureC: 12, windSpeed: 2 });
    assert.ok(fine.birdRate > 1 && fine.birdGain > 0.3);
    assert.equal(level({ sunElevationDeg: 4, rain: 0.8 }).birdRate, 0);
    assert.equal(level({ sunElevationDeg: 4, windSpeed: 25 }).birdRate, 0);
    assert.equal(level({ sunElevationDeg: 4, temperatureC: -10 }).birdRate, 0);
  });

  test("crickets: warm nights only, chirping at Dolbear's rate for the temperature", () => {
    assert.ok(close(cricketChirpRate(20), 170 / 60));
    assert.ok(cricketChirpRate(28) > cricketChirpRate(15));
    assert.equal(cricketChirpRate(6), 0);
    const night = level({ sunElevationDeg: -15, temperatureC: 22 });
    assert.ok(night.insectGain > 0.1 && close(night.insectChirpRate, cricketChirpRate(22)));
    assert.equal(level({ sunElevationDeg: 30, temperatureC: 22 }).insectGain, 0, "not by day");
    assert.equal(level({ sunElevationDeg: -15, temperatureC: 5 }).insectGain, 0, "not in the cold");
  });

  test("reverb follows the surroundings: an open field is short and dry, a canyon long, indoors in between", () => {
    const field = environmentReverb(0, 0), canyon = environmentReverb(1, 0), room = environmentReverb(0, 1);
    assert.ok(field.decay < room.decay && room.decay < canyon.decay);
    assert.ok(field.mix < room.mix && field.mix < canyon.mix && canyon.mix <= 0.5);
    const { ctx } = fakeAudioContext();
    const ir = createReverbImpulse(ctx as unknown as BaseAudioContext, 1.5);
    assert.equal(ir.length, Math.floor(ctx.sampleRate * 1.5));
    const data = ir.getChannelData(0);
    const rms = (a: number, b: number) => Math.sqrt(data.slice(a, b).reduce((s, x) => s + x * x, 0) / (b - a));
    assert.ok(rms(ctx.sampleRate * 0.05, ctx.sampleRate * 0.15) > 30 * rms(ir.length - ctx.sampleRate * 0.1, ir.length), "decays ~60 dB");
    assert.deepEqual(Array.from(createReverbImpulse(ctx as unknown as BaseAudioContext, 1.5).getChannelData(1).slice(0, 2000)), Array.from(ir.getChannelData(1).slice(0, 2000)), "deterministic");
  });
});

group("soundscape", () => {
  test("levels reach the voices, birds sing at their rate around dawn and not at night, reverb impulses swap per bucket, dispose stops everything", () => {
    const { ctx, nodes } = fakeAudioContext();
    const scape = new EnvironmentSoundscape(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { seed: 7 });
    const loops = nodes.filter((n) => n.kind === "buffer" || n.kind === "oscillator");
    assert.equal(loops.length, 8, "6 noise voices + cricket tone + pulse");
    const storm = createAmbienceInput({ windSpeed: 28, gust: 0.7, rain: 0.9, wetness: 1, puddles: 0.5, windDirection: -Math.PI / 2 });
    const l = scape.update(storm, 1 / 60);
    const gains = nodes.filter((n) => n.kind === "gain").map((n) => (n.gain as FakeParam).targets.at(-1));
    assert.ok(gains.includes(l.windGain) && gains.includes(l.rainGain));
    const pan = nodes.find((n) => n.kind === "stereoPanner")!;
    assert.ok(close((pan.pan as FakeParam).targets.at(-1)!, l.windPan));
    const convolver = nodes.find((n) => n.kind === "convolver")!;
    const firstIr = convolver.buffer;
    assert.ok(firstIr, "an impulse from the first update");
    scape.update({ ...storm, reflectivity: 0.11 }, 1 / 60);
    assert.equal(convolver.buffer, firstIr, "a small change stays in the same decay bucket");
    scape.update({ ...storm, reflectivity: 0.9 }, 1 / 60);
    assert.notEqual(convolver.buffer, firstIr, "a canyon rebuilds the impulse");

    const dawn = createAmbienceInput({ sunElevationDeg: 4, temperatureC: 12, windSpeed: 2 });
    const before = scape.birdsPlayed;
    for (let i = 0; i < 600; i++) scape.update(dawn, 1 / 60); // 10 s
    const sung = scape.birdsPlayed - before;
    const expected = ambienceLevels(dawn).birdRate * 10;
    assert.ok(sung >= expected * 0.6 && sung <= expected * 1.6, `${sung} phrases vs ~${expected.toFixed(1)}`);
    const night = createAmbienceInput({ sunElevationDeg: -15, temperatureC: 20 });
    const atNight = scape.birdsPlayed;
    for (let i = 0; i < 600; i++) scape.update(night, 1 / 60);
    assert.equal(scape.birdsPlayed, atNight);
    // Bird phrases clean up after themselves.
    const chirps = nodes.filter((n) => n.kind === "oscillator" && !loops.includes(n));
    assert.ok(chirps.length > 0 && chirps.every((n) => (n.stopped as number) === 1));
    for (const c of chirps) end(c);

    scape.dispose();
    assert.ok(loops.every((n) => (n.stopped as number) === 1 && (n as FakeNode).disconnected > 0));
    const count = nodes.length;
    scape.update(dawn, 1);
    assert.equal(nodes.length, count, "a disposed soundscape is inert");
  });
});

finish();
