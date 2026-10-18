/**
 * @suite ui:uiText
 * @group unit
 * @covers engine/src/ui/text/font.ts
 * @covers engine/src/ui/text/builtinFont.ts
 * @covers engine/src/ui/text/textLayout.ts
 * @covers engine/src/ui/text/textEngine.ts
 * @covers engine/src/ui/text/localization.ts
 * @desc UI text: the built-in SDF atlas decodes intact with real glyph ink, metrics/kerning/letter spacing, word/char wrapping incl. CJK and long words, newlines, maxLines + ellipsis/clip, line alignment, caret positions and hit testing, code-point (not UTF-16) indexing, fallback faces and missing-glyph replacement, the LRU layout cache and text scale, and localization (fallbacks, interpolation, plurals, pseudo-localization, missing keys)
 */

export const suite = {
  name: "ui:uiText",
  group: "unit",
  covers: ["engine/src/ui/text/font.ts", "engine/src/ui/text/builtinFont.ts", "engine/src/ui/text/textLayout.ts", "engine/src/ui/text/textEngine.ts", "engine/src/ui/text/localization.ts"],
  desc: "UI text: the built-in SDF atlas decodes intact with real glyph ink, metrics/kerning/letter spacing, word/char wrapping incl. CJK and long words, newlines, maxLines + ellipsis/clip, line alignment, caret positions and hit testing, code-point (not UTF-16) indexing, fallback faces and missing-glyph replacement, the LRU layout cache and text scale, and localization (fallbacks, interpolation, plurals, pseudo-localization, missing keys)",
};

import assert from "node:assert/strict";
import { finish, group, test } from "selrun";
import { DynamicGlyphFace, ForgeSansFace, Localizer, TextEngine, hitTestText, pseudoLocalize, type GlyphRasterizer } from "@forge/engine";

const face = new ForgeSansFace();
const engine = (): TextEngine => new TextEngine({ builtin: face });
const close = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps;

group("built-in font", () => {
  test("the atlas decodes to its declared size and glyphs have ink inside their boxes", () => {
    const p = face.page;
    assert.equal(p.data.length, p.width * p.height);
    for (const ch of "AgW@é€✓") {
      const g = face.glyph(ch.codePointAt(0)!)!;
      assert.ok(g && g.width > 0 && g.height > 0, ch);
      // SDF: texels well inside the glyph are > 0.5 (128); the box must contain some.
      let inside = 0;
      const x0 = Math.round(g.u0 * p.width);
      const y0 = Math.round(g.v0 * p.height);
      for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) if (p.data[(y0 + y) * p.width + x0 + x]! > 160) inside++;
      assert.ok(inside > 10, `${ch} has ${inside} interior texels`);
      // The spread margin (outermost ring) is outside the outline.
      assert.ok(p.data[y0 * p.width + x0]! < 128, `${ch} corner is outside`);
    }
  });

  test("covers ASCII, Latin-1 and the icon glyphs; space has an advance and no ink", () => {
    const cov = new Set(face.coverage);
    for (let cp = 32; cp < 127; cp++) assert.ok(cov.has(cp), String.fromCodePoint(cp));
    for (const cp of [0xe9, 0xf1, 0xfc, 0x2026, 0x2630, 0x2699]) assert.ok(cov.has(cp), cp.toString(16));
    const space = face.glyph(32)!;
    assert.ok(space.advance > 0 && space.width === 0 && space.page === null);
  });

  test("kerning pairs exist and tighten AV", () => {
    assert.ok(face.kerning(65, 86) < 0, "A→V kerns closer");
    const e = engine();
    const av = e.measure("AV", "default", 32).width;
    const a = e.measure("A", "default", 32).width;
    const v = e.measure("V", "default", 32).width;
    assert.ok(av < a + v);
  });
});

group("measurement and wrapping", () => {
  test("width scales linearly with size; letter spacing adds per gap", () => {
    const e = engine();
    const w16 = e.measure("Forge", "default", 16).width;
    const w32 = e.measure("Forge", "default", 32).width;
    assert.ok(close(w32, w16 * 2, 0.01));
    const spaced = e.layout({ text: "Forge", family: "default", size: 16, letterSpacing: 2 });
    assert.ok(close(spaced.width, w16 + 2 * 4), "4 gaps between 5 letters (trailing spacing not counted)");
  });

  test("letter-spaced text laid out at its own measured width neither wraps nor ellipsizes", () => {
    const e = engine();
    for (const letterSpacing of [0, 2.4, 4.5]) {
      const natural = e.layout({ text: "LANDING ZONES", family: "default", size: 12, weight: 600, letterSpacing });
      for (const overflow of ["ellipsis", "clip"] as const) {
        const fitted = e.layout({ text: "LANDING ZONES", family: "default", size: 12, weight: 600, letterSpacing, maxWidth: natural.width, wrap: "none", overflow });
        assert.equal(fitted.truncated, false, `spacing ${letterSpacing}, ${overflow}`);
        assert.ok(close(fitted.width, natural.width), `spacing ${letterSpacing}, ${overflow}: ${fitted.width} vs ${natural.width}`);
      }
      const wrapped = e.layout({ text: "LANDING ZONES", family: "default", size: 12, letterSpacing, maxWidth: e.layout({ text: "LANDING ZONES", family: "default", size: 12, letterSpacing }).width, wrap: "word" });
      assert.equal(wrapped.lines.length, 1, `spacing ${letterSpacing}: one line`);
    }
    // A genuinely narrower box still ellipsizes, and the ellipsis is the line's last visible glyph.
    const cut = e.layout({ text: "LANDING ZONES", family: "default", size: 12, letterSpacing: 3, maxWidth: 60, wrap: "none", overflow: "ellipsis" });
    assert.ok(cut.truncated && cut.width <= 60 + 1e-3, `${cut.width}`);
  });

  test("synthetic bold widens advances", () => {
    const e = engine();
    assert.ok(e.layout({ text: "Bold", family: "default", size: 20, weight: 700 }).width > e.layout({ text: "Bold", family: "default", size: 20 }).width);
  });

  test("word wrap breaks at spaces, trailing spaces do not count, explicit newlines break", () => {
    const e = engine();
    const one = e.measure("aaaa", "default", 16).width;
    const r = e.layout({ text: "aaaa bbbb cccc", family: "default", size: 16, maxWidth: one * 2.2 });
    assert.equal(r.lines.length, 2);
    assert.deepEqual(r.lines.map((l) => [l.start, l.end]), [[0, 9], [10, 14]]);
    assert.ok(r.lines[0]!.width <= one * 2.2);
    const nl = e.layout({ text: "a\nb\n\nc", family: "default", size: 16 });
    assert.equal(nl.lines.length, 4);
    assert.equal(nl.height, 4 * nl.lineHeight);
  });

  test("a word longer than the line breaks inside the word; char wrap breaks anywhere", () => {
    const e = engine();
    const r = e.layout({ text: "supercalifragilistic", family: "default", size: 16, maxWidth: 60 });
    assert.ok(r.lines.length > 1);
    for (const l of r.lines) assert.ok(l.width <= 60 + 1e-3);
    const c = e.layout({ text: "ab cd", family: "default", size: 16, maxWidth: e.measure("ab c", "default", 16).width, wrap: "char" });
    assert.equal(c.lines[0]!.end, 4);
  });

  test("CJK text breaks between ideographs (rendered by a fallback face)", () => {
    const ras: GlyphRasterizer = { ascent: 26, descent: 6, rasterize: (cp) => (cp >= 0x4e00 ? { advance: 32, x: 0, y: -26, width: 30, height: 30, alpha: new Uint8Array(900).fill(200) } : null) };
    const e = engine();
    e.addFallback("default", new DynamicGlyphFace("cjk", ras));
    const r = e.layout({ text: "日本語のテキスト", family: "default", size: 32, maxWidth: 100 });
    assert.ok(r.lines.length >= 2);
    assert.equal(r.missing, Array.from("のテキスト").length, "kana are not covered by the test rasteriser");
  });

  test("maxLines + ellipsis truncates with … within the width; clip cuts without one", () => {
    const e = engine();
    const text = "The quick brown fox jumps over the lazy dog again and again";
    const r = e.layout({ text, family: "default", size: 16, maxWidth: 150, maxLines: 2, overflow: "ellipsis" });
    assert.equal(r.lines.length, 2);
    assert.equal(r.truncated, true);
    assert.ok(r.lines[1]!.width <= 150 + 1e-3);
    const single = e.layout({ text, family: "default", size: 16, maxWidth: 100, wrap: "none", overflow: "ellipsis" });
    assert.ok(single.width <= 100 + 1e-3 && single.truncated);
    const ell = engine().layout({ text: "…", family: "default", size: 16 });
    assert.equal(single.glyphCount, single.lines[0]!.end - countSpaces(text.slice(0, single.lines[0]!.end)) + ell.glyphCount);
    const clip = e.layout({ text, family: "default", size: 16, maxWidth: 100, wrap: "none", overflow: "clip" });
    assert.ok(clip.width <= 100 && clip.truncated);
  });

  test("lines align within the block; the block width is the widest line (not the box)", () => {
    const e = engine();
    const r = e.layout({ text: "wide line here\nx", family: "default", size: 16, align: "center", maxWidth: 1000 });
    assert.ok(close(r.width, r.lines[0]!.width), "measured as wide as its text");
    assert.ok(close(r.lines[1]!.x, (r.lines[0]!.width - r.lines[1]!.width) / 2));
    const end = e.layout({ text: "wide line here\nx", family: "default", size: 16, align: "end" });
    assert.ok(close(end.lines[1]!.x + end.lines[1]!.width, end.width));
  });
});

group("carets and indices", () => {
  test("caret positions are monotonic per line and hit testing finds the nearest caret", () => {
    const r = engine().layout({ text: "hello world", family: "default", size: 20 });
    for (let i = 1; i <= 11; i++) assert.ok(r.caretX[i]! >= r.caretX[i - 1]!);
    const mid = (r.caretX[3]! + r.caretX[4]!) / 2 + 0.1;
    assert.equal(hitTestText(r, mid, 5), 4);
    assert.equal(hitTestText(r, -50, 5), 0);
    assert.equal(hitTestText(r, 9999, 5), 11);
  });

  test("indices are code points: an astral character is one caret step", () => {
    const r = engine().layout({ text: "a😀b", family: "default", size: 16 });
    assert.equal(r.codepoints.length, 3);
    assert.equal(r.caretX.length, 4);
    assert.equal(r.missing, 1, "😀 is not in the built-in font and was replaced");
  });

  test("multi-line hit testing picks the line from y", () => {
    const r = engine().layout({ text: "ab\ncd", family: "default", size: 16 });
    assert.equal(hitTestText(r, 0, r.lineHeight * 1.5), 3);
  });
});

group("engine cache, fallback and scale", () => {
  test("identical layouts hit the cache; the LRU evicts the oldest", () => {
    const e = new TextEngine({ builtin: face, maxEntries: 2 });
    const a = e.layout({ text: "a", family: "default", size: 10 });
    assert.equal(e.layout({ text: "a", family: "default", size: 10 }), a);
    e.layout({ text: "b", family: "default", size: 10 });
    e.layout({ text: "a", family: "default", size: 10 }); // refresh a
    e.layout({ text: "c", family: "default", size: 10 }); // evicts b
    assert.equal(e.stats.evictions, 1);
    assert.equal(e.stats.hits, 2);
    const missesBefore = e.stats.misses;
    e.layout({ text: "b", family: "default", size: 10 });
    assert.equal(e.stats.misses, missesBefore + 1, "b was evicted");
  });

  test("an unknown family falls back to the default chain; missing glyphs draw '?' and are counted", () => {
    const e = engine();
    const r = e.layout({ text: "一", family: "nope", size: 16 });
    assert.equal(r.glyphCount, 1);
    assert.equal(e.stats.missingGlyphs, 1);
  });

  test("dynamic faces rasterise once into their atlas and bump its version", () => {
    let calls = 0;
    const ras: GlyphRasterizer = { ascent: 20, descent: 5, rasterize: () => (calls++, { advance: 10, x: 0, y: -10, width: 8, height: 10, alpha: new Uint8Array(80).fill(255) }) };
    const dyn = new DynamicGlyphFace("t", ras, 32, 64);
    const v0 = dyn.page.version;
    const g = dyn.glyph(0x416)!;
    dyn.glyph(0x416);
    assert.equal(calls, 1);
    assert.ok(dyn.page.version > v0);
    assert.equal(dyn.page.data[Math.round(g.v0 * 64) * 64 + Math.round(g.u0 * 64)], 255);
    // Fill the 64×64 atlas until it overflows; overflowing glyphs report null, never corrupt.
    let n = 0;
    while (dyn.glyph(0x500 + n) !== null && n < 500) n++;
    assert.ok(dyn.overflowed >= 1 && n < 500);
  });

  test("textScale multiplies every size", () => {
    const e = engine();
    const base = e.measure("Scale", "default", 16).width;
    e.textScale = 1.5;
    assert.ok(close(e.measure("Scale", "default", 16).width, base * 1.5, 0.01));
  });
});

group("localization", () => {
  test("lookup falls back through locales; params interpolate; unknown params stay visible", () => {
    const l = new Localizer();
    l.addTable("en", { hi: "Hello {name}", only: "english only" });
    l.addTable("de", { hi: "Hallo {name}" });
    l.setLocale("de", ["en"]);
    assert.equal(l.t("hi", { name: "Ada" }), "Hallo Ada");
    assert.equal(l.t("only"), "english only");
    assert.equal(l.t("hi"), "Hallo {name}");
  });

  test("plural forms use Intl.PluralRules", () => {
    const l = new Localizer();
    l.addTable("en", { items: { one: "{count} item", other: "{count} items" } });
    l.setLocale("en");
    assert.equal(l.t("items", { count: 1 }), "1 item");
    assert.equal(l.t("items", { count: 3 }), "3 items");
  });

  test("missing keys render as the key and are reported once", () => {
    const l = new Localizer();
    const msgs: string[] = [];
    l.diagnostic = (m) => msgs.push(m);
    assert.equal(l.t("menu.nope"), "menu.nope");
    l.t("menu.nope");
    assert.equal(msgs.length, 1);
    assert.ok(l.missingKeys.has("menu.nope"));
  });

  test("pseudo-localization accents and lengthens (≥ 40%) and stays in the built-in font", () => {
    const p = pseudoLocalize("Settings and Controls");
    assert.ok(p.length >= "Settings and Controls".length * 1.4);
    for (const ch of p) assert.ok(face.glyph(ch.codePointAt(0)!) !== null, `glyph for ${ch}`);
  });

  test("onChange fires for locale, table and pseudo changes", () => {
    const l = new Localizer();
    let n = 0;
    l.onChange.on(() => n++);
    l.setLocale("fr");
    l.addTable("fr", { a: "b" });
    l.pseudo = true;
    l.pseudo = true;
    assert.equal(n, 3);
  });
});

function countSpaces(s: string): number {
  return Array.from(s).filter((c) => c === " ").length;
}

await finish();
