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
 *  5a. the UI scales with the viewport: a 1920×1080 window draws at uiScale 1.5 and a real click at
 *     the scaled position hits the intended button;
 *  6. drawing and hit testing agree: the element `hitTestAt` returns at a button's centre is that
 *     button, and the pixel there is the button's colour, not the scene's;
 *  7. the demo's floating Profiler panel works as a window: the toolbar hook opens it, it paints live
 *     numbers and keeps repainting them, a real drag of the title bar moves it, a real drag of the
 *     corner grip resizes it, the bar's collapse button leaves only a corner icon that re-opens it,
 *     and holding a drag near a viewport edge for the dwell docks it flush there;
 *  7a. the panel's frame timeline strip paints a real frame history, hovering a column selects that
 *     frame and a click pins it (and a second click releases it), while wheel zoom and Shift-wheel
 *     move the bounded retained window;
 *  7b. the demo's floating Inspector window browses the Phase 21 diagnostic APIs on a scene that has
 *     terrain in it: the toolbar button opens it, all nine tabs load and paint rows, a click on a row
 *     fills the detail pane, the filter narrows the list, and the Terrain tab's overlay checkbox
 *     switches on debug lines the frame loop really draws;
 *  7c. the visible Console opens, executes a registered stats command and rejects/effectively
 *     displays an unregistered JavaScript-looking command without evaluating it.
 *
 * Screenshots: `tools/.browser-ui-<page>.png`, `tools/.browser-ui-profiler-timeline.png` and
 * `tools/.browser-ui-inspector.png` (git-ignored). Look at them.
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

// 7. The demo's floating Profiler panel, driven by real pointer input: it opens from the toolbar
//    hook, paints live numbers, drags by its title bar, resizes by its corner grip, collapses to a
//    corner icon and docks flush to a viewport edge. (tests/examples/profilerPanel.test.ts pins the
//    same wiring against a fake DOM; this is the real page.)
const panelLayout = () => page.evaluate(() => window.__forge.profilerLayout());
const reportText = () => page.evaluate(() => document.getElementById("profiler").textContent ?? "");
/** Drag an element by (dx, dy) with a real mouse, optionally holding still for `dwellMs` first. */
const dragBy = async (selector, dx, dy, dwellMs = 0) => {
  const box = await page.locator(selector).first().boundingBox();
  const vp = page.viewportSize();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const tx = Math.min(Math.max(cx + dx, 1), vp.width - 1);
  const ty = Math.min(Math.max(cy + dy, 1), vp.height - 1);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 8 });
  if (dwellMs > 0) await sleep(dwellMs);
  await page.mouse.up();
};
const opened = await page.evaluate(() => {
  window.__forge.setProfilerVisible(true);
  return window.__forge.profilerLayout();
});
await waitFrames(2);
check(opened.visible === true && opened.collapsed === false, `the Profiler button opens the panel (visible ${opened.visible})`);
// The panel's rect and the real element must agree: a stale `position: fixed` rule on the report
// body would leave the chrome laid out somewhere else entirely.
const box = await page.locator("#profiler-panel").boundingBox();
check(
  Math.abs(box.x - opened.rect.x) < 1.5 && Math.abs(box.y - opened.rect.y) < 1.5 && Math.abs(box.width - opened.rect.w) < 1.5 && Math.abs(box.height - opened.rect.h) < 1.5,
  `the panel is laid out at its rect (${box.width.toFixed(0)}x${box.height.toFixed(0)} at ${box.x.toFixed(0)},${box.y.toFixed(0)} vs ${opened.rect.w}x${opened.rect.h} at ${opened.rect.x},${opened.rect.y})`,
);
const first = await reportText();
const frameNow = (text) => Number(/frame (\d+)/.exec(text)?.[1] ?? "0");
check(/frame \d+/.test(first) && first.includes("scope"), `the report is painted (${first.split("\n")[0].slice(0, 64)})`);
// Software rendering runs the gallery at a few frames a second, so wait for the frame counter to
// move rather than sleeping a fixed slice of it.
const firstFrame = frameNow(first);
let second = first;
try {
  await page.waitForFunction((f) => Number(/frame (\d+)/.exec(document.getElementById("profiler").textContent ?? "")?.[1] ?? 0) > f, firstFrame, { timeout: 60000 });
  second = await reportText();
} catch {
  /* reported below */
}
check(frameNow(second) > firstFrame, `the live report keeps updating (frame ${firstFrame} → ${frameNow(second)})`);

// 7a. The panel's frame timeline strip, driven by real pointer input on a real canvas: it paints the
//     frame history, hovering a column selects that frame (not the newest one), and a click pins it
//     so the readout stops moving. (tests/examples/profilerTimeline.test.ts pins the same wiring
//     against a fake canvas; this is the real page, real WebGPU frame records and a real pointer.)
const timelineState = () => page.evaluate(() => window.__forge.profilerTimeline());
const stripBox = await page.locator("#profiler-panel canvas").first().boundingBox();
check(!!stripBox && stripBox.width > 40 && stripBox.height > 40, `the panel carries a timeline strip (${stripBox ? `${stripBox.width.toFixed(0)}x${stripBox.height.toFixed(0)}` : "absent"})`);
const strip = await timelineState();
check(strip && strip.painted > 0 && strip.cssWidth > 40, `the strip has painted (${strip?.painted} paints, ${strip?.cssWidth}x${strip?.cssHeight} css px at dpr ${strip?.dpr})`);
check(strip && strip.frames > 1 && strip.columns > 1, `the strip has a history to draw (${strip?.frames} frames, ${strip?.columns} columns)`);
check(strip && strip.peakMs > 0, `and a real frame time behind it (peak ${strip?.peakMs?.toFixed(2)} ms)`);
check(typeof strip?.readout === "string" && /^#\d+\s+cpu /.test(strip.readout ?? ""), `with a readout naming the selected frame (${JSON.stringify((strip?.readout ?? "").split("\n")[0])})`);

// The strip's own pixels: a blank canvas paints every check above and shows the user nothing. The
// backdrop is drawn at 0.92 alpha, so every opaque pixel is a column, a lane, a marker or a label.
const ink = await page.evaluate(() => {
  const canvas = document.querySelector("#profiler-panel canvas");
  const context = canvas.getContext("2d");
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const counts = new Map();
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) continue;
    opaque++;
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { opaque, total: data.length / 4, colours: counts.size, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) };
});
check(ink.opaque > ink.total * 0.02, `the strip has pixels on it, not a blank canvas (${((100 * ink.opaque) / ink.total).toFixed(1)}% opaque)`);
check(ink.colours >= 3, `in more than one category colour (${ink.colours} distinct opaque colours, heaviest ${ink.top.map(([c, n]) => `${c}:${n}`).join(" ")})`);

// Hover a column a third of the way in: the strip must select that frame, not the newest one.
const hoverX = stripBox.x + stripBox.width * 0.34;
const hoverY = stripBox.y + stripBox.height * 0.25;
await page.mouse.move(hoverX, hoverY);
await sleep(400); // one 4 Hz repaint plus margin, under software rendering
const hovered = await timelineState();
check(hovered.pinned === false, "a hover does not pin the strip");
check(
  hovered.selectedFrame !== null && hovered.selectedFrame < strip.selectedFrame,
  `hovering a column selects that frame (#${hovered.selectedFrame} of #${strip.selectedFrame})`,
);
check(hovered.readout.startsWith(`#${hovered.selectedFrame} `), `and the readout follows it (${JSON.stringify(hovered.readout.split("\n")[0])})`);

// Click to pin, then hover somewhere else: a pinned strip must not move.
await page.mouse.click(hoverX, hoverY);
await sleep(400);
const pinned = await timelineState();
check(pinned.pinned === true, "a click pins the frame under the pointer");
check(pinned.selectedFrame === hovered.selectedFrame, `and it is the frame that was under it (#${pinned.selectedFrame})`);
await page.mouse.move(stripBox.x + stripBox.width * 0.85, hoverY);
await sleep(400);
const stillPinned = await timelineState();
check(stillPinned.selectedFrame === pinned.selectedFrame, `pinned: hovering elsewhere leaves it alone (still #${stillPinned.selectedFrame})`);
await page.locator("#profiler-panel").screenshot({ path: "tools/.browser-ui-profiler-timeline.png" });

// Release the pin by clicking the pinned column again. The strip keeps scrolling while it is pinned
// (that is the point of pinning by frame number), so the column that was under the pointer has
// drifted left by now: ask the strip where its pinned column is and click *that*, and try a couple
// of times because a frame may land between the look-up and the click.
let released = await timelineState();
for (let attempt = 0; attempt < 3 && released.pinned; attempt++) {
  const slot = stripBox.width / released.columns;
  const leftmost = released.frames - released.columns;
  const pinnedX = stripBox.x + (released.selected - leftmost + 0.5) * slot;
  await page.mouse.click(pinnedX, hoverY);
  await sleep(400);
  released = await timelineState();
}
check(released.pinned === false, "clicking the pinned frame again releases it");
await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height * 0.25);
const zoomBefore = await timelineState();
await page.mouse.wheel(0, -120);
await sleep(400);
const zoomed = await timelineState();
check(zoomed.view.zoom > zoomBefore.view.zoom, `wheel zooms the retained history (${zoomBefore.view.windowFrames} → ${zoomed.view.windowFrames} frames)`);
await page.keyboard.down("Shift");
await page.mouse.wheel(0, 120);
await page.keyboard.up("Shift");
await sleep(400);
const scrubbed = await timelineState();
check(scrubbed.view.scrubbed === true, `Shift-wheel scrubs to an older retained window (end #${scrubbed.view.windowEnd})`);
await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y - 60);

const at = await panelLayout();
await dragBy("#profiler-panel .fdp-bar", 60, -80);
const moved = await panelLayout();
check(moved.rect.x === at.rect.x + 60 && moved.rect.y === at.rect.y - 80, `dragging the title bar moves the panel (${at.rect.x},${at.rect.y} → ${moved.rect.x},${moved.rect.y})`);
await dragBy("#profiler-panel .fdp-grip", 40, 60);
const sized = await panelLayout();
check(sized.rect.w === moved.rect.w + 40 && sized.rect.h === moved.rect.h + 60, `the corner grip resizes it (${moved.rect.w}x${moved.rect.h} → ${sized.rect.w}x${sized.rect.h})`);

await page.locator("#profiler-panel .fdp-toggle").click();
const hidden = await panelLayout();
check(hidden.visible === false && hidden.collapsed === true, "the bar's collapse button closes it");
check(await page.locator("#profiler-icon").isVisible(), "and leaves a corner icon behind");
await page.locator("#profiler-icon").click();
check((await panelLayout()).visible === true, "the corner icon brings it back");

// Hold the drag within the snap threshold of the left edge for the dwell: the ghost appears, and
// releasing on it docks the panel flush against that edge.
await dragBy("#profiler-panel .fdp-bar", -2000, 0, 2300);
const docked = await panelLayout();
check(docked.snap?.x === "left", `releasing on the dock ghost snaps it to the left edge (${JSON.stringify(docked.snap)})`);
check(docked.rect.x === 10, `docked flush inside the safe area (x ${docked.rect.x})`);
await page.evaluate(() => window.__forge.setProfilerVisible(false));
check((await panelLayout()).visible === false, "the Profiler button closes it again");

// Hide the demo's DOM chrome so screenshots show only the canvas.
await page.addStyleTag({ content: "#hud,#hud-panel,#toolbar,#toolbar-toggle,#controls-hint,#error,#profiler-panel,#profiler-icon,.touch-controls{display:none!important}" });

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

// 6. Drawing and hit testing agree, in pixels: the Continue button's left padding shows its background
// (the frontier primary is a vertical gradient, so the expected colour is the blend at that height).
const defaults = await page.evaluate(() => [window.__forge.ui().ui.theme, window.__forge.ui().ui.skin]);
check(defaults[0] === "frontier" && defaults[1] === "frontier", `default look is frontier/frontier (${defaults.join("/")})`);
const play = await locate("Continue", 7);
const hitOk = await page.evaluate(([x, y, uid]) => window.__forge.ui().ui.hitTest(x, y)?.uid === uid, [play.lx, play.ly, play.uid]);
check(hitOk, `hitTest at the Continue button returns the Continue button (${play.type})`);
const playBg = await page.evaluate((ly) => {
  const h = window.__forge.ui();
  let el = null;
  h.ui.root.walk((e) => {
    if (!el && e.visible && e.accessibility.label === "Continue") el = e;
  });
  const s = el.computedStyle;
  const rgb = (c) => [((c >>> 0) >>> 24) & 255, ((c >>> 0) >>> 16) & 255, ((c >>> 0) >>> 8) & 255];
  const a = rgb(s.background);
  if (s.gradient !== "vertical") return a;
  const b = rgb(s.backgroundEnd);
  const t = (ly - el.bounds.y) / el.bounds.height;
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}, play.ly);
const atPlay = (await pixels(await capture(), [[play.x, play.y]])).at[0];
check(atPlay.every((v, i) => diff(v, playBg[i]) <= 24), `pixel inside Continue is its background (got ${atPlay}, style ${playBg})`);

// The saved-expeditions card (the second reference screen) swaps in for the menu card.
check(await clickLabel("Saved expeditions"), "found the Saved expeditions button");
const savedState = await page.evaluate(() => {
  let saved = null;
  window.__forge.ui().gallery.pages.menu.walk((e) => {
    if (!saved && e.name === "saved-expeditions") saved = e;
  });
  let resumes = 0;
  saved.walk((e) => {
    if (e.visible && e.accessibility.label.startsWith("Resume ")) resumes++;
  });
  return { visible: saved.visible, resumes };
});
check(savedState.visible && savedState.resumes === 3, `a real click opened the saved list (${savedState.resumes} Resume buttons)`);
await shot("saved");
check(await clickLabel("Back"), "found the Back button");

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
await page.evaluate(() => window.__forge.ui().gallery.setTheme("frontier"));
await page.evaluate(() => window.__forge.ui().gallery.setSkin("parchment"));
const parchmentPng = await capture();
await page.locator("canvas").first().screenshot({ path: "tools/.browser-ui-parchment.png" });
const parchmentPlay = (await pixels(parchmentPng, [[play.x, play.y]])).at[0];
check(parchmentPlay.some((v, i) => diff(v, atPlay[i]) > 24), `parchment skin repaints the Continue button (${atPlay} → ${parchmentPlay})`);
await page.evaluate(() => window.__forge.ui().gallery.setSkin("frontier"));

// 5a. The UI scales with the viewport: a 1920×1080 window draws the 1280×720 layout at 1.5×, and a
// real click at the scaled position still hits the button (drawing and input share one scale).
await page.setViewportSize({ width: 1920, height: 1080 });
await waitFrames(10);
const large = await page.evaluate(() => {
  const v = window.__forge.ui().ui.viewport;
  return { scale: v.uiScale, w: v.width, h: v.height, bp: window.__forge.ui().ui.breakpoint };
});
check(Math.abs(large.scale - 1.5) < 1e-6 && Math.abs(large.w - 1280) < 1e-3, `1920x1080 window → uiScale ${large.scale}, logical ${large.w}x${large.h} (${large.bp})`);
const largeBox = await page.locator("canvas").first().boundingBox();
const savedBtn = await locate("Saved expeditions");
await page.mouse.click(largeBox.x + savedBtn.x, largeBox.y + savedBtn.y);
await waitFrames(4);
const largeSaved = await page.evaluate(() => {
  let v = false;
  window.__forge.ui().gallery.pages.menu.walk((e) => {
    if (e.name === "saved-expeditions") v = e.visible;
  });
  return v;
});
check(largeSaved, "a real click at the 1.5x-scaled position opened the saved list");
await shot("large");
await page.evaluate(() => window.__forge.ui().ui.root.walk((e) => {
  if (e.name === "main-menu") e.visible = true;
  if (e.name === "saved-expeditions") e.visible = false;
}));
await page.setViewportSize({ width: 1280, height: 720 });
await waitFrames(10);

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
await page.evaluate(() => window.__forge.ui().ui.root.walk((e) => {
  if (e.name === "main-menu") e.visible = false;
  if (e.name === "saved-expeditions") e.visible = true;
}));
await shot("compact-saved");
await page.evaluate(() => window.__forge.ui().ui.root.walk((e) => {
  if (e.name === "main-menu") e.visible = true;
  if (e.name === "saved-expeditions") e.visible = false;
}));
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

// 7b. The demo's floating Inspector window, browsed with real pointer input on a scene that has
//     terrain in it (section 7's UI scene has no terrain, physics, particles or weather to browse).
//     tests/examples/inspectorPanel.test.ts pins the same wiring against a fake DOM; this is the real
//     page, a real WebGPU frame loop, real pointer input and real terrain chunks.
const errorsBeforeInspector = consoleErrors.length;
await page.goto(`${BASE}?scene=terrain`);
try {
  await page.waitForFunction(() => (window.__forge?.stats?.().frame ?? 0) > 3, null, { timeout: 180000 });
} catch {
  console.error(`${CHECK_NAME} FAIL — the terrain scene did not start\n${consoleErrors.slice(errorsBeforeInspector).join("\n")}`);
  await finish(1);
}
const inspectorState = () => page.evaluate(() => window.__forge.inspectorState());
const inspectorLayout = () => page.evaluate(() => window.__forge.inspectorLayout());
const inspectorTab = (title) => page.locator("#inspector-panel .fip-tabs button", { hasText: new RegExp(`^${title}$`) });
const inspectorText = (selector) => page.locator(`#inspector-panel ${selector}`).first().textContent();

check((await inspectorLayout()).visible === false, "the Inspector starts closed");
await page.locator("#btn-inspector").click();
await waitFrames(3);
check((await inspectorLayout()).visible === true, "the Inspector toolbar button opens it");
const ecsTab = await inspectorState();
check(ecsTab.tab === "ecs" && ecsTab.rows > 0, `and it paints the scene's entities at once (${ecsTab.rows} rows)`);
check(/entities \d+/.test((await inspectorText(".fip-summary")) ?? ""), `with a summary over the list ("${((await inspectorText(".fip-summary")) ?? "").slice(0, 60)}")`);

// Every tab, clicked: each one loads its own snapshot without a page error, and eight of the nine
// have something to show in a terrain scene (the particles tab has no world here, but it must say so
// rather than throwing).
const loaded = [];
for (const title of ["ECS", "Systems", "Graph", "GPU", "Physics", "Terrain", "Particles", "Streaming", "World"]) {
  await inspectorTab(title).click();
  await waitFrames(2);
  const state = await inspectorState();
  const notes = (await inspectorText(".fip-notes")) ?? "";
  loaded.push({ title, tab: state.tab, rows: state.rows, summary: ((await inspectorText(".fip-summary")) ?? "").slice(0, 48), notes: notes.slice(0, 48) });
  check(state.tab !== "" && state.refreshed > 0, `the ${title} tab loads (${state.rows} rows)`);
  check(!/error|undefined|NaN/.test(`${state.tab} ${loaded.at(-1).summary} ${loaded.at(-1).notes}`), `and the ${title} tab reads cleanly ("${loaded.at(-1).summary}")`);
}
check(loaded.length === 9 && new Set(loaded.map((t) => t.tab)).size === 9, `all nine tabs are distinct (${loaded.map((t) => t.tab).join(", ")})`);
check(loaded.filter((t) => t.rows > 0).length >= 7, `and most have rows to browse (${loaded.map((t) => `${t.tab}:${t.rows}`).join(" ")})`);
await page.locator("#inspector-panel").screenshot({ path: "tools/.browser-ui-inspector.png" });

// Terrain: click a chunk row and the detail pane must fill in with that chunk's own numbers.
await inspectorTab("Terrain").click();
await waitFrames(2);
const chunkRows = await page.locator("#inspector-panel .fip-list > *").count();
check(chunkRows > 0, `the Terrain tab lists chunks (${chunkRows} rows)`);
await page.locator("#inspector-panel .fip-list > *").first().click();
await waitFrames(2);
const selectedChunk = await inspectorState();
const detailText = (await inspectorText(".fip-detail")) ?? "";
check(!!selectedChunk.selected, `clicking a chunk selects it (${selectedChunk.selected})`);
check(detailText.length > 40 && detailText.includes(String(selectedChunk.selected)), `and the detail pane fills in with it (${detailText.split("\n").length} lines, ${JSON.stringify(detailText.slice(0, 44))})`);

// The filter narrows the list, and clearing it brings the rows back.
const beforeFilter = (await inspectorState()).rows;
await page.locator("#inspector-panel .fip-filter").fill("0:0");
await waitFrames(2);
const filtered = await inspectorState();
check(filtered.rows < beforeFilter, `the filter narrows the list (${beforeFilter} → ${filtered.rows} rows for "0:0")`);
await page.locator("#inspector-panel .fip-filter").fill("");
await waitFrames(2);
check((await inspectorState()).rows === beforeFilter, `and clearing it brings them back (${(await inspectorState()).rows} rows)`);

// The overlay: off by default, and switching it on makes the frame loop draw real debug lines.
check((await inspectorState()).drawn === 0, "no debug lines are drawn while the overlay is off");
await page.locator("#inspector-panel .fip-overlay").check();
await waitFrames(6);
const overlayOn = await inspectorState();
check(overlayOn.overlays.includes("terrain"), `the checkbox switches the Terrain overlay on (${JSON.stringify(overlayOn.overlays)})`);
check(overlayOn.drawn > 0, `and the frame loop really draws it (${overlayOn.drawn} debug lines per frame)`);
await page.locator("#inspector-panel").screenshot({ path: "tools/.browser-ui-inspector-overlay.png" });
await page.locator("#inspector-panel .fip-overlay").uncheck();
await waitFrames(4);
const overlayOff = await inspectorState();
check(overlayOff.overlays.length === 0 && overlayOff.drawn === 0, `switching it off stops the lines (${overlayOff.drawn} drawn)`);

// The window chrome: collapse to a corner icon, and the icon brings it back.
await page.locator("#inspector-panel .fdp-toggle").click();
await waitFrames(2);
const inspectorCollapsed = await inspectorLayout();
check(inspectorCollapsed.visible === false && inspectorCollapsed.collapsed === true, "the bar's collapse button closes it");
check(await page.locator("#inspector-icon").isVisible(), "and leaves a corner icon behind");
await page.locator("#inspector-icon").click();
await waitFrames(2);
check((await inspectorLayout()).visible === true, "the corner icon brings it back");
await page.evaluate(() => window.__forge.setInspectorVisible(false));
check((await inspectorLayout()).visible === false, "the Inspector button closes it again");

// 7c. The visible terminal uses the same registered-command model as the embeddable API. The
// programmatic hook is only a deterministic assertion aid; the button and input are real DOM controls.
const consoleState = () => page.evaluate(() => window.__forge.consoleState());
const consoleErrorsBefore = consoleErrors.length;
check((await consoleState()).visible === false, "the Console starts closed");
await page.locator("#btn-console").click();
await waitFrames(1);
check((await consoleState()).visible === true, "the Console toolbar button opens it");
const statsResult = await page.evaluate(() => window.__forge.executeConsole("stats"));
check(statsResult.ok === true && (await consoleState()).entries >= 1, "the visible Console runs the registered stats command");
const unsafeResult = await page.evaluate(() => window.__forge.executeConsole("Math.max 1 2"));
check(unsafeResult.ok === false && /unknown command|never evaluated/i.test(unsafeResult.output.join("\n")), "JavaScript-looking input is rejected as a command, not evaluated");
check((await page.locator("#console-panel .forge-console-output").textContent()).includes("stats"), "the terminal transcript is visible");
await page.evaluate(() => window.__forge.setConsoleVisible(false));
check((await consoleState()).visible === false, "the Console button closes it again");
check(consoleErrors.length === consoleErrorsBefore, `no page console errors from the Console run (${consoleErrors.slice(consoleErrorsBefore, consoleErrorsBefore + 3).join(" | ")})`);
check(consoleErrors.length === errorsBeforeInspector, `no page console errors from the Inspector run (${consoleErrors.slice(errorsBeforeInspector, errorsBeforeInspector + 3).join(" | ")})`);

console.log(`screenshots: ${menuShot} and tools/.browser-ui-{settings,hud,inventory,widgets,data,saved,dialog,light,parchment,large,compact,compact-saved,inspector,inspector-overlay}.png`);

console.log(problems.length === 0 ? `${CHECK_NAME} PASS` : `${CHECK_NAME} FAIL (${problems.length})`);
await finish(problems.length === 0 ? 0 : 1);
