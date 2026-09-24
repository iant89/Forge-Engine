/**
 * Vehicle touch pad — A/B gas/brake must survive an iOS long-press.
 *
 * The bug: Safari's text-selection / callout gesture cancels pointer capture on the labelled
 * buttons, so a held A or B drops mid-drive. The pad module must preventDefault on selectstart,
 * contextmenu and touchstart (non-passive) in addition to the CSS user-select rules.
 */
import { afterEach, describe, expect, it } from "vitest";
import { attachVehicleTouch, stickDeflection, type VehicleTouchHandle } from "../examples/src/controls/vehicleTouch.js";

type Listener = (event: Event) => void;

class StubElement {
  readonly listeners = new Map<string, Array<{ fn: Listener; passive?: boolean }>>();
  readonly classes = new Set<string>();
  readonly attrs = new Map<string, string>();
  style: { transform?: string } = {};

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

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

  addEventListener(type: string, fn: Listener, options?: boolean | AddEventListenerOptions): void {
    const list = this.listeners.get(type) ?? [];
    const passive = typeof options === "object" && options ? options.passive : undefined;
    list.push({ fn, passive });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const at = list.findIndex((e) => e.fn === fn);
    if (at >= 0) list.splice(at, 1);
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  fire(type: string, event: Record<string, unknown> = {}): { prevented: boolean } {
    let prevented = false;
    const full = {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
      ...event,
    };
    for (const { fn } of [...(this.listeners.get(type) ?? [])]) fn(full as unknown as Event);
    return { prevented };
  }

  has(type: string): boolean {
    return (this.listeners.get(type)?.length ?? 0) > 0;
  }

  passiveFlag(type: string): boolean | undefined {
    return this.listeners.get(type)?.[0]?.passive;
  }
}

function stubRoot(): {
  root: HTMLElement;
  gas: StubElement;
  brake: StubElement;
  stick: StubElement;
  mast: StubElement;
  view: StubElement;
} {
  const gas = new StubElement();
  const brake = new StubElement();
  const stick = new StubElement();
  const knob = new StubElement();
  const mast = new StubElement();
  const view = new StubElement();
  const root = {
    querySelector: (sel: string): StubElement | null => {
      if (sel === "#veh-gas") return gas;
      if (sel === "#veh-brake") return brake;
      if (sel === "#veh-stick") return stick;
      if (sel === "#veh-stick-knob") return knob;
      if (sel === "#veh-mast") return mast;
      return null;
    },
    ownerDocument: { defaultView: view },
  };
  return { root: root as unknown as HTMLElement, gas, brake, stick, mast, view };
}

describe("stickDeflection", () => {
  it("clamps to the circle and applies the deadzone", () => {
    const inside = stickDeflection(10, 0, 50);
    expect(inside.x).toBeGreaterThan(0);
    expect(inside.px).toBe(10);
    const dead = stickDeflection(2, 0, 50);
    expect(dead.x).toBe(0);
  });
});

describe("attachVehicleTouch — iOS selection / hold", () => {
  let handle: VehicleTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it("registers non-passive touchstart/selectstart/contextmenu blockers on gas, brake and stick", () => {
    const { root, gas, brake, stick } = stubRoot();
    handle = attachVehicleTouch(root);
    for (const el of [gas, brake, stick]) {
      expect(el.has("selectstart")).toBe(true);
      expect(el.has("contextmenu")).toBe(true);
      expect(el.has("touchstart")).toBe(true);
      expect(el.passiveFlag("touchstart")).toBe(false);
    }
  });

  it("preventDefault on the selection gestures so a long-press cannot cancel the hold", () => {
    const { root, gas } = stubRoot();
    handle = attachVehicleTouch(root);
    expect(gas.fire("selectstart").prevented).toBe(true);
    expect(gas.fire("contextmenu").prevented).toBe(true);
    expect(gas.fire("touchstart").prevented).toBe(true);
  });

  it("holds gas continuously across pointerdown until pointerup", () => {
    const { root, gas } = stubRoot();
    handle = attachVehicleTouch(root);
    gas.fire("pointerdown", { pointerType: "touch" });
    expect(handle!.sample().throttle).toBe(1);
    expect(gas.classes.has("pressed")).toBe(true);
    gas.fire("pointerup", { pointerType: "touch" });
    expect(handle!.sample().throttle).toBe(0);
  });

  it("ends gas and brake holds on window termination or lost pointer capture", () => {
    const { root, gas, brake, view } = stubRoot();
    handle = attachVehicleTouch(root);

    gas.fire("pointerdown", { pointerId: 7, pointerType: "touch" });
    expect(handle!.sample().throttle).toBe(1);
    view.fire("pointerup", { pointerId: 7, pointerType: "touch" });
    expect(handle!.sample().throttle).toBe(0);
    expect(gas.classes.has("pressed")).toBe(false);

    brake.fire("pointerdown", { pointerId: 8, pointerType: "touch" });
    expect(handle!.sample().brake).toBe(1);
    view.fire("pointercancel", { pointerId: 8, pointerType: "touch" });
    expect(handle!.sample().brake).toBe(0);

    gas.fire("pointerdown", { pointerId: 9, pointerType: "touch" });
    gas.fire("lostpointercapture", { pointerId: 9, pointerType: "touch" });
    expect(handle!.sample().throttle).toBe(0);
  });
});

describe("attachVehicleTouch — MAST toggle (Mars showcase)", () => {
  let handle: VehicleTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it("fires onMastToggle once per tap, ignoring non-left mouse buttons", () => {
    const { root, mast } = stubRoot();
    let toggles = 0;
    handle = attachVehicleTouch(root, { onMastToggle: () => toggles++ });
    mast.fire("pointerdown", { pointerId: 3, pointerType: "touch" });
    mast.fire("pointerdown", { pointerId: 4, pointerType: "touch" });
    expect(toggles).toBe(2);
    mast.fire("pointerdown", { pointerId: 5, pointerType: "mouse", button: 2 });
    expect(toggles).toBe(2);
  });

  it("binds nothing when the scene passes no toggle (vehicle playground)", () => {
    const { root, mast } = stubRoot();
    handle = attachVehicleTouch(root);
    expect(mast.has("pointerdown")).toBe(false);
  });

  it("setMast lights the button from the commanded state and dispose clears it", () => {
    const { root, mast } = stubRoot();
    handle = attachVehicleTouch(root, { onMastToggle: () => {} });
    handle!.setMast(true);
    expect(mast.classes.has("active")).toBe(true);
    expect(mast.attrs.get("aria-pressed")).toBe("true");
    handle!.setMast(false);
    expect(mast.classes.has("active")).toBe(false);
    expect(mast.attrs.get("aria-pressed")).toBe("false");
    handle!.setMast(true);
    handle!.dispose();
    expect(mast.classes.has("active")).toBe(false);
    handle = null;
  });
});
