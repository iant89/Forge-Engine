/**
 * @suite controls:armTouch
 * @group unit
 * @covers examples/src/controls/armTouch.ts
 * @desc Robotic-arm thumbsticks (examples/src/controls/armTouch.ts): shown only while the scene says the
 */

export const suite = {
  name: "controls:armTouch",
  group: "unit",
  covers:   [
    "examples/src/controls/armTouch.ts"
  ],
  desc: "Robotic-arm thumbsticks (examples/src/controls/armTouch.ts): shown only while the scene says the",
};
/**
 * Robotic-arm thumbsticks (examples/src/controls/armTouch.ts): shown only while the scene says the
 * arm is unfolded, two independent sticks mapped to the four jog axes, the drive stick's dead
 * zone / release / iOS-chrome behaviour, and a clean dispose.
 */
import assert from "node:assert/strict";
import { afterEach, assertCloseTo, finish, group, test } from "selrun";
import { attachArmTouch, type ArmTouchHandle } from "../../examples/src/controls/armTouch.js";

type Listener = (event: Event) => void;

/** Just enough DOM for the module: listeners, classes, attributes, a fixed rect, one child knob. */
class StubElement {
  readonly listeners = new Map<string, Array<{ fn: Listener; passive?: boolean }>>();
  readonly classes = new Set<string>();
  readonly attrs = new Map<string, string>();
  style: { transform?: string } = {};
  knob: StubElement | null = null;

  constructor(private readonly rect = { left: 0, top: 0, width: 116, height: 116 }) {}

  readonly classList = {
    add: (name: string): void => void this.classes.add(name),
    remove: (name: string): void => void this.classes.delete(name),
    toggle: (name: string, force?: boolean): boolean => {
      const next = force ?? !this.classes.has(name);
      if (next) this.classes.add(name);
      else this.classes.delete(name);
      return next;
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  querySelector(sel: string): StubElement | null {
    return sel === ".veh-knob" ? this.knob : null;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }

  addEventListener(type: string, fn: Listener, options?: boolean | AddEventListenerOptions): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, passive: typeof options === "object" && options ? options.passive : undefined });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    const at = list?.findIndex((e) => e.fn === fn) ?? -1;
    if (list && at >= 0) list.splice(at, 1);
  }

  setPointerCapture(): void {}

  fire(type: string, event: Record<string, unknown> = {}): { prevented: boolean } {
    let prevented = false;
    const full = {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 0,
      clientY: 0,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
      ...event,
    };
    for (const { fn } of [...(this.listeners.get(type) ?? [])]) fn(full as unknown as Event);
    return { prevented };
  }

  count(): number {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }
}

function stubArmRoot(): { root: HTMLElement; el: StubElement; left: StubElement; right: StubElement; view: StubElement } {
  // Left ring centred at (58, 58), right ring at (358, 58); both 116 px (knob travel 36 px).
  const left = new StubElement({ left: 0, top: 0, width: 116, height: 116 });
  const right = new StubElement({ left: 300, top: 0, width: 116, height: 116 });
  left.knob = new StubElement();
  right.knob = new StubElement();
  const view = new StubElement();
  const el = new StubElement();
  const root = Object.assign(el, {
    querySelector: (sel: string): StubElement | null => (sel === "#arm-stick-left" ? left : sel === "#arm-stick-right" ? right : null),
    ownerDocument: { defaultView: view },
  });
  return { root: root as unknown as HTMLElement, el, left, right, view };
}

group("attachArmTouch", () => {
  let handle: ArmTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  test("shows / hides through the root's `shown` class and aria-hidden", () => {
    const { root, el } = stubArmRoot();
    handle = attachArmTouch(root);
    assert.equal(handle.visible, false);
    handle.setVisible(true);
    assert.equal(handle.visible, true);
    assert.equal(el.classes.has("shown"), true);
    assert.equal(el.attrs.get("aria-hidden"), "false");
    handle.setVisible(false);
    assert.equal(el.classes.has("shown"), false);
    assert.equal(el.attrs.get("aria-hidden"), "true");
  });

  test("ignores touches while hidden", () => {
    const { root, left } = stubArmRoot();
    handle = attachArmTouch(root);
    left.fire("pointerdown", { clientX: 58, clientY: 20 });
    assert.deepEqual(handle.sample(), { swing: 0, shoulder: 0, elbow: 0, turret: 0 });
  });

  test("maps the left stick to swing / shoulder and the right to turret / elbow, up and right positive", () => {
    const { root, left, right } = stubArmRoot();
    handle = attachArmTouch(root);
    handle.setVisible(true);
    // Left: full up-right diagonal beyond the ring (clamped to the 36 px travel).
    left.fire("pointerdown", { pointerId: 1, clientX: 58 + 60, clientY: 58 - 60 });
    // Right: straight down, then dragged to straight left.
    right.fire("pointerdown", { pointerId: 2, clientX: 358, clientY: 58 + 36 });
    let axes = handle.sample();
    assertCloseTo(axes.swing, Math.SQRT1_2, 6);
    assertCloseTo(axes.shoulder, Math.SQRT1_2, 6);
    assertCloseTo(axes.elbow, -1, 6);
    assert.equal(axes.turret, 0);
    right.fire("pointermove", { pointerId: 2, clientX: 358 - 36, clientY: 58 });
    axes = handle.sample();
    assertCloseTo(axes.turret, -1, 6);
    assert.equal(axes.elbow, 0);
    assert.equal(left.classes.has("active"), true);
    assert.equal(left.knob!.classes.has("shown"), true);
  });

  test("applies the drive stick's dead zone", () => {
    const { root, left } = stubArmRoot();
    handle = attachArmTouch(root);
    handle.setVisible(true);
    left.fire("pointerdown", { clientX: 58 + 3, clientY: 58 - 3 });
    assert.equal(handle.sample().swing, 0);
    assert.equal(handle.sample().shoulder, 0);
  });

  test("each stick follows only its own pointer and recentres on release", () => {
    const { root, left, right, view } = stubArmRoot();
    handle = attachArmTouch(root);
    handle.setVisible(true);
    left.fire("pointerdown", { pointerId: 5, clientX: 58 + 36, clientY: 58 });
    left.fire("pointermove", { pointerId: 9, clientX: 58 - 36, clientY: 58 }); // someone else's finger
    assertCloseTo(handle.sample().swing, 1, 6);
    right.fire("pointerdown", { pointerId: 6, clientX: 358, clientY: 58 - 36 });
    left.fire("pointerup", { pointerId: 5 });
    assert.equal(handle.sample().swing, 0);
    assert.equal(left.knob!.classes.has("shown"), false);
    assertCloseTo(handle.sample().elbow, 1, 6);
    // The window-level fallback ends a gesture whose element never saw the terminal event.
    view.fire("pointercancel", { pointerId: 6 });
    assert.equal(handle.sample().elbow, 0);
  });

  test("hiding (the arm starting to stow) releases held sticks", () => {
    const { root, left, right } = stubArmRoot();
    handle = attachArmTouch(root);
    handle.setVisible(true);
    left.fire("pointerdown", { pointerId: 1, clientX: 58, clientY: 58 - 36 });
    right.fire("pointerdown", { pointerId: 2, clientX: 358 + 36, clientY: 58 });
    handle.setVisible(false);
    assert.deepEqual(handle.sample(), { swing: 0, shoulder: 0, elbow: 0, turret: 0 });
    assert.equal(left.classes.has("active"), false);
    assert.equal(right.knob!.classes.has("shown"), false);
  });

  test("blocks the iOS selection / callout gestures on both sticks", () => {
    const { root, left, right } = stubArmRoot();
    handle = attachArmTouch(root);
    for (const el of [left, right]) {
      assert.equal(el.listeners.get("touchstart")?.[0]?.passive, false);
      assert.equal(el.fire("touchstart").prevented, true);
      assert.equal(el.fire("selectstart").prevented, true);
      assert.equal(el.fire("contextmenu").prevented, true);
    }
  });

  test("dispose removes every listener and hides the sticks", () => {
    const { root, el, left, right, view } = stubArmRoot();
    handle = attachArmTouch(root);
    handle.setVisible(true);
    handle.dispose();
    handle = null;
    assert.equal(left.count(), 0);
    assert.equal(right.count(), 0);
    assert.equal(view.count(), 0);
    assert.equal(el.classes.has("shown"), false);
  });

  test("tolerates a page without the arm sticks", () => {
    handle = attachArmTouch(null);
    handle.setVisible(true);
    handle.setVisible(false);
    assert.deepEqual(handle.sample(), { swing: 0, shoulder: 0, elbow: 0, turret: 0 });
  });
});

await finish();
