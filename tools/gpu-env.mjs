/**
 * `tools/gpu-env.mjs` — how a headless Chromium is given a WebGPU adapter.
 *
 * Chromium's Linux builds can ship their whole software Vulkan stack next to the binary
 * (`libvulkan.so.1`, `libvk_swiftshader.so`, `vk_swiftshader_icd.json`). The @sparticuz/chromium
 * payload that `scripts/setup-deps.sh` extracts into the temp dir does exactly that. When those files
 * are there, that is the ICD to use: nothing has to be installed system-wide, and the ICD belongs to
 * the browser being launched. When they are not there, the system Vulkan loader finds the machine's
 * own ICDs by itself (Mesa's lavapipe, which `scripts/setup-deps.sh` installs) and no environment
 * variable is needed at all.
 *
 * This module is the single place that decides which of the two applies, so the gate that launches
 * the browser (`tools/browser-check.mjs`), the script that provisions the machine
 * (`scripts/setup-deps.sh`) and the test that pins the rule (`tests/gpuEnv.test.ts`) cannot drift
 * apart. Getting this wrong is not subtle: with no ICD the page still boots, `navigator.gpu` still
 * exists, and `requestAdapter()` quietly returns null.
 *
 * CLI:
 *   node tools/gpu-env.mjs --chromium <path> [--extra-lib <dir>]... [--json]
 *
 * `--json` is what the scripts consume (without `env`, which is the caller's environment plus the
 * `additions` and has no business in a log); the default output is the same thing for a human to read.
 * The discovered values come from the *path* of a browser binary, so this runs before any launch —
 * and it never fails: a path that does not exist simply has no bundled ICD.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The loader names tried next to the browser binary (some builds ship only the versioned soname). */
const LOADER_NAMES = ["libvulkan.so.1", "libvulkan.so"];

/** Chromium's own software ICD, written to point at `libvk_swiftshader.so` in the same directory. */
const BUNDLED_ICD_NAMES = ["vk_swiftshader_icd.json"];

/** Where distro packages put the Vulkan loader, for the "is this machine able to present WebGPU" answer. */
const SYSTEM_LOADER_PATHS = [
  "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
  "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
  "/usr/lib64/libvulkan.so.1",
  "/usr/lib/libvulkan.so.1",
];

const firstExisting = (dir, names) => {
  if (!dir) return null;
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/** Join PATH-style entries, dropping empties and duplicates while keeping the first occurrence. */
const mergeSearchPath = (entries) => {
  const seen = new Set();
  const parts = [];
  for (const entry of entries) {
    for (const part of String(entry ?? "").split(":")) {
      if (!part || seen.has(part)) continue;
      seen.add(part);
      parts.push(part);
    }
  }
  return parts.join(":");
};

/**
 * The SwiftShader ICD shipped next to `executablePath`, or null when the build does not bundle one.
 * Exported because `scripts/setup-deps.sh` reports it separately from the rest of the environment.
 */
export function swiftShaderIcdFor(executablePath) {
  return firstExisting(executablePath ? path.dirname(executablePath) : null, BUNDLED_ICD_NAMES);
}

/**
 * The Vulkan loader as { path, source }: `bundled` when it sits next to the browser (so it must go on
 * the library search path), `system` when the distro provides one, `none` when neither exists.
 */
export function vulkanLoaderFor(executablePath) {
  const bundled = firstExisting(executablePath ? path.dirname(executablePath) : null, LOADER_NAMES);
  if (bundled) return { path: bundled, source: "bundled" };
  for (const candidate of SYSTEM_LOADER_PATHS) {
    if (existsSync(candidate)) return { path: candidate, source: "system" };
  }
  return { path: null, source: "none" };
}

/**
 * The environment to launch `executablePath` with.
 *
 * Precedence, deliberately: an ICD already named by the caller's environment wins (that is how a
 * developer points the gate at an ICD of their choosing, and it keeps the run reproducible when the
 * machine has several), then the browser's own bundled ICD, then the system ICD list the loader
 * discovers on its own — in which case no `VK_*` variable is set at all.
 *
 * `extraLibraryPaths` exist for payloads whose shared libraries live beside the binary rather than in
 * it (the @sparticuz extraction puts fonts and NSS/NSPR in `<dir>/al2023/lib`); they are searched
 * before the binary's own directory, which is the order those payloads document.
 */
export function gpuLaunchEnv({ executablePath = null, env = process.env, extraLibraryPaths = [] } = {}) {
  const directory = executablePath ? path.dirname(executablePath) : null;
  const explicitIcd = env.VK_ICD_FILENAMES || env.VK_DRIVER_FILES || null;
  const bundledIcd = swiftShaderIcdFor(executablePath);
  const icd = explicitIcd ?? bundledIcd;
  const icdSource = explicitIcd ? "environment" : bundledIcd ? "bundled" : "system";
  const loader = vulkanLoaderFor(executablePath);
  const libraryPath = mergeSearchPath([...extraLibraryPaths, directory, env.LD_LIBRARY_PATH]);

  const additions = { LD_LIBRARY_PATH: libraryPath };
  if (icd) {
    additions.VK_ICD_FILENAMES = icd;
    additions.VK_DRIVER_FILES = icd;
  }

  return {
    chromium: executablePath,
    directory,
    icd,
    icdSource,
    loader: loader.path,
    loaderSource: loader.source,
    libraryPath,
    additions,
    env: { ...env, ...additions },
  };
}

export const ICD_SOURCE_TEXT = {
  environment: "from VK_ICD_FILENAMES/VK_DRIVER_FILES",
  bundled: "bundled with the browser",
  system: "the loader's own ICD list (no override)",
};

export const LOADER_SOURCE_TEXT = {
  bundled: "bundled with the browser",
  system: "installed by the distro",
  none: "not found",
};

// --------------------------------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const options = { chromium: null, extraLibraryPaths: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--chromium") options.chromium = argv[++i] ?? null;
    else if (arg === "--extra-lib") options.extraLibraryPaths.push(argv[++i] ?? "");
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else return { error: `unknown option: ${arg}` };
  }
  return options;
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.error || options.help) {
    if (options.error) console.error(options.error);
    console.log("usage: node tools/gpu-env.mjs --chromium <path> [--extra-lib <dir>]... [--json]");
    process.exit(options.error ? 2 : 0);
  }

  const result = gpuLaunchEnv({ executablePath: options.chromium, extraLibraryPaths: options.extraLibraryPaths });

  if (options.json) {
    // `env` is deliberately not printed here: it is the caller's whole environment plus `additions`,
    // and this output goes into logs and pull requests.
    const { env: _env, ...printable } = result;
    console.log(JSON.stringify(printable, null, 2));
  } else {
    console.log(`chromium    ${result.chromium ?? "(none)"}`);
    console.log(`icd         ${result.icd ?? "(none)"} — ${ICD_SOURCE_TEXT[result.icdSource]}`);
    console.log(`loader      ${result.loader ?? "(none)"} — ${LOADER_SOURCE_TEXT[result.loaderSource]}`);
    console.log(`library     ${result.libraryPath || "(empty)"}`);
    for (const [key, value] of Object.entries(result.additions)) console.log(`export ${key}=${value}`);
  }
}
