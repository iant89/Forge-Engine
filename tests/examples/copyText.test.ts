/**
 * @suite examples:copyText
 * @group unit
 * @covers examples/src/diag/copyText.ts
 * @desc Pins the ?diag=1 Copy button's clipboard path: Async Clipboard is called synchronously, and a missing or rejecting clipboard falls back to a hidden textarea + execCommand copy that works on iOS Safari
 */

export const suite = {
  name: "examples:copyText",
  group: "unit",
  covers: [
    "examples/src/diag/copyText.ts",
  ],
  desc: "Pins the ?diag=1 Copy button's clipboard path: Async Clipboard is called synchronously, and a missing or rejecting clipboard falls back to a hidden textarea + execCommand copy that works on iOS Safari",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { copyText, type CopyEnv } from "../../examples/src/diag/copyText.js";

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
});

finish();
