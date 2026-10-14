/**
 * @suite core:deviceTier
 * @group unit
 * @covers engine/src/core/deviceTier.ts
 * @desc Device capability tier helper: hint gathering, classification, frame-time monitor, adaptive quality
 */

export const suite = {
  name: "core:deviceTier",
  group: "unit",
  covers:   [
    "engine/src/core/deviceTier.ts"
  ],
  desc: "Device capability tier helper: hint gathering, classification, frame-time monitor, adaptive quality",
};
import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AdaptiveDeviceQuality,
  FrameTimeMonitor,
  classifyDeviceTier,
  isMobileUserAgent,
  readDeviceCapabilityHints,
  tierValue,
} from "../../engine/src/core/deviceTier.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

group("hints", () => {
  test("reads navigator + adapter fields and tolerates absent ones", () => {
    const h = readDeviceCapabilityHints(
      { hardwareConcurrency: 8, deviceMemory: 4, userAgent: DESKTOP },
      { limits: { maxTextureDimension2D: 16384, maxStorageBufferBindingSize: 1 << 30 }, info: { vendor: "NVIDIA", architecture: "Ampere", isFallbackAdapter: false } },
    );
    assert.deepEqual(h, { hardwareConcurrency: 8, deviceMemoryGB: 4, mobile: false, maxTextureDimension2D: 16384, maxStorageBufferBindingSize: 1 << 30, gpuVendor: "nvidia", gpuArchitecture: "ampere", isFallbackAdapter: false });
    assert.deepEqual(readDeviceCapabilityHints(null, null), {});
  });
  test("mobile UA detection: UA string, client hints, iPadOS desktop mode", () => {
    assert.equal(isMobileUserAgent({ userAgent: IPHONE }), true);
    assert.equal(isMobileUserAgent({ userAgent: DESKTOP }), false);
    assert.equal(isMobileUserAgent({ userAgent: DESKTOP, userAgentData: { mobile: true } }), true);
    assert.equal(isMobileUserAgent({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 }), true);
    assert.equal(isMobileUserAgent(undefined), false);
  });
});

group("classification", () => {
  test("no evidence → high; strong desktop → high", () => {
    assert.equal(classifyDeviceTier({}).tier, "high");
    assert.equal(classifyDeviceTier({ hardwareConcurrency: 16, deviceMemoryGB: 8, maxTextureDimension2D: 16384 }).tier, "high");
  });
  test("mobile is capped at medium, weak mobile drops to low", () => {
    assert.equal(classifyDeviceTier({ mobile: true, hardwareConcurrency: 8, deviceMemoryGB: 8 }).tier, "medium");
    const weak = classifyDeviceTier({ mobile: true, hardwareConcurrency: 4, deviceMemoryGB: 2 });
    assert.equal(weak.tier, "low");
    assert.ok(weak.reasons.includes("mobile user agent"));
  });
  test("fallback adapter is always low", () => {
    assert.equal(classifyDeviceTier({ hardwareConcurrency: 32, isFallbackAdapter: true }).tier, "low");
  });
  test("tierValue maps tiers", () => {
    assert.equal(tierValue("medium", { low: 1, medium: 2, high: 3 }), 2);
  });
});

group("frame-time monitor", () => {
  test("steps down after sustained slow frames, ignores outliers", () => {
    const m = new FrameTimeMonitor({ budgetMs: 16, downgradeAfterS: 1 });
    for (let i = 0; i < 20; i++) assert.equal(m.sample(1000), 0, "outliers ignored");
    let step = 0;
    let frames = 0;
    while (step === 0 && frames < 500) { step = m.sample(40); frames++; }
    assert.equal(step, -1);
    assert.ok(frames * 0.04 >= 1 && frames * 0.04 < 1.5, `took ${frames} frames`);
  });
  test("steps up after sustained headroom; on-budget frames do nothing", () => {
    const m = new FrameTimeMonitor({ budgetMs: 16, upgradeAfterS: 2 });
    for (let i = 0; i < 600; i++) assert.equal(m.sample(14), 0);
    let step = 0;
    for (let i = 0; i < 1000 && step === 0; i++) step = m.sample(5);
    assert.equal(step, 1);
  });
});

group("adaptive quality", () => {
  test("drops to the floor and climbs back no higher than the starting tier", () => {
    const q = new AdaptiveDeviceQuality({ mobile: true }, { budgetMs: 16, downgradeAfterS: 0.5, upgradeAfterS: 0.5 });
    assert.equal(q.tier, "medium");
    for (let i = 0; i < 200; i++) q.sample(60);
    assert.equal(q.tier, "low");
    for (let i = 0; i < 2000; i++) q.sample(4);
    assert.equal(q.tier, "medium", "never above the starting ceiling");
    assert.equal(q.value({ low: 1.5, medium: 1, high: 0.5 }), 1);
  });
  test("forced initial tier and floor", () => {
    const q = new AdaptiveDeviceQuality({}, { initialTier: "medium", floor: "medium", budgetMs: 16, downgradeAfterS: 0.2 });
    for (let i = 0; i < 500; i++) q.sample(60);
    assert.equal(q.tier, "medium");
    assert.equal(q.changes, 0);
  });
});

await finish();
