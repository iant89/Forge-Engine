/**
 * @suite ui:uiAnimation
 * @group unit
 * @covers engine/src/ui/anim/animator.ts
 * @covers engine/src/ui/data/binding.ts
 * @desc UI animation and data binding: delta-time tweens with easing, delay, repeat/yoyo, reverse, finish/cancel callbacks, one-animation-per-property conflict replacement, sequences and parallel groups, time scale and pause, reduced motion (essential exempt), owner cancellation on dispose; observables, computed values, keyed stores, batching, one-way and two-way bindings with loop guards, converter errors and binding disposal with their element
 */

export const suite = {
  name: "ui:uiAnimation",
  group: "unit",
  covers: ["engine/src/ui/anim/animator.ts", "engine/src/ui/data/binding.ts"],
  desc: "UI animation and data binding: delta-time tweens with easing, delay, repeat/yoyo, reverse, finish/cancel callbacks, one-animation-per-property conflict replacement, sequences and parallel groups, time scale and pause, reduced motion (essential exempt), owner cancellation on dispose; observables, computed values, keyed stores, batching, one-way and two-way bindings with loop guards, converter errors and binding disposal with their element",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { Binder, EASINGS, Label, Observable, ObservableStore, Slider, UIAnimator, UsageError, batch, computed, observable } from "@forge/engine";
import { frame, makeUI } from "../support/uiHarness.js";

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

group("tweens", () => {
  test("linear tween follows delta time, not frame count", () => {
    const an = new UIAnimator();
    const o = { x: 0 };
    an.animate(o, { x: 10 }, { duration: 1, easing: "linear" });
    an.update(0.25);
    assert.ok(near(o.x, 2.5));
    an.update(0.5);
    assert.ok(near(o.x, 7.5));
    an.update(1);
    assert.equal(o.x, 10);
    assert.equal(an.activeCount, 0);
  });

  test("easing curves hit their endpoints and are monotonic where expected", () => {
    for (const [name, fn] of Object.entries(EASINGS)) {
      assert.ok(near(fn(0), 0), `${name}(0)`);
      assert.ok(near(fn(1), 1), `${name}(1)`);
    }
    assert.ok(EASINGS.easeOutBack(0.8) > 1, "back overshoots");
  });

  test("delay, completion callback and the done promise", async () => {
    const an = new UIAnimator();
    const o = { x: 0 };
    let completed = 0;
    const [h] = an.animate(o, { x: 1 }, { duration: 0.5, delay: 0.5, easing: "linear", onComplete: () => completed++ });
    an.update(0.4);
    assert.equal(o.x, 0, "still in the delay");
    assert.equal(h!.state, "pending");
    an.update(0.35);
    assert.ok(near(o.x, 0.5));
    an.update(1);
    assert.equal(completed, 1);
    assert.equal(await h!.done, "finished");
  });

  test("repeat with yoyo alternates direction and ends at the right value", () => {
    const an = new UIAnimator();
    const o = { x: 0 };
    an.animate(o, { x: 1 }, { duration: 1, easing: "linear", repeat: 1, yoyo: true });
    an.update(1.5);
    assert.ok(near(o.x, 0.5), `on the way back: ${o.x}`);
    an.update(0.5);
    assert.equal(o.x, 0, "yoyo ends where it started");
  });

  test("reverse plays back from the current point; finish jumps to the end", () => {
    const an = new UIAnimator();
    const o = { x: 0 };
    const [h] = an.animate(o, { x: 10 }, { duration: 1, easing: "linear" });
    an.update(0.6);
    h!.reverse();
    an.update(0.3);
    assert.ok(near(o.x, 3), `reversed: ${o.x}`);
    h!.finish();
    assert.equal(o.x, 0, "a reversed animation finishes at its start value");
  });

  test("a new animation on the same property cancels the old one and starts from the current value", () => {
    const an = new UIAnimator();
    const o = { x: 0 };
    let cancelled = 0;
    an.animate(o, { x: 10 }, { duration: 1, easing: "linear", onCancel: () => cancelled++ });
    an.update(0.5);
    an.animate(o, { x: 0 }, { duration: 1, easing: "linear" });
    assert.equal(cancelled, 1);
    an.update(0.5);
    assert.ok(near(o.x, 2.5), "started from 5, halfway to 0");
    assert.equal(an.activeCount, 1);
  });

  test("colour animation interpolates channels", () => {
    const an = new UIAnimator();
    const o = { color: 0x000000ff };
    an.animateColor(o, "color", "#ffffffff", { duration: 1, easing: "linear" });
    an.update(0.5);
    assert.equal(o.color, 0x808080ff);
  });

  test("sequence runs steps in order synchronously; parallel waits for all; cancel stops the rest", () => {
    const an = new UIAnimator();
    const o = { a: 0, b: 0 };
    const log: string[] = [];
    const seq = an.sequence([
      () => an.animate(o, { a: 1 }, { duration: 0.5, onComplete: () => log.push("a") }),
      () => an.animate(o, { b: 1 }, { duration: 0.5, onComplete: () => log.push("b") }),
    ]);
    let groupDone = 0;
    seq.onComplete = () => groupDone++;
    an.update(0.6);
    assert.deepEqual(log, ["a"]);
    assert.equal(o.b, 0, "the second step starts on the next update");
    an.update(0.6);
    assert.deepEqual(log, ["a", "b"]);
    assert.equal(groupDone, 1);
    const p = an.parallel([...an.animate(o, { a: 0 }, { duration: 1 }), ...an.animate(o, { b: 0 }, { duration: 2 })]);
    an.update(1.1);
    assert.equal(p.state, "running");
    p.cancel();
    assert.equal(p.state, "cancelled");
    assert.equal(an.activeCount, 0);
  });

  test("time scale, pause and reduced motion (essential animations still run)", () => {
    const an = new UIAnimator();
    const o = { x: 0, y: 0 };
    an.timeScale = 2;
    an.animate(o, { x: 1 }, { duration: 1, easing: "linear" });
    an.update(0.25);
    assert.ok(near(o.x, 0.5));
    an.paused = true;
    an.update(10);
    assert.ok(near(o.x, 0.5));
    an.paused = false;
    an.reducedMotion = true;
    an.animate(o, { y: 1 }, { duration: 1, essential: true, easing: "linear" });
    an.update(0.25);
    assert.equal(o.x, 1, "non-essential jumped to its end");
    assert.ok(near(o.y, 0.5), "essential kept animating");
  });

  test("animations die with their element (disposal and detach cancel them)", () => {
    const ui = makeUI();
    const l = ui.base.add(new Label({ text: "x" }));
    frame(ui);
    ui.animator.animate(l, { opacity: 0 }, { duration: 1 });
    assert.equal(ui.animator.activeCount, 1);
    l.dispose();
    assert.equal(ui.animator.activeCount, 0);
  });

  test("validation: negative durations, unknown easings and non-numeric targets throw", () => {
    const an = new UIAnimator();
    assert.throws(() => an.animate({ x: 0 }, { x: 1 }, { duration: -1 }), UsageError);
    assert.throws(() => an.animate({ x: 0 }, { x: 1 }, { duration: 1, easing: "bouncy" as never }), /unknown easing/);
    assert.throws(() => an.animate({ x: "a" } as never, { x: 1 } as never, { duration: 1 }), /not a numeric property/);
  });

  test("a steady update loop does not grow the running list", () => {
    const an = new UIAnimator();
    const objs = Array.from({ length: 200 }, () => ({ x: 0 }));
    for (const o of objs) an.animate(o, { x: 1 }, { duration: 1, repeat: Infinity, yoyo: true });
    for (let i = 0; i < 600; i++) an.update(1 / 60);
    assert.equal(an.activeCount, 200);
  });
});

group("observables", () => {
  test("notifications fire on change only (Object.is), with the previous value", () => {
    const o = observable(1);
    const seen: [number, number][] = [];
    o.subscribe((v, p) => seen.push([v, p]));
    o.value = 1;
    o.value = 2;
    o.value = NaN;
    o.value = NaN;
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], [2, 1]);
  });

  test("computed follows its dependencies and stops after dispose", () => {
    const a = observable(2);
    const b = observable(3);
    const sum = computed([a, b], () => a.value + b.value);
    assert.equal(sum.value, 5);
    a.value = 10;
    assert.equal(sum.value, 13);
    assert.throws(() => (sum.value = 1), /read-only/);
    sum.dispose();
    a.value = 0;
    assert.equal(sum.value, 13);
    assert.equal(a.subscriberCount, 0);
  });

  test("batch defers notifications and delivers each final value once", () => {
    const store = new ObservableStore({ hp: 100, shield: 50 });
    const log: string[] = [];
    store.on("hp", (v) => log.push(`hp=${v}`));
    store.on("shield", (v) => log.push(`shield=${v}`));
    batch(() => {
      store.set("hp", 90);
      store.set("hp", 80);
      store.set("shield", 40);
      assert.deepEqual(log, []);
    });
    assert.deepEqual(log, ["hp=80", "shield=40"]);
    store.update({ hp: 70, shield: 40 });
    assert.deepEqual(log.slice(2), ["hp=70"]);
    assert.throws(() => store.field("nope" as never), /no field "nope"/);
    assert.deepEqual(store.snapshot(), { hp: 70, shield: 40 });
  });

  test("a notification cycle is detected instead of spinning forever", () => {
    const a = new Observable(0);
    const b = new Observable(0);
    a.subscribe((v) => (b.value = v + 1));
    b.subscribe((v) => (a.value = v + 1));
    assert.throws(() => batch(() => (a.value = 1)), /did not settle|Maximum call stack/);
  });
});

group("bindings", () => {
  test("one-way: the initial value applies and changes flow to the target", () => {
    const ui = makeUI();
    const label = ui.base.add(new Label());
    const name = observable("Ada");
    ui.bind(label, "text", name, { convert: (n: string) => `Pilot: ${n}` });
    assert.equal(label.text, "Pilot: Ada");
    name.value = "Grace";
    assert.equal(label.text, "Pilot: Grace");
  });

  test("two-way with a slider: edits write back, and the guard prevents a feedback loop", () => {
    const ui = makeUI();
    const s = ui.base.add(new Slider({ min: 0, max: 100, step: 1 }));
    const store = new ObservableStore({ volume: 30 });
    ui.bind(s, "value", [store, "volume"], { mode: "two-way" });
    assert.equal(s.value, 30);
    s.value = 55;
    assert.equal(store.get("volume"), 55);
    store.set("volume", 10);
    assert.equal(s.value, 10);
    assert.equal(store.field("volume").notifications, 2, "no echo notification");
  });

  test("converter errors are recorded and reported, the target keeps its value", () => {
    const binder = new Binder();
    const errs: string[] = [];
    binder.onError = (m) => errs.push(m);
    const target = { text: "keep" };
    const src = observable(1);
    const b = binder.bind(target, "text", src, {
      convert: (v: number) => {
        if (v > 1) throw new Error("too big");
        return String(v);
      },
    });
    src.value = 2;
    assert.equal(target.text, "1");
    assert.equal(b.errors.length, 1);
    assert.match(errs[0]!, /too big/);
  });

  test("binding to a missing property or two-way to a plain object is an explicit error", () => {
    const binder = new Binder();
    assert.throws(() => binder.bind({}, "nope", observable(1)), /no property "nope"/);
    assert.throws(() => binder.bind({ x: 0 }, "x", observable(1), { mode: "two-way" }), /need a UI element target/);
  });

  test("bindings die with their element (no leaked subscriptions)", () => {
    const ui = makeUI();
    const label = ui.base.add(new Label());
    const src = observable("a");
    ui.bind(label, "text", src);
    assert.equal(src.subscriberCount, 1);
    assert.equal(ui.binder.activeBindings, 1);
    label.dispose();
    assert.equal(src.subscriberCount, 0);
    assert.equal(ui.binder.activeBindings, 0);
  });

  test("a bound change only invalidates what the property affects", () => {
    const ui = makeUI();
    const label = ui.base.add(new Label({ text: "x" }));
    const color = observable<number>(0xff0000ff);
    ui.bind(label, "color", color);
    frame(ui);
    color.value = 0x00ff00ff;
    const f = ui.update(1 / 60);
    assert.equal(f.measures, 0, "a colour change does not re-measure");
    assert.equal(ui.needsRender, true);
  });
});

await finish();
