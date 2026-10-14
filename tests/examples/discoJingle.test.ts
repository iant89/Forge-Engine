/**
 * @suite examples:discoJingle
 * @group unit
 * @covers examples/src/audio/discoJingle.ts
 * @desc fe-28 original WebAudio disco jingle: score shape, autoplay gate, mute
 */

export const suite = {
  name: "examples:discoJingle",
  group: "unit",
  covers:   [
    "examples/src/audio/discoJingle.ts"
  ],
  desc: "fe-28 original WebAudio disco jingle: score shape, autoplay gate, mute",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { DiscoJingle, JINGLE_BEAT, JINGLE_BPM, JINGLE_CHORDS, JINGLE_DURATION, discoJingleScore, midiHz } from "../../examples/src/audio/discoJingle.js";
import { YMCA_CLIP } from "../../examples/src/scenes/dustStormRoute.js";

group("score", () => {
  test("15 s at 128 bpm — exactly the finale clip — and nothing rings past the end", () => {
    assert.equal(JINGLE_BPM, 128);
    assert.ok(Math.abs(JINGLE_DURATION - 15) < 1e-9);
    assert.ok(Math.abs(JINGLE_DURATION - YMCA_CLIP) < 1e-9, "jingle and dance clip end together");
    const score = discoJingleScore();
    assert.ok(score.length > 100);
    for (const n of score) assert.ok(n.t >= 0 && n.t + n.dur <= JINGLE_DURATION + 1e-9, `${n.voice} @${n.t}`);
    for (let i = 1; i < score.length; i++) assert.ok(score[i]!.t >= score[i - 1]!.t);
  });
  test("four-on-the-floor kick and an I–vi–IV–V progression in C", () => {
    const kicks = discoJingleScore().filter((n) => n.voice === "kick").map((n) => n.t / JINGLE_BEAT);
    for (let beat = 0; beat < 30; beat++) assert.ok(kicks.some((k) => Math.abs(k - beat) < 1e-6), `kick on beat ${beat}`);
    assert.deepEqual(JINGLE_CHORDS.slice(0, 4).map((c) => c[0]! % 12), [0, 9, 5, 7]);
    assert.ok(Math.abs(midiHz(69) - 440) < 1e-9);
  });
});

function fakeContext(state: "running" | "suspended" = "running") {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {} });
  const started: number[] = [];
  const ctx = {
    state,
    currentTime: 0,
    sampleRate: 8000,
    destination: node(),
    resumed: 0,
    closed: 0,
    resume() { this.resumed++; this.state = "running"; return Promise.resolve(); },
    close() { this.closed++; return Promise.resolve(); },
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: "", frequency: param() }),
    createOscillator: () => ({ ...node(), type: "", frequency: param(), start: (t: number) => started.push(t), stop() {}, onended: null }),
    createBufferSource: () => ({ ...node(), buffer: null, start: (t: number) => started.push(t), stop() {}, onended: null }),
    createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) }),
  };
  return { ctx, started };
}

group("player", () => {
  test("locked until a gesture unlocks it; unavailable WebAudio is a silent no-op", () => {
    const none = new DiscoJingle({ createContext: () => null });
    assert.equal(none.play(), false);
    none.unlock();
    assert.equal(none.play(), false);
    const { ctx, started } = fakeContext("suspended");
    const j = new DiscoJingle({ createContext: () => ctx as unknown as AudioContext });
    assert.equal(j.play(), false, "no context before the gesture");
    j.unlock();
    assert.equal(ctx.resumed, 1, "the gesture resumes a suspended context");
    assert.equal(j.play(), true);
    assert.equal(started.length, discoJingleScore().length);
    assert.equal(j.playing, true);
  });
  test("mute blocks playback and stops a running jingle; dispose closes the context", () => {
    const { ctx, started } = fakeContext();
    const j = new DiscoJingle({ muted: true, createContext: () => ctx as unknown as AudioContext });
    j.unlock();
    assert.equal(j.play(), false);
    assert.equal(started.length, 0);
    j.muted = false;
    assert.equal(j.play(), true);
    j.muted = true;
    assert.equal(j.playing, false);
    j.dispose();
    assert.equal(ctx.closed, 1);
  });
});

await finish();
