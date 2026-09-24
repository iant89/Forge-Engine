/**
 * Regression pin for the production "worker N crashed: unknown" failure.
 *
 * The scheduler's default browser worker is only *bundled* by build tools when it is declared in
 * the one shape they statically recognise — `new Worker(new URL("./worker-entry.js",
 * import.meta.url), …)`, URL inline as the first `Worker` constructor argument (Vite's
 * worker-import-meta-url plugin, webpack, esbuild). When the URL was instead computed through a
 * `workerUrl` variable, bundlers matched `new URL(..., import.meta.url)` as a plain *asset*
 * reference: the production demo inlined worker-entry's raw TypeScript source as a
 * `data:video/mp2t;base64` URL, the worker died parsing it in every browser, and because worker
 * script failures surface as `error` events with no message (WebKit; Chromium for module workers)
 * the log read "worker N crashed: unknown" while the scheduler silently fell back to inline.
 *
 * The unit suite runs exclusively through `createWorker`/`workerUrl` (there is no bundler in
 * Node), so this contract is pinned on the scheduler's source the way a bundler reads it: the
 * canonical shape must exist verbatim, and the entry file it names must exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schedulerPath = fileURLToPath(new URL("../engine/src/core/tasks/scheduler.ts", import.meta.url));

describe("worker bundling contract", () => {
  it("constructs the default worker as `new Worker(new URL(\"./worker-entry.js\", import.meta.url), …)` — the only shape bundlers bundle", () => {
    const source = readFileSync(schedulerPath, "utf8");
    // Whitespace-tolerant (formatting may change); the specifier and its position must not.
    const canonical = /new\s+Worker\s*\(\s*new\s+URL\s*\(\s*["']\.\/worker-entry\.js["']\s*,\s*import\.meta\.url\s*\)\s*,/;
    expect(
      canonical.test(source),
      "scheduler.ts lost the literal `new Worker(new URL(\"./worker-entry.js\", import.meta.url), …)` shape. " +
        "Bundlers only emit a compiled worker chunk for that exact pattern; computing the URL through a variable " +
        "makes them inline the raw .ts source as an asset URL instead, and the worker crashes on parse " +
        "(reported as 'worker N crashed: unknown').",
    ).toBe(true);
  });

  it("worker-entry.ts exists next to scheduler.ts — the specifier above must resolve", () => {
    const entryPath = fileURLToPath(new URL("../engine/src/core/tasks/worker-entry.ts", import.meta.url));
    expect(existsSync(entryPath), "engine/src/core/tasks/worker-entry.ts was renamed or moved; update the scheduler's default worker URL").toBe(
      true,
    );
  });
});
