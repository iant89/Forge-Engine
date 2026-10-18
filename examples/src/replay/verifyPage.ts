/**
 * replay-verify.html (Phase 19.5): runs the cross-engine replay checks in this browser and shows the
 * verdict, so a phone or a Safari install — engines CI cannot run — can be checked by opening a page.
 */

import type { VerifyPageResult } from "./verifyWorker.js";

const verdict = document.getElementById("verdict")!;
const rows = document.getElementById("rows") as HTMLTableElement;
const json = document.getElementById("json") as HTMLTextAreaElement;

function row(label: string, value: string, good?: boolean): void {
  const tr = rows.insertRow();
  tr.insertCell().textContent = label;
  const td = tr.insertCell();
  td.textContent = value;
  if (good !== undefined) td.className = good ? "ok" : "bad";
}

function show(r: VerifyPageResult): void {
  rows.innerHTML = "";
  verdict.className = r.ok ? "pass" : "fail";
  verdict.textContent = r.ok ? "PASS — identical state hashes" : "FAIL";
  row("browser", navigator.userAgent);
  if (r.error) {
    row("error", r.error, false);
  } else {
    row("DMath digest", `${r.dmathDigest} (pinned ${r.dmathExpected})`, r.dmathDigest === r.dmathExpected);
    row("replay", `${r.frames} frames, ${r.checkpoints} checkpoint hashes, ${r.divergences.length} divergences`, r.divergences.length === 0);
    row("expected final hash", r.expectedFinal);
    row("live re-run", r.rerunFinal, r.rerunFinal === r.expectedFinal);
    row("resumed from a mid-session save", r.resumedFinal, r.resumedFinal === r.expectedFinal);
    row("engine-dependent Math calls", String(r.approximatedCalls), r.approximatedCalls === 0);
    row("time", `${(r.ms / 1000).toFixed(1)} s`);
    if (r.divergences.length) row("first divergence", JSON.stringify(r.divergences[0]), false);
  }
  json.value = JSON.stringify({ userAgent: navigator.userAgent, ...r }, null, 2);
}

function start(): void {
  verdict.className = "run";
  verdict.textContent = "Running…";
  rows.innerHTML = "";
  const worker = new Worker(new URL("./verifyWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<VerifyPageResult>) => {
    show(e.data);
    worker.terminate();
  };
  worker.onerror = (e) => {
    show({ ok: false, error: e.message || "worker failed to start" } as VerifyPageResult);
    worker.terminate();
  };
  worker.postMessage("run");
}

document.getElementById("copy")!.addEventListener("click", () => {
  json.select();
  void navigator.clipboard?.writeText(json.value).catch(() => document.execCommand("copy"));
});
document.getElementById("again")!.addEventListener("click", start);
start();
