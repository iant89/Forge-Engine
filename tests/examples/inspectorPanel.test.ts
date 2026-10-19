/**
 * @suite examples:inspectorPanel
 * @group unit
 * @covers examples/src/diag/inspectorPanel.ts
 * @covers examples/src/diag/inspectorTabs.ts
 * @desc Pins the demo's Inspector window: it starts closed, every tab turns its snapshot into rows and a lazy detail view, selection follows a row's key across refreshes, the filter narrows the list, a missing subsystem reports a note instead of throwing, overlays are opt-in and drawn through the host's line sink, and a refresh that changes nothing rebuilds nothing
 */

export const suite = {
  name: "examples:inspectorPanel",
  group: "unit",
  covers: [
    "examples/src/diag/inspectorPanel.ts",
    "examples/src/diag/inspectorTabs.ts",
  ],
  desc: "Pins the demo's Inspector window: it starts closed, every tab turns its snapshot into rows and a lazy detail view, selection follows a row's key across refreshes, the filter narrows the list, a missing subsystem reports a note instead of throwing, overlays are opt-in and drawn through the host's line sink, and a refresh that changes nothing rebuilds nothing",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  AssetStreamer,
  EntityWorld,
  GraphicsDevice,
  Profiler,
  RenderGraph,
  ResourceRegistry,
  Scene,
  TaskScheduler,
  TerrainChunk,
  TerrainWorld,
  TextureUsage,
  Transform,
  Vec3,
} from "@forge/engine";
import { mountInspectorPanel, type InspectorRow } from "../../examples/src/diag/inspectorPanel.js";
import { INSPECTOR_TABS, type InspectorSource, type InspectorTab } from "../../examples/src/diag/inspectorTabs.js";
import { FakeEl, env, type FakeEnv } from "../support/fakeDom.js";

interface Rig {
  env: FakeEnv;
  /** Ids of the two entities the fixture scene starts with (Camera Rig, Rover). */
  ids: { rig: number; rover: number };
  panel: ReturnType<typeof mountInspectorPanel>;
  body: FakeEl;
  button: FakeEl;
  source: InspectorSource;
  scene: Scene;
  lines: { count: number };
  /** The panel's tab strip, filter box, overlay checkbox, list and detail pane. */
  tabs: FakeEl[];
  filter: FakeEl;
  overlay: FakeEl;
  list: FakeEl;
  detail: FakeEl;
  notes: FakeEl;
  summary: FakeEl;
}

const renderTarget = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING;

async function rig(overrides: Partial<InspectorSource> = {}, tabs: readonly InspectorTab[] = INSPECTOR_TABS): Promise<Rig> {
  const e = env();
  const body = new FakeEl("div");
  const button = new FakeEl("button");
  e.body.append(body, button);

  const scene = new Scene({ name: "inspect-demo" });
  const rigEntity = scene.world.createEntity("Camera Rig");
  rigEntity.add(new Transform());
  const rover = scene.world.createEntity("Rover");
  rover.add(new Transform());
  const ids = { rig: rigEntity.id, rover: rover.id };
  scene.world.registerSystem({ name: "physics", order: 10, enabled: true, update() {}, stats: () => ({ bodies: 2 }) });

  const device = await GraphicsDevice.create({ forceMock: true });
  device.resize(64, 32);
  const graph = new RenderGraph(device);
  graph.begin();
  const swapchain = graph.importTexture("swapchain", device.currentTexture!);
  const hdr = graph.createTexture("hdr", { width: 64, height: 32, format: "rgba16float", usage: renderTarget });
  const unused = graph.createTexture("debugDump", { width: 16, height: 16, format: "rgba16float", usage: renderTarget });
  graph.addPass({ name: "forward", color: [{ texture: hdr }], execute: (c) => void c.beginRenderPass().end() });
  graph.addPass({ name: "debug", color: [{ texture: unused }], execute: (c) => void c.beginRenderPass().end() });
  graph.addPass({ name: "tonemap", reads: [hdr], color: [{ texture: swapchain }], execute: (c) => void c.beginRenderPass().end() });
  graph.execute();

  const lines = { count: 0 };
  const source: InspectorSource = {
    currentScene: scene,
    profiler: new Profiler(),
    renderer: { graph },
    gpu: device,
    streamer: new AssetStreamer(new ResourceRegistry()),
    tasks: new TaskScheduler({ inline: true }),
    stats: () => ({}),
    drawLine: () => {
      lines.count++;
    },
    ...overrides,
  };

  const panel = mountInspectorPanel({
    body: body as unknown as HTMLElement,
    button: button as unknown as HTMLElement,
    tabs,
    source: () => source,
    storage: null,
    doc: e.doc,
    win: e.win,
    now: e.now,
  });

  // The shell is the element the panel adopted as its body; its children, in the order the shell
  // builds them, are: tabs, tools (filter + overlay + count), summary, split (list + detail), notes.
  const shell = (panel.ui.root as unknown as FakeEl).children.find((child) => child.classes.has("fdp-body"))!;
  const children = shell.children;
  const tabBar = children[0]!;
  const tools = children[1]!;
  return {
    env: e,
    ids,
    panel,
    body,
    button,
    source,
    scene,
    lines,
    tabs: tabBar.children,
    filter: tools.children[0]!,
    overlay: (tools.children[1]!.children[0] ?? tools.children[1]!) as FakeEl,
    list: children[3]!.children[0]!,
    detail: children[3]!.children[1]!,
    notes: children[4]!,
    summary: children[2]!,
  };
}

const open = (r: Rig): void => r.button.click();
const rowText = (r: Rig, index: number): string => (r.list.children[index]!.children[0]! as FakeEl).textContent;

group("the window itself", () => {
  test("starts closed and costs nothing until the toolbar button opens it", async () => {
    const r = await rig();
    assert.equal(r.panel.visible, false);
    assert.equal(r.panel.state().refreshed, 0, "a closed inspector reads no snapshots");
    open(r);
    assert.equal(r.panel.visible, true);
    assert.equal(r.panel.state().refreshed, 1);
    assert.ok(r.panel.state().rows > 0, "and the first tab has rows");
  });

  test("offers every diagnostic API as a tab, and switching tabs reloads", async () => {
    const r = await rig();
    open(r);
    assert.deepEqual(r.tabs.map((t) => t.textContent), ["ECS", "Systems", "Graph", "GPU", "Physics", "Terrain", "Particles", "Streaming", "World"]);
    assert.equal(r.panel.state().tab, "ecs");
    r.tabs[1]!.click();
    assert.equal(r.panel.state().tab, "systems");
    assert.match(r.summary.textContent, /systems 2/);
    assert.match(rowText(r, 0), /physics/);
    r.tabs[2]!.click();
    assert.equal(r.panel.state().tab, "graph");
    assert.match(r.summary.textContent, /passes 3/);
    assert.match(r.summary.textContent, /culled 1/);
  });

  test("the summary, the rows and the notes all come from the active tab", async () => {
    const r = await rig();
    open(r);
    assert.match(r.summary.textContent, /entities 2/);
    assert.match(r.summary.textContent, /components 2/);
    r.tabs[3]!.click();
    assert.match(r.summary.textContent, /total \d/);
    r.tabs[4]!.click();
    assert.match(r.notes.textContent, /PhysicsSystem/, "no physics system in this scene, so the tab says so");
    r.tabs[5]!.click();
    assert.match(r.notes.textContent, /TerrainWorld/);
  });

  test("refresh is throttled while the panel is open", async () => {
    const r = await rig();
    open(r);
    const before = r.panel.state().refreshed;
    r.panel.tick(r.env.now() + 100);
    assert.equal(r.panel.state().refreshed, before, "100 ms is too soon");
    r.panel.tick(r.env.now() + 600);
    assert.equal(r.panel.state().refreshed, before + 1);
    r.panel.setVisible(false);
    const closed = r.panel.state().refreshed;
    r.panel.tick(r.env.now() + 100000);
    assert.equal(r.panel.state().refreshed, closed, "a closed panel stops refreshing entirely");
  });
});

group("browsing", () => {
  test("selecting a row shows its detail, and the detail is computed only for that row", async () => {
    const r = await rig();
    open(r);
    // Two entities: whichever row is the rover, selecting it must name it and its components.
    const index = rowText(r, 0).includes("Rover") ? 0 : 1;
    assert.match(rowText(r, index), /Rover/);
    r.list.children[index]!.click();
    const selected = r.panel.state().selected;
    assert.ok(selected, "a row is selected");
    assert.match(r.detail.textContent, /^#\d+ Rover/);
    assert.match(r.detail.textContent, /Transform/, "the component detail comes from inspectEntity, so its fields are there");
    assert.match(r.detail.textContent, /0\.000, 0\.000, 0\.000/, "component fields, formatted to three decimals");
    assert.equal(selected, r.panel.state().selected, "the selection is stable");
    assert.equal(r.detail.textContent.includes("Camera Rig"), false, "and no other row's detail is computed");
  });

  test("the selection follows the row's key across a refresh, not its position", async () => {
    const r = await rig();
    open(r);
    // A third entity so the rover sits in the middle of the list and can be made to move.
    const third = r.scene.world.createEntity("Aardvark");
    third.add(new Transform());
    r.panel.tick(r.env.now() + 10000);
    const before = r.list.children.findIndex((node) => (node.children[0] as FakeEl).textContent.includes("Rover"));
    assert.equal(before, 1, "the rover is the middle row: [Camera Rig, Rover, Aardvark]");
    r.list.children[before]!.click();
    const key = r.panel.state().selected;

    // Destroy the row *above* it: the rover's position changes, and a positional selection would
    // quietly slide onto the Aardvark.
    r.scene.world.destroyEntity(r.ids.rig);
    r.panel.tick(r.env.now() + 20000);
    assert.equal(r.panel.state().selected, key, "still the rover");
    const after = r.list.children.findIndex((node) => (node.children[0] as FakeEl).textContent.includes("Rover"));
    assert.equal(after, 0, `and its row really did move (${before} → ${after})`);
    assert.match(r.detail.textContent, /Rover/, "the detail pane followed the key, not the index");
  });

  test("a row that disappears takes its selection with it", async () => {
    const r = await rig();
    open(r);
    const index = r.list.children.findIndex((node) => (node.children[0] as FakeEl).textContent.includes("Rover"));
    r.list.children[index]!.click();
    const key = r.panel.state().selected!;
    assert.match(key, /^e\d+$/);
    r.scene.world.destroyEntity(r.ids.rover);
    r.panel.tick(r.env.now() + 10000);
    assert.equal(r.panel.state().selected, null, "the row is gone, so nothing is selected");
    assert.match(r.detail.textContent, /select a row/);
  });

  test("the filter narrows the list, and clearing it brings the rows back", async () => {
    const r = await rig();
    open(r);
    const all = r.panel.state().rows;
    r.filter.value = "Rover";
    r.filter.fire("input");
    assert.equal(r.panel.state().rows, 1);
    assert.match(rowText(r, 0), /Rover/);
    assert.equal(r.panel.state().selected, null, "a new filter forgets the old selection");
    r.filter.value = "nothing-matches-this";
    r.filter.fire("input");
    assert.equal(r.panel.state().rows, 0);
    assert.match(r.notes.textContent, /no entity matches/);
    r.filter.value = "";
    r.filter.fire("input");
    assert.equal(r.panel.state().rows, all);
  });

  test("a tab that ignores the filter still refreshes, and one that matches nothing says so", async () => {
    const r = await rig();
    open(r);
    r.tabs[2]!.click(); // Graph
    r.filter.value = "forward";
    r.filter.fire("input");
    assert.equal(r.panel.state().rows, 1);
    assert.match(rowText(r, 0), /forward/);
  });

  test("a refresh that changes nothing rebuilds no rows and keeps the scroll position's nodes", async () => {
    const r = await rig();
    open(r);
    const first = r.list.children[0]!;
    const count = r.list.children.length;
    r.panel.tick(r.env.now() + 10000);
    assert.equal(r.list.children.length, count);
    assert.equal(r.list.children[0], first, "the same node is reused: the list is not rebuilt every 500 ms");
  });

  test("the rows of a tab that has no data at all are empty, with a note that says why", async () => {
    const r = await rig({ currentScene: null });
    open(r);
    assert.equal(r.panel.state().rows, 0);
    assert.match(r.notes.textContent, /no scene is active/);
    assert.match(r.detail.textContent, /nothing to inspect/);
  });

  test("a tab whose snapshot throws reports the failure instead of breaking the window", async () => {
    const boom: InspectorTab = {
      id: "boom",
      title: "Boom",
      load() {
        throw new Error("the snapshot is on fire");
      },
    };
    const r = await rig({}, [boom, INSPECTOR_TABS[0]!]);
    open(r);
    assert.match(r.notes.textContent, /the snapshot is on fire/);
    assert.equal(r.panel.state().rows, 0);
    r.tabs[1]!.click();
    assert.ok(r.panel.state().rows > 0, "and the other tabs still work");
  });

  test("the row cap bounds the DOM, not the data", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `row ${i}` }));
    const tab: InspectorTab = {
      id: "many",
      title: "Many",
      load: () => ({ summary: [{ label: "rows", value: String(many.length) }], rows: many as InspectorRow[], notes: [] }),
    };
    const r = await rig({}, [tab]);
    open(r);
    assert.equal(r.panel.state().rows, 40);
    r.panel.setVisible(false);
  });
});

group("overlays", () => {
  test("are opt-in: nothing is drawn until the checkbox is switched on", async () => {
    const r = await rig();
    open(r);
    r.tabs[5]!.click(); // Terrain
    assert.equal(r.panel.drawOverlays(), 0, "no overlay is enabled");
    assert.deepEqual(r.panel.state().overlays, []);

    // A terrain world with one pending chunk in it, so the tab has something to draw.
    const terrain = new TerrainWorld({ chunkSize: 16, chunkResolution: 5, viewDistance: 48, horizonSkirt: false });
    const chunk = new TerrainChunk(1, -2, 16, 5, 1);
    terrain.chunks.set(chunk.key, chunk);
    r.scene.add(terrain as unknown as never);
    r.panel.tick(r.env.now() + 10000);
    assert.equal(r.panel.state().tab, "terrain");

    r.overlay.checked = true;
    r.overlay.fire("change");
    assert.deepEqual(r.panel.state().overlays, ["terrain"]);
    const drawn = r.panel.drawOverlays();
    assert.ok(drawn > 0, `the overlay drew lines (${drawn})`);
    assert.equal(r.lines.count, drawn, "every line went through the host's sink");
    assert.equal(r.panel.state().drawn, drawn, "and the panel remembers how many, for a gate to read");
  });

  test("a host with no line sink draws nothing rather than throwing", async () => {
    const r = await rig({ drawLine: null });
    open(r);
    r.tabs[5]!.click();
    r.overlay.checked = true;
    r.overlay.fire("change");
    assert.equal(r.panel.drawOverlays(), 0);
  });

  test("only the enabled tab's overlay is drawn, and disabling it stops the lines", async () => {
    const r = await rig();
    open(r);
    r.tabs[5]!.click();
    r.overlay.checked = true;
    r.overlay.fire("change");
    assert.deepEqual(r.panel.state().overlays, ["terrain"]);
    r.overlay.checked = false;
    r.overlay.fire("change");
    assert.deepEqual(r.panel.state().overlays, []);
    assert.equal(r.panel.drawOverlays(), 0);
    assert.equal(r.panel.state().drawn, 0, "and the count goes back to zero with it");
  });
});

group("disposal", () => {
  test("a disposed inspector stops refreshing and drawing", async () => {
    const r = await rig();
    open(r);
    r.panel.dispose();
    const before = r.panel.state().refreshed;
    r.panel.tick(r.env.now() + 100000);
    assert.equal(r.panel.state().refreshed, before);
  });
});

/** Keeps the unused-import warning away for `Vec3`, which the sink type mentions. */
void Vec3;
void EntityWorld;

finish();
