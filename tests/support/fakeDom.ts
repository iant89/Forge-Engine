/**
 * A tiny fake DOM + window for the demo's floating-panel suites (`debugPanel`, `profilerPanel`):
 * elements carrying class lists, listeners, inline styles and pointer capture, plus a window whose
 * clock and interval callbacks a test drives by hand — so the edge-snap dwell timer, the icon
 * re-placement tick and the profiler's repaint throttle are deterministic instead of wall-clock.
 *
 * It is deliberately the same shape `mountDebugPanel` pokes at (`doc.createElement`,
 * `doc.getElementById`, `doc.querySelectorAll`, `win.getComputedStyle` on the safe-area probe,
 * pointer events with `pointerId`/`clientX`/`clientY`/`button`), which is what lets those suites
 * assert on real panel behaviour without a browser.
 */

export class FakeEl {
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
  box = { left: 0, top: 0, width: 0, height: 0 };
  captured: number | null = null;
  constructor(public tag: string) {}
  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter(Boolean));
  }
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: FakeEl) {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]) {
    for (const c of cs) this.appendChild(c);
  }
  removeChild(c: FakeEl) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  insertBefore(c: FakeEl, ref: FakeEl) {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener(t: string, f: (e: unknown) => void) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
  }
  fire(t: string, e: Record<string, unknown> = {}) {
    let stopped = false;
    const ev = { pointerId: 1, clientX: 0, clientY: 0, button: 0, stopPropagation: () => (stopped = true), preventDefault() {}, ...e };
    for (const f of this.listeners[t] ?? []) f(ev);
    return stopped;
  }
  click() {
    this.fire("click");
  }
  setPointerCapture(id: number) {
    this.captured = id;
  }
  getBoundingClientRect() {
    return this.box;
  }
  focus() {}
  select() {}
  setSelectionRange() {}
}

export interface FakeEnv {
  doc: Document;
  win: import("../../examples/src/diag/debugPanel.js").DebugPanelOptions["win"];
  head: FakeEl;
  body: FakeEl;
  execs: string[];
  /** Elements `doc.querySelectorAll(".obstacle")` returns. */
  obstacles: FakeEl[];
  /** Run every live interval callback, 100 ms of virtual time at a time. */
  advance(ms: number): void;
  rotate(w: number, h: number): void;
  now(): number;
}

export function env(opts: { execOk?: boolean; vp?: { w: number; h: number } } = {}): FakeEnv {
  const head = new FakeEl("head");
  const body = new FakeEl("body");
  const execs: string[] = [];
  const obstacles: FakeEl[] = [];
  const doc = {
    head,
    body,
    createElement: (t: string) => new FakeEl(t),
    getElementById: (id: string) => head.children.find((c) => c.id === id) ?? null,
    querySelectorAll: (sel: string) => (sel === ".obstacle" ? obstacles : []),
    execCommand: (c: string) => {
      execs.push(c);
      return opts.execOk ?? true;
    },
  };
  let clock = 0;
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const winListeners: Record<string, (() => void)[]> = {};
  const win = {
    innerWidth: opts.vp?.w ?? 400,
    innerHeight: opts.vp?.h ?? 800,
    addEventListener: (t: string, f: () => void) => void (winListeners[t] ??= []).push(f),
    removeEventListener: (t: string, f: () => void) => void (winListeners[t] = (winListeners[t] ?? []).filter((x) => x !== f)),
    setInterval: (f: () => void) => {
      const id = nextId++;
      intervals.set(id, f);
      return id;
    },
    clearInterval: (id: number) => void intervals.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      clock += 100;
      for (const f of [...intervals.values()]) f();
    }
  };
  const rotate = (w: number, h: number) => {
    win.innerWidth = w;
    win.innerHeight = h;
    for (const f of winListeners.resize ?? []) f();
  };
  return { doc: doc as unknown as Document, win: win as unknown as FakeEnv["win"], head, body, execs, obstacles, advance, rotate, now: () => clock };
}
