/**
 * @suite audio:audioSystem
 * @group unit
 * @covers engine/src/audio/system.ts
 * @covers engine/src/audio/source.ts
 * @covers engine/src/audio/stream.ts
 * @covers engine/src/audio/params.ts
 * @covers engine/src/audio/effects.ts
 * @covers engine/src/audio/types.ts
 * @covers engine/src/audio/index.ts
 * @covers engine/src/testing/mockAudio.ts
 * @desc Phase 20.1–20.4 on a strict MockAudioContext: the mock's automation timeline against the Web Audio rules, the bus tree and its loudness on every path, anchored fades (bus, voice, stop, listener), the voice limit holding under bursts, spatial voices and occlusion that scales the voice's own volume and closes a low-pass, clip loading (one request per URL, failures evicted, decode errors, release), streams under the autoplay policy, live effect insertion, and a dispose that leaves no node connected
 */

export const suite = {
  name: "audio:audioSystem",
  group: "unit",
  covers: [
    "engine/src/audio/system.ts",
    "engine/src/audio/source.ts",
    "engine/src/audio/stream.ts",
    "engine/src/audio/params.ts",
    "engine/src/audio/effects.ts",
    "engine/src/audio/types.ts",
    "engine/src/audio/index.ts",
    "engine/src/testing/mockAudio.ts",
  ],
  desc: "Phase 20.1–20.4 on a strict MockAudioContext: the mock's automation timeline against the Web Audio rules, the bus tree and its loudness on every path, anchored fades (bus, voice, stop, listener), the voice limit holding under bursts, spatial voices and occlusion that scales the voice's own volume and closes a low-pass, clip loading (one request per URL, failures evicted, decode errors, release), streams under the autoplay policy, live effect insertion, and a dispose that leaves no node connected",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AudioSystem,
  FilterEffect,
  OCCLUSION_CUTOFF,
  OCCLUSION_FLOOR,
  VOICE_STEAL_FADE,
  createMockAudio,
  encodeMockAudio,
  type MockAudioContext,
  type MockAudioNode,
  type MockMediaElement,
} from "@forge/engine";

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

function setup(options: { maxVoices?: number; masterVolume?: number; files?: Record<string, ArrayBuffer | number> } = {}) {
  const { mock, context } = createMockAudio({ state: "running" });
  const requests: string[] = [];
  const files = options.files ?? {};
  const fetch = async (url: string): Promise<Response> => {
    requests.push(url);
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    if (typeof body === "number") return { ok: false, status: body, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    return { ok: true, status: 200, arrayBuffer: async () => body } as Response;
  };
  const elements: MockMediaElement[] = [];
  const audio = new AudioSystem({
    context,
    maxVoices: options.maxVoices,
    masterVolume: options.masterVolume,
    fetch,
    createMediaElement: () => {
      const el = mock.createMediaElement();
      elements.push(el);
      return el as unknown as HTMLMediaElement;
    },
  });
  const clip = (seconds = 1) => mock.createBuffer(2, Math.round(seconds * mock.sampleRate), mock.sampleRate) as unknown as AudioBuffer;
  return { mock, audio, clip, requests, elements };
}

const asNode = (n: unknown): MockAudioNode => n as MockAudioNode;

group("the mock's automation timeline (the rules the engine is checked against)", () => {
  test("setValueAtTime, linear and exponential ramps, setTargetAtTime and cancellation evaluate as Web Audio specifies", () => {
    const { mock } = createMockAudio({ state: "running" });
    const g = mock.createGain().gain;
    g.setValueAtTime(1, 1);
    g.linearRampToValueAtTime(3, 3);
    assert.equal(g.valueAt(0.5), 1, "default value before the first event");
    assert.equal(g.valueAt(2), 2, "linear ramp from the previous event");
    assert.equal(g.valueAt(5), 3, "holds the ramp's end");
    g.exponentialRampToValueAtTime(24, 6);
    assert.ok(close(g.valueAt(4), 6, 1e-9), "exponential ramp: 3 → 24 over 3 s is ×2 per second");
    g.cancelScheduledValues(4);
    assert.equal(g.valueAt(10), 3, "cancelled ramp is gone");
    g.setTargetAtTime(0, 4, 0.5);
    assert.ok(close(g.valueAt(4.5), 3 * Math.exp(-1)), "setTarget decays with its time constant");
    g.cancelAndHoldAtTime(4.5);
    assert.ok(close(g.valueAt(9), 3 * Math.exp(-1)), "cancelAndHold freezes the value");
  });

  test("an unanchored ramp starts from time 0 (the worst case), which is why the engine anchors every fade", () => {
    const { mock } = createMockAudio({ state: "running" });
    mock.advance(2);
    const g = mock.createGain().gain; // default 1, no events
    g.linearRampToValueAtTime(0, 4);
    assert.equal(g.valueAt(2), 0.5, "half-way through a ramp that 'started' at 0 — a jump at the fade's start");
  });

  test("time only passes while the context runs, and sources end once at their stop or natural end", () => {
    const { mock } = createMockAudio();
    const src = mock.createBufferSource();
    src.buffer = mock.createBuffer(1, 48000, 48000);
    let ended = 0;
    src.onended = () => ended++;
    src.start(0);
    mock.advance(5);
    assert.equal(mock.currentTime, 0, "a suspended context's clock stands still (autoplay policy)");
    void mock.resume();
    mock.advance(0.5);
    assert.equal(ended, 0);
    mock.advance(0.6);
    mock.advance(1);
    assert.equal(ended, 1, "one-shot ended exactly once");
    assert.throws(() => src.start(0), /started twice/);
  });
});

group("buses (20.4)", () => {
  test("master → speakers and music/sfx/dialogue/ambient → master; a voice's loudness is the product along its path", () => {
    const { mock, audio, clip } = setup({ masterVolume: 0.8 });
    assert.equal(audio.stats().buses, 5);
    audio.setBusVolume("music", 0.5);
    const voice = audio.play(clip(), { bus: "music", volume: 0.25 });
    assert.ok(close(mock.pathGain(asNode(voice.source)), 0.8 * 0.5 * 0.25), String(mock.pathGain(asNode(voice.source))));
    audio.createBus("radio", "sfx");
    audio.setBusVolume("sfx", 0.5);
    const chatter = audio.play(clip(), { bus: "radio" });
    assert.ok(close(mock.pathGain(asNode(chatter.source)), 0.8 * 0.5), "a child bus inherits its parent's volume");
    assert.throws(() => audio.createBus("lost", "nope"), /unknown parent bus "nope"/);
    assert.throws(() => audio.play(clip(), { bus: "nope" }), /unknown audio bus "nope"/);
  });

  test("a bus fade starts at the bus's level, not at a stale automation point", () => {
    const { mock, audio } = setup();
    mock.advance(1);
    audio.setBusVolume("ambient", 0.2, 0.5);
    const music = (audio as unknown as { buses: Map<string, { gain: { gain: { valueAt(t: number): number } } }> }).buses.get("ambient")!.gain.gain;
    assert.equal(music.valueAt(1), 1, "unchanged at the start of the fade");
    assert.ok(close(music.valueAt(1.25), 0.6));
    assert.ok(close(music.valueAt(1.5), 0.2));
    mock.advance(0.25);
    audio.setBusVolume("ambient", 1, 0.5); // reverse mid-fade
    assert.ok(close(music.valueAt(1.25), 0.6), "a reversal continues from where the fade had got to");
    assert.ok(close(audio.busVolume("ambient"), 0.6));
  });

  test("effects insert and leave a bus live, and bypass routes around them", () => {
    const { mock, audio, clip } = setup();
    const voice = audio.play(clip(), { bus: "sfx" });
    const filter = new FilterEffect(mock as unknown as AudioContext, "lowpass", 1200);
    audio.bus("sfx").add(filter);
    const through = mock.paths(asNode(voice.source)).some((p) => p.includes(asNode(filter.filter)));
    assert.ok(through, "the voice now passes the filter");
    filter.setBypassed(true);
    assert.ok(close(mock.pathGain(asNode(voice.source)), 1), "bypassed: the dry path carries it at unity");
    assert.ok(audio.bus("sfx").remove(filter));
    assert.ok(!mock.paths(asNode(voice.source)).some((p) => p.includes(asNode(filter.filter))));
    assert.ok(mock.reachesDestination(asNode(voice.source)), "still audible after removal");
  });
});

group("voices (20.1)", () => {
  test("fades start at the voice's level: setVolume, stop(fadeOut) and fadeIn", () => {
    const { mock, audio, clip } = setup();
    mock.advance(2);
    const v = audio.play(clip(10), { volume: 0.8, loop: true });
    const g = asNode(v.gain) as unknown as { gain: { valueAt(t: number): number } };
    v.setVolume(0.4, 1);
    assert.ok(close(g.gain.valueAt(2), 0.8) && close(g.gain.valueAt(2.5), 0.6) && close(g.gain.valueAt(3), 0.4));
    mock.advance(1);
    v.stop(0.5);
    assert.ok(close(g.gain.valueAt(3), 0.4), "the fade-out starts at the current level");
    assert.ok(close(g.gain.valueAt(3.25), 0.2) && close(g.gain.valueAt(3.5), 0));
    assert.ok(v.fadingOut);
    mock.advance(0.6);
    assert.ok(v.finished && !v.fadingOut);
    const f = audio.play(clip(), { volume: 0.5, fadeIn: 0.2 });
    const fg = asNode(f.gain) as unknown as { gain: { valueAt(t: number): number } };
    assert.ok(close(fg.gain.valueAt(mock.currentTime), 0) && close(fg.gain.valueAt(mock.currentTime + 0.1), 0.25));
  });

  test("the voice limit holds under a burst: stolen voices fade over 10 ms, stop counting at once, and are cleaned up", () => {
    const { mock, audio, clip } = setup({ maxVoices: 4 });
    const voices = Array.from({ length: 10 }, () => audio.play(clip(5), { loop: true }));
    const s = audio.stats();
    assert.equal(s.activeVoices, 4);
    assert.equal(s.stolenVoices, 6);
    assert.equal(s.releasingVoices, 6);
    assert.ok(voices.slice(0, 6).every((v) => v.fadingOut) && voices.slice(6).every((v) => !v.fadingOut), "the oldest six were stolen");
    mock.advance(VOICE_STEAL_FADE * 2);
    assert.equal(audio.stats().releasingVoices, 0);
    assert.ok(voices.slice(0, 6).every((v) => v.finished));
    for (const v of voices.slice(0, 6)) assert.equal(asNode(v.gain).outputs.size, 0, "a stolen voice disconnects when it ends");
  });

  test("one-shots leave the voice set when they end; stopVoice frees the slot during its fade", () => {
    const { mock, audio, clip } = setup({ maxVoices: 2 });
    audio.play(clip(0.5));
    const long = audio.play(clip(5), { loop: true });
    mock.advance(0.6);
    assert.equal(audio.stats().activeVoices, 1, "the one-shot ended");
    audio.stopVoice(long, 1);
    assert.equal(audio.stats().activeVoices, 0, "a fading voice no longer counts");
    assert.equal(audio.stats().releasingVoices, 1);
    mock.advance(1.1);
    assert.equal(audio.stats().releasingVoices, 0);
  });

  test("spatial voices: panner configured and positioned, listener moved (jump or anchored glide), emitter updates", () => {
    const { mock, audio, clip } = setup();
    const v = audio.play(clip(), { loop: true, spatial: true, position: { x: 3, y: 0, z: -4 }, refDistance: 2, rolloffFactor: 0.5, distanceModel: "exponential" });
    const p = v.panner as unknown as { refDistance: number; rolloffFactor: number; distanceModel: string; panningModel: string; positionX: { value: number }; positionZ: { value: number } };
    assert.deepEqual([p.refDistance, p.rolloffFactor, p.distanceModel, p.panningModel], [2, 0.5, "exponential", "HRTF"]);
    // Engine space is left-handed, Web Audio right-handed: z crosses negated (20.1, spatial.ts).
    assert.deepEqual([p.positionX.value, p.positionZ.value], [3, 4]);
    v.setPosition({ x: -1, y: 2, z: 0 });
    assert.equal(p.positionX.value, -1);
    audio.setListener({ position: { x: 10, y: 1, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
    assert.deepEqual([mock.listener.positionX.value, mock.listener.forwardZ.value], [10, -1], "ramp 0 jumps; engine forward +Z is Web Audio's −Z");
    mock.advance(1);
    audio.setListener({ position: { x: 20, y: 1, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 0.5);
    assert.equal(mock.listener.positionX.valueAt(1), 10, "a glide starts where the listener is");
    assert.equal(mock.listener.positionX.valueAt(1.25), 15);
    assert.ok(mock.reachesDestination(asNode(v.source)));
  });

  test("occlusion scales the voice's own volume and closes the low-pass; clearing it restores both", () => {
    const { mock, audio, clip } = setup();
    const v = audio.play(clip(), { spatial: true, volume: 0.5 });
    const gain = asNode(v.gain) as unknown as { gain: { valueAt(t: number): number } };
    const freq = asNode(v.filter) as unknown as { frequency: { valueAt(t: number): number } };
    const open = mock.sampleRate / 2;
    assert.equal(freq.frequency.valueAt(0), open);
    v.setOcclusion(1, 0.1);
    assert.ok(close(gain.gain.valueAt(0.1), 0.5 * OCCLUSION_FLOOR), "a quiet voice stays quiet behind a wall");
    assert.ok(close(freq.frequency.valueAt(0.1), OCCLUSION_CUTOFF, 1e-6));
    mock.advance(0.2);
    v.setOcclusion(0.5, 0);
    assert.ok(close(freq.frequency.valueAt(mock.currentTime), Math.sqrt(open * OCCLUSION_CUTOFF), 1e-6), "half occlusion is half-way in octaves");
    v.setVolume(1);
    assert.ok(close(gain.gain.valueAt(mock.currentTime), 1 - (1 - OCCLUSION_FLOOR) * 0.5), "volume changes keep the occlusion factor");
    v.setOcclusion(0, 0);
    assert.ok(close(gain.gain.valueAt(mock.currentTime), 1) && close(freq.frequency.valueAt(mock.currentTime), open, 1e-6));
  });
});

group("clips (20.2)", () => {
  test("concurrent loads share one request and one decode; stats count clips and decoded seconds", async () => {
    const { mock, audio, requests } = setup({ files: { "/a.ogg": encodeMockAudio({ seconds: 2, channels: 2 }), "/b.ogg": encodeMockAudio({ seconds: 0.5, channels: 1 }) } });
    const [a1, a2, b] = await Promise.all([audio.load("/a.ogg"), audio.load("/a.ogg"), audio.load("/b.ogg")]);
    assert.equal(a1, a2);
    assert.deepEqual(requests, ["/a.ogg", "/b.ogg"]);
    assert.equal(mock.decodeCalls, 2);
    assert.equal(a1.duration, 2);
    assert.equal(b.channels, 1);
    assert.deepEqual([audio.stats().cachedClips, audio.stats().decodedSeconds], [2, 4.5]);
    assert.equal(await audio.load("/a.ogg"), a1, "a later load is served from the cache");
    assert.equal(requests.length, 2);
    assert.ok(audio.release("/a.ogg"));
    assert.deepEqual([audio.stats().cachedClips, audio.stats().decodedSeconds], [1, 0.5]);
    await audio.load("/a.ogg");
    assert.equal(requests.length, 3, "a released clip is fetched again");
  });

  test("a 404 or an undecodable file rejects and is evicted, so a retry can succeed", async () => {
    const files: Record<string, ArrayBuffer | number> = { "/missing.ogg": 404, "/corrupt.ogg": new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]).buffer };
    const { audio, requests } = setup({ files });
    await assert.rejects(audio.load("/missing.ogg"), /404/);
    await assert.rejects(audio.load("/corrupt.ogg"), (e: Error) => e.name === "EncodingError");
    assert.equal(audio.stats().cachedClips, 0);
    files["/missing.ogg"] = encodeMockAudio({ seconds: 1 });
    const clip = await audio.load("/missing.ogg");
    assert.equal(clip.duration, 1);
    assert.equal(requests.filter((r) => r === "/missing.ogg").length, 2);
  });
});

group("streams (20.3)", () => {
  test("a stream routes its media element through a gain into its bus and plays", async () => {
    const { mock, audio, elements } = setup();
    audio.setBusVolume("music", 0.5);
    const s = audio.stream("https://cdn.example/theme.ogg", { volume: 0.6, loop: true });
    const el = elements[0]!;
    assert.deepEqual([el.src, el.loop, el.crossOrigin], ["https://cdn.example/theme.ogg", true, "anonymous"]);
    const src = el.sourceNode!;
    assert.ok(close(mock.pathGain(src), 0.6 * 0.5), "stream gain × music bus × master");
    assert.equal(await s.play(), "playing");
    assert.equal(el.paused, false);
    s.setVolume(0.3, 1);
    assert.ok(close(mock.pathGain(src, mock.currentTime + 0.5), 0.45 * 0.5));
    s.pause();
    assert.equal(s.state, "paused");
    s.stop();
    assert.deepEqual([s.state, el.currentTime, el.paused], ["idle", 0, true]);
  });

  test("the autoplay policy blocks a stream; resume() from a gesture plays it; a non-looping stream reports its end", async () => {
    const { mock, audio, elements } = setup();
    mock.autoplayBlocked = true;
    let ended = 0;
    const s = audio.stream("/ambience.mp3", { bus: "ambient", fadeIn: 2, onEnded: () => ended++ });
    assert.equal(await s.play(), "blocked", "refused, not failed");
    mock.autoplayBlocked = false;
    await audio.resume();
    assert.equal(s.state, "playing");
    const gain = asNode(s.gain) as unknown as { gain: { valueAt(t: number): number } };
    assert.ok(close(gain.gain.valueAt(mock.currentTime), 0) && close(gain.gain.valueAt(mock.currentTime + 1), 0.5), "fades in from silence");
    elements[0]!.dispatch("ended");
    assert.deepEqual([s.state, ended], ["ended", 1]);
  });

  test("disposing a stream releases the element and its listeners and disconnects it", () => {
    const { mock, audio, elements } = setup();
    const s = audio.stream("/x.ogg");
    const el = elements[0]!;
    assert.equal(el.listenerCount(), 2);
    s.dispose();
    assert.deepEqual([s.state, el.src, el.listenerCount(), audio.stats().streams], ["disposed", "", 0, 0]);
    assert.ok(!mock.reachesDestination(el.sourceNode!));
  });
});

group("lifecycle", () => {
  test("dispose stops every voice and stream, disconnects every node and closes the context", async () => {
    const { mock, audio, clip } = setup({ maxVoices: 3 });
    for (let i = 0; i < 5; i++) audio.play(clip(3), { loop: true, spatial: i % 2 === 0 });
    audio.stream("/m.ogg");
    audio.bus("sfx").add(new FilterEffect(mock as unknown as AudioContext));
    await audio.dispose();
    assert.equal(mock.state, "closed");
    assert.deepEqual(mock.connectedNodes().map((n) => n.kind), [], "nothing left connected");
    assert.throws(() => audio.play(clip()), /disposed/);
    await audio.dispose(); // idempotent
  });

  test("resume and suspend follow the context state; a suspended context does not advance", async () => {
    const { mock, context } = createMockAudio();
    const audio = new AudioSystem({ context });
    assert.equal(audio.stats().state, "suspended");
    await audio.resume();
    assert.equal(mock.state, "running");
    await audio.suspend();
    mock.advance(1);
    assert.equal(mock.currentTime, 0);
    await audio.dispose();
  });
});

await finish();

export type { MockAudioContext };
