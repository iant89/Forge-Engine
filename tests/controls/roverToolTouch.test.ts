/**
 * @suite controls:roverToolTouch
 * @group unit
 * @covers examples/src/controls/roverToolTouch.ts
 * @covers examples/src/scenes/roverTools.ts
 * @desc Proximity-gated Mars turret action panel
 */

export const suite = {
  name: "controls:roverToolTouch",
  group: "unit",
  covers:   [
    "examples/src/controls/roverToolTouch.ts",
    "examples/src/scenes/roverTools.ts"
  ],
  desc: "Proximity-gated Mars turret action panel",
};
/** Proximity-gated Mars turret action panel. */
import assert from "node:assert/strict";
import { afterEach, finish, group, test } from "selrun";
import { attachRoverToolTouch, type RoverToolTouchHandle } from "../../examples/src/controls/roverToolTouch.js";
import type { RoverToolAction } from "../../examples/src/scenes/roverTools.js";

type Listener = (event: Event) => void;

class StubElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly classes = new Set<string>();
  readonly attrs = new Map<string, string>();
  readonly style: { width?: string } = {};
  textContent: string | null = "";
  disabled = false;

  readonly classList = {
    add: (name: string): void => void this.classes.add(name),
    remove: (name: string): void => void this.classes.delete(name),
    toggle: (name: string, force?: boolean): boolean => {
      const enabled = force ?? !this.classes.has(name);
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
      return enabled;
    },
  };

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    const index = list?.indexOf(listener) ?? -1;
    if (index >= 0) list!.splice(index, 1);
  }

  fire(type: string): { prevented: boolean } {
    let prevented = false;
    const event = {
      preventDefault() { prevented = true; },
      stopPropagation() {},
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event as unknown as Event);
    return { prevented };
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, list) => total + list.length, 0);
  }
}

function stubRoot() {
  const panel = new StubElement();
  const target = new StubElement();
  const status = new StubElement();
  const progress = new StubElement();
  const buttons = {
    drill: new StubElement(),
    abrade: new StubElement(),
    analyze: new StubElement(),
  };
  const elements = new Map<string, StubElement>([
    ["#rover-tool-panel", panel],
    ["#rover-tool-target", target],
    ["#rover-tool-status", status],
    ["#rover-tool-progress", progress],
    ["#mars-tool-drill", buttons.drill],
    ["#mars-tool-abrade", buttons.abrade],
    ["#mars-tool-analyze", buttons.analyze],
  ]);
  const root = { querySelector: (selector: string) => elements.get(selector) ?? null } as unknown as HTMLElement;
  return { root, panel, target, status, progress, buttons };
}

group("attachRoverToolTouch", () => {
  let handle: RoverToolTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  test("shows only when a reachable rock is prompted and dispatches the selected tool", () => {
    const { root, panel, target, buttons } = stubRoot();
    const actions: RoverToolAction[] = [];
    handle = attachRoverToolTouch(root, (action) => actions.push(action));
    assert.equal(handle.visible, false);
    assert.equal(panel.classes.has("shown"), false);
    assert.equal([...Object.values(buttons)].every((button) => button.disabled), true);

    handle.setTarget("ROCK · 0.7 m");
    assert.equal(handle.visible, true);
    assert.equal(panel.classes.has("shown"), true);
    assert.equal(panel.attrs.get("aria-hidden"), "false");
    assert.equal(target.textContent, "ROCK · 0.7 m");
    assert.equal(buttons.drill.disabled, false);
    buttons.drill.fire("click");
    buttons.analyze.fire("click");
    assert.deepEqual(actions, ["drill", "analyze"]);
  });

  test("locks actions during automatic alignment/work and reports bounded progress", () => {
    const { root, panel, status, progress, buttons } = stubRoot();
    handle = attachRoverToolTouch(root, () => {});
    handle.setTarget("BOULDER · 1.3 m");
    handle.setBusy("ALIGNING ARM");
    handle.setProgress(0.42);
    assert.equal(handle.visible, true);
    assert.equal(panel.classes.has("shown"), true);
    assert.equal(status.textContent, "ALIGNING ARM");
    assert.equal([...Object.values(buttons)].every((button) => button.disabled), true);
    assert.equal(progress.style.width, "42%");
    assert.equal(progress.attrs.get("aria-valuenow"), "42");

    handle.setProgress(2);
    assert.equal(progress.style.width, "100%");
    handle.setBusy(null);
    assert.equal(buttons.abrade.disabled, false);
  });

  test("hides after the target leaves reach and removes listeners on dispose", () => {
    const { root, panel, buttons } = stubRoot();
    handle = attachRoverToolTouch(root, () => {});
    handle.setTarget("ROCK · 0.4 m");
    assert.equal([...Object.values(buttons)].some((button) => button.listenerCount() > 0), true);
    handle.setTarget(null);
    assert.equal(handle.visible, false);
    assert.equal(panel.classes.has("shown"), false);
    handle.dispose();
    handle = null;
    assert.equal([...Object.values(buttons)].every((button) => button.listenerCount() === 0), true);
    assert.equal(panel.attrs.get("aria-hidden"), "true");
  });
});

await finish();
