/**
 * @suite examples:hurricane
 * @group unit
 * @covers examples/src/scenes/hurricane.ts
 * @covers examples/src/sceneSelection.ts
 * @covers examples/src/scenes/hurricaneHouses.ts
 * @desc fe-33 hurricane demo script: track, intensification, landfall, eyewall → eye → back eyewall over the beach
 */

export const suite = {
  name: "examples:hurricane",
  group: "unit",
  covers:   [
    "examples/src/scenes/hurricane.ts",
    "examples/src/sceneSelection.ts",
    "examples/src/scenes/hurricaneHouses.ts"
  ],
  desc: "fe-33 hurricane demo script: track, intensification, landfall, eyewall → eye → back eyewall over the beach",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { coastalCoordinates, coastalHeightAt, cyclonePhaseAt, cycloneWindAt, saffirSimpsonCategory } from "@forge/engine";
import { HURRICANE_BEATS, HURRICANE_COAST, HURRICANE_OBSERVER, hurricaneTide, HURRICANE_TIME_COMPRESSION, createHurricaneTrack, hurricaneLandfallTime } from "../../examples/src/scenes/hurricane.js";
import { resolveDemoSceneName } from "../../examples/src/sceneSelection.js";
import { houseSites } from "../../examples/src/scenes/hurricaneHouses.js";

const track = createHurricaneTrack();
const phaseAt = (t: number) => {
  const s = track.sample(t);
  return cyclonePhaseAt(s, HURRICANE_OBSERVER.x, HURRICANE_OBSERVER.z);
};

group("hurricane script", () => {
  test("about two minutes, tropical storm to Category 5", () => {
    assert.ok(track.duration >= 100 && track.duration <= 140);
    assert.equal(saffirSimpsonCategory(track.sample(0).maxWind), 0);
    let peak = 0;
    for (let t = 0; t <= track.duration; t += 1) peak = Math.max(peak, saffirSimpsonCategory(track.sample(t).maxWind));
    assert.ok(peak >= 4);
    for (let t = 0; t < 90; t += 5) assert.ok(track.sample(t + 5).maxWind >= track.sample(t).maxWind, "intensifies on approach");
  });

  test("lands between the eyewall and back eyewall beats", () => {
    const landfall = hurricaneLandfallTime(track);
    assert.ok(landfall > HURRICANE_BEATS.eyewall && landfall < HURRICANE_BEATS.backEyewall);
  });

  test("the beats see offshore → bands → eyewall → eye → back eyewall", () => {
    assert.equal(phaseAt(HURRICANE_BEATS.offshore), "outer-bands");
    assert.equal(phaseAt(HURRICANE_BEATS.midStorm), "rainbands");
    assert.equal(phaseAt(HURRICANE_BEATS.eyewall), "eyewall");
    assert.equal(phaseAt(HURRICANE_BEATS.eye), "eye");
    assert.equal(phaseAt(HURRICANE_BEATS.backEyewall), "eyewall");
    const opts = { timeCompression: HURRICANE_TIME_COMPRESSION };
    const front = cycloneWindAt(track.sample(HURRICANE_BEATS.eyewall), HURRICANE_OBSERVER.x, HURRICANE_OBSERVER.z, opts);
    const back = cycloneWindAt(track.sample(HURRICANE_BEATS.backEyewall), HURRICANE_OBSERVER.x, HURRICANE_OBSERVER.z, opts);
    const eye = cycloneWindAt(track.sample(HURRICANE_BEATS.eye), HURRICANE_OBSERVER.x, HURRICANE_OBSERVER.z, opts);
    assert.ok(front.speed > 50 && back.speed > 45 && eye.speed < 15);
    assert.ok(front.x * back.x + front.z * back.z < 0, "the wind reverses after the eye");
  });

  test("scene routing", () => {
    assert.equal(resolveDemoSceneName("hurricane"), "hurricane");
    assert.equal(resolveDemoSceneName("beach"), "hurricane");
  });
});

group("hurricane polish (fe-34)", () => {
  test("the sea pulls back before the storm and the tide recovers for the surge", () => {
    assert.ok(Math.abs(hurricaneTide(0)) < 1e-12);
    assert.ok(hurricaneTide(HURRICANE_BEATS.lowTide) < -0.6, "low tide at the low-tide beat");
    assert.ok(hurricaneTide(HURRICANE_BEATS.surge) > -0.05, "tide back by the surge");
    for (let t = 0; t < 130; t += 0.5) assert.ok(hurricaneTide(t) <= 0 && hurricaneTide(t) >= -0.9);
  });
  test("beach houses sit behind the dunes, on dry ground, deterministically", () => {
    const sites = houseSites(HURRICANE_COAST, 7, 520, 122);
    assert.deepEqual(sites, houseSites(HURRICANE_COAST, 7, 520, 122));
    for (const s of sites) {
      assert.ok(coastalCoordinates(HURRICANE_COAST, s.x, s.z).along > 90, "behind the fore-dune");
      assert.ok(s.y >= coastalHeightAt(HURRICANE_COAST, s.x, s.z) && s.y > 3, "dry, pilings on the ground");
    }
  });
});

finish();
