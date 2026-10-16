/**
 * Text entry: `TextInput` (single line) and `TextArea` (multi-line, word-wrapped).
 *
 * Editing model: the value is a string edited in **code points** (an emoji or an accented letter is
 * one caret step). Supported: caret movement (arrows, Home/End, Ctrl+arrows by word, Up/Down between
 * lines in a TextArea), selection (Shift+movement, pointer drag, double-click selects a word,
 * Ctrl/Cmd+A), Backspace/Delete (Ctrl = by word), typing and pasting through `textinput` events,
 * undo/redo (Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z), `maxLength`, a per-character `filter`, password
 * masking, `validate` (sets the `invalid` state), and Enter → `submit` (TextInput) or newline
 * (TextArea). The caret blinks only while focused, and the view scrolls to keep it visible.
 *
 * Clipboard: copy/cut write to `TextInput.clipboard` (in-memory by default; the DOM adapter installs
 * one that also writes the system clipboard). Paste arrives as a `textinput` event from the platform;
 * Ctrl+V reads `clipboard.read()` only when that returns text (the in-memory default does), so a
 * platform paste is never applied twice. IME composition is not supported (docs/UI.md §11).
 */

import type { UIContext } from "../core/context.js";
import type { ResolvedStyle } from "../style/types.js";
import { UIState } from "../style/types.js";
import type { UIPainter } from "../render/painter.js";
import { withAlpha } from "../core/color.js";
import { hitTestText, type TextLayoutResult } from "../text/textLayout.js";
import { UICustomEvent, type UIKeyEvent, type UIPointerEvent, type UITextEvent } from "../input/events.js";
import { UIControl, type UIControlOptions } from "./base.js";

export interface Clipboard {
  read(): string | null;
  write(text: string): void;
}

export class MemoryClipboard implements Clipboard {
  private text = "";
  read(): string | null {
    return this.text;
  }
  write(text: string): void {
    this.text = text;
  }
}

export interface TextInputOptions extends UIControlOptions {
  value?: string;
  placeholder?: string;
  maxLength?: number;
  password?: boolean;
  /** Per-character acceptance (e.g. digits only). */
  filter?: (char: string) => boolean;
  /** Return an error message to mark the value invalid (shown via the `invalid` state). */
  validate?: (value: string) => string | null;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  readOnly?: boolean;
}

const BULLET = "•";
const isWordChar = (s: string): boolean => /[\p{L}\p{N}_]/u.test(s);

export class TextInput extends UIControl {
  static override styleName = "TextInput";
  static clipboard: Clipboard = new MemoryClipboard();

  protected chars: string[];
  private _caret: number;
  private _anchor: number;
  placeholder: string;
  maxLength: number;
  password: boolean;
  filter: ((char: string) => boolean) | null;
  validate: ((value: string) => string | null) | null;
  readOnly: boolean;
  /** Current validation message (null = valid). */
  error: string | null = null;
  protected scrollX = 0;
  protected scrollY = 0;
  protected readonly multiline: boolean = false;
  private readonly onChangeCallback: ((value: string) => void) | null;
  private readonly onSubmitCallback: ((value: string) => void) | null;
  private undoStack: { text: string; caret: number }[] = [];
  private redoStack: { text: string; caret: number }[] = [];
  private lastEditKind = "";
  private selectingWithPointer = false;
  private layoutCache: { key: string; layout: TextLayoutResult } | null = null;
  private blinkOn = true;

  constructor(options: TextInputOptions = {}) {
    super(options);
    this.chars = Array.from(options.value ?? "");
    this._caret = this.chars.length;
    this._anchor = this._caret;
    this.placeholder = options.placeholder ?? "";
    this.maxLength = options.maxLength ?? Infinity;
    this.password = options.password ?? false;
    this.filter = options.filter ?? null;
    this.validate = options.validate ?? null;
    this.readOnly = options.readOnly ?? false;
    this.onChangeCallback = options.onChange ?? null;
    this.onSubmitCallback = options.onSubmit ?? null;
    this.accessibility.role = "textbox";
    this.accessibility.description = this.placeholder;
    this.syncA11y();
    this.on("keydown", (e) => this.onKey(e));
    this.on("textinput", (e: UITextEvent) => {
      if (this.readOnly) return;
      e.preventDefault();
      this.insert(e.text, "type");
    });
    this.on("pointerdown", (e) => this.onPointerDown(e));
    this.on("pointermove", (e) => {
      if (!this.selectingWithPointer) return;
      this.setCaret(this.indexAt(e), true);
    });
    this.on("pointerup", () => (this.selectingWithPointer = false));
    this.on("dblclick", () => this.selectWordAt(this._caret));
    this.on("focus", () => {
      this.blinkOn = true;
      this.setTicking(true);
    });
    this.on("blur", () => {
      this.setTicking(false);
      this.selectingWithPointer = false;
      this.invalidateRender();
    });
    this.runValidation();
  }

  // ------------------------------------------------------------------ value

  get value(): string {
    return this.chars.join("");
  }
  set value(v: string) {
    if (v === this.value) return;
    this.chars = Array.from(v).slice(0, Number.isFinite(this.maxLength) ? this.maxLength : undefined);
    this._caret = Math.min(this._caret, this.chars.length);
    this._anchor = this._caret;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.changed();
  }

  get caret(): number {
    return this._caret;
  }

  get selectionStart(): number {
    return Math.min(this._caret, this._anchor);
  }

  get selectionEnd(): number {
    return Math.max(this._caret, this._anchor);
  }

  get selectedText(): string {
    return this.chars.slice(this.selectionStart, this.selectionEnd).join("");
  }

  /** Place the caret (code-point index); `extend` keeps the selection anchor. */
  setCaret(index: number, extend = false): void {
    const i = Math.max(0, Math.min(this.chars.length, index));
    if (i === this._caret && (extend || this._anchor === i)) return;
    this._caret = i;
    if (!extend) this._anchor = i;
    this.blinkOn = true;
    this.lastEditKind = "";
    this.revealCaret();
    this.invalidateRender();
  }

  select(start: number, end: number): void {
    this._anchor = Math.max(0, Math.min(this.chars.length, start));
    this._caret = Math.max(0, Math.min(this.chars.length, end));
    this.revealCaret();
    this.invalidateRender();
  }

  selectAll(): void {
    this.select(0, this.chars.length);
  }

  private syncA11y(): void {
    this.accessibility.value = this.password ? BULLET.repeat(this.chars.length) : this.value;
  }

  private snapshot(kind: string): void {
    // Consecutive typing/deleting coalesces into one undo step.
    if (kind === this.lastEditKind && (kind === "type" || kind === "delete")) return;
    this.undoStack.push({ text: this.value, caret: this._caret });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this.lastEditKind = kind;
  }

  /** Replace the selection with `text` (filtered, newline-stripped for single line, length-capped). */
  insert(text: string, kind = "insert"): boolean {
    if (this.readOnly) return false;
    let incoming = Array.from(text);
    if (!this.multiline) incoming = incoming.filter((c) => c !== "\n" && c !== "\r");
    else incoming = incoming.filter((c) => c !== "\r");
    if (this.filter) incoming = incoming.filter((c) => c === "\n" || this.filter!(c));
    const s0 = this.selectionStart;
    const s1 = this.selectionEnd;
    const room = this.maxLength - (this.chars.length - (s1 - s0));
    if (room < incoming.length) incoming = incoming.slice(0, Math.max(0, room));
    if (incoming.length === 0 && s0 === s1) return false;
    this.snapshot(kind);
    this.chars.splice(s0, s1 - s0, ...incoming);
    this._caret = this._anchor = s0 + incoming.length;
    this.changed();
    return true;
  }

  private deleteRange(a: number, b: number): void {
    if (a === b || this.readOnly) return;
    this.snapshot("delete");
    this.chars.splice(a, b - a);
    this._caret = this._anchor = a;
    this.changed();
  }

  /** After any value change (typing or programmatic — `change` fires for both, like every widget). */
  private changed(): void {
    this.layoutCache = null;
    this.syncA11y();
    this.runValidation();
    this.blinkOn = true;
    this.revealCaret();
    this.invalidateLayout();
    const v = this.value;
    this.onChangeCallback?.(v);
    this.emitChange("value", v);
  }

  private runValidation(): void {
    this.error = this.validate ? this.validate(this.value) : null;
    this.setStateBit(UIState.Invalid, this.error !== null);
    this.accessibility.description = this.error ?? this.placeholder;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push({ text: this.value, caret: this._caret });
    this.chars = Array.from(prev.text);
    this._caret = this._anchor = prev.caret;
    this.lastEditKind = "";
    this.changed();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push({ text: this.value, caret: this._caret });
    this.chars = Array.from(next.text);
    this._caret = this._anchor = next.caret;
    this.lastEditKind = "";
    this.changed();
    return true;
  }

  // ------------------------------------------------------------------ word navigation

  private wordLeft(i: number): number {
    while (i > 0 && !isWordChar(this.chars[i - 1]!)) i--;
    while (i > 0 && isWordChar(this.chars[i - 1]!)) i--;
    return i;
  }

  private wordRight(i: number): number {
    const n = this.chars.length;
    while (i < n && !isWordChar(this.chars[i]!)) i++;
    while (i < n && isWordChar(this.chars[i]!)) i++;
    return i;
  }

  private selectWordAt(i: number): void {
    let a = i;
    let b = i;
    while (a > 0 && isWordChar(this.chars[a - 1]!)) a--;
    while (b < this.chars.length && isWordChar(this.chars[b]!)) b++;
    this.select(a, b);
  }

  // ------------------------------------------------------------------ keyboard

  private onKey(e: UIKeyEvent): void {
    const m = e.modifiers;
    const word = m.ctrl || m.alt;
    const cmd = m.ctrl || m.meta;
    const sel = this.selectionStart !== this.selectionEnd;
    let handled = true;
    switch (e.key) {
      case "ArrowLeft":
        if (!m.shift && sel) this.setCaret(this.selectionStart);
        else this.setCaret(word ? this.wordLeft(this._caret) : this._caret - 1, m.shift);
        break;
      case "ArrowRight":
        if (!m.shift && sel) this.setCaret(this.selectionEnd);
        else this.setCaret(word ? this.wordRight(this._caret) : this._caret + 1, m.shift);
        break;
      case "ArrowUp":
      case "ArrowDown":
        handled = this.verticalMove(e.key === "ArrowUp" ? -1 : 1, m.shift);
        break;
      case "Home":
        this.setCaret(cmd || !this.multiline ? 0 : this.lineEdge(-1), m.shift);
        break;
      case "End":
        this.setCaret(cmd || !this.multiline ? this.chars.length : this.lineEdge(1), m.shift);
        break;
      case "Backspace":
        if (sel) this.deleteRange(this.selectionStart, this.selectionEnd);
        else if (this._caret > 0) this.deleteRange(word ? this.wordLeft(this._caret) : this._caret - 1, this._caret);
        break;
      case "Delete":
        if (sel) this.deleteRange(this.selectionStart, this.selectionEnd);
        else if (this._caret < this.chars.length) this.deleteRange(this._caret, word ? this.wordRight(this._caret) : this._caret + 1);
        break;
      case "Enter":
        if (this.multiline) this.insert("\n", "newline");
        else {
          this.onSubmitCallback?.(this.value);
          this.emit(new UICustomEvent("submit", { value: this.value }));
        }
        break;
      default:
        handled = false;
        if (cmd) {
          handled = true;
          const k = e.key.toLowerCase();
          if (k === "a") this.selectAll();
          else if (k === "c") {
            if (sel && !this.password) TextInput.clipboard.write(this.selectedText);
          } else if (k === "x") {
            if (sel && !this.password) {
              TextInput.clipboard.write(this.selectedText);
              this.deleteRange(this.selectionStart, this.selectionEnd);
            }
          } else if (k === "v") {
            const t = TextInput.clipboard.read();
            if (t !== null) this.insert(t, "paste");
            else handled = false;
          } else if (k === "z") {
            if (m.shift) this.redo();
            else this.undo();
          } else if (k === "y") this.redo();
          else handled = false;
        }
    }
    // Space is text, not activation; Enter has been handled above.
    if (e.key === " ") handled = true;
    if (handled) e.preventDefault();
  }

  /** TextArea overrides; a single line lets Up/Down move focus. */
  protected verticalMove(_dir: number, _extend: boolean): boolean {
    return false;
  }

  protected lineEdge(_dir: number): number {
    return _dir < 0 ? 0 : this.chars.length;
  }

  // ------------------------------------------------------------------ pointer

  private onPointerDown(e: UIPointerEvent): void {
    if (!this.effectivelyEnabled) return;
    this.setCaret(this.indexAt(e), e.modifiers.shift);
    this.selectingWithPointer = true;
  }

  protected indexAt(e: UIPointerEvent): number {
    const l = this.currentLayout();
    if (!l) return 0;
    const c = this.contentRect;
    const top = this.multiline ? c.y - this.scrollY : c.y + (c.height - l.height) / 2;
    return hitTestText(l, e.x - c.x + this.scrollX, e.y - top);
  }

  // ------------------------------------------------------------------ layout & paint

  /** The text as displayed (masked for passwords). */
  protected get displayText(): string {
    return this.password ? BULLET.repeat(this.chars.length) : this.value;
  }

  protected currentLayout(): TextLayoutResult | null {
    const ctx = this.context;
    if (!ctx) return null;
    const s = this.computedStyle;
    const width = this.multiline ? Math.max(1, this.contentRect.width) : Infinity;
    const key = `${width}|${s.fontSize}|${s.fontFamily}|${s.fontWeight}|${s.lineHeight}|${ctx.text.textScale}|${this.password}`;
    if (this.layoutCache && this.layoutCache.key === key) return this.layoutCache.layout;
    const layout = ctx.text.layout({
      text: this.displayText,
      family: ctx.text.hasFamily(s.fontFamily) ? s.fontFamily : "default",
      size: s.fontSize,
      weight: s.fontWeight,
      lineHeight: s.lineHeight,
      maxWidth: width,
      wrap: this.multiline ? "word" : "none",
    });
    this.layoutCache = { key, layout };
    return layout;
  }

  protected revealCaret(): void {
    const l = this.currentLayout();
    if (!l) return;
    const c = this.contentRect;
    const x = l.caretX[this._caret] ?? 0;
    if (x - this.scrollX > c.width - 2) this.scrollX = x - c.width + 2;
    if (x - this.scrollX < 0) this.scrollX = x;
    if (!this.multiline) this.scrollX = Math.max(0, Math.min(this.scrollX, Math.max(0, l.width - c.width + 2)));
    if (this.multiline) {
      const line = l.caretLine[this._caret] ?? 0;
      const y0 = line * l.lineHeight;
      if (y0 < this.scrollY) this.scrollY = y0;
      if (y0 + l.lineHeight > this.scrollY + c.height) this.scrollY = y0 + l.lineHeight - c.height;
      this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, l.height - c.height)));
    }
  }

  override update(): void {
    const ctx = this.context;
    if (!ctx || !this.focused) return;
    const on = ctx.reducedMotion || Math.floor(ctx.time / 0.53) % 2 === 0;
    if (on !== this.blinkOn) {
      this.blinkOn = on;
      this.invalidateRender();
    }
  }

  protected override onAttach(_ctx: UIContext): void {
    this.layoutCache = null;
  }

  protected override onStyleChanged(): void {
    this.layoutCache = null;
  }

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const lineH = s.fontSize * s.lineHeight * (this.context?.text.textScale ?? 1);
    if (this.multiline) return { width: Math.min(availableWidth, 240), height: lineH * 4 };
    return { width: Math.min(availableWidth, 200), height: lineH };
  }

  protected override paintContent(p: UIPainter, s: ResolvedStyle): void {
    const c = this.contentRect;
    const ctx = this.context;
    if (!ctx) return;
    p.pushClip(c.x, c.y, c.width, c.height);
    const l = this.currentLayout();
    if (this.chars.length === 0) {
      if (this.placeholder) {
        const ph = ctx.text.layout({ text: this.placeholder, family: "default", size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight, maxWidth: this.multiline ? c.width : Infinity, wrap: this.multiline ? "word" : "none" });
        p.text(ph, c.x, this.multiline ? c.y : c.y + (c.height - ph.height) / 2, withAlpha(s.foreground, 0.45));
      }
    }
    if (l) {
      const ox = c.x - this.scrollX;
      const oy = this.multiline ? c.y - this.scrollY : c.y + (c.height - l.height) / 2;
      // Selection highlight, per line.
      const a = this.selectionStart;
      const b = this.selectionEnd;
      if (a !== b && this.focused) {
        const hl = withAlpha(s.accent, 0.35);
        for (let li = 0; li < l.lines.length; li++) {
          const line = l.lines[li]!;
          const s0 = Math.max(a, line.start);
          const s1 = Math.min(b, li + 1 < l.lines.length ? l.lines[li + 1]!.start : line.end);
          if (s1 <= s0) continue;
          const x0 = l.caretX[s0] ?? 0;
          const x1 = s1 > line.end ? line.x + line.width + s.fontSize * 0.3 : l.caretX[s1] ?? 0;
          p.fillRect(ox + x0, oy + line.y, Math.max(2, x1 - x0), l.lineHeight, hl);
        }
      }
      if (this.chars.length > 0) p.text(l, ox, oy, s.foreground);
      if (this.focused && this.blinkOn && !this.readOnly) {
        const cx = ox + (l.caretX[this._caret] ?? 0);
        const line = l.caretLine[this._caret] ?? 0;
        p.fillRect(cx - 0.5, oy + line * l.lineHeight + l.lineHeight * 0.12, 1.5, l.lineHeight * 0.76, s.accent);
      }
    }
    p.popClip();
  }
}

export class TextArea extends TextInput {
  static override styleName = "TextArea";
  protected override readonly multiline = true;

  constructor(options: TextInputOptions & { rows?: number } = {}) {
    super(options);
    this.accessibility.role = "textbox";
    this.accessibility.description = this.accessibility.description || "multi-line";
    if (options.rows) this.rows = options.rows;
    this.on("wheel", (e) => {
      const l = this.currentLayout();
      if (!l) return;
      const max = Math.max(0, l.height - this.contentRect.height);
      const next = Math.max(0, Math.min(max, this.scrollY + e.deltaY));
      if (next !== this.scrollY) {
        this.scrollY = next;
        e.preventDefault();
        e.stopPropagation();
        this.invalidateRender();
      }
    });
  }

  rows = 4;

  protected override measureContent(availableWidth: number): { width: number; height: number } {
    const s = this.computedStyle;
    const lineH = s.fontSize * s.lineHeight * (this.context?.text.textScale ?? 1);
    return { width: Math.min(availableWidth, 260), height: lineH * this.rows };
  }

  protected override verticalMove(dir: number, extend: boolean): boolean {
    const l = this.currentLayout();
    if (!l) return false;
    const line = (l.caretLine[this.caret] ?? 0) + dir;
    if (line < 0 || line >= l.lines.length) {
      this.setCaret(dir < 0 ? 0 : this.chars.length, extend);
      return true;
    }
    const x = l.caretX[this.caret] ?? 0;
    const target = l.lines[line]!;
    let best = target.start;
    let bestD = Infinity;
    for (let i = target.start; i <= target.end; i++) {
      const d = Math.abs((l.caretX[i] ?? 0) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.setCaret(best, extend);
    return true;
  }

  protected override lineEdge(dir: number): number {
    const l = this.currentLayout();
    if (!l) return dir < 0 ? 0 : this.chars.length;
    const line = l.lines[l.caretLine[this.caret] ?? 0];
    if (!line) return dir < 0 ? 0 : this.chars.length;
    return dir < 0 ? line.start : line.end;
  }
}
