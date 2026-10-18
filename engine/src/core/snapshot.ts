/**
 * Structural state snapshots (Phase 19.3): capture the mutable state of an object graph and write it
 * back into the same graph later, bit for bit, so a simulation restored from a snapshot continues
 * exactly as the original did.
 *
 * `captureState(obj)` walks the object's own enumerable fields — private ones included, since a
 * TypeScript `private` is an ordinary property — and records numbers, booleans, strings, `null`,
 * arrays, typed arrays and nested objects (vectors, quaternions, sub-records). Functions are ignored.
 * Fields named in `skip` (external references: a scene, a ground query, a shared heightfield) are
 * left out, and so is any object already visited, which keeps shared references from being written
 * twice and cycles from looping. `restoreState(obj, data)` walks the same shape and assigns the
 * recorded values, recursing into the existing nested objects rather than replacing them (so a
 * `readonly position = new Vec3()` keeps its identity). A shape mismatch — an array of a different
 * length, a missing nested object — throws: a snapshot only fits the structure it was taken from.
 *
 * The data is JSON-safe and stays exact through `JSON.stringify`: `-0`, `NaN` and the infinities are
 * written as `{ "$n": "-0" | "NaN" | "Infinity" | "-Infinity" }`, and typed arrays as
 * `{ "$t": "<Ctor>", "v": [...] }` (float32 values survive the round trip through float64 exactly).
 *
 * `hashState(data)` is a 32-bit FNV-1a hash of the data's canonical JSON — the "same input, same
 * state hash" check of Phase 19.4/19.5.
 */

export type StateValue = number | boolean | string | null | StateValue[] | { [key: string]: StateValue };
export type StateRecord = { [key: string]: StateValue };

export interface CaptureOptions {
  /** Field names to leave out at any depth (external references, caches rebuilt on restore). */
  skip?: readonly string[];
}

const TYPED = new Map<string, new (values: number[]) => ArrayLike<number>>([
  ["Float32Array", Float32Array],
  ["Float64Array", Float64Array],
  ["Int8Array", Int8Array],
  ["Int16Array", Int16Array],
  ["Int32Array", Int32Array],
  ["Uint8Array", Uint8Array],
  ["Uint16Array", Uint16Array],
  ["Uint32Array", Uint32Array],
  ["Uint8ClampedArray", Uint8ClampedArray],
]);

/** A number as state data (exact: `-0`, `NaN` and the infinities are tagged). */
export function encodeNumber(n: number): StateValue {
  if (Number.isNaN(n)) return { $n: "NaN" };
  if (n === Infinity) return { $n: "Infinity" };
  if (n === -Infinity) return { $n: "-Infinity" };
  if (n === 0 && 1 / n < 0) return { $n: "-0" };
  return n;
}

/** The number `encodeNumber` wrote, or undefined when `v` is not a number. */
export function decodeNumber(v: StateValue): number | undefined {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v["$n"] === "string" && Object.keys(v).length === 1) {
    switch (v["$n"]) {
      case "NaN":
        return Number.NaN;
      case "Infinity":
        return Infinity;
      case "-Infinity":
        return -Infinity;
      case "-0":
        return -0;
    }
  }
  return undefined;
}

/** Capture `obj`'s mutable state (see the module contract). */
export function captureState(obj: object, options: CaptureOptions = {}): StateRecord {
  const skip = new Set(options.skip ?? []);
  const seen = new WeakSet<object>();
  const out = captureValue(obj, skip, seen);
  if (!out || typeof out !== "object" || Array.isArray(out)) throw new TypeError("captureState: expected an object");
  return out as StateRecord;
}

function captureValue(value: unknown, skip: Set<string>, seen: WeakSet<object>): StateValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
      return encodeNumber(value);
    case "boolean":
    case "string":
      return value;
    case "object":
      break;
    default:
      return undefined; // functions, symbols, undefined, bigint
  }
  const o = value as object;
  if (seen.has(o)) return undefined;
  seen.add(o);
  if (ArrayBuffer.isView(o)) {
    const name = o.constructor.name;
    if (!TYPED.has(name)) return undefined;
    return { $t: name, v: Array.from(o as unknown as ArrayLike<number>, encodeNumber) };
  }
  if (Array.isArray(o)) {
    const arr: StateValue[] = [];
    for (const item of o) arr.push(captureValue(item, skip, seen) ?? null);
    return arr;
  }
  if (o instanceof Map || o instanceof Set || o instanceof WeakMap || o instanceof WeakSet || o instanceof Promise) return undefined;
  const rec: StateRecord = {};
  for (const [key, v] of Object.entries(o)) {
    if (skip.has(key)) continue;
    const c = captureValue(v, skip, seen);
    if (c !== undefined) rec[key] = c;
  }
  return rec;
}

/** Write `data` (from `captureState` on an object of the same shape) back into `obj`. */
export function restoreState(obj: object, data: StateRecord, path = "state"): void {
  restoreInto(obj as Record<string, unknown>, data, path);
}

function restoreInto(target: Record<string, unknown>, data: StateRecord, path: string): void {
  for (const [key, saved] of Object.entries(data)) {
    const here = `${path}.${key}`;
    const current = target[key];
    const restored = restoreValue(current, saved, here);
    if (restored.assign) {
      try {
        target[key] = restored.value;
      } catch {
        throw new TypeError(`restoreState: cannot assign ${here}`);
      }
    }
  }
}

function restoreValue(current: unknown, saved: StateValue, path: string): { assign: boolean; value?: unknown } {
  const n = decodeNumber(saved);
  if (n !== undefined) return { assign: true, value: n };
  if (saved === null || typeof saved === "boolean" || typeof saved === "string") return { assign: true, value: saved };
  if (Array.isArray(saved)) {
    if (!Array.isArray(current)) throw new TypeError(`restoreState: ${path} is not an array here`);
    if (current.length !== saved.length) throw new TypeError(`restoreState: ${path} has ${current.length} entries, the snapshot ${saved.length}`);
    for (let i = 0; i < saved.length; i++) {
      const r = restoreValue(current[i], saved[i]!, `${path}[${i}]`);
      if (r.assign) current[i] = r.value;
    }
    return { assign: false };
  }
  const rec = saved as StateRecord;
  if (typeof rec["$t"] === "string" && Array.isArray(rec["v"])) {
    if (!ArrayBuffer.isView(current) || current.constructor.name !== rec["$t"]) throw new TypeError(`restoreState: ${path} is not a ${String(rec["$t"])}`);
    const arr = current as unknown as { length: number; [i: number]: number };
    const values = rec["v"] as StateValue[];
    if (arr.length !== values.length) throw new TypeError(`restoreState: ${path} has ${arr.length} entries, the snapshot ${values.length}`);
    for (let i = 0; i < values.length; i++) arr[i] = decodeNumber(values[i]!) ?? 0;
    return { assign: false };
  }
  if (current === null || typeof current !== "object") throw new TypeError(`restoreState: ${path} is not an object here`);
  restoreInto(current as Record<string, unknown>, rec, path);
  return { assign: false };
}

/** Canonical JSON (sorted keys) of state data — the input to `hashState`. */
export function canonicalState(data: StateValue): string {
  if (data === null || typeof data !== "object") return JSON.stringify(data);
  if (Array.isArray(data)) return `[${data.map(canonicalState).join(",")}]`;
  const keys = Object.keys(data).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalState(data[k]!)}`).join(",")}}`;
}

/** 32-bit FNV-1a of the canonical JSON, as 8 hex digits. Equal state → equal hash, across key order. */
export function hashState(data: StateValue): string {
  const s = canonicalState(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
