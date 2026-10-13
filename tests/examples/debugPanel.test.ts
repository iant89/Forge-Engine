/**
 * @suite examples:debugPanel
 * @group unit
 * @covers examples/src/diag/debugPanel.ts
 * @desc Pins the shared debug-panel title bar: collapse state + localStorage persistence (tolerating missing/throwing storage), toggle glyphs, copy text and the clipboard fallback, and the bar/body DOM order
 */

export const suite = {
  name: "examples:debugPanel",
  group: "unit",
  covers: [
    "examples/src/diag/debugPanel.ts",
  ],
  desc: "Pins the shared debug-panel title bar: collapse state + localStorage persistence (tolerating missing/throwing storage), toggle glyphs, copy text and the clipboard fallback, and the bar/body DOM order",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { CollapseState, copyResultLabel, mountDebugPanel, toggleGlyph, type StorageLike } from "../../examples/src/diag/debugPanel.js";

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

class FakeEl {
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  classes = new Set<string>();
  style: Record<string, string> = {};
  textContent = "";
  innerHTML = "";
  id = "";
  type = "";
  title = "";
  value = "";
  readOnly = false;
  contentEditable = "";
  constructor(public tag: string) {}
  get className(): string { return [...this.classes].join(" "); }
  set className(v: string) { this.classes = new Set(v.split(/\s+/).filter(Boolean)); }
  classList = {
    add: (c: string) => this.classes.add(c),
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(c: FakeEl) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs: FakeEl[]) { for (const c of cs) this.appendChild(c); }
  removeChild(c: FakeEl) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  insertBefore(c: FakeEl, ref: FakeEl) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); return c; }
  remove() { this.parentNode?.removeChild(this); }
  addEventListener(t: string, f: (e: unknown) => void) { (this.listeners[t] ??= []).push(f); }
  removeEventListener(t: string, f: (e: unknown) => void) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f); }
  click() { for (const f of this.listeners.click ?? []) f({ stopPropagation() {} }); }
  focus() {}
  select() {}
  setSelectionRange() {}
}

function fakeDoc(execOk: boolean) {
  const head = new FakeEl("head");
  const body = new FakeEl("body");
  const execs: string[] = [];
  const doc = {
    head,
    body,
    createElement: (t: string) => new FakeEl(t),
    getElementById: (id: string) => head.children.find((c) => c.id === id) ?? null,
    execCommand: (c: string) => { execs.push(c); return execOk; },
  };
  return { doc: doc as unknown as Document, body, head, execs };
}

function mount(opts: { storage?: StorageLike | null; barEdge?: "top" | "bottom"; clipboard?: { writeText(t: string): Promise<void> } | null; execOk?: boolean; text?: string }) {
  const f = fakeDoc(opts.execOk ?? true);
  const panelBody = new FakeEl("div");
  f.body.appendChild(panelBody);
  const p = mountDebugPanel({
    body: panelBody as unknown as HTMLElement,
    title: "stats",
    barEdge: opts.barEdge ?? "bottom",
    getText: () => opts.text ?? "fps 60",
    storageKey: "k",
    storage: opts.storage ?? null,
    clipboard: opts.clipboard ?? null,
    doc: f.doc,
  });
  return { ...f, p, panelBody, root: p.root as unknown as FakeEl };
}

group("CollapseState", () => {
  test("defaults, toggles and persists", () => {
    const s = mem();
    const c = new CollapseState("k", s);
    assert.equal(c.collapsed, false);
    assert.equal(c.toggle(), true);
    assert.equal(s.data.get("k"), "1");
    assert.equal(new CollapseState("k", s).collapsed, true, "restored from storage");
    c.toggle();
    assert.equal(s.data.get("k"), "0");
    assert.equal(new CollapseState("k", s, true).collapsed, false, "stored 0 beats initial");
  });
  test("garbage or missing storage falls back to initial", () => {
    const s = mem();
    s.data.set("k", "maybe");
    assert.equal(new CollapseState("k", s, true).collapsed, true);
    const c = new CollapseState("k", null);
    assert.equal(c.toggle(), true);
  });
  test("throwing storage (Safari private mode) never throws", () => {
    const bad: StorageLike = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    const c = new CollapseState("k", bad);
    assert.equal(c.collapsed, false);
    assert.equal(c.toggle(), true);
  });
});

group("labels", () => {
  test("glyphs point the way the panel moves", () => {
    assert.equal(toggleGlyph(false, "bottom"), "▴");
    assert.equal(toggleGlyph(true, "bottom"), "▾");
    assert.equal(toggleGlyph(false, "top"), "▾");
    assert.equal(toggleGlyph(true, "top"), "▴");
    assert.equal(copyResultLabel(true), "Copied");
    assert.equal(copyResultLabel(false), "Copy failed");
  });
});

group("mountDebugPanel", () => {
  test("bottom-edge bar comes after the body, copy left of the toggle at the far right", () => {
    const m = mount({});
    assert.equal(m.body.children[0], m.root, "root takes the body's place");
    assert.equal(m.root.children[0], m.panelBody);
    const bar = m.root.children[1]!;
    const last = bar.children.at(-1)!, prev = bar.children.at(-2)!;
    assert.ok(last.classes.has("fdp-toggle"));
    assert.ok(prev.classes.has("fdp-copy"));
    assert.match(prev.innerHTML, /<svg/);
    assert.ok(m.head.children.some((c) => c.tag === "style"), "styles injected once");
  });
  test("top-edge bar comes before the body", () => {
    const m = mount({ barEdge: "top" });
    assert.ok(m.root.children[0]!.classes.has("fdp-bar"));
    assert.equal(m.root.children[1], m.panelBody);
  });
  test("toggle collapses, persists and updates aria", () => {
    const s = mem();
    const m = mount({ storage: s });
    const t = m.p.toggleButton as unknown as FakeEl;
    assert.equal(t.attrs["aria-expanded"], "true");
    t.click();
    assert.ok(m.root.classes.has("fdp-collapsed"));
    assert.equal(t.attrs["aria-expanded"], "false");
    assert.equal(s.data.get("k"), "1");
    const again = mount({ storage: s });
    assert.ok(again.root.classes.has("fdp-collapsed"), "restored collapsed on remount");
  });
  test("copy writes getText() via clipboard synchronously", async () => {
    const written: string[] = [];
    const m = mount({ text: "frame 1\nfps 60", clipboard: { writeText: async (t) => void written.push(t) } });
    const p = m.p.copy();
    assert.deepEqual(written, ["frame 1\nfps 60"]);
    assert.equal(await p, true);
    assert.deepEqual(m.execs, []);
  });
  test("rejecting clipboard falls back to execCommand copy", async () => {
    const m = mount({ clipboard: { writeText: () => Promise.reject(new Error("NotAllowed")) } });
    assert.equal(await m.p.copy(), true);
    assert.deepEqual(m.execs, ["copy"]);
  });
  test("no clipboard and failing execCommand reports failure", async () => {
    const m = mount({ clipboard: null, execOk: false });
    assert.equal(await m.p.copy(), false);
    m.p.dispose();
    assert.equal(m.body.children.length, 0);
  });
});

finish();
