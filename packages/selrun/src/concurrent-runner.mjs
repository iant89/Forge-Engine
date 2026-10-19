import { spawn } from "node:child_process";
import * as path from "node:path";

/** Run isolated test processes with bounded concurrency, preserving manifest-order output. */
export async function runSuitesConcurrent(files, options = {}) {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("concurrency must be an integer from 1 to 16");
  }
  const root = path.resolve(options.root ?? process.cwd());
  const startedAt = performance.now();
  const results = new Array(files.length);
  let next = 0;
  let completed = 0;
  console.log(`\nSelrun · running ${files.length} suites (isolated processes, concurrency ${concurrency})`);
  console.log("────────────────────────────────────────────────────────────");

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      results[index] = await runOne(root, files[index]);
      completed++;
      if (completed % 10 === 0 || completed === files.length) {
        console.log(`  progress ${completed}/${files.length} suites complete`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));

  let failed = 0;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    console.log(`\n[${index + 1}/${files.length}] ${result.file}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const duration = formatDuration(result.durationMs);
    if (result.status !== 0 || result.error) {
      failed++;
      console.log(`  ✗ SUITE FAILED  ${duration}${result.error ? ` · ${result.error}` : ""}`);
    } else {
      console.log(`  ✓ SUITE PASSED  ${duration}`);
    }
  }
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`Suite summary  ✓ ${files.length - failed} passed   ✗ ${failed} failed`);
  console.log(`Total duration ${formatDuration(performance.now() - startedAt)}`);
  return failed === 0 ? 0 : 1;
}

function runOne(root, file) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let error = null;
    const absolute = path.resolve(root, file);
    const child = spawn(process.execPath, ["--import", "tsx", absolute], {
      cwd: root,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tests/tsconfig.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (cause) => { error = cause; });
    child.on("close", (status) => {
      resolve({
        file,
        status: status ?? 1,
        error: error?.message ?? null,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
      });
    });
  });
}

function formatDuration(milliseconds) {
  return milliseconds < 1_000 ? `${milliseconds.toFixed(0)} ms` : `${(milliseconds / 1_000).toFixed(2)} s`;
}
