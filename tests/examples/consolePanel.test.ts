/**
 * @suite examples:consolePanel
 * @group unit
 * @covers examples/src/diag/consolePanel.ts
 * @covers examples/src/diag/debugPanel.ts
 * @desc Phase 21.10 — visible safe command terminal, transcript bounds, completion, and panel state
 */

export const suite = {
  name: "examples:consolePanel",
  group: "unit",
  covers: ["examples/src/diag/consolePanel.ts", "examples/src/diag/debugPanel.ts"],
  desc: "Phase 21.10 — visible safe command terminal, transcript bounds, completion, and panel state",
};

import assert from "node:assert/strict";
import { DeveloperConsole } from "@forge/engine";
import { mountConsolePanel } from "../../examples/src/diag/consolePanel.js";
import { FakeEl, env } from "../support/fakeDom.js";
import { finish, group, test } from "selrun";

function find(root: FakeEl, className: string): FakeEl | null {
  if (root.classes.has(className)) return root;
  for (const child of root.children) {
    const found = find(child, className);
    if (found) return found;
  }
  return null;
}

group("visible developer console", () => {
  test("opens from the toolbar and executes only registered commands", () => {
    const e = env();
    const body = new FakeEl("div");
    const button = new FakeEl("button");
    e.body.append(body, button);
    const panel = mountConsolePanel({
      body: body as unknown as HTMLElement,
      button: button as unknown as HTMLElement,
      host: { stats: () => ({ frame: 7, fps: 60 }) },
      storage: null,
      doc: e.doc,
      win: e.win,
      now: e.now,
    });
    assert.equal(panel.visible, false);
    button.click();
    assert.equal(panel.visible, true);
    assert.equal(button.attrs["aria-pressed"], "true");
    assert.equal(panel.execute("stats").ok, true);
    assert.equal(panel.execute("Math.max 1 2").ok, false);
    assert.equal(panel.state().entries, 2);
    const output = find(panel.ui.root as unknown as FakeEl, "forge-console-output");
    assert.ok(output);
    assert.match(output!.textContent, /frame/);
    assert.match(output!.textContent, /unknown command|never evaluated/i);
    panel.dispose();
  });

  test("keeps transcript and completion bounded by the engine command model", () => {
    const e = env();
    const body = new FakeEl("div");
    e.body.appendChild(body);
    const model = new DeveloperConsole({ stats: () => "ok" }, { maxHistory: 2, maxOutputChars: 256 });
    const panel = mountConsolePanel({ body: body as unknown as HTMLElement, host: {}, console: model, storage: null, doc: e.doc, win: e.win, now: e.now });
    panel.setVisible(true);
    panel.execute("stats");
    panel.execute("help");
    panel.execute("unknown");
    assert.equal(panel.state().entries, 2);
    assert.deepEqual(model.history.map((entry) => entry.command), ["help", "unknown"]);
    const input = find(panel.ui.root as unknown as FakeEl, "forge-console-input");
    assert.ok(input);
    input!.value = "pro";
    input!.fire("keydown", { key: "Tab" });
    assert.equal(input!.value, "profiler ", "Tab completes a command without evaluating it");
    panel.dispose();
  });
});

finish();
