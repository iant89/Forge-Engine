/**
 * Toolbar hamburger — DEMO SCENE / TONE MAPPING / RENDERING stay in the DOM, start collapsed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { attachToolbarMenu, type ToolbarMenuHandle } from "../examples/src/controls/toolbarMenu.js";

type Listener = (event: Event) => void;

class StubElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly classes = new Set<string>();
  readonly attrs = new Map<string, string>();
  private readonly children = new Set<StubElement>();

  readonly classList = {
    add: (name: string): void => {
      this.classes.add(name);
    },
    remove: (name: string): void => {
      this.classes.delete(name);
    },
    toggle: (name: string, force?: boolean): boolean => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  adopt(child: StubElement): void {
    this.children.add(child);
  }

  contains(node: StubElement | null): boolean {
    if (!node) return false;
    return node === this || this.children.has(node);
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    const full = { preventDefault() {}, stopPropagation() {}, target: this, ...event };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(full as unknown as Event);
  }
}

class StubDocument {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  fire(type: string, target: unknown): void {
    const event = { target, preventDefault() {}, stopPropagation() {} };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event as unknown as Event);
  }
}

describe("attachToolbarMenu", () => {
  let handle: ToolbarMenuHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  function mount(): { toolbar: StubElement; toggle: StubElement; doc: StubDocument } {
    const toolbar = new StubElement();
    const toggle = new StubElement();
    toolbar.adopt(toggle);
    const doc = new StubDocument();
    handle = attachToolbarMenu({
      toolbar: toolbar as unknown as HTMLElement,
      toggle: toggle as unknown as HTMLElement,
      rootDocument: doc,
    });
    return { toolbar, toggle, doc };
  }

  it("starts collapsed", () => {
    const { toolbar, toggle } = mount();
    expect(handle!.isOpen()).toBe(false);
    expect(toolbar.classes.has("toolbar-open")).toBe(false);
    expect(toggle.attrs.get("aria-expanded")).toBe("false");
  });

  it("opens on toggle click and closes on a second click", () => {
    const { toolbar, toggle } = mount();
    toggle.fire("click");
    expect(handle!.isOpen()).toBe(true);
    expect(toolbar.classes.has("toolbar-open")).toBe(true);
    expect(toggle.attrs.get("aria-expanded")).toBe("true");
    toggle.fire("click");
    expect(handle!.isOpen()).toBe(false);
  });

  it("collapses when pointerdown lands outside the toolbar", () => {
    const { toggle, doc } = mount();
    toggle.fire("click");
    expect(handle!.isOpen()).toBe(true);
    doc.fire("pointerdown", { tagName: "CANVAS" });
    expect(handle!.isOpen()).toBe(false);
  });

  it("keeps the menu open when pointerdown lands inside the toolbar", () => {
    const { toolbar, toggle, doc } = mount();
    toggle.fire("click");
    doc.fire("pointerdown", toggle);
    expect(handle!.isOpen()).toBe(true);
    expect(toolbar.classes.has("toolbar-open")).toBe(true);
  });
});
