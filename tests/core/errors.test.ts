/**
 * @suite core:errors
 * @group unit
 * @covers engine/src/core/errors.ts
 * @covers engine/src/index.ts
 * @desc Phase 27.1 runtime evidence for the first approved API batch: public errors and assertions
 */

export const suite = {
  name: "core:errors",
  group: "unit",
  covers: ["engine/src/core/errors.ts", "engine/src/index.ts"],
  desc: "Phase 27.1 runtime evidence for the first approved API batch: public errors and assertions",
};

import assert from "node:assert/strict";
import {
  AssetError,
  CapabilityError,
  ForgeError,
  InlineOnlyError,
  InternalError,
  ObjectDisposedError,
  ResourceLifecycleError,
  UnsupportedPlatformError,
  UsageError,
  assert as forgeAssert,
  assertDefined,
  assertInRange,
  assertInt,
  assertNever,
  assertPositive,
  assertionsEnabledValue,
  setAssertionsEnabled,
} from "@forge/engine";
import { finish, group, test } from "selrun";

group("approved error taxonomy", () => {
  test("ForgeError exposes a stable machine code, details and concrete class name", () => {
    const details = { operation: "probe" };
    const error = new ForgeError("failed", "E_PROBE", details);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "ForgeError");
    assert.equal(error.message, "failed");
    assert.equal(error.code, "E_PROBE");
    assert.equal(error.details, details);
    assert.equal(new ForgeError("default").code, "E_FORGE");
  });

  test("caller, capability and platform failures preserve their inheritance and codes", () => {
    const details = { requested: "feature" };
    const usage = new UsageError("bad call", details);
    assert.ok(usage instanceof ForgeError);
    assert.equal(usage.code, "E_USAGE");
    assert.equal(usage.details, details);

    const capability = new CapabilityError("missing", details);
    assert.ok(capability instanceof ForgeError);
    assert.equal(capability.code, "E_CAPABILITY");
    assert.equal(capability.details, details);

    const platform = new UnsupportedPlatformError("no WebGPU", details);
    assert.ok(platform instanceof CapabilityError);
    assert.equal(platform.name, "UnsupportedPlatformError");
    assert.equal(platform.code, "E_CAPABILITY");
    assert.equal(platform.details, details);
  });

  test("asset, lifecycle, internal, disposal and inline-only failures keep their public payloads", () => {
    const asset = new AssetError("decode failed", "scene.glb");
    assert.ok(asset instanceof ForgeError);
    assert.equal(asset.code, "E_ASSET");
    assert.equal(asset.url, "scene.glb");
    assert.equal(new AssetError("decode failed", "scene.glb", "E_ASSET_GLTF").code, "E_ASSET_GLTF");

    assert.equal(new ResourceLifecycleError("released").code, "E_RESOURCE_LIFECYCLE");
    assert.equal(new InternalError("invariant").code, "E_INTERNAL");

    const disposed = new ObjectDisposedError("Texture atlas");
    assert.equal(disposed.code, "E_DISPOSED");
    assert.equal(disposed.message, "Texture atlas has been disposed and cannot be used.");

    const inline = new InlineOnlyError();
    assert.equal(inline.code, "E_INLINE_ONLY");
    assert.equal(inline.message, "task handler requires the main thread");
    assert.equal(new InlineOnlyError("DOM required").message, "DOM required");
  });
});

group("approved assertion helpers", () => {
  test("assert throws InternalError with details while checks are enabled", () => {
    setAssertionsEnabled(true);
    assert.equal(assertionsEnabledValue(), true);
    assert.doesNotThrow(() => forgeAssert({ ready: true }, "ready"));
    assert.throws(
      () => forgeAssert(false, "broken invariant", { entity: 7 }),
      (error: unknown) => error instanceof InternalError
        && error.code === "E_INTERNAL"
        && error.message === "broken invariant ({\"entity\":7})",
    );
  });

  test("disabled invariant checks report instead of throwing and the switch is observable", () => {
    const originalConsoleError = console.error;
    const messages: string[] = [];
    try {
      console.error = (...parts: unknown[]) => { messages.push(parts.map(String).join(" ")); };
      setAssertionsEnabled(false);
      assert.equal(assertionsEnabledValue(), false);
      assert.doesNotThrow(() => forgeAssert(false, "recoverable frame"));
      assert.deepEqual(messages, ["[forge:assert-disabled] recoverable frame"]);
    } finally {
      setAssertionsEnabled(true);
      console.error = originalConsoleError;
    }
    assert.equal(assertionsEnabledValue(), true);
  });

  test("defined, positive, range and integer guards accept boundaries and reject invalid values", () => {
    const value = { id: 4 };
    assert.equal(assertDefined(value, "value"), value);
    assert.throws(() => assertDefined(undefined, "value"), UsageError);
    assert.throws(() => assertDefined(null, "value"), UsageError);

    assert.doesNotThrow(() => assertPositive("speed", Number.MIN_VALUE));
    assert.throws(() => assertPositive("speed", 0), UsageError);
    assert.throws(() => assertPositive("speed", Number.POSITIVE_INFINITY), UsageError);

    assert.doesNotThrow(() => assertInRange("mix", 0, 0, 1));
    assert.doesNotThrow(() => assertInRange("mix", 1, 0, 1));
    assert.throws(() => assertInRange("mix", -0.1, 0, 1), UsageError);
    assert.throws(() => assertInRange("mix", Number.NaN, 0, 1), UsageError);

    assert.doesNotThrow(() => assertInt("count", -2));
    assert.throws(() => assertInt("count", 1.5), UsageError);
  });

  test("assertNever always reports the missing exhaustive case as an internal error", () => {
    assert.throws(
      () => assertNever("future-case" as never, "mode switch"),
      (error: unknown) => error instanceof InternalError
        && error.message === "mode switch: unexpected value future-case",
    );
  });
});

await finish();
