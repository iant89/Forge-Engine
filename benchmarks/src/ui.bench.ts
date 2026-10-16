/**
 * UI framework benchmark (docs/UI-GUIDE.md §Performance).
 *
 * Runs the retained-mode pipeline headless (no GPU: `UIManager.update` + `render()` produce the
 * instance list the WebGPU backend uploads) over workloads that separate the costs that matter:
 *
 * - **build** — create 1,000 buttons in a wrapping grid and lay them out once;
 * - **steady frame** — nothing changed: must do no style resolves, no measures and no draw-list rebuild;
 * - **hover sweep** — the pointer crosses a button every frame (state change → restyle → transition →
 *   draw-list rebuild, no relayout);
 * - **local text change** — one label's text changes each frame inside a fixed-size panel (a layout
 *   boundary), so only that panel's subtree re-measures;
 * - **viewport resize** — the whole tree relayouts (the worst case a window drag produces);
 * - **draw-list rebuild** — painting 1,000 buttons into the instance buffer;
 * - **virtualized scroll** — a 100,000-row list scrolled every frame;
 * - **text layout** — 800 distinct strings shaped through the SDF font (cache misses), then the same
 *   strings again (cache hits; 800 fits the engine's default 1,024-entry LRU — cycling more strings
 *   than the capacity through an LRU is a 0 % hit rate by construction).
 *
 * The guards are shape checks, not stopwatch thresholds, so a slower runner does not go red: a steady
 * frame must do zero layout/style work, a local text change must measure a small fraction of what a
 * resize does, the virtualized list must keep its element pool bounded, and a cache hit must be much
 * cheaper than a miss.
 */

import { Button, Grid, Label, Panel, UIManager, VirtualizedList, VStack } from "@forge/engine";
import type { BenchmarkResult } from "./ecs.bench.ts";

export interface UIBenchmark {
  results: BenchmarkResult[];
  notes: string[];
  steadyMeasures: number;
  steadyResolves: number;
  steadyRebuilt: boolean;
  localMeasures: number;
  resizeMeasures: number;
  pool: number;
  instances: number;
  batches: number;
  cacheMissMs: number;
  cacheHitMs: number;
  cacheHits: number;
  textStrings: number;
}

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function result(name: string, count: number, ms: number): BenchmarkResult {
  return { name, count, durationMs: ms, opsPerSec: Math.round(count / Math.max(1e-9, ms / 1000)) };
}

export function runUIBenchmark(buttons = 1000): UIBenchmark {
  const results: BenchmarkResult[] = [];
  const ui = new UIManager({ width: 1920, height: 1080 });
  const root = ui.base.add(new VStack({ gap: 8, layout: { padding: 8, width: "100%" } }));
  const status = root.add(new Panel({ layout: { width: 400, height: 40 } }));
  const label = status.add(new Label({ text: "frame 0" }));
  const grid = root.add(new Grid({ columns: { autoFill: 110 }, columnGap: 4, rowGap: 4, layout: { width: "100%" } }));
  const all: Button[] = [];

  results.push(result(`UI build + layout (${buttons} buttons)`, buttons, time(() => {
    for (let i = 0; i < buttons; i++) all.push(grid.add(new Button({ text: `Item ${i}` })));
    ui.update(1 / 60);
    ui.render();
  })));

  // Warm up (styles, glyph atlas, transitions settled).
  for (let i = 0; i < 30; i++) {
    ui.update(1 / 60);
    ui.render();
  }

  // Steady frames.
  let steadyMeasures = 0;
  let steadyResolves = 0;
  let steadyRebuilt = false;
  const steadyFrames = 300;
  results.push(result("UI steady frame (update + render)", steadyFrames, time(() => {
    for (let i = 0; i < steadyFrames; i++) {
      const f = ui.update(1 / 60);
      steadyMeasures += f.measures;
      steadyResolves += f.styleResolves;
      ui.render();
      steadyRebuilt ||= f.drawListRebuilt;
    }
  })));

  // Hover sweep: the pointer moves to a different button every frame.
  const hoverFrames = 300;
  results.push(result("UI hover sweep (restyle + repaint)", hoverFrames, time(() => {
    for (let i = 0; i < hoverFrames; i++) {
      const b = all[(i * 7) % all.length]!.bounds;
      ui.router.pointerMove(b.x + b.width / 2, b.y + b.height / 2, 1, "mouse");
      ui.update(1 / 60);
      ui.render();
    }
  })));
  ui.router.pointerMove(5, 1075, 1, "mouse");
  for (let i = 0; i < 30; i++) {
    ui.update(1 / 60);
    ui.render();
  }

  // Local text change inside a fixed-size panel.
  let localMeasures = 0;
  const textFrames = 300;
  results.push(result("UI local text change (layout boundary)", textFrames, time(() => {
    for (let i = 0; i < textFrames; i++) {
      label.text = `frame ${i + 1}`;
      localMeasures += ui.update(1 / 60).measures;
      ui.render();
    }
  })));
  localMeasures /= textFrames;

  // Full relayout on resize.
  let resizeMeasures = 0;
  const resizes = 60;
  results.push(result("UI viewport resize (full relayout)", resizes, time(() => {
    for (let i = 0; i < resizes; i++) {
      ui.setViewport(1920 - (i % 2) * 300, 1080);
      resizeMeasures += ui.update(1 / 60).measures;
      ui.render();
    }
  })));
  resizeMeasures /= resizes;

  // Draw-list rebuild only.
  const rebuilds = 200;
  results.push(result(`UI draw-list rebuild (${buttons} buttons)`, rebuilds, time(() => {
    for (let i = 0; i < rebuilds; i++) {
      ui.markRenderDirty();
      ui.render();
    }
  })));
  const list = ui.render();
  const instances = list.count;
  const batches = list.batches.length;
  ui.dispose();

  // Virtualized list scroll.
  const vui = new UIManager({ width: 1280, height: 720 });
  const rows = Array.from({ length: 100_000 }, (_, i) => `row ${i}`);
  const vlist = vui.base.add(new VirtualizedList<string>({ items: rows, itemExtent: 22, createItem: () => new Label(), bindItem: (el, item) => ((el as Label).text = item), layout: { width: 600, height: 700 } }));
  vui.update(1 / 60);
  vui.render();
  const scrollFrames = 600;
  results.push(result("UI virtualized scroll (100k rows)", scrollFrames, time(() => {
    for (let i = 0; i < scrollFrames; i++) {
      vui.router.wheel(300, 300, 0, 37);
      vui.update(1 / 60);
      vui.render();
    }
  })));
  const pool = vlist.instantiated;
  vui.dispose();

  // Text layout: misses then hits.
  const tui = new UIManager({ width: 800, height: 600 });
  const strings = Array.from({ length: 800 }, (_, i) => `Quest log entry ${i}: reach waypoint ${(i * 31) % 97}`);
  const cacheMissMs = time(() => {
    for (const s of strings) tui.text.layout({ text: s, family: "default", size: 16 });
  });
  const hitsBefore = tui.text.stats.hits;
  const cacheHitMs = time(() => {
    for (const s of strings) tui.text.layout({ text: s, family: "default", size: 16 });
  });
  const cacheHits = tui.text.stats.hits - hitsBefore;
  results.push(result("UI text layout (cache miss)", strings.length, cacheMissMs));
  results.push(result("UI text layout (cache hit)", strings.length, cacheHitMs));
  tui.dispose();

  const notes = [
    `steady frame: ${steadyMeasures} measures, ${steadyResolves} style resolves, draw list rebuilt: ${steadyRebuilt}`,
    `local text change: ${localMeasures.toFixed(1)} measures/frame vs ${resizeMeasures.toFixed(0)} for a full relayout`,
    `${buttons} buttons → ${instances} instances in ${batches} batch(es)`,
    `virtualized 100k rows: ${pool} elements instantiated`,
    `text layout: ${cacheMissMs.toFixed(1)} ms for ${strings.length} misses, ${cacheHitMs.toFixed(2)} ms for ${cacheHits} hits`,
  ];
  return { results, notes, steadyMeasures, steadyResolves, steadyRebuilt, localMeasures, resizeMeasures, pool, instances, batches, cacheMissMs, cacheHitMs, cacheHits, textStrings: strings.length };
}

/** Shape guards; returns failure messages (empty = pass). */
export function assertUIBenchmark(b: UIBenchmark): string[] {
  const fails: string[] = [];
  if (b.steadyMeasures !== 0 || b.steadyResolves !== 0 || b.steadyRebuilt) fails.push(`steady frames did work (${b.notes[0]})`);
  if (!(b.localMeasures * 20 < b.resizeMeasures)) fails.push(`a local text change re-measured too much (${b.notes[1]})`);
  if (b.pool > 60) fails.push(`virtualized list pool grew to ${b.pool}`);
  if (b.cacheHits !== b.textStrings) fails.push(`the second text pass was not served from the cache (${b.cacheHits}/${b.textStrings} hits)`);
  if (!(b.cacheHitMs * 5 < b.cacheMissMs)) fails.push(`text cache hits are not much cheaper than misses (${b.notes[4]})`);
  if (b.batches > 3) fails.push(`${b.batches} batches for solid widgets + one atlas`);
  return fails;
}
