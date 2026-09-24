/**
 * Device-side diagnostics for reports from hardware we cannot attach a debugger to.
 *
 * The bug class this exists for: a frame that renders correctly in every browser we can run here
 * (Chromium + real WebGPU) but comes out wrong on a phone — no console, no remote inspector, no
 * desktop browser to reproduce in. The phone has to answer for itself, in one pass, with numbers a
 * photograph of the screen can carry.
 *
 * `?diag=1` on the demo (or an injected `window.__forgeDiagEndpoint`) installs a panel that:
 *
 * 1. snapshots everything the page knows about itself — user agent, viewport and drawing-buffer
 *    sizes, adapter limits, features, and the engine's stats/error state;
 * 2. captures the presented frame through a 2D canvas and reports its average colour plus a coarse
 *    colour grid, so "the frame is uniform sky" is a measurement rather than an impression;
 * 3. repeats (2) across a small matrix of render settings (sky / HDR / shadows) so a frame that only
 *    paints background can be attributed to a feature instead of guessed at;
 * 3b. runs the raw-WebGPU primitive probes (rawGpuTests.ts) against the engine's device and a fresh
 *    one, so a device-specific primitive failure is named rather than inferred;
 * 4. POSTs each report as JSON to `window.__forgeDiagEndpoint` when the host provides one (the
 *    sandbox dev server does; a plain `npm run demo` does not), and shows the same text on screen.
 *
 * Nothing here is imported by the normal demo path: `main.ts` loads it with a dynamic `import()`
 * only when diagnostics are asked for.
 */

import { runRawGpuTests, type RawTestResult } from "./rawGpuTests.js";

/** The parts of `window.__forge` this module reads. All optional: the panel must never throw. */
export interface DiagForge {
  stats?: () => unknown;
  scene?: { settings?: { skyEnabled?: boolean; hdr?: boolean; shadow?: { enabled?: boolean } } };
  marsState?: () => unknown;
  camera?: () => unknown;
  terrainHeightAt?: (x: number, z: number) => number | null;
  setHdr?: (on: boolean) => void;
  setShadows?: (on: boolean) => void;
  setSky?: (on: boolean) => void;
  sceneName?: string;
}

export interface DiagHost {
  /** The canvas the engine presents into. */
  canvas: HTMLCanvasElement;
  /** `window.__forge`. */
  forge: DiagForge;
  /** `engine.gpu` — adapter caps/limits/format live here. */
  gpu: unknown;
  /** `engine.platform` if the host wants to supply it. */
  platform?: unknown;
}

interface Capture {
  ok: boolean;
  error?: string;
  blank?: boolean;
  avg?: [number, number, number];
  rows?: string[];
  /** Cells whose colour differs from the frame average by more than the threshold — a "detail" score. */
  detailCells?: number;
  alphaAvg?: number;
}

interface Step {
  label: string;
  draws: number | null;
  tris: number | null;
  instances: number | null;
  passes: string[];
  gpuErrors: number | null;
  lastError: string | null;
  hdr: boolean | null;
  skyOn: boolean | null;
  shadowsOn: boolean | null;
  frame: Capture;
}

const DEFAULTS = {
  /** Widest axis of the analysis grid. 3×3 cells per capture is enough to see sky-over-ground. */
  cols: 3,
  rows: 6,
  /** Per-entry limits for the JSON prune: keeps a report postable from a phone. */
  maxDepth: 4,
  maxKeys: 40,
  maxArray: 40,
};

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

/**
 * Deep-copy a value into something JSON-safe: functions dropped, typed arrays summed out, cycles
 * broken, arrays and objects truncated. The point is a report that always serialises.
 */
function prune(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? value : String(value);
  if (t === "string" || t === "boolean") return value;
  if (t === "bigint") return `${value as bigint}n`;
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (depth >= DEFAULTS.maxDepth) {
    if (ArrayBuffer.isView(value)) return `[${(value as unknown as { constructor: { name: string } }).constructor.name} ${(value as unknown as { length: number }).length}]`;
    if (Array.isArray(value)) return `[array ${value.length}]`;
    return `[${(value as object).constructor?.name ?? "object"}]`;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { length: number; [i: number]: number };
    const out: string[] = [];
    for (let i = 0; i < Math.min(view.length, 4); i++) out.push(String(Number(view[i])));
    return `${(value as unknown as { constructor: { name: string } }).constructor.name}[${view.length}]: ${out.join(", ")}${view.length > 4 ? ", …" : ""}`;
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, DEFAULTS.maxArray).map((v) => prune(v, depth + 1));
    if (value.length > DEFAULTS.maxArray) out.push(`…${value.length - DEFAULTS.maxArray} more`);
    return out;
  }
  if (t === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let keys: string[] = [];
    try {
      keys = Object.keys(src);
    } catch {
      return "[unreadable object]";
    }
    for (const key of keys.slice(0, DEFAULTS.maxKeys)) {
      let v: unknown;
      try {
        v = src[key];
      } catch (error) {
        v = `<getter threw: ${String(error)}>`;
      }
      const p = prune(v, depth + 1);
      if (p !== undefined) out[key] = p;
    }
    if (keys.length > DEFAULTS.maxKeys) out["…"] = `${keys.length - DEFAULTS.maxKeys} more keys`;
    return out;
  }
  return String(value);
}

/** Read a nested field defensively: any missing link or throwing getter yields `undefined`. */
function get(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    try {
      cur = (cur as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }
  return cur;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the presented frame back through a 2D canvas.
 *
 * `drawImage` from a WebGPU canvas is the only capture path available without the engine handing
 * out a COPY_SRC texture, and it is the one that differs most between browsers — so a fully blank
 * result is reported as such (`blank: true`) rather than being mistaken for a black frame.
 */
function captureFrame(canvas: HTMLCanvasElement, cols: number, rows: number): Capture {
  try {
    if (!canvas.width || !canvas.height) return { ok: false, error: `canvas is ${canvas.width}x${canvas.height}` };
    const c = document.createElement("canvas");
    c.width = cols * 3;
    c.height = rows * 3;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: false, error: "no 2d context" };
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
      a += data[i + 3]!;
    }
    const n = data.length / 4;
    const avg: [number, number, number] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    const alphaAvg = Math.round(a / n);
    // Per-row strip colours: a frame with ground under sky reads as a colour *gradient* down the
    // rows, while a sky-only frame is one row colour repeated.
    const rowColours: string[] = [];
    let detailCells = 0;
    for (let row = 0; row < rows; row++) {
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let count = 0;
      for (let y = row * 3; y < row * 3 + 3; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          rr += data[i]!;
          gg += data[i + 1]!;
          bb += data[i + 2]!;
          count++;
        }
      }
      const cell: [number, number, number] = [Math.round(rr / count), Math.round(gg / count), Math.round(bb / count)];
      if (Math.abs(cell[0] - avg[0]) + Math.abs(cell[1] - avg[1]) + Math.abs(cell[2] - avg[2]) > 24) detailCells++;
      rowColours.push(cell.join(","));
    }
    return { ok: true, blank: alphaAvg === 0, avg, rows: rowColours, detailCells, alphaAvg };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function statsBits(forge: DiagForge): Step {
  let st: unknown = null;
  try {
    st = forge.stats?.() ?? null;
  } catch (error) {
    st = null;
    void error;
  }
  const settings = forge.scene?.settings;
  let passes: string[] = [];
  const rawPasses = get(st, "renderPasses");
  if (Array.isArray(rawPasses)) passes = rawPasses.map((p) => String(p));
  return {
    label: "",
    draws: num(get(st, "drawCalls")),
    tris: num(get(st, "triangles")),
    instances: num(get(st, "instances")),
    passes,
    gpuErrors: num(get(st, "gpuErrors")),
    lastError: (get(st, "lastError") as string | null) ?? null,
    hdr: typeof settings?.hdr === "boolean" ? settings.hdr : null,
    skyOn: typeof settings?.skyEnabled === "boolean" ? settings.skyEnabled : null,
    shadowsOn: typeof settings?.shadow?.enabled === "boolean" ? settings.shadow.enabled : null,
    frame: { ok: false },
  };
}

export interface DiagHandle {
  /** Latest full report (same JSON the endpoint receives). */
  report: () => unknown;
  /** Re-run the capture matrix now. */
  run: () => Promise<unknown>;
  dispose: () => void;
}

/**
 * Install the panel + capture loop. Returns immediately; work continues in the background so the
 * install never delays the first frame.
 */
export function installIosReport(
  host: DiagHost,
  options: { tag?: string; toggles?: boolean; raw?: boolean; sceneTour?: boolean } = {},
): DiagHandle {
  const { canvas, forge } = host;
  const tag = options.tag ?? "ios";
  const withRaw = options.raw ?? true;
  const withTour = options.sceneTour ?? true;
  const endpoint = (globalThis as unknown as { __forgeDiagEndpoint?: string }).__forgeDiagEndpoint ?? null;
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;max-height:46vh;overflow:auto;z-index:60;" +
    "background:rgb(2 4 8 / 0.92);color:#e2e8f0;border-top:2px solid #38bdf8;padding:8px 10px;" +
    "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;" +
    "-webkit-user-select:text;user-select:text";
  panel.setAttribute("data-forge-diag", "1");
  document.body.appendChild(panel);
  // The panel covers the bottom of the canvas, so it has to be hideable: the numbers it prints are
  // also POSTed, and a user who wants to look at the frame itself needs the space back.
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = "diag ▴";
  toggle.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:61;padding:6px 10px;font:11px ui-monospace,Menlo,monospace;" +
    "background:rgb(2 4 8 / 0.9);color:#7dd3fc;border:1px solid #38bdf8;border-radius:6px;touch-action:manipulation";
  let panelVisible = true;
  toggle.addEventListener("click", () => {
    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? "block" : "none";
    toggle.textContent = panelVisible ? "diag ▴" : "diag ▾";
  });
  document.body.appendChild(toggle);
  let captures: Step[] = [];
  let rawSuites: { label: string; results: RawTestResult[] }[] = [];
  let posting = "pending";
  let lastReport: Record<string, unknown> = {};

  const status = (): string => `diag ${tag} · report ${posting} · endpoint ${endpoint ?? "(none — screenshot this panel)"}`;

  function describe(v: unknown): string {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  function renderPanel(): void {
    const head = status();
    const lines: string[] = [head, ""];
    const failed = rawSuites.reduce((n, suite) => n + suite.results.filter((r) => !r.ok).length, 0);
    const probes = rawSuites.reduce((n, suite) => n + suite.results.length, 0);
    if (probes) lines.push(`raw probes: ${probes - failed}/${probes} pass${failed ? ` — ${failed} suspect (see below)` : ""}`);
    const live = captures[0] ?? statsBits(forge);
    lines.push(
      `ua ${navigator.userAgent}`,
      `scene ${forge.sceneName ?? "?"}  gpu ${describe(get(host.gpu, "format"))}/${describe(get(host.gpu, "depthFormat"))}` +
        `  canvas ${canvas.width}x${canvas.height} css ${canvas.clientWidth}x${canvas.clientHeight} dpr ${window.devicePixelRatio}`,
      `passes ${live.passes.join(" ")}`,
      `draws ${live.draws}  tris ${live.tris}  instances ${live.instances}  gpuErrors ${live.gpuErrors}  lastError ${live.lastError ?? "null"}`,
      "",
      "captures (label · avg RGB · row colours · draws):",
    );
    for (const step of captures) {
      const f = step.frame;
      lines.push(
        `  ${step.label}: ${f.ok ? (f.blank ? "BLANK(alpha 0)" : `avg ${f.avg?.join(",")}`) : `fail ${f.error}`}` +
          ` · ${f.rows?.join(" | ") ?? "-"} · detail ${f.detailCells ?? "-"} · draws ${step.draws} tris ${step.tris} passes ${step.passes.length}`,
      );
    }
    if (rawSuites.length) {
      lines.push("", "raw WebGPU probes:");
      for (const suite of rawSuites) {
        for (const r of suite.results) {
          lines.push(`  ${r.ok ? "PASS" : "FAIL"} ${suite.label} ${r.name}: ${r.actual}${r.error ? ` err ${r.error.slice(0, 120)}` : ""} (want ${r.expected})`);
        }
      }
    }
    lines.push("", describe(prune(lastReport, 0)).slice(0, 4000));
    panel.textContent = lines.join("\n");
  }

  /** Apply one renderer setting, wait for steady frames, then record what came out. */
  async function record(label: string, apply: (() => void) | null): Promise<Step> {
    if (apply) {
      try {
        apply();
      } catch (error) {
        panel.textContent += `\n[${label}] apply threw: ${String(error)}`;
      }
      await frames(4);
    }
    const step = statsBits(forge);
    step.label = label;
    step.frame = captureFrame(canvas, DEFAULTS.cols, DEFAULTS.rows);
    captures.push(step);
    renderPanel();
    return step;
  }

  async function build(): Promise<Record<string, unknown>> {
    let gpuInfo: unknown = null;
    try {
      const device = await navigator.gpu?.requestAdapter?.() ?? null;
      gpuInfo = device ? prune({ adapterInfo: get(device, "info") ?? get(device, "adapterInfo") }) : null;
    } catch (error) {
      gpuInfo = String(error);
    }
    const settings = forge.scene?.settings;
    let cameraState: unknown = null;
    let terrainY: unknown = null;
    let mars: unknown = null;
    try {
      cameraState = prune(forge.camera?.() ?? null);
      mars = prune(forge.marsState?.() ?? null);
      const eye = (forge.camera?.() as { eye?: { x?: number; y?: number; z?: number } } | null)?.eye;
      if (eye && typeof eye.x === "number" && typeof eye.z === "number" && forge.terrainHeightAt) {
        terrainY = prune({ atEye: forge.terrainHeightAt(eye.x, eye.z) });
      }
    } catch (error) {
      terrainY = String(error);
    }
    return {
      tag,
      t: Math.round(performance.now()),
      ua: navigator.userAgent,
      secureContext: globalThis.isSecureContext ?? null,
      visibility: document.visibilityState,
      prefersReducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? null,
      viewport: {
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        visual: [window.visualViewport?.width ?? null, window.visualViewport?.height ?? null, window.visualViewport?.scale ?? null],
        dpr: window.devicePixelRatio,
        canvasBacking: [canvas.width, canvas.height],
        canvasCss: [canvas.clientWidth, canvas.clientHeight],
      },
      platform: prune(host.platform ?? null),
      adapter: gpuInfo,
      gpu: prune(host.gpu, 1),
      settings: prune(settings ?? null),
      stats: prune(forge.stats?.() ?? null),
      passes: (get(forge.stats?.() ?? null, "renderPasses") as string[] | undefined) ?? [],
      camera: cameraState,
      terrainHeight: terrainY,
      mars,
      raw: prune(
        rawSuites.flatMap((suite) =>
          suite.results.map((r) => ({ suite: suite.label, name: r.name, ok: r.ok, actual: r.actual, error: r.error })),
        ),
      ),
      rawSummary: {
        probes: rawSuites.reduce((n, suite) => n + suite.results.length, 0),
        failed: rawSuites.reduce((n, suite) => n + suite.results.filter((r) => !r.ok).length, 0),
      },
      captures,
      captureSupport: captures[0]?.frame.ok ? (captures[0].frame.blank ? "blank" : "ok") : "unsupported",
      note: "POSTed by examples/src/diag/iosReport.ts (?diag=1)",
    };
  }

  async function post(report: Record<string, unknown>): Promise<void> {
    lastReport = report;
    if (!endpoint) {
      posting = "no endpoint";
      renderPanel();
      return;
    }
    const body = JSON.stringify(report);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
      posting = response.ok || response.status === 204 ? "sent" : `http ${response.status}`;
    } catch (error) {
      posting = `failed ${String(error)}`;
    }
    renderPanel();
  }

  /** Raw primitive probes: the engine's own device first, then a freshly requested one. */
  async function runRaw(): Promise<void> {
    const device = get(host.gpu, "device") as (GPUDevice & { createTexture?: unknown }) | undefined;
    if (!device || typeof device.createTexture !== "function") {
      rawSuites = [{ label: "engine-device", results: [{ name: "device", ok: false, expected: "a GPUDevice", actual: "engine device not exposed" }] }];
      renderPanel();
      return;
    }
    try {
      rawSuites.push(await runRawGpuTests(device, "engine-device"));
    } catch (error) {
      rawSuites.push({ label: "engine-device", results: [{ name: "suite", ok: false, expected: "10 probes", actual: "suite threw", error: String(error) }] });
    }
    renderPanel();
    await post(await build());
    try {
      const adapter = await navigator.gpu?.requestAdapter?.();
      const fresh = adapter ? await adapter.requestDevice() : null;
      if (fresh) {
        rawSuites.push(await runRawGpuTests(fresh, "fresh-device"));
        await post(await build());
      } else {
        rawSuites.push({ label: "fresh-device", results: [{ name: "device", ok: false, expected: "a second GPUDevice", actual: "requestAdapter/requestDevice returned nothing" }] });
      }
    } catch (error) {
      rawSuites.push({ label: "fresh-device", results: [{ name: "device", ok: false, expected: "a second GPUDevice", actual: "threw", error: String(error) }] });
    }
    renderPanel();
  }

  /**
   * Same device, different scenes: the Mars showcase against the two demos that do render on the
   * affected phone. Cubes are captured three times because they self-rotate — if their colours move
   * with the rotation, the "colours change while rotating" report is reproducible here.
   */
  async function sceneTour(): Promise<void> {
    const forgeApi = (globalThis as unknown as { __forge?: { loadScene?: (name: string) => void } }).__forge;
    if (typeof forgeApi?.loadScene !== "function") return;
    // Every demo, on the device that only renders some of them. The point is the *comparison*: the
    // sky and weather demos draw a ground plane and lit spheres through the same forward pipeline as
    // the Mars showcase, so "sky renders, terrain does not" narrows the fault to what the two scenes
    // do differently (instanced batches, streamed geometry, image textures) rather than to WebGPU.
    // Cubes are captured twice because they self-rotate: if their colours move with the rotation,
    // the "colours change while rotating" report is reproducible here, in a still page.
    const tour: [string, number][] = [
      ["cubes", 30],
      ["cubes", 20],
      ["pbr", 30],
      ["sky", 30],
      ["weather", 30],
      ["vehicle", 40],
      ["particles", 40],
      ["terrain", 45],
      ["terrain", 25],
      ["mars-showcase", 45],
    ];
    let previous = "";
    for (let i = 0; i < tour.length; i++) {
      const [name, settle] = tour[i]!;
      if (name !== previous) {
        try {
          forgeApi.loadScene(name);
        } catch (error) {
          panel.textContent += `\n[scene ${name}] loadScene threw: ${String(error)}`;
        }
        await frames(settle);
      } else {
        await frames(Math.min(settle, 20));
      }
      previous = name;
      const repeats = tour.filter(([n]) => n === name).length;
      await record(`scene ${name}${repeats > 1 ? ` #${tour.slice(0, i + 1).filter(([n]) => n === name).length}` : ""}`, null);
      await post(await build());
    }
  }

  async function run(): Promise<unknown> {
    captures = [];
    await frames(6);
    // Raw probes first, and awaited: the device is asked about primitives while the page it is
    // failing to draw is still untouched, and every later capture then runs on a quiet device.
    if (withRaw) await runRaw();
    // Matrix: the whole point is to attribute a background-only frame to a feature. Each step only
    // changes one thing, and every step restores the setting it owned.
    const settings = forge.scene?.settings;
    const before = { hdr: settings?.hdr, shadows: settings?.shadow?.enabled, sky: settings?.skyEnabled };
    await record("as-is", null);
    if (options.toggles !== false) {
      await record("sky off", () => forge.setSky?.(false));
      await record("sky off + hdr off", () => forge.setHdr?.(false));
      await record("sky off + hdr off + shadows off", () => forge.setShadows?.(false));
      await record("hdr off + shadows off (sky back on)", () => {
        if (typeof before.sky === "boolean" && settings) settings.skyEnabled = before.sky;
      });
      await record("hdr off (sky on, shadows on)", () => forge.setHdr?.(false));
    }
    // Restore.
    if (settings) {
      if (typeof before.sky === "boolean") settings.skyEnabled = before.sky;
      if (typeof before.hdr === "boolean") forge.setHdr?.(before.hdr);
      if (typeof before.shadows === "boolean") forge.setShadows?.(before.shadows);
    }
    await frames(3);
    await record("restored", null);
    await post(await build());
    if (withTour) await sceneTour();
    const report = await build();
    await post(report);
    return report;
  }

  const periodic = (globalThis as unknown as { __forgeDiagPeriodic?: boolean }).__forgeDiagPeriodic ?? Boolean(endpoint);
  let timer = 0;
  const timers: number[] = [];
  if (periodic) {
    for (const after of [3000, 12000, 30000]) {
      timers.push(
        window.setTimeout(() => {
          void (async () => {
            await frames(2);
            await record(`t+${after / 1000}s`, null);
            await post(await build());
          })();
        }, after),
      );
    }
  }
  // An early report first: if the matrix below throws on some device, the snapshot that says what
  // the page looks like at rest still made it out.
  window.setTimeout(() => {
    void (async () => {
      await frames(3);
      await record("early", null);
      await post(await build());
    })();
  }, 800);
  window.setTimeout(() => {
    void run();
  }, 2500);

  const handle: DiagHandle = {
    report: () => lastReport,
    run,
    dispose: () => {
      window.clearTimeout(timer);
      for (const t of timers) window.clearTimeout(t);
      panel.remove();
      toggle.remove();
    },
  };
  (globalThis as unknown as { __forgeDiag?: () => unknown }).__forgeDiag = () => lastReport;
  return handle;
}
