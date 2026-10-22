/**
 * @suite core:runtimeApi
 * @group unit
 * @covers engine/api-approvals.json
 * @covers engine/api-surface.json
 * @covers engine/src/core/config.ts
 * @covers engine/src/core/events.ts
 * @covers engine/src/core/log.ts
 * @covers engine/src/core/platform.ts
 * @covers engine/src/core/pool.ts
 * @covers engine/src/index.ts
 * @desc Completed public API namespace linkage and foundational config, event, log, platform, and pool contracts
 */

export const suite = {
  name: "core:runtimeApi",
  group: "unit",
  covers: [
    "engine/api-approvals.json",
    "engine/api-surface.json",
    "engine/src/core/config.ts",
    "engine/src/core/events.ts",
    "engine/src/core/log.ts",
    "engine/src/core/platform.ts",
    "engine/src/core/pool.ts",
    "engine/src/index.ts",
  ],
  desc: "Completed public API namespace linkage and foundational config, event, log, platform, and pool contracts",
};

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish, group, test } from "selrun";
import * as EngineApi from "@forge/engine";
import {
  DisposableGroup,
  EventBus,
  EventTarget2,
  FloatArena,
  FloatBuffer,
  FreeList,
  IntStack,
  LogBuffer,
  Logger,
  LogLevel,
  ObjectPool,
  Signal,
  Uint16Buffer,
  Uint32Buffer,
  UsageError,
  VERSION,
  createLogger,
  describeConfig,
  detectPlatform,
  handleGeneration,
  handleSlot,
  makeHandle,
  parseLogLevel,
  probeWebGPU,
  resolveConfig,
} from "@forge/engine";

type SurfaceRow = {
  name: string;
  kind: "type" | "value" | "type-and-value";
  stability: "public" | "experimental" | "deprecated";
};

type SurfaceFile = {
  counts: {
    total: number;
    type: number;
    value: number;
    typeAndValue: number;
    public: number;
    experimental: number;
    deprecated: number;
    internal: number;
  };
  exports: SurfaceRow[];
};

type ApprovalFile = {
  counts: { approved: number; pendingPublic: number; experimental: number; deprecated: number };
  approvals: { name: string }[];
};

function loadJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

group("completed package-root contract", () => {
  test("links every value declaration and keeps every type-only declaration out of the runtime namespace", () => {
    const surface = loadJson<SurfaceFile>("../../engine/api-surface.json");
    const approvals = loadJson<ApprovalFile>("../../engine/api-approvals.json");

    assert.deepEqual(surface.counts, {
      total: 2210,
      type: 814,
      value: 1010,
      typeAndValue: 386,
      public: 2201,
      experimental: 9,
      deprecated: 0,
      internal: 0,
    });
    assert.deepEqual(approvals.counts, { approved: 2201, pendingPublic: 0, experimental: 9, deprecated: 0 });
    assert.equal(new Set(approvals.approvals.map((row) => row.name)).size, 2201);

    let valueCount = 0;
    let typeCount = 0;
    for (const item of surface.exports) {
      const exists = Object.hasOwn(EngineApi, item.name);
      if (item.kind === "type") {
        typeCount++;
        assert.equal(exists, false, `${item.name} is classified type-only but exists at runtime`);
      } else {
        valueCount++;
        assert.equal(exists, true, `${item.name} is a value declaration but is absent at runtime`);
      }
    }
    assert.equal(valueCount, 1396, "386 type-and-value plus 1,010 value exports, including experiments");
    assert.equal(typeCount, 814);
    assert.equal(VERSION, "1.0.0", "the released Engine API version is 1.0.0");
  });
});

group("configuration", () => {
  test("applies profiles, normalizes bounded values, preserves overrides, and hashes deterministically", () => {
    const warnings: string[] = [];
    const first = resolveConfig(
      {
        quality: "low",
        assetBaseUrl: "/game-assets",
        anisotropy: 99,
        shadowCascades: 8,
        shadowMapSize: 1000,
        maxFps: 900,
      },
      { onWarning: (message) => warnings.push(message) },
    );
    const second = resolveConfig(
      {
        quality: "low",
        assetBaseUrl: "/game-assets",
        anisotropy: 99,
        shadowCascades: 8,
        shadowMapSize: 1000,
        maxFps: 900,
      },
    );

    assert.equal(first.renderScale, 0.8);
    assert.equal(first.assetBaseUrl, "/game-assets/");
    assert.equal(first.anisotropy, 16);
    assert.equal(first.shadowCascades, 4);
    assert.equal(first.shadowMapSize, 1024);
    assert.equal(first.maxFps, 500);
    assert.equal(first.configHash, second.configHash);
    assert.equal(Object.isFrozen(first.userOverrides), true);
    assert.equal(first.userOverrides.assetBaseUrl, "/game-assets");
    assert.equal(warnings.length, 4);
    assert.match(describeConfig(first), /quality=low backend=webgpu/);
    assert.match(describeConfig(first), /configHash=0x[0-9a-f]+/);
  });

  test("reports unknown keys and rejects invalid strict, profile, and numeric input", () => {
    const warnings: string[] = [];
    const config = resolveConfig({ mystery: true } as never, { onWarning: (message) => warnings.push(message) });
    assert.equal(config.userOverrides.mystery, undefined);
    assert.match(warnings[0] ?? "", /unknown option "mystery"/);
    assert.throws(() => resolveConfig({ mystery: true } as never, { strict: true }), UsageError);
    assert.throws(() => resolveConfig({ quality: "cinematic" } as never), UsageError);
    assert.throws(() => resolveConfig({ fixedDeltaTime: 0 }), UsageError);
    assert.throws(() => resolveConfig({ maxSubSteps: 1.5 }), UsageError);
    assert.throws(() => resolveConfig({ workerCount: -1 }), UsageError);
  });
});

group("events and disposal", () => {
  test("preserves order, defers additions, handles once/dispose, and isolates listener failures", () => {
    const event = new EventTarget2<number>();
    const seen: string[] = [];
    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.at(-1));
    try {
      const first = event.on((value) => {
        seen.push(`first:${value}`);
        event.on((later) => seen.push(`late:${later}`));
      });
      event.once((value) => seen.push(`once:${value}`));
      event.on(() => {
        throw new Error("listener failed");
      });

      event.emit(1);
      first.dispose();
      first.dispose();
      event.emit(2);

      assert.deepEqual(seen, ["first:1", "once:1", "late:2"]);
      assert.equal(errors.length, 2);
      assert.equal(event.length, 2);
      assert.equal(event.hasListeners, true);
      event.clear();
      assert.deepEqual(event.snapshot(), { count: 0, capacity: 0 });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("routes named events, bridges signals, and disposes groups in reverse order", () => {
    type Events = { score: number; ready: void };
    const bus = new EventBus<Events>();
    const source = new EventTarget2<number>();
    const scores: number[] = [];
    const bridge = bus.bridge("score", source);
    const subscription = bus.on("score", (score) => scores.push(score));
    source.emit(4);
    assert.deepEqual(scores, [4]);
    assert.equal(bus.listenerCount("score"), 1);
    bridge.dispose();
    subscription.dispose();
    source.emit(5);
    assert.deepEqual(scores, [4]);

    const order: number[] = [];
    const group = new DisposableGroup([
      { dispose: () => order.push(1) },
      { dispose: () => order.push(2) },
    ]);
    group.dispose();
    group.add({ dispose: () => order.push(3) });
    assert.deepEqual(order, [2, 1, 3]);
    assert.equal(group.isDisposed, true);

    const signal = new Signal();
    let fired = 0;
    signal.on(() => fired++);
    signal.fire();
    assert.equal(fired, 1);
  });
});

group("logging", () => {
  test("parses levels and retains a bounded chronological record ring", () => {
    assert.equal(parseLogLevel("off"), LogLevel.Silent);
    assert.equal(parseLogLevel("warning"), LogLevel.Warn);
    assert.equal(parseLogLevel("verbose"), LogLevel.Trace);
    assert.equal(parseLogLevel(99), LogLevel.Trace);
    assert.equal(parseLogLevel(undefined), LogLevel.Info);

    const buffer = new LogBuffer(2);
    const logger = new Logger({ level: LogLevel.Debug, sinks: [buffer], dedupe: false });
    logger.info("one");
    logger.child("asset").warn("two", { id: 7 });
    logger.debug("three");
    assert.deepEqual(buffer.snapshot().map(({ scope, message }) => [scope, message]), [
      ["asset", "two"],
      ["core", "three"],
    ]);
    assert.equal(buffer.droppedCount, 1);
    assert.equal(logger.counts[LogLevel.Info], 1);
    assert.equal(logger.counts[LogLevel.Warn], 1);
    assert.equal(logger.counts[LogLevel.Debug], 1);
    buffer.clear();
    assert.equal(buffer.length, 0);
  });

  test("creates scoped multi-sink loggers and isolates broken sinks", () => {
    const records: string[] = [];
    const flushes: number[] = [];
    const logger = createLogger({
      level: "debug",
      scope: "tools",
      sinks: [
        { write: (record) => records.push(`${record.scope}:${record.message}`), flush: () => flushes.push(1) },
        { write: () => { throw new Error("broken sink"); }, flush: () => flushes.push(2) },
      ],
    });
    logger.debug("ready");
    logger.flush();
    assert.deepEqual(records, ["tools:ready"]);
    assert.deepEqual(flushes, [1, 2]);
    assert.equal(logger.history.length, 1, "createRoot also installs its bounded history sink");
  });
});

group("pooling and typed storage", () => {
  test("reuses reset objects and reports retention, outstanding, and discard counts", () => {
    let serial = 0;
    const pool = new ObjectPool(
      () => ({ serial: serial++, value: 0, reset() { this.value = 0; } }),
      { prewarm: 1, maxRetained: 1 },
    );
    const first = pool.obtain();
    const second = pool.obtain();
    first.value = 9;
    pool.release(first);
    pool.release(second);
    assert.deepEqual(pool.stats, { created: 2, retained: 1, outstanding: 0, acquired: 2, discarded: 1 });
    const reused = pool.obtain();
    assert.equal(reused, first);
    assert.equal(reused.value, 0);
    assert.equal(pool.leaked, 1);
    pool.release(reused);
    pool.drain();
    assert.equal(pool.stats.retained, 0);
  });

  test("invalidates recycled generational handles", () => {
    const list = new FreeList(2);
    const first = list.allocate();
    const handle = makeHandle(first.slot, first.generation);
    assert.equal(handleSlot(handle), first.slot);
    assert.equal(handleGeneration(handle), first.generation & 0xff);
    assert.equal(list.handleOf(first.slot), handle);
    assert.equal(list.isValid(handle), true);
    list.release(first.slot);
    assert.equal(list.isValid(handle), false);
    const recycled = list.allocate();
    assert.equal(recycled.slot, first.slot);
    assert.notEqual(makeHandle(recycled.slot, recycled.generation), handle);
    assert.deepEqual(list.stats, { size: 2, live: 1, recycled: 0 });
    list.reset();
    assert.equal(list.liveCount, 0);
    assert.equal(list.highWaterMark, 0);
  });

  test("grows stacks and typed writers while preserving views, alignment, and rewind", () => {
    const stack = new IntStack(1);
    for (let i = 0; i < 20; i++) stack.push(i);
    assert.equal(stack.peek(), 19);
    assert.deepEqual(stack.drain(), Array.from({ length: 20 }, (_, index) => 19 - index));

    const floats = new FloatBuffer(1);
    floats.write3(1, 2, 3);
    floats.padToElementAlignment(4);
    floats.writeArray([5, 6, 7], 1, 2);
    assert.deepEqual([...floats.view()], [1, 2, 3, 0, 6, 7]);
    assert.equal(floats.byteLength, 24);
    floats.reset();
    assert.equal(floats.length, 0);

    const u16 = new Uint16Buffer(1);
    u16.write(65_535);
    assert.deepEqual([...u16.view()], [65_535]);
    const u32 = new Uint32Buffer(1);
    u32.write3(1, 2, 3);
    assert.deepEqual([...u32.view()], [1, 2, 3]);

    const arena = new FloatArena(8);
    assert.equal(arena.allocate(3), 0);
    assert.equal(arena.allocate(1), 4);
    assert.equal(arena.usedFloats, 8);
    assert.throws(() => arena.allocate(1), /FloatArena overflow/);
    arena.rewind();
    assert.equal(arena.usedBytes, 0);
  });
});

group("platform", () => {
  test("detects the headless runtime and returns an actionable unsupported WebGPU probe", async () => {
    const platform = detectPlatform();
    assert.equal(platform.hasDom, false);
    assert.equal(platform.browser, "node");
    assert.equal(platform.os, "linux");
    assert.equal(platform.devicePixelRatio, 1);
    assert.equal(platform.hasWasm, true);
    assert.equal(platform.isSecureContext, true);

    const probe = await probeWebGPU();
    assert.equal(probe.supported, false);
    assert.equal(probe.adapter, null);
    assert.match(probe.reason ?? "", /navigator\.gpu is undefined/);
  });
});

await finish();
