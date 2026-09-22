import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const tool = path.join(root, "tools", "gpu-env.mjs");

/**
 * `tools/gpu-env.mjs` decides which Vulkan ICD a headless Chromium is launched with, and it runs
 * before any browser exists — so it is testable without one. That matters more than it looks: the
 * failure mode it guards against is silent (`navigator.gpu` present, `requestAdapter()` null), and it
 * is the difference between `npm run check:browser` proving something and reporting "did not run".
 *
 * The tool is driven as a CLI, exactly as `scripts/setup-deps.sh` drives it, so the shell script's
 * contract is tested too, not just the module behind it.
 */
interface GpuEnv {
  chromium: string | null;
  directory: string | null;
  icd: string | null;
  icdSource: "environment" | "bundled" | "system";
  loader: string | null;
  loaderSource: "bundled" | "system" | "none";
  libraryPath: string;
  additions: Record<string, string>;
}

function gpuEnv(chromium: string | null, env: NodeJS.ProcessEnv = {}, extraLibs: string[] = []): GpuEnv {
  const args = [tool, "--json"];
  if (chromium !== null) args.push("--chromium", chromium);
  for (const dir of extraLibs) args.push("--extra-lib", dir);
  const out = execFileSync(process.execPath, args, { cwd: root, encoding: "utf-8", env: { ...process.env, ...env } });
  return JSON.parse(out) as GpuEnv;
}

/** A directory shaped like a Chromium build that ships its own software Vulkan stack. */
function bundledBrowser(dir: string, files = ["chromium", "libvulkan.so.1", "vk_swiftshader_icd.json"]) {
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(path.join(dir, file), file.endsWith(".json") ? "{}" : "binary");
  return path.join(dir, "chromium");
}

describe("tools/gpu-env.mjs — which ICD a headless Chromium gets", () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "forge-gpu-env-"));
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("points VK_ICD_FILENAMES at the ICD bundled next to the browser", () => {
    const browser = bundledBrowser(path.join(work, "bundled"));
    const result = gpuEnv(browser);

    expect(result.icd).toBe(path.join(work, "bundled", "vk_swiftshader_icd.json"));
    expect(result.icdSource).toBe("bundled");
    expect(result.additions.VK_ICD_FILENAMES).toBe(result.icd);
    // Both names are set: the loader reads VK_ICD_FILENAMES, Dawn checks VK_DRIVER_FILES first.
    expect(result.additions.VK_DRIVER_FILES).toBe(result.icd);
    // A bundled loader only exists for the browser if its directory is on the search path.
    expect(result.libraryPath.split(":")).toContain(path.join(work, "bundled"));
    expect(result.loaderSource).toBe("bundled");
  });

  it("keeps an ICD the caller already chose, instead of overriding it", () => {
    const browser = bundledBrowser(path.join(work, "override"));
    const result = gpuEnv(browser, { VK_ICD_FILENAMES: "/custom/icd.json" });

    expect(result.icd).toBe("/custom/icd.json");
    expect(result.icdSource).toBe("environment");
    expect(result.additions.VK_ICD_FILENAMES).toBe("/custom/icd.json");
  });

  it("honours VK_DRIVER_FILES alone, and still spells both names out", () => {
    const browser = bundledBrowser(path.join(work, "driver-files"));
    const result = gpuEnv(browser, { VK_DRIVER_FILES: "/custom/driver.json" });

    expect(result.icdSource).toBe("environment");
    expect(result.additions.VK_ICD_FILENAMES).toBe("/custom/driver.json");
  });

  it("sets no ICD override when the build has none, leaving the system list to the loader", () => {
    const browser = bundledBrowser(path.join(work, "plain"), ["chromium"]);
    const result = gpuEnv(browser);

    expect(result.icd).toBeNull();
    expect(result.icdSource).toBe("system");
    expect(result.additions).not.toHaveProperty("VK_ICD_FILENAMES");
    expect(result.additions).not.toHaveProperty("VK_DRIVER_FILES");
    // The browser's own directory is still searched, which is where its libEGL/libGLESv2 live.
    expect(result.libraryPath.split(":")).toContain(path.join(work, "plain"));
  });

  it("puts payload libraries before the browser directory and never repeats a path", () => {
    const dir = path.join(work, "sparticuz");
    const browser = bundledBrowser(dir);
    const result = gpuEnv(browser, { LD_LIBRARY_PATH: "/already/there" }, [path.join(dir, "al2023/lib"), dir]);

    expect(result.libraryPath).toBe(`${path.join(dir, "al2023/lib")}:${dir}:/already/there`);
  });

  it("answers for a browser that does not exist instead of failing", () => {
    const result = gpuEnv(path.join(work, "missing", "chromium"));

    expect(result.icd).toBeNull();
    expect(result.icdSource).toBe("system");
  });

  it("prints the same decision for a human as --json does for the script", () => {
    const dir = path.join(work, "human");
    const browser = bundledBrowser(dir);
    const text = execFileSync(process.execPath, [tool, "--chromium", browser], { cwd: root, encoding: "utf-8" });

    expect(text).toContain(path.join(dir, "vk_swiftshader_icd.json"));
    expect(text).toContain("bundled with the browser");
    expect(text).toContain("export VK_ICD_FILENAMES=");
  });

  it("rejects an unknown option and says how it is used", () => {
    let failure: (Error & { status?: number; stdout?: string; stderr?: string }) | undefined;
    try {
      execFileSync(process.execPath, [tool, "--nope"], { cwd: root, encoding: "utf-8", stdio: "pipe" });
    } catch (error) {
      failure = error as Error & { status?: number; stdout?: string; stderr?: string };
    }

    expect(failure?.status).toBe(2);
    expect(String(failure?.stderr)).toContain("unknown option: --nope");
    expect(String(failure?.stdout)).toContain("usage: node tools/gpu-env.mjs");
  });
});
