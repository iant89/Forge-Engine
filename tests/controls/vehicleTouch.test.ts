/**
 * @suite controls:vehicleTouch
 * @group unit
 * @covers examples/index.html
 * @covers examples/src/controls/vehicleTouch.ts
 * @covers examples/src/scenes/vehiclePlaygroundScene.ts
 * @desc Vehicle touch pad — A/B gas/brake must survive an iOS long-press
 */

export const suite = {
  name: "controls:vehicleTouch",
  group: "unit",
  covers:   [
    "examples/index.html",
    "examples/src/controls/vehicleTouch.ts",
    "examples/src/scenes/vehiclePlaygroundScene.ts"
  ],
  desc: "Vehicle touch pad — A/B gas/brake must survive an iOS long-press",
};
/**
 * Vehicle touch pad — A/B gas/brake must survive an iOS long-press.
 *
 * The bug: Safari's text-selection / callout gesture cancels pointer capture on the labelled
 * buttons, so a held A or B drops mid-drive. The pad module must preventDefault on selectstart,
 * contextmenu and touchstart (non-passive) in addition to the CSS user-select rules.
 */
import assert from "node:assert/strict";
import { afterEach, finish, group, test } from "selrun";
import { attachVehicleTouch, stickDeflection, type VehicleTouchHandle } from "../../examples/src/controls/vehicleTouch.js";

type Listener = (event: Event) => void;

class StubElement {
  readonly listeners = new Map<string, Array<{ fn: Listener; passive?: boolean }>>();
  readonly classes = new Set<string>();
  readonly attrs = new Map<string, string>();
  style: { transform?: string } = {};
  disabled = false;

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
  arm: StubElement;
  park: StubElement;
  gearF: StubElement;
  gearN: StubElement;
  gearR: StubElement;
  view: StubElement;
} {
  const gas = new StubElement();
  const brake = new StubElement();
  const stick = new StubElement();
  const knob = new StubElement();
  const mast = new StubElement();
  const arm = new StubElement();
  const park = new StubElement();
  const gearF = new StubElement();
  const gearN = new StubElement();
  const gearR = new StubElement();
  const view = new StubElement();
  const root = {
    querySelector: (sel: string): StubElement | null => {
      if (sel === "#veh-gas") return gas;
      if (sel === "#veh-brake") return brake;
      if (sel === "#veh-stick") return stick;
      if (sel === "#veh-stick-knob") return knob;
      if (sel === "#veh-mast") return mast;
      if (sel === "#veh-arm") return arm;
      if (sel === "#veh-park") return park;
      if (sel === "#veh-gear-f") return gearF;
      if (sel === "#veh-gear-n") return gearN;
      if (sel === "#veh-gear-r") return gearR;
      return null;
    },
    ownerDocument: { defaultView: view },
  };
  return { root: root as unknown as HTMLElement, gas, brake, stick, mast, arm, park, gearF, gearN, gearR, view };
}

group("stickDeflection", () => {
  test("clamps to the circle and applies the deadzone", () => {
    const inside = stickDeflection(10, 0, 50);
    assert.ok(inside.x > 0);
    assert.equal(inside.px, 10);
    const dead = stickDeflection(2, 0, 50);
    assert.equal(dead.x, 0);
  });
});

group("attachVehicleTouch — iOS selection / hold", () => {
  let handle: VehicleTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  test("registers non-passive touchstart/selectstart/contextmenu blockers on gas, brake and stick", () => {
    const { root, gas, brake, stick } = stubRoot();
    handle = attachVehicleTouch(root);
    for (const el of [gas, brake, stick]) {
      assert.equal(el.has("selectstart"), true);
      assert.equal(el.has("contextmenu"), true);
      assert.equal(el.has("touchstart"), true);
      assert.equal(el.passiveFlag("touchstart"), false);
    }
  });

  test("preventDefault on the selection gestures so a long-press cannot cancel the hold", () => {
    const { root, gas } = stubRoot();
    handle = attachVehicleTouch(root);
    assert.equal(gas.fire("selectstart").prevented, true);
    assert.equal(gas.fire("contextmenu").prevented, true);
    assert.equal(gas.fire("touchstart").prevented, true);
  });

  test("holds gas continuously across pointerdown until pointerup", () => {
    const { root, gas } = stubRoot();
    handle = attachVehicleTouch(root);
    gas.fire("pointerdown", { pointerType: "touch" });
    assert.equal(handle!.sample().throttle, 1);
    assert.equal(gas.classes.has("pressed"), true);
    gas.fire("pointerup", { pointerType: "touch" });
    assert.equal(handle!.sample().throttle, 0);
  });

  test("ends gas and brake holds on window termination or lost pointer capture", () => {
    const { root, gas, brake, view } = stubRoot();
    handle = attachVehicleTouch(root);

    gas.fire("pointerdown", { pointerId: 7, pointerType: "touch" });
    assert.equal(handle!.sample().throttle, 1);
    view.fire("pointerup", { pointerId: 7, pointerType: "touch" });
    assert.equal(handle!.sample().throttle, 0);
    assert.equal(gas.classes.has("pressed"), false);

    brake.fire("pointerdown", { pointerId: 8, pointerType: "touch" });
    assert.equal(handle!.sample().brake, 1);
    view.fire("pointercancel", { pointerId: 8, pointerType: "touch" });
    assert.equal(handle!.sample().brake, 0);

    gas.fire("pointerdown", { pointerId: 9, pointerType: "touch" });
    gas.fire("lostpointercapture", { pointerId: 9, pointerType: "touch" });
    assert.equal(handle!.sample().throttle, 0);
  });
});

group("attachVehicleTouch — MAST toggle (Mars showcase)", () => {
  let handle: VehicleTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  test("fires onMastToggle once per tap, ignoring non-left mouse buttons", () => {
    const { root, mast } = stubRoot();
    let toggles = 0;
    handle = attachVehicleTouch(root, { onMastToggle: () => toggles++ });
    mast.fire("pointerdown", { pointerId: 3, pointerType: "touch" });
    mast.fire("pointerdown", { pointerId: 4, pointerType: "touch" });
    assert.equal(toggles, 2);
    mast.fire("pointerdown", { pointerId: 5, pointerType: "mouse", button: 2 });
    assert.equal(toggles, 2);
  });

  test("binds nothing when the scene passes no toggle (vehicle playground)", () => {
    const { root, mast } = stubRoot();
    handle = attachVehicleTouch(root);
    assert.equal(mast.has("pointerdown"), false);
  });

  test("setMast lights the button from the commanded state and dispose clears it", () => {
    const { root, mast } = stubRoot();
    handle = attachVehicleTouch(root, { onMastToggle: () => {} });
    handle!.setMast(true);
    assert.equal(mast.classes.has("active"), true);
    assert.equal(mast.attrs.get("aria-pressed"), "true");
    handle!.setMast(false);
    assert.equal(mast.classes.has("active"), false);
    assert.equal(mast.attrs.get("aria-pressed"), "false");
    handle!.setMast(true);
    handle!.dispose();
    assert.equal(mast.classes.has("active"), false);
    handle = null;
  });
});

group("attachVehicleTouch — ARM toggle (Mars showcase)", () => {
  let handle: VehicleTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  test("fires onArmToggle once per tap, independently of MAST", () => {
    const { root, arm, mast } = stubRoot();
    let arms = 0;
    let masts = 0;
    handle = attachVehicleTouch(root, { onMastToggle: () => masts++, onArmToggle: () => arms++ });
    arm.fire("pointerdown", { pointerId: 3, pointerType: "touch" });
    assert.equal(arms, 1);
    assert.equal(masts, 0);
    mast.fire("pointerdown", { pointerId: 4, pointerType: "touch" });
    assert.equal(arms, 1);
    assert.equal(masts, 1);
    arm.fire("pointerdown", { pointerId: 5, pointerType: "mouse", button: 2 });
    assert.equal(arms, 1);
  });

  test("guards the ARM button against the iOS selection gestures and binds no toggle without a handler", () => {
    const { root, arm } = stubRoot();
    handle = attachVehicleTouch(root);
    assert.equal(arm.passiveFlag("touchstart"), false);
    assert.equal(arm.fire("selectstart").prevented, true);
    assert.equal(arm.has("pointerdown"), false);
  });

  test("setArm lights the button from the commanded state and dispose clears it", () => {
    const { root, arm, mast } = stubRoot();
    handle = attachVehicleTouch(root, { onArmToggle: () => {} });
    handle!.setArm(true);
    assert.equal(arm.classes.has("active"), true);
    assert.equal(arm.attrs.get("aria-pressed"), "true");
    assert.equal(mast.classes.has("active"), false);
    handle!.setArm(false);
    assert.equal(arm.classes.has("active"), false);
    assert.equal(arm.attrs.get("aria-pressed"), "false");
    handle!.setArm(true);
    handle!.dispose();
    assert.equal(arm.classes.has("active"), false);
    handle = null;
  });
});

group("attachVehicleTouch — PARK toggle (vehicle playground)", () => {
  let handle: VehicleTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  test("fires onParkToggle once per tap, ignoring non-left mouse buttons", () => {
    const { root, park } = stubRoot();
    let toggles = 0;
    handle = attachVehicleTouch(root, { onParkToggle: () => toggles++ });
    park.fire("pointerdown", { pointerId: 3, pointerType: "touch" });
    park.fire("pointerdown", { pointerId: 4, pointerType: "touch" });
    assert.equal(toggles, 2);
    park.fire("pointerdown", { pointerId: 5, pointerType: "mouse", button: 2 });
    assert.equal(toggles, 2);
  });

  test("guards the PARK button against the iOS selection gestures and binds no toggle without a handler", () => {
    const { root, park } = stubRoot();
    handle = attachVehicleTouch(root);
    assert.equal(park.passiveFlag("touchstart"), false);
    assert.equal(park.fire("selectstart").prevented, true);
    assert.equal(park.fire("contextmenu").prevented, true);
    assert.equal(park.has("pointerdown"), false);
  });

  test("setPark lights the latched button from the commanded state and dispose clears it", () => {
    const { root, park, gas } = stubRoot();
    handle = attachVehicleTouch(root, { onParkToggle: () => {} });
    handle!.setPark(true);
    assert.equal(park.classes.has("active"), true);
    assert.equal(park.attrs.get("aria-pressed"), "true");
    assert.equal(gas.classes.has("active"), false);
    handle!.setPark(false);
    assert.equal(park.classes.has("active"), false);
    assert.equal(park.attrs.get("aria-pressed"), "false");
    handle!.setPark(true);
    handle!.dispose();
    assert.equal(park.classes.has("active"), false);
    handle = null;
  });
});

group("attachVehicleTouch — F/N/R switch", () => {
  let handle: VehicleTouchHandle | null = null;
  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  test("requests all three positions and lights accepted selection", () => {
    const { root, gearF, gearN, gearR } = stubRoot();
    const requested: string[] = [];
    handle = attachVehicleTouch(root, { onGearSelect: (position) => { requested.push(position); return true; } });
    handle.setGear("F");
    assert.equal(gearF.classes.has("active"), true);
    gearN.fire("pointerdown");
    gearR.fire("pointerdown");
    assert.deepEqual(requested, ["N", "R"]);
    assert.equal(gearF.classes.has("active"), false);
    assert.equal(gearN.classes.has("active"), false);
    assert.equal(gearR.classes.has("active"), true);
    assert.equal(gearR.attrs.get("aria-pressed"), "true");
  });

  test("disables and marks a rejected position without moving the switch", () => {
    const { root, gearF, gearR } = stubRoot();
    handle = attachVehicleTouch(root, { onGearSelect: position => position !== "R", gearRejectMs: 250 });
    handle.setGear("F");
    gearR.fire("pointerdown");
    assert.equal(gearF.classes.has("active"), true);
    assert.equal(gearR.classes.has("active"), false);
    assert.equal(gearR.classes.has("rejected"), true);
    assert.equal(gearR.disabled, true);
    handle.dispose();
    assert.equal(gearR.classes.has("rejected"), false);
    assert.equal(gearR.disabled, false);
    handle = null;
  });
});

await finish();
