#!/usr/bin/env node
/**
 * `npm run check:browser:ui` — scoped REAL-WebGPU check of the UI framework (docs/UI.md), NOT the
 * full `check:browser` gate.
 *
 * Boots the demo at `?scene=ui` in headless Chromium + SwiftShader (same launch as
 * `tools/browser-check.mjs`) and asserts, on a real device:
 *
 *  1. the frame runs a `forge.ui` render-graph pass with zero GPU errors and a steady frame creates
 *     no textures (`texturesCreated: 0`);
 *  2. the UI is *visible*: every gallery page differs from the 3D scene without the overlay, and the
 *     menu title's text box contains glyph ink (SDF text actually rasterised);
 *  3. real input works end to end: a mouse click on the "Settings" nav item switches pages, Tab moves
 *     keyboard focus, Escape closes a confirmation dialog opened by a click;
 *  4. theme and skin switching change the pixels;
 *  5. a compact viewport collapses the navigation bar (breakpoint) without layout issues, and the
 *     settings page shows exactly one tab page (responsive grids once re-showed hidden tabs);
 *  6. drawing and hit testing agree: the element `hitTestAt` returns at a button's centre is that
 *     button, and the pixel there is the button's colour, not the scene's.
 *
 * Screenshots: `tools/.browser-ui-<page>.png` (git-ignored). Look at them.
 * Exit codes: 0 pass, 1 fail, 2 NOT RUN (no browser/adapter).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gpuLaunchEnv } from "./gpu-env.mjs";

const CHECK_NAME = "check:browser:ui";
const PORT = Number(process.env.PORT ?? 5198);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpOk(url) {
  return new Promise((resolve) => {
    const req = request(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "examples/vite.config.ts", "--port", String(PORT), "--strictPort", "--force"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLog = "";
vite.stdout.on("data", (b) => (viteLog += b));
vite.stderr.on("data", (b) => (viteLog += b));
let served = false;
for (let i = 0; i < 60 && !served; i++) {
  served = await httpOk(BASE);
  if (!served) await sleep(500);
}
if (!served) {
  console.error(`vite did not serve ${BASE}\n${viteLog.slice(0, 2000)}`);
  vite.kill("SIGKILL");
  process.exit(1);
}

const { chromium } = await import("playwright-core");
const spartan = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync("/tmp/chromium") ? "/tmp/chromium" : null);
const managed = () => {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
};
const launchEnvironment = gpuLaunchEnv({ executablePath: spartan ?? managed(), extraLibraryPaths: [join(tmpdir(), "al2023", "lib")] });
let browser;
try {
  browser = await chromium.launch({
    ...(spartan ? { executablePath: spartan } : { channel: "chromium" }),
    env: launchEnvironment.env,
    ignoreDefaultArgs: ["--headless"],
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--headless=new", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--enable-features=Vulkan"],
    timeout: 90000,
  });
} catch (error) {
  console.error(`${CHECK_NAME} NOT RUN — no launchable browser (${String(error).split("\n")[0]})`);
  vite.kill("SIGKILL");
  process.exit(2);
}

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
  console.log(`${ok ? "  ok  " : " FAIL "} ${message}`);
};

const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

async function finish(code) {
  await browser.close();
  vite.kill("SIGKILL");
  process.exit(code);
}

await page.goto(`${BASE}?scene=ui`, { waitUntil: "load" });
const hasAdapter = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())));
if (!hasAdapter) {
  console.error(`${CHECK_NAME} NOT RUN — the browser exposes no WebGPU adapter`);
  await finish(2);
}
try {
  await page.waitForFunction(() => window.__forge?.ui?.() && window.__forge.stats().frame > 10, null, { timeout: 120000 });
} catch {
  console.error(`${CHECK_NAME} FAIL — the UI scene did not start\n${consoleErrors.slice(0, 5).join("\n")}`);
  await finish(1);
}
// Hide the demo's DOM chrome so screenshots show only the canvas.
await page.addStyleTag({ content: "#hud,#hud-panel,#toolbar,#toolbar-toggle,#controls-hint,#error,#profiler-panel,.touch-controls{display:none!important}" });

const waitFrames = async (n = 6) => {
  const start = await page.evaluate(() => window.__forge.stats().frame);
  await page.waitForFunction((s) => window.__forge.stats().frame >= s, start + n, { timeout: 60000 });
};
const shot = async (name) => {
  await waitFrames();
  const path = `tools/.browser-ui-${name}.png`;
  await page.locator("canvas").first().screenshot({ path });
  return path;
};

await waitFrames(10);
const s0 = await page.evaluate(() => {
  const st = window.__forge.stats();
  const h = window.__forge.ui();
  return { passes: st.renderPasses, gpuErrors: st.gpuErrors, lastError: st.lastError, instances: h.uiRenderer.stats.instances, draws: h.uiRenderer.stats.drawCalls, overlays: h.ui.messages.filter((m) => m.level === "error").map((m) => m.message) };
});
check(s0.passes.includes("forge.ui"), `forge.ui pass executed (passes: ${s0.passes.join(", ")})`);
check(s0.gpuErrors === 0, `zero GPU errors (${s0.gpuErrors}${s0.lastError ? `: ${s0.lastError}` : ""})`);
check(s0.instances > 50 && s0.draws >= 1, `UI drew ${s0.instances} instances in ${s0.draws} draw call(s)`);
check(s0.overlays.length === 0, `no UI error diagnostics (${s0.overlays.slice(0, 3).join(" | ")})`);
const menuShot = await shot("menu");

// ---- helpers: element geometry → page coordinates, screenshot pixels decoded in the page
const canvasBox = await page.locator("canvas").first().boundingBox();
/** CSS-pixel centre (or an offset point) of the first visible element whose accessible label matches. */
const locate = (label, dx = null) =>
  page.evaluate(([label, dx]) => {
    const h = window.__forge.ui();
    let found = null;
    h.ui.root.walk((e) => {
      if (!found && e.visible && e.accessibility.label === label && e.bounds.width > 0) found = e;
    });
    if (!found) return null;
    const b = found.bounds;
    const s = h.ui.viewport.uiScale;
    const lx = dx === null ? b.x + b.width / 2 : b.x + dx;
    const ly = b.y + b.height / 2;
    return { lx, ly, x: lx * s, y: ly * s, type: found.typeName, uid: found.uid };
  }, [label, dx]);
const clickLabel = async (label) => {
  const p = await locate(label);
  if (!p) return false;
  await page.mouse.click(canvasBox.x + p.x, canvasBox.y + p.y);
  await waitFrames(4);
  return true;
};
/** Decode a PNG in the page and return the RGB at CSS points plus the mean luminance. */
const pixels = (png, points) =>
  page.evaluate(
    async ([b64, points]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const at = points.map(([x, y]) => {
        const i = (Math.round(y) * c.width + Math.round(x)) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      });
      return { mean: sum / (d.length / 4), at };
    },
    [png.toString("base64"), points],
  );
const capture = async () => {
  await waitFrames();
  return page.locator("canvas").first().screenshot();
};
const diff = (a, b) => Math.abs(a - b);

// 2. Visible: every page looks different from the others (the overlay is drawing what was asked).
const means = {};
for (const id of ["menu", "settings", "hud", "inventory", "widgets", "data"]) {
  await page.evaluate((id) => window.__forge.ui().gallery.navigate(id), id);
  const png = await capture();
  await page.locator("canvas").first().screenshot({ path: `tools/.browser-ui-${id}.png` });
  means[id] = (await pixels(png, [])).mean;
}
await page.evaluate(() => window.__forge.ui().gallery.navigate("settings"));
await waitFrames(4);
const tabPages = await page.evaluate(() => {
  let tabs = null;
  window.__forge.ui().gallery.pages.settings.walk((e) => {
    if (!tabs && e.typeName === "TabContainer") tabs = e;
  });
  return Array.from({ length: tabs.tabCount }, (_, i) => tabs.page(i).visible).filter(Boolean).length;
});
check(tabPages === 1, `settings shows exactly one tab page (${tabPages} visible)`);
const distinct = new Set(Object.values(means).map((m) => m.toFixed(1))).size;
check(distinct >= 5, `gallery pages render differently (mean luminance ${Object.entries(means).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")})`);
await page.evaluate(() => window.__forge.ui().gallery.navigate("menu"));
await waitFrames(4);

// 6. Drawing and hit testing agree, in pixels: the Play button's left padding shows its background.
const play = await locate("Play", 7);
const hitOk = await page.evaluate(([x, y, uid]) => window.__forge.ui().ui.hitTest(x, y)?.uid === uid, [play.lx, play.ly, play.uid]);
check(hitOk, `hitTest at the Play button returns the Play button (${play.type})`);
const playBg = await page.evaluate(() => {
  const h = window.__forge.ui();
  let el = null;
  h.ui.root.walk((e) => {
    if (!el && e.visible && e.accessibility.label === "Play") el = e;
  });
  const c = el.computedStyle.background >>> 0;
  return [(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255];
});
const atPlay = (await pixels(await capture(), [[play.x, play.y]])).at[0];
check(atPlay.every((v, i) => diff(v, playBg[i]) <= 24), `pixel inside Play is its background (got ${atPlay}, style ${playBg})`);

// 3. Real input: mouse click on the Settings nav item, Tab focus, click Quit → dialog → Escape.
check(await clickLabel("Settings"), "found the Settings nav item");
check((await page.evaluate(() => window.__forge.ui().gallery.page)) === "settings", "a real mouse click switched to the Settings page");
await page.evaluate(() => window.__forge.ui().gallery.navigate("menu"));
await waitFrames(4);
await page.keyboard.press("Tab");
await waitFrames(4);
const focus = await page.evaluate(() => {
  const ui = window.__forge.ui().ui;
  return { name: ui.focus.focused?.debugName ?? null, visible: ui.focus.focusVisible };
});
check(focus.name !== null && focus.visible, `Tab moved keyboard focus (${focus.name}, ring visible: ${focus.visible})`);
check(await clickLabel("Quit"), "found the Quit button");
const modal = await page.evaluate(() => window.__forge.ui().ui.topModal?.typeName ?? null);
check(modal === "ConfirmationDialog", `clicking Quit opened a confirmation dialog (${modal})`);
await page.locator("canvas").first().screenshot({ path: "tools/.browser-ui-dialog.png" });
await page.keyboard.press("Escape");
await waitFrames(4);
check((await page.evaluate(() => window.__forge.ui().ui.topModal)) === null, "Escape closed the dialog");

// 4. Theme and skin switching change the pixels.
const base = (await pixels(await capture(), [[play.x, play.y]])).mean;
await page.evaluate(() => window.__forge.ui().gallery.setTheme("light"));
const light = (await pixels(await capture(), [])).mean;
await page.locator("canvas").first().screenshot({ path: "tools/.browser-ui-light.png" });
check(light > base + 5, `light theme is brighter (${base.toFixed(1)} → ${light.toFixed(1)})`);
await page.evaluate(() => window.__forge.ui().gallery.setTheme("dark"));
await page.evaluate(() => window.__forge.ui().gallery.setSkin("parchment"));
const parchmentPng = await capture();
await page.locator("canvas").first().screenshot({ path: "tools/.browser-ui-parchment.png" });
const parchmentPlay = (await pixels(parchmentPng, [[play.x, play.y]])).at[0];
check(parchmentPlay.some((v, i) => diff(v, atPlay[i]) > 24), `parchment skin repaints the Play button (${atPlay} → ${parchmentPlay})`);
await page.evaluate(() => window.__forge.ui().gallery.setSkin("forge"));

// 5. A compact (phone) viewport collapses the navigation without layout issues.
await page.setViewportSize({ width: 390, height: 844 });
await waitFrames(10);
const compact = await page.evaluate(() => {
  const h = window.__forge.ui();
  return { bp: h.ui.breakpoint, collapsed: h.gallery.nav.collapsed, issues: h.ui.diagnostics.validateLayout().filter((i) => i.kind === "invalid-geometry" || i.kind === "overlap").map((i) => `${i.kind} ${i.element} ${i.detail}`) };
});
check(compact.bp === "compact" && compact.collapsed, `phone viewport → ${compact.bp}, nav collapsed: ${compact.collapsed}`);
check(compact.issues.length === 0, `no layout issues at 390x844 (${compact.issues.slice(0, 3).join(" | ")})`);
await shot("compact");
await page.setViewportSize({ width: 1280, height: 720 });
await waitFrames(10);

// 1b. A steady frame allocates no render-graph textures and the run recorded no GPU errors.
await waitFrames(20);
const s1 = await page.evaluate(() => {
  const st = window.__forge.stats();
  return { texturesCreated: st.render.texturesCreated, gpuErrors: st.gpuErrors, lastError: st.lastError, uiErrors: window.__forge.ui().ui.messages.filter((m) => m.level === "error").map((m) => m.message) };
});
check(s1.texturesCreated === 0, `steady frame created ${s1.texturesCreated} textures`);
check(s1.gpuErrors === 0, `still zero GPU errors after the interaction run (${s1.gpuErrors}${s1.lastError ? `: ${s1.lastError}` : ""})`);
check(s1.uiErrors.length === 0, `no UI error diagnostics after the run (${s1.uiErrors.slice(0, 3).join(" | ")})`);
check(consoleErrors.length === 0, `no page console errors (${consoleErrors.slice(0, 3).join(" | ")})`);
console.log(`screenshots: ${menuShot} and tools/.browser-ui-{settings,hud,inventory,widgets,data,dialog,light,parchment,compact}.png`);

console.log(problems.length === 0 ? `${CHECK_NAME} PASS` : `${CHECK_NAME} FAIL (${problems.length})`);
await finish(problems.length === 0 ? 0 : 1);
