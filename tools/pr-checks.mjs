#!/usr/bin/env node
/**
 * Render `gh pr checks` as a compact, live-updating pull-request dashboard.
 *
 * Usage: node tools/pr-checks.mjs <pr-number> [--interval <seconds>] [--repo <owner/name>] [--once]
 *
 * GitHub CLI versions do not all support JSON output for `gh pr checks`, so this polls its stable
 * one-shot table output rather than trying to scrape the CLI's own watch animation. In a TTY the
 * dashboard is repainted in place; redirected output gets one plain snapshot per poll.
 */

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const GH_STATES = [
  "startup_failure",
  "startup failure",
  "action_required",
  "action required",
  "in_progress",
  "in progress",
  "timed_out",
  "timed out",
  "cancelled",
  "canceled",
  "skipping",
  "success",
  "successful",
  "failure",
  "failed",
  "fail",
  "pass",
  "pending",
  "queued",
  "waiting",
  "requested",
  "expected",
  "running",
  "skipped",
  "skip",
  "cancel",
  "neutral",
  "error",
  "completed",
];
const STATE_PATTERN = GH_STATES
  .sort((a, b) => b.length - a.length)
  .map((state) => state.replace(/ /g, "\\s+"))
  .join("|");
const CHECK_ROW = new RegExp(
  `^(.+?)\\s+(${STATE_PATTERN})\\s+(\\S+)(?:\\s+(https?:\\/\\/\\S+))?\\s*$`,
  "i",
);

function usage() {
  return [
    "Usage: npm run pr:checks -- <pr-number> [options]",
    "       node tools/pr-checks.mjs <pr-number> [options]",
    "",
    "Options:",
    "  --interval, -i <seconds>  Refresh interval (default: 15; minimum: 1)",
    "  --repo, -R <owner/name>   Use a specific GitHub repository",
    "  --watch                   Watch until checks finish (default)",
    "  --once                    Print one snapshot and exit",
    "  --color / --no-color      Force or disable ANSI colors",
    "  --help, -h                Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    pr: null,
    interval: 15,
    repo: null,
    once: false,
    color: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--watch") {
      // Watching is the default; accept gh's explicit flag for drop-in command-line familiarity.
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--color") {
      options.color = true;
    } else if (arg === "--no-color") {
      options.color = false;
    } else if (arg === "--interval" || arg === "-i") {
      options.interval = Number(argv[++i]);
    } else if (arg.startsWith("--interval=")) {
      options.interval = Number(arg.slice("--interval=".length));
    } else if (arg === "--repo" || arg === "-R") {
      options.repo = argv[++i] ?? null;
    } else if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    } else if (options.pr === null) {
      options.pr = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n\n${usage()}`);
    }
  }

  if (options.help) return options;
  if (!options.pr || !/^\d+$/.test(options.pr) || Number(options.pr) < 1) {
    throw new Error(`A positive pull-request number is required.\n\n${usage()}`);
  }
  if (!Number.isInteger(options.interval) || options.interval < 1) {
    throw new Error("The refresh interval must be a whole number of at least 1 second.");
  }
  if (options.repo !== null && !options.repo.trim()) {
    throw new Error("The repository name cannot be empty.");
  }
  return options;
}

function resolveRepo() {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (remote.status !== 0 || !remote.stdout.trim()) return null;

  const match = remote.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE, "");
}

function checkIdFromUrl(url) {
  if (!url) return null;
  const jobId = url.match(/\/job\/(\d+)(?:[/?#]|$)/i)?.[1];
  if (jobId) return jobId;
  return url.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? null;
}

/** Parse the four useful columns from the table printed by `gh pr checks`. */
function parseChecks(output) {
  const checks = [];
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(CHECK_ROW);
    if (!match) continue;

    const [, rawName, rawState, elapsed, url = ""] = match;
    const name = rawName.trim();
    if (!name || /^name$/i.test(name)) continue;
    checks.push({
      name,
      state: rawState.trim().toLowerCase().replace(/[\s-]+/g, "_"),
      elapsed: elapsed.trim(),
      url: url.trim(),
      id: checkIdFromUrl(url.trim()),
    });
  }
  return checks;
}

function describeState(state) {
  if (["pass", "passed", "success", "successful", "completed"].includes(state)) {
    return { kind: "passed", symbol: "✓", color: "green", label: "PASSED", failed: false };
  }
  if (
    [
      "fail",
      "failed",
      "failure",
      "error",
      "timed_out",
      "startup_failure",
      "action_required",
    ].includes(state)
  ) {
    return { kind: "failed", symbol: "✗", color: "red", label: "FAILED", failed: true };
  }
  if (["pending", "in_progress", "queued", "waiting", "requested", "expected", "running"].includes(state)) {
    return { kind: "running", symbol: "…", color: "yellow", label: "RUNNING...", failed: false };
  }
  if (["cancel", "cancelled", "canceled"].includes(state)) {
    return { kind: "cancelled", symbol: "!", color: "yellow", label: "CANCELLED", failed: false };
  }
  if (["skip", "skipped", "skipping"].includes(state)) {
    return { kind: "skipped", symbol: "–", color: "dim", label: "SKIPPED", failed: false };
  }
  if (state === "neutral") {
    return { kind: "neutral", symbol: "–", color: "dim", label: "NEUTRAL", failed: false };
  }
  return {
    kind: "unknown",
    symbol: "?",
    color: "yellow",
    label: state.replace(/_/g, " ").toUpperCase() || "UNKNOWN",
    failed: false,
  };
}

function shouldUseColor(option) {
  if (option !== null) return option;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
}

function paint(value, color, enabled) {
  if (!enabled) return value;
  const codes = { green: 32, red: 31, yellow: 33, dim: 2 };
  return `\u001b[${codes[color] ?? 0}m${value}\u001b[0m`;
}

function checkPresentation(check) {
  const advisory = /\badvisory\b/i.test(check.name);
  const name = check.name
    .replace(/\s*\(?\s*advisory\s*\)?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  const state = describeState(check.state);
  const elapsed = check.elapsed && check.elapsed !== "0" ? ` (${check.elapsed})` : "";
  let detail = state.label;
  if (state.kind === "passed" || state.kind === "failed" || state.kind === "cancelled") {
    detail += elapsed;
  }
  // Pending advisory checks use the bullet shown in the requested layout. Completed advisory
  // checks get the same green/red result marker as required checks.
  const symbol = advisory && state.kind === "running" ? "-" : state.symbol;
  return {
    advisory,
    name: name || check.name.toUpperCase(),
    id: check.id,
    symbol,
    symbolColor: advisory && state.kind === "running" ? null : state.color,
    detail,
    color: state.color,
  };
}

function dashboardLines({ repo, pr, checks, footer, seconds, color }) {
  const presented = checks.map((check) => ({ view: checkPresentation(check) }));
  const required = presented.filter(({ view }) => !view.advisory);
  const advisory = presented.filter(({ view }) => view.advisory);
  const lines = [
    " -- [ GH PULL-REQUEST CHECKS ] --",
    "",
    `\tREPOSITORY: ${repo ?? "(unknown)"}`,
    `\t     PR ID: ${pr}`,
    "",
  ];

  const addGroup = (group) => {
    for (const { view } of group) {
      const id = view.id ? ` (ID ${view.id})` : "";
      const symbol = view.symbolColor ? paint(view.symbol, view.symbolColor, color) : view.symbol;
      lines.push(`\t${symbol} ${view.name}${id}`);
      lines.push(`\t  - ${paint(view.detail, view.color, color)}`);
      lines.push("");
    }
  };

  addGroup(required);
  if (advisory.length > 0) {
    lines.push("\t[ADVISORY]");
    addGroup(advisory);
  }
  if (checks.length === 0) lines.push("\tNo checks found.\n");

  if (footer === "refresh") {
    const unit = seconds === 1 ? "SECOND" : "SECONDS";
    lines.push(`  ** REFRESHING IN ${seconds} ${unit} **`);
  } else if (footer === "once") {
    lines.push("  ** ONE-SHOT SNAPSHOT **");
  } else if (footer === "failed") {
    lines.push("  ** CHECKS COMPLETED WITH FAILURES **");
  } else {
    lines.push("  ** ALL CHECKS COMPLETED **");
  }
  lines.push(" --------------------------------");
  return lines;
}

function render({ repo, pr, checks, footer, seconds, color, tty }) {
  const lines = dashboardLines({ repo, pr, checks, footer, seconds, color });
  if (tty) process.stdout.write("\u001b[H\u001b[J");
  process.stdout.write(`${lines.join("\n")}\n`);
  return true;
}

function runGhChecks(pr, repo) {
  const args = ["pr", "checks", pr];
  if (repo) args.push("--repo", repo);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("gh", args, {
      cwd: REPO_ROOT,
      env: { ...process.env, GH_PAGER: "cat", PAGER: "cat" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

let activeChild = null;
let cancelWait = null;
let interrupted = false;

function interrupt() {
  interrupted = true;
  if (activeChild && !activeChild.killed) activeChild.kill("SIGINT");
  cancelWait?.();
}

function waitOneSecond() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancelWait = null;
      resolve(true);
    }, 1000);
    cancelWait = () => {
      clearTimeout(timer);
      cancelWait = null;
      resolve(false);
    };
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const repo = options.repo?.trim() ?? resolveRepo();
  const tty = Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
  const color = shouldUseColor(options.color);
  let rendered = false;
  if (tty) process.stdout.write("\u001b[?25l");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  try {
    while (!interrupted) {
      const result = await runGhChecks(options.pr, repo);
      if (interrupted) break;

      const checks = parseChecks(`${result.stdout}\n${result.stderr}`);
      if (checks.length === 0 && result.code !== 0) {
        const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
        throw new Error(`gh pr checks failed: ${reason}`);
      }
      const hasFailure = checks.some((check) => describeState(check.state).failed);

      if (options.once) {
        rendered = render({ repo, pr: options.pr, checks, footer: "once", color, tty });
        process.exitCode = hasFailure ? 1 : 0;
        break;
      }

      const allComplete = checks.every((check) => describeState(check.state).kind !== "running");
      if (allComplete) {
        rendered = render({
          repo,
          pr: options.pr,
          checks,
          footer: hasFailure ? "failed" : "complete",
          color,
          tty,
        });
        process.exitCode = hasFailure ? 1 : 0;
        break;
      }

      for (let seconds = options.interval; seconds > 0 && !interrupted; seconds--) {
        if (tty || seconds === options.interval) {
          rendered = render({
            repo,
            pr: options.pr,
            checks,
            footer: "refresh",
            seconds,
            color,
            tty,
          });
        }
        if (!(await waitOneSecond())) break;
      }
    }
  } catch (error) {
    if (!interrupted) {
      if (tty && rendered) process.stdout.write("\u001b[H\u001b[J");
      console.error(`pr-checks: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (tty) process.stdout.write("\u001b[?25h");
    if (interrupted) {
      process.exitCode = 130;
      process.stdout.write("\n");
    }
  }
}

await main();
