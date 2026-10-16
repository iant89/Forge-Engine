/**
 * `Localizer` — string tables, locale fallback, interpolation and plurals.
 *
 * `t("menu.play")` looks the key up in the active locale, then each fallback locale in order; a key
 * found nowhere is reported once (diagnostic + `missingKeys`) and rendered as the key itself, so a
 * missing translation is visible rather than blank. `{name}` placeholders are replaced from `params`.
 * A table entry may be a plural map (`{ one: "{count} item", other: "{count} items" }`) selected with
 * `Intl.PluralRules` when the runtime has it (English rules otherwise).
 *
 * Widgets that display localized text take a `textKey` and re-resolve when `onChange` fires, then
 * re-measure: a German string twice the English length reflows its layout instead of overflowing.
 * `pseudo = true` turns every string into an accented, ~40% longer variant to test exactly that.
 */

import { Signal } from "../../core/events.js";

export type PluralForms = Partial<Record<"zero" | "one" | "two" | "few" | "many" | "other", string>>;
export type StringTable = Record<string, string | PluralForms>;

const PSEUDO: Record<string, string> = { a: "á", e: "é", i: "í", o: "ö", u: "ü", c: "ç", n: "ñ", y: "ý", A: "Å", E: "É", I: "Í", O: "Ö", U: "Ü", C: "Ç", N: "Ñ" };

export class Localizer {
  private readonly tables = new Map<string, StringTable>();
  private _locale = "en";
  private _fallbacks: string[] = [];
  private _pseudo = false;
  readonly missingKeys = new Set<string>();
  /** Fires after the locale, fallbacks, a table or pseudo mode changed. */
  readonly onChange = new Signal();
  diagnostic: (message: string) => void = () => {};

  get locale(): string {
    return this._locale;
  }

  setLocale(locale: string, fallbacks: readonly string[] = this._fallbacks): void {
    this._locale = locale;
    this._fallbacks = [...fallbacks];
    this.missingKeys.clear();
    this.onChange.fire();
  }

  get pseudo(): boolean {
    return this._pseudo;
  }
  set pseudo(v: boolean) {
    if (v === this._pseudo) return;
    this._pseudo = v;
    this.onChange.fire();
  }

  /** Add or merge strings for a locale. */
  addTable(locale: string, table: StringTable): void {
    this.tables.set(locale, { ...(this.tables.get(locale) ?? {}), ...table });
    this.onChange.fire();
  }

  has(key: string): boolean {
    return this.lookup(key) !== undefined;
  }

  private lookup(key: string): string | PluralForms | undefined {
    for (const loc of [this._locale, ...this._fallbacks]) {
      const v = this.tables.get(loc)?.[key];
      if (v !== undefined) return v;
    }
    return undefined;
  }

  t(key: string, params?: Record<string, string | number>): string {
    let entry = this.lookup(key);
    if (entry === undefined) {
      if (!this.missingKeys.has(key)) {
        this.missingKeys.add(key);
        this.diagnostic(`localization: key "${key}" is missing in "${this._locale}"${this._fallbacks.length ? ` and fallbacks ${this._fallbacks.join(", ")}` : ""}`);
      }
      entry = key;
    }
    let text: string;
    if (typeof entry === "string") text = entry;
    else {
      const count = typeof params?.count === "number" ? params.count : 0;
      text = entry[this.pluralCategory(count)] ?? entry.other ?? key;
    }
    if (params) text = text.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] !== undefined ? String(params[name]) : m));
    return this._pseudo ? pseudoLocalize(text) : text;
  }

  pluralCategory(count: number): keyof PluralForms {
    const PR = (globalThis as { Intl?: { PluralRules?: new (l: string) => { select(n: number): string } } }).Intl?.PluralRules;
    if (PR) {
      try {
        return new PR(this._locale).select(count) as keyof PluralForms;
      } catch {
        // Unknown locale tag: fall through to English rules.
      }
    }
    return count === 1 ? "one" : "other";
  }
}

/** Accent vowels/consonants and pad by ~40% (placeholders are preserved). */
export function pseudoLocalize(text: string): string {
  let out = "";
  for (const ch of text) out += PSEUDO[ch] ?? ch;
  const pad = Math.ceil(text.length * 0.4);
  return `[${out}${pad > 0 ? " " + "~".repeat(pad) : ""}]`;
}
