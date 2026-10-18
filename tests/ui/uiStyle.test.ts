/**
 * @suite ui:uiStyle
 * @group unit
 * @covers engine/src/ui/style/resolver.ts
 * @covers engine/src/ui/style/types.ts
 * @covers engine/src/ui/style/builtins.ts
 * @covers engine/src/ui/manager.ts
 * @desc Skins and themes: registration validation, inheritance with unknown-parent and cycle detection, deterministic precedence (defaults → chain → variant → states in order → overrides), composable states, token resolution and diagnostics, cache reuse and invalidation, runtime theme/skin switching restyling the tree, state transitions, and every built-in component resolving in every theme × skin
 */

export const suite = {
  name: "ui:uiStyle",
  group: "unit",
  covers: ["engine/src/ui/style/resolver.ts", "engine/src/ui/style/types.ts", "engine/src/ui/style/builtins.ts", "engine/src/ui/manager.ts"],
  desc: "Skins and themes: registration validation, inheritance with unknown-parent and cycle detection, deterministic precedence (defaults → chain → variant → states in order → overrides), composable states, token resolution and diagnostics, cache reuse and invalidation, runtime theme/skin switching restyling the tree, state transitions, and every built-in component resolving in every theme × skin",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import {
  Button,
  Label,
  DEFAULT_STYLE,
  StyleResolver,
  UIElement,
  UIState,
  UsageError,
  contrastRatio,
  validateSkin,
  StateRegistry,
} from "@forge/engine";
import { advance, frame, makeUI } from "../support/uiHarness.js";

class Thing extends UIElement {
  static override styleName = "Thing";
}
class SpecialThing extends Thing {
  static override styleName = "SpecialThing";
}

function resolver(): { r: StyleResolver; diags: string[] } {
  const diags: string[] = [];
  const r = new StyleResolver((_l, m) => diags.push(m));
  r.registerTheme({ name: "base", tokens: { color: { fg: "#111111", accent: "#0000ff" }, space: { md: 12 } } });
  r.registerSkin({
    name: "s",
    version: 1,
    components: {
      Element: { foreground: "$color.fg", padding: "$space.md" },
      Thing: {
        background: "#100000",
        borderWidth: 1,
        states: { hovered: { background: "#200000" }, selected: { borderColor: "#00ff00" }, pressed: { background: "#300000" }, disabled: { opacity: 0.5 } },
        variants: { primary: { background: "$color.accent", states: { hovered: { background: "#4444ff" } } } },
      },
      SpecialThing: { borderWidth: 3 },
    },
  });
  r.setTheme("base");
  r.setSkin("s");
  return { r, diags };
}

group("registration and inheritance", () => {
  test("themes and skins inherit from their parents (child wins)", () => {
    const r = new StyleResolver();
    r.registerTheme({ name: "a", tokens: { color: { x: "#000000", y: "#111111" } } });
    r.registerTheme({ name: "b", extends: "a", tokens: { color: { y: "#222222" } } });
    r.setTheme("b");
    assert.equal(r.token("color.x"), 0x000000ff);
    assert.equal(r.token("color.y"), 0x222222ff);
    r.registerSkin({ name: "p", version: 1, components: { Thing: { borderWidth: 2, background: "#000000", states: { hovered: { background: "#010101" } } } } });
    r.registerSkin({ name: "c", version: 1, extends: "p", components: { Thing: { borderWidth: 5, states: { pressed: { background: "#020202" } } } } });
    r.setSkin("c");
    const merged = r.componentSkin("Thing")!;
    assert.equal(merged.borderWidth, 5);
    assert.equal(merged.background, "#000000");
    assert.deepEqual(Object.keys(merged.states!).sort(), ["hovered", "pressed"], "state blocks merge across the chain");
  });

  test("unknown parents and inheritance cycles are rejected and leave the registry unchanged", () => {
    const r = new StyleResolver();
    assert.throws(() => r.registerSkin({ name: "x", version: 1, extends: "missing" }), /"missing" is not registered/);
    assert.deepEqual(r.skinNames, []);
    r.registerSkin({ name: "a", version: 1 });
    r.registerSkin({ name: "b", version: 1, extends: "a" });
    assert.throws(() => r.registerSkin({ name: "a", version: 1, extends: "b" }, { replace: true }), /inheritance cycle/);
    assert.equal(r.skinChain("b").join(","), "a,b", "the original 'a' is restored after the failed replace");
    r.registerTheme({ name: "t", tokens: {} });
    assert.throws(() => r.registerTheme({ name: "t", extends: "t", tokens: {} }, { replace: true }), /cycle/);
  });

  test("structural validation: unknown properties/states/groups, bad colours, bad versions", () => {
    const r = new StyleResolver();
    assert.throws(() => r.registerSkin({ name: "v", version: 0 }), /version must be an integer >= 1/);
    assert.throws(() => r.registerSkin({ name: "u", version: 1, components: { Thing: { bckground: "#fff" } as never } }), /unknown style property "bckground"/);
    assert.throws(() => r.registerSkin({ name: "w", version: 1, components: { Thing: { states: { wobbly: {} } } } }), /unknown state "wobbly"/);
    assert.throws(() => r.registerTheme({ name: "t", tokens: { color: { a: "notacolour" } } }), /is not a colour/);
    assert.throws(() => r.registerTheme({ name: "t2", tokens: { sizes: {} } as never }), /unknown token group "sizes"/);
    r.registerSkin({ name: "x", version: 1 });
    assert.throws(() => r.registerSkin({ name: "x", version: 1 }), /already registered/);
  });

  test("custom states must be defined before a skin uses them, and then resolve in definition order", () => {
    const states = new StateRegistry();
    assert.equal(validateSkin({ name: "s", version: 1, components: { Thing: { states: { burning: {} } } } }, states).length, 1);
    const bit = states.define("burning");
    assert.equal(states.define("burning"), bit, "defining twice returns the same bit");
    assert.equal(validateSkin({ name: "s", version: 1, components: { Thing: { states: { burning: {} } } } }, states).length, 0);
    assert.deepEqual(states.names(bit | UIState.Hovered), ["hovered", "burning"]);
  });

  test("an active theme or skin cannot be unloaded; a parent cannot be removed before its child", () => {
    const { r } = resolver();
    assert.throws(() => r.unregisterSkin("s"), /is active/);
    r.registerSkin({ name: "child", version: 1, extends: "s" });
    r.registerSkin({ name: "other", version: 1 });
    r.setSkin("other");
    assert.throws(() => r.unregisterSkin("s"), /"child" extends "s"/);
    assert.equal(r.unregisterSkin("child"), true);
    assert.equal(r.unregisterSkin("s"), true);
  });
});

group("precedence", () => {
  test("defaults → style chain (generic first) → variant → states → instance overrides", () => {
    const { r } = resolver();
    const plain = new Thing();
    const special = new SpecialThing();
    assert.equal(r.resolve(plain).background, 0x100000ff, "component block over defaults");
    assert.equal(r.resolve(plain).foreground, 0x111111ff, "Element block reaches every component");
    assert.equal(r.resolve(plain).fontSize, DEFAULT_STYLE.fontSize, "untouched properties keep the framework defaults");
    assert.equal(r.resolve(special).borderWidth, 3, "the more specific class wins");
    assert.equal(r.resolve(special).background, 0x100000ff, "and inherits the rest of its chain");
    special.variant = "primary";
    assert.equal(r.resolve(special).background, 0x0000ffff, "variant over base");
    special.setStateBit(UIState.Hovered, true);
    assert.equal(r.resolve(special).background, 0x4444ffff, "variant state over base state");
    special.style = { background: "#abcdef" };
    assert.equal(r.resolve(special).background, 0xabcdefff, "instance override wins");
  });

  test("states compose: hovered+selected keeps selection styling, later states win conflicts", () => {
    const { r } = resolver();
    const t = new Thing();
    t.setStateBit(UIState.Selected, true);
    t.setStateBit(UIState.Hovered, true);
    const s = r.resolve(t);
    assert.equal(s.background, 0x200000ff, "hovered background");
    assert.equal(s.borderColor, 0x00ff00ff, "selected border survives");
    t.setStateBit(UIState.Pressed, true);
    assert.equal(r.resolve(t).background, 0x300000ff, "pressed (later) beats hovered");
    t.setStateBit(UIState.Disabled, true);
    assert.equal(r.resolve(t).opacity, 0.5);
  });

  test("styleClass adds a skin name at the end of the chain", () => {
    const r = new StyleResolver();
    r.registerSkin({ name: "s", version: 1, components: { Button: { borderWidth: 1 }, TabButton: { borderWidth: 7 } } });
    r.setSkin("s");
    const b = new Button();
    assert.equal(r.resolve(b).borderWidth, 1);
    b.styleClass = "TabButton";
    assert.deepEqual(b.styleChain.slice(-2), ["Button", "TabButton"]);
    assert.equal(r.resolve(b).borderWidth, 7);
  });
});

group("tokens and diagnostics", () => {
  test("token references resolve against the active theme; insets accept tokens", () => {
    const { r } = resolver();
    const s = r.resolve(new Thing());
    assert.deepEqual({ ...s.padding }, { top: 12, right: 12, bottom: 12, left: 12 });
  });

  test("a missing token is reported once and the property keeps the previous layer's value", () => {
    const { r, diags } = resolver();
    r.registerSkin({ name: "broken", version: 1, extends: "s", components: { Thing: { background: "$color.nope" } } });
    r.setSkin("broken");
    const a = r.resolve(new Thing());
    r.resolve(new SpecialThing());
    assert.equal(a.background, 0x100000ff, "fell back to the inherited value, not an unrelated colour");
    assert.equal(diags.filter((d) => d.includes("$color.nope")).length, 1);
  });

  test("an unknown variant is diagnosed (once per chain and variant)", () => {
    const { r, diags } = resolver();
    const t = new Thing({ variant: "ghostly" });
    r.resolve(t);
    r.resolve(t);
    assert.equal(diags.filter((d) => d.includes('no variant "ghostly"')).length, 1);
  });

  test("resolved styles are shared and frozen; the cache is keyed on chain, variant and state", () => {
    const { r } = resolver();
    const a = r.resolve(new Thing());
    const b = r.resolve(new Thing());
    assert.equal(a, b, "identical elements share one object");
    assert.ok(Object.isFrozen(a));
    const hovered = new Thing();
    hovered.setStateBit(UIState.Hovered, true);
    assert.notEqual(r.resolve(hovered), a);
    assert.ok(r.stats.cacheHits >= 1);
    const withOverride = new Thing({ style: { borderWidth: 9 } });
    assert.notEqual(r.resolve(withOverride), r.resolve(withOverride), "overrides are resolved per element, never cached globally");
  });

  test("switching theme or skin bumps the epoch, clears the cache and restyles attached elements", () => {
    const ui = makeUI();
    const b = ui.base.add(new Button({ text: "x" }));
    frame(ui);
    const darkBg = b.computedStyle.background;
    const epoch = ui.resolver.epoch;
    ui.setTheme("light");
    assert.ok(ui.resolver.epoch > epoch);
    const f = ui.update(0);
    assert.ok(f.styleResolves >= 1);
    assert.notEqual(b.computedStyle.background, darkBg, "the button was restyled");
    ui.setSkin("flat");
    frame(ui);
    assert.equal(b.computedStyle.radius.topLeft, 0, "flat skin: square corners");
  });
});

group("transitions", () => {
  test("a hovered state change blends colours over the skin's transition duration", () => {
    const ui = makeUI();
    const b = ui.base.add(new Button({ text: "hover me" }));
    frame(ui);
    const from = b.computedStyle.background;
    b.setStateBit(UIState.Hovered, true);
    frame(ui, 0.04); // the state change frame: the transition starts from the old colour
    assert.equal(b.paintStyle.background, from);
    frame(ui, 0.04); // one third of the forge skin's 0.12 s colour transition
    const to = b.computedStyle.background;
    assert.notEqual(from, to);
    const mid = b.paintStyle.background;
    assert.ok(mid !== from && mid !== to, `mid-transition colour ${mid.toString(16)} is between ${from.toString(16)} and ${to.toString(16)}`);
    advance(ui, 0.2);
    assert.equal(b.paintStyle, b.computedStyle, "the blend is dropped when the transition ends");
  });

  test("reduced motion applies the new style immediately", () => {
    const ui = makeUI({ reducedMotion: true });
    const b = ui.base.add(new Button({ text: "x" }));
    frame(ui);
    b.setStateBit(UIState.Hovered, true);
    frame(ui);
    assert.equal(b.paintStyle, b.computedStyle);
  });
});

group("built-in themes and skins", () => {
  test("every registered component resolves in every theme × skin without missing tokens", () => {
    const ui = makeUI();
    const elements: UIElement[] = [];
    for (const entry of ui.components.list()) {
      if (entry.name === "TabContainer" || entry.name === "VirtualizedList" || entry.name === "VirtualizedGrid") {
        // These need constructor callbacks; their style chains are covered by their parts below.
        continue;
      }
      elements.push(ui.create(entry.name, entry.name === "EquipmentSlot" ? { slotType: "weapon" } : {}));
    }
    for (const theme of ui.resolver.themeNames) {
      for (const skin of ui.resolver.skinNames) {
        ui.setTheme(theme);
        ui.setSkin(skin);
        for (const el of elements) {
          for (const state of [0, UIState.Hovered, UIState.Pressed | UIState.Focused, UIState.Selected, UIState.Disabled]) {
            el.setStateBit(UIState.Hovered | UIState.Pressed | UIState.Focused | UIState.Selected | UIState.Disabled, false);
            if (state) el.setStateBit(state, true);
            ui.resolver.resolve(el);
          }
        }
      }
    }
    const tokenProblems = ui.messages.filter((m) => /token|not a colour|unknown style property/.test(m.message));
    assert.deepEqual(tokenProblems.map((m) => m.message), []);
  });

  test("high-contrast text meets WCAG AAA (7:1) on its surfaces", () => {
    const ui = makeUI({ theme: "high-contrast" });
    const t = (k: string): number => ui.resolver.token(`color.${k}`) as number;
    assert.ok(contrastRatio(t("text"), t("surface")) >= 7);
    assert.ok(contrastRatio(t("accentText"), t("accent")) >= 7);
    assert.ok(contrastRatio(t("tooltipText"), t("tooltip")) >= 7);
  });

  test("light and dark body text keep at least AA (4.5:1) contrast", () => {
    for (const theme of ["frontier", "dark", "light"]) {
      const ui = makeUI({ theme });
      const t = (k: string): number => ui.resolver.token(`color.${k}`) as number;
      assert.ok(contrastRatio(t("text"), t("surface")) >= 4.5, `${theme} text/surface`);
      assert.ok(contrastRatio(t("textMuted"), t("surface")) >= 4.5, `${theme} muted/surface`);
    }
  });

  test("frontier: accent text on the orange accent stays readable; the skin uppercases control labels only on screen", () => {
    const ui = makeUI();
    const t = (k: string): number => ui.resolver.token(`color.${k}`) as number;
    assert.ok(contrastRatio(t("accentText"), t("accent")) >= 4.5, "dark text on the orange primary");
    assert.ok(contrastRatio(t("accent"), t("surface")) >= 4.5, "orange outline text on a card");
    const b = ui.base.add(new Button({ text: "Resume", variant: "outline" }));
    ui.update(0);
    assert.equal(b.computedStyle.textTransform, "uppercase");
    assert.ok(b.computedStyle.letterSpacing > 0);
    assert.equal(b.text, "Resume", "the model keeps its case");
    assert.equal(b.accessibility.label, "Resume", "and so does the accessible label");
    // Layout measures the transformed text: "abcd" is narrower than "ABCD".
    const lower = ui.base.add(new Label({ text: "abcd", style: { textTransform: "none" } }));
    const upper = ui.base.add(new Label({ text: "abcd", style: { textTransform: "uppercase" } }));
    frame(ui);
    assert.ok(upper.bounds.width > lower.bounds.width + 4, `${upper.bounds.width} vs ${lower.bounds.width}`);
    assert.equal(upper.text, "abcd");
  });

  test("setting an unknown theme or skin fails without changing the active one", () => {
    const ui = makeUI();
    assert.throws(() => ui.setTheme("nope"), UsageError);
    assert.equal(ui.theme, "frontier", "frontier is the default theme");
    assert.throws(() => ui.setSkin("nope"), UsageError);
    assert.equal(ui.skin, "frontier", "frontier is the default skin");
  });
});

await finish();
