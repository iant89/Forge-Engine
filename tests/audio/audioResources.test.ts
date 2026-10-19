/**
 * @suite audio:audioResources
 * @group unit
 * @covers engine/src/audio/resources.ts
 * @covers engine/src/audio/system.ts
 * @covers engine/src/resources/registry.ts
 * @desc Phase 20.2 audio resources: clips are ResourceRegistry entries (one load per id, refcounted handles, decoded-byte budget with idle eviction), alternative sources fall back by codec support and decode failure, loads cancel and validate, procedural clips cache like files, and banks load and release sets of clips
 */

export const suite = {
  name: "audio:audioResources",
  group: "unit",
  covers: [
    "engine/src/audio/resources.ts",
    "engine/src/audio/system.ts",
    "engine/src/resources/registry.ts",
  ],
  desc: "Phase 20.2 audio resources: clips are ResourceRegistry entries (one load per id, refcounted handles, decoded-byte budget with idle eviction), alternative sources fall back by codec support and decode failure, loads cancel and validate, procedural clips cache like files, and banks load and release sets of clips",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AUDIO_RESOURCE_KIND,
  AudioBank,
  AudioSystem,
  ResourceRegistry,
  audioClipDescriptor,
  audioClipId,
  decodedAudioBytes,
  proceduralClipDescriptor,
  rankAudioSources,
} from "@forge/engine";
import { fakeAudioContext } from "../support/fakeAudio.js";

/** A fake server: url → byte length (decoded as that many frames), or an HTTP status. */
function server(files: Record<string, number>) {
  const requests: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    requests.push(url);
    const size = files[url];
    if (size === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(size) } as Response;
  };
  return { fetch, requests };
}

function system(files: Record<string, number>, registry?: ResourceRegistry, decode?: (data: ArrayBuffer) => { frames: number; channels?: number; rate?: number }) {
  const fake = fakeAudioContext({ decode });
  const net = server(files);
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = net.fetch;
  const audio = new AudioSystem({ context: fake.ctx as unknown as AudioContext, registry });
  return { audio, ctx: fake.ctx, net, restore: () => ((globalThis as { fetch: unknown }).fetch = original) };
}

group("clips are registry resources", () => {
  test("one fetch and decode per id; handles share it; bytes are the decoded size; load keeps the clip", async () => {
    const { audio, ctx, net, restore } = system({ "sfx/hit.ogg": 4000 });
    try {
      const [a, b] = [audio.acquire("sfx/hit.ogg"), audio.acquire("sfx/hit.ogg")];
      const [ca, cb] = await Promise.all([a.wait(), b.wait()]);
      assert.equal(ca, cb);
      assert.equal(net.requests.length, 1);
      assert.equal(ctx.decoded, 1);
      assert.equal(ca.id, "audio:sfx/hit.ogg");
      assert.equal(audioClipId("sfx/hit.ogg"), "audio:sfx/hit.ogg");
      assert.equal(audio.registry.stateOf("audio:sfx/hit.ogg"), "ready");
      assert.equal(decodedAudioBytes(ca.buffer), 4000 * 1 * 4, "frames × channels × float32");
      assert.equal(audio.stats().clipBytes, 16_000);
      const loaded = await audio.load("sfx/hit.ogg");
      assert.equal(loaded, ca, "load reuses the registry entry");
      assert.equal(net.requests.length, 1);
      assert.equal(audio.stats().cachedClips, 1);
      a.release();
      b.release();
      assert.equal(audio.registry.evictIdle(1), 0, "load still holds it");
      audio.clearCache();
      assert.equal(audio.registry.evictIdle(1), 1, "released clips are evictable");
      assert.equal(audio.stats().clipBytes, 0);
    } finally {
      restore();
    }
  });

  test("a shared, budgeted registry evicts idle clips least-recently-used first, never held ones", async () => {
    const registry = new ResourceRegistry({ maxBytes: 3 * 40_000, idleGraceMs: 0 });
    const { audio, restore } = system({ "a.ogg": 10_000, "b.ogg": 10_000, "c.ogg": 10_000, "d.ogg": 10_000 }, registry);
    try {
      const held = audio.acquire("a.ogg");
      await held.wait();
      for (const url of ["b.ogg", "c.ogg"]) {
        const h = audio.acquire(url);
        await h.wait();
        h.release();
      }
      assert.equal(registry.bytesOfKind(AUDIO_RESOURCE_KIND), 120_000);
      const d = audio.acquire("d.ogg");
      await d.wait();
      // Over budget by one clip: the oldest idle one (b) goes; a is held.
      assert.equal(registry.stateOf("audio:b.ogg"), null);
      assert.equal(registry.stateOf("audio:a.ogg"), "ready");
      assert.equal(registry.stateOf("audio:c.ogg"), "ready");
      assert.equal(registry.bytesOfKind(AUDIO_RESOURCE_KIND), 120_000);
      held.release();
      d.release();
    } finally {
      restore();
    }
  });

  test("a failed load rejects, is not kept, and the next load retries", async () => {
    const { audio, net, restore } = system({});
    try {
      await assert.rejects(audio.load("missing.ogg"), /HTTP 404/);
      assert.equal(audio.stats().cachedClips, 0);
      await assert.rejects(audio.load("missing.ogg"), /HTTP 404/);
      assert.equal(net.requests.length, 2);
    } finally {
      restore();
    }
  });
});

group("formats and fallback", () => {
  test("sources the browser refuses are skipped; 'probably' outranks 'maybe'; order breaks ties", () => {
    const can = (type: string): "" | "maybe" | "probably" => (type.includes("opus") ? "" : type.includes("mp4") ? "probably" : "maybe");
    const ranked = rankAudioSources([{ url: "x.opus", type: "audio/ogg; codecs=opus" }, { url: "x.ogg", type: "audio/ogg" }, { url: "x.m4a", type: "audio/mp4" }, { url: "x.wav" }], can);
    assert.deepEqual(ranked.map((c) => c.url), ["x.m4a", "x.ogg", "x.wav"]);
  });

  test("a source that fails to fetch or decode falls through to the next; the id stays the first url's", async () => {
    const fake = fakeAudioContext({ decode: (d) => { if (d.byteLength === 13) throw new Error("EncodingError"); return { frames: d.byteLength }; } });
    const net = server({ "music.opus": 13, "music.m4a": 2000 });
    const registry = new ResourceRegistry();
    const sources = [{ url: "missing.webm" }, { url: "music.opus" }, { url: "music.m4a" }];
    const clip = await registry.acquireAndWait(audioClipDescriptor(fake.ctx as unknown as BaseAudioContext, sources, { fetch: net.fetch, canPlayType: () => "maybe" }));
    assert.equal(clip.url, "music.m4a");
    assert.equal(clip.id, "audio:missing.webm");
    assert.deepEqual(net.requests, ["missing.webm", "music.opus", "music.m4a"]);
    const none = audioClipDescriptor(fake.ctx as unknown as BaseAudioContext, [{ url: "a.opus", type: "audio/ogg; codecs=opus" }], { fetch: net.fetch, canPlayType: () => "" });
    await assert.rejects(registry.acquireAndWait(none), /no playable source/);
    const all = audioClipDescriptor(fake.ctx as unknown as BaseAudioContext, [{ url: "x.ogg" }, { url: "y.ogg" }], { fetch: net.fetch, canPlayType: () => "maybe" });
    await assert.rejects(registry.acquireAndWait(all), /every source failed.*x\.ogg.*y\.ogg/);
  });

  test("validation rejects empty audio and warns on clips long enough to stream; cancellation discards the decode", async () => {
    const fake = fakeAudioContext({ decode: (d) => ({ frames: d.byteLength === 1 ? 0 : d.byteLength, rate: 8000 }) });
    const net = server({ "empty.wav": 1, "long.ogg": 8000 * 40, "slow.ogg": 100 });
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m), debug() {}, error() {}, info() {} };
    const registry = new ResourceRegistry({ logger: logger as never });
    const desc = (url: string) => audioClipDescriptor(fake.ctx as unknown as BaseAudioContext, url, { fetch: net.fetch });
    await assert.rejects(registry.acquireAndWait(desc("empty.wav")), /audio\.empty/);
    const long = await registry.acquireAndWait(desc("long.ogg"));
    assert.equal(long.duration, 40);
    assert.ok(warnings.some((w) => w.includes("audio.long")), warnings.join("\n"));
    const h = registry.acquire(desc("slow.ogg"));
    assert.equal(registry.cancelLoad("audio:slow.ogg"), true);
    await assert.rejects(h.wait(), /cancelled/);
    assert.equal(registry.stateOf("audio:slow.ogg"), "failed");
  });
});

group("procedural clips and banks", () => {
  test("a procedural clip builds once, is shared and budgeted like a file", async () => {
    const { audio, ctx, restore } = system({});
    try {
      let builds = 0;
      const thunder = proceduralClipDescriptor("thunder/0", () => (builds++, ctx.createBuffer(2, 16_000, 8000) as unknown as AudioBuffer));
      assert.equal(thunder.id, "audio:procedural/thunder/0");
      const a = audio.acquire(thunder), b = audio.acquire(thunder);
      await Promise.all([a.wait(), b.wait()]);
      assert.equal(builds, 1);
      assert.equal(audio.stats().clipBytes, 16_000 * 2 * 4);
      a.release();
      b.release();
    } finally {
      restore();
    }
  });

  test("a bank loads a set together with progress, hands out clips by key, reports failures, and releases them all", async () => {
    const { audio, restore } = system({ "ui/click.wav": 100, "ui/open.wav": 200 });
    try {
      const bank = new AudioBank("ui", audio, { click: "ui/click.wav", open: "ui/open.wav" });
      assert.deepEqual(bank.keys, ["click", "open"]);
      assert.equal(bank.get("click"), null, "not ready yet");
      await bank.load();
      assert.equal(bank.progress, 1);
      assert.equal(bank.get("open")!.buffer.length, 200);
      assert.deepEqual(audio.registry.descriptorOf("audio:ui/click.wav")?.tags, ["bank:ui"]);
      bank.pin();
      assert.equal(audio.registry.evictIdle(1), 0);
      bank.release();
      assert.equal(bank.get("click"), null);
      assert.equal(audio.registry.evictIdle(1), 2, "released banks are evictable");
      const broken = new AudioBank("broken", audio, { ok: "ui/click.wav", gone: "ui/gone.wav" });
      await assert.rejects(broken.load());
      assert.deepEqual(broken.failed, ["gone"]);
      assert.equal(broken.progress, 0.5);
      broken.release();
    } finally {
      restore();
    }
  });

  test("dispose releases held clips and disposes a registry the system owns, never a shared one", async () => {
    const shared = new ResourceRegistry();
    const { audio, ctx, restore } = system({ "a.ogg": 10 }, shared);
    try {
      await audio.load("a.ogg");
      await audio.dispose();
      assert.equal(ctx.closed, 1);
      assert.equal(shared.stateOf("audio:a.ogg"), "ready", "the shared registry keeps its (now idle) entry");
      assert.equal(shared.evictIdle(1), 1);
      const own = system({ "b.ogg": 10 });
      await own.audio.load("b.ogg");
      await own.audio.dispose();
      assert.throws(() => own.audio.registry.acquire({ id: "x", kind: "audio", load: () => null }), /disposed/);
      own.restore();
    } finally {
      restore();
    }
  });
});

finish();
