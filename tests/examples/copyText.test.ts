/**
 * @suite examples:copyText
 * @group unit
 * @covers examples/src/diag/copyText.ts
 * @covers examples/src/diag/errorReport.ts
 * @desc Pins the diagnostic clipboard path: Async Clipboard is called synchronously, a missing or rejecting clipboard falls back to a hidden textarea + execCommand copy, and the GPU error report includes the displayed error plus build/runtime/engine context
 */

export const suite = {
  name: "examples:copyText",
  group: "unit",
  covers: [
    "examples/src/diag/copyText.ts",
    "examples/src/diag/errorReport.ts",
  ],
  desc: "Pins the diagnostic clipboard path: Async Clipboard is called synchronously, a missing or rejecting clipboard falls back to a hidden textarea + execCommand copy, and the GPU error report includes the displayed error plus build/runtime/engine context",
};

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish, group, test } from "selrun";
import { copyText, type CopyEnv } from "../../examples/src/diag/copyText.js";
import { buildGpuErrorReport } from "../../examples/src/diag/errorReport.js";

function fakeDoc(execResult: boolean | "throw") {
  const log: string[] = [];
  const area: Record<string, unknown> = {
    style: {},
    setAttribute: () => {},
    focus: () => log.push("focus"),
    select: () => log.push("select"),
    setSelectionRange: (a: number, b: number) => log.push(`range ${a}-${b}`),
  };
  let attached = 0;
  const document = {
    createElement: () => area,
    execCommand: (cmd: string) => {
      log.push(`exec ${cmd} value=${String(area.value)} readOnly=${String(area.readOnly)} ce=${String(area.contentEditable)}`);
      if (execResult === "throw") throw new Error("nope");
      return execResult;
    },
    body: { appendChild: () => { attached++; }, removeChild: () => { attached--; } },
  } as unknown as CopyEnv["document"];
  return { document, log, attached: () => attached };
}

group("diag Copy button clipboard", () => {
  test("clipboard success resolves true without touching the fallback, and writeText is called synchronously", async () => {
    const d = fakeDoc(true);
    const written: string[] = [];
    const p = copyText("build abc1234", { clipboard: { writeText: async (t) => { written.push(t); } }, document: d.document });
    assert.deepEqual(written, ["build abc1234"], "writeText must run before the first await (iOS gesture)");
    assert.equal(await p, true);
    assert.deepEqual(d.log, []);
  });

  test("clipboard rejection falls back to textarea + setSelectionRange + execCommand('copy')", async () => {
    const d = fakeDoc(true);
    const ok = await copyText("report", { clipboard: { writeText: () => Promise.reject(new Error("NotAllowed")) }, document: d.document });
    assert.equal(ok, true);
    assert.ok(d.log.includes("range 0-6"));
    assert.ok(d.log.includes("exec copy value=report readOnly=true ce=true"));
    assert.equal(d.attached(), 0, "the hidden textarea is removed");
  });

  test("no clipboard API uses the fallback; a failing execCommand reports false", async () => {
    const d = fakeDoc(false);
    assert.equal(await copyText("x", { clipboard: null, document: d.document }), false);
    const t = fakeDoc("throw");
    assert.equal(await copyText("x", { clipboard: { writeText: () => { throw new Error("sync"); } }, document: t.document }), false);
    assert.equal(t.attached(), 0);
  });

  test("the GPU error dialog wires a labeled Copy button to success/failure feedback", () => {
    const html = readFileSync(new URL("../../examples/index.html", import.meta.url), "utf8");
    const main = readFileSync(new URL("../../examples/src/main.ts", import.meta.url), "utf8");
    assert.match(html, /<button type="button" id="error-copy">Copy error \+ debug info<\/button>/);
    assert.match(html, /id="error-copy-status" aria-live="polite"/);
    assert.match(main, /errorCopyButton\.addEventListener\("click"/);
    assert.match(main, /copyText\(buildCurrentErrorReport\(\),/);
    assert.match(main, /clipboard: navigator\.clipboard \?\? null/);
    assert.match(main, /Copied error and debug information/);
    assert.match(main, /Copy failed — select the dialog text manually/);
  });

  test("GPU error reports keep the displayed error and useful runtime context together", () => {
    const report = buildGpuErrorReport({
      error: "GPUValidationError: bind group layout mismatch",
      build: "test-build",
      capturedAt: "2026-10-23T12:00:00.000Z",
      page: {
        url: "https://example.test/?scene=vehicle",
        referrer: "https://example.test/",
        userAgent: "TestBrowser/1.0",
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        scene: "vehicle",
        platform: "chrome/linux",
        secureContext: true,
        hardwareConcurrency: 8,
      },
      engine: {
        stats: { frame: 42, gpuErrors: 3, deviceFatal: false },
        gpu: { format: "bgra8unorm", timestampQuery: true },
      },
    });
    assert.ok(report.includes("GPUValidationError: bind group layout mismatch"));
    assert.ok(report.includes('"build": "test-build"'));
    assert.ok(report.includes('"scene": "vehicle"'));
    assert.ok(report.includes('"frame": 42'));
    assert.ok(report.includes('"gpuErrors": 3'));
    assert.ok(report.includes('"format": "bgra8unorm"'));
  });
});

finish();
