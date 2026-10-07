import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const tool = path.join(root, "tools", "pr-checks.mjs");
const tempDirs: string[] = [];

const sampleOutput = [
  "CPU gates\tpass\t1m18s\thttps://github.com/iant89/Forge-Engine/actions/runs/37655058647/job/112907954406",
  "WebGPU browser gate (advisory)\tpending\t0\thttps://github.com/iant89/Forge-Engine/actions/runs/37655058647/job/112907953892",
].join("\n");

function runDashboard(
  output: string,
  options: { exitCode?: number; color?: boolean; once?: boolean; interval?: number; firstOutput?: string } = {},
) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-pr-checks-test-"));
  tempDirs.push(tempDir);
  const fakeGh = path.join(tempDir, "gh");
  const argsFile = path.join(tempDir, "gh-args.json");
  const callsFile = path.join(tempDir, "gh-calls.txt");
  fs.writeFileSync(
    fakeGh,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.FORGE_TEST_GH_ARGS, JSON.stringify(process.argv.slice(2)));',
      'const count = fs.existsSync(process.env.FORGE_TEST_GH_CALLS) ? Number(fs.readFileSync(process.env.FORGE_TEST_GH_CALLS, "utf8")) + 1 : 1;',
      'fs.writeFileSync(process.env.FORGE_TEST_GH_CALLS, String(count));',
      'const first = process.env.FORGE_TEST_GH_FIRST_OUTPUT;',
      'process.stdout.write(count === 1 && first !== undefined ? first : process.env.FORGE_TEST_GH_OUTPUT || "");',
      'process.stderr.write(process.env.FORGE_TEST_GH_STDERR || "");',
      'process.exitCode = Number(process.env.FORGE_TEST_GH_EXIT || "0");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(
    process.execPath,
    [
      tool,
      "68",
      ...(options.once === false ? ["--watch", "--interval", String(options.interval ?? 1)] : ["--once"]),
      "--repo",
      "iant89/Forge-Engine",
      ...(options.color ? ["--color"] : []),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        FORGE_TEST_GH_ARGS: argsFile,
        FORGE_TEST_GH_CALLS: callsFile,
        FORGE_TEST_GH_OUTPUT: output,
        ...(options.firstOutput === undefined ? {} : { FORGE_TEST_GH_FIRST_OUTPUT: options.firstOutput }),
        FORGE_TEST_GH_EXIT: String(options.exitCode ?? 0),
        NO_COLOR: "1",
      },
    },
  );

  const args = fs.existsSync(argsFile) ? (JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[]) : [];
  const calls = fs.existsSync(callsFile) ? Number(fs.readFileSync(callsFile, "utf8")) : 0;
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    args,
    calls,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pull-request checks dashboard", () => {
  it("formats passed and advisory-pending jobs with the repository, PR, and job IDs", () => {
    const result = runDashboard(sampleOutput, { color: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.args).toEqual(["pr", "checks", "68", "--repo", "iant89/Forge-Engine"]);
    expect(result.stdout).toContain("-- [ GH PULL-REQUEST CHECKS ] --");
    expect(result.stdout).toContain("REPOSITORY: iant89/Forge-Engine");
    expect(result.stdout).toContain("PR ID: 68");
    expect(result.stdout).toContain("\u001b[32m✓\u001b[0m CPU GATES (ID 112907954406)");
    expect(result.stdout).toContain("\u001b[32mPASSED (1m18s)\u001b[0m");
    expect(result.stdout).toContain("[ADVISORY]");
    expect(result.stdout).toContain("- WEBGPU BROWSER GATE (ID 112907953892)");
    expect(result.stdout).toContain("RUNNING...");
  });

  it("renders failed gates with a red cross and exits unsuccessfully", () => {
    const failure =
      "CPU gates\tfail\t1m18s\thttps://github.com/iant89/Forge-Engine/actions/runs/37655058647/job/112907954406";
    const result = runDashboard(failure, { exitCode: 1, color: true });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("\u001b[31m✗\u001b[0m CPU GATES (ID 112907954406)");
    expect(result.stdout).toContain("\u001b[31mFAILED (1m18s)\u001b[0m");
    expect(result.stdout).toContain("ONE-SHOT SNAPSHOT");
  });

  it("polls pending checks again and stops after the last check passes", () => {
    const pending =
      "CPU gates\tpending\t0\thttps://github.com/iant89/Forge-Engine/actions/runs/37655058647/job/112907954406";
    const passed =
      "CPU gates\tpass\t1m18s\thttps://github.com/iant89/Forge-Engine/actions/runs/37655058647/job/112907954406";
    const result = runDashboard(passed, { once: false, interval: 1, firstOutput: pending });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls, result.stdout).toBe(2);
    expect(result.stdout).toContain("REFRESHING IN 1 SECOND");
    expect(result.stdout).toContain("RUNNING...");
    expect(result.stdout).toContain("PASSED (1m18s)");
    expect(result.stdout).toContain("ALL CHECKS COMPLETED");
  });
});
