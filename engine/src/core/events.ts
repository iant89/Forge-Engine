/**
 * Event system.
 *
 * Requirements that shaped this implementation:
 *  - zero allocation per emit (no array spread, no per-emit wrapper objects)
 *  - safe to add/remove listeners *from inside* a handler — structural changes are deferred and
 *    applied after dispatch, so a handler that unsubscribes itself cannot skip a sibling
 *  - disposable handles, because scripts/editor panels create and destroy listeners constantly
 *  - deterministic ordering: listeners fire in registration order
 *  - one listener throwing must not silence the event for the others
 *
 * It is deliberately NOT Node's EventEmitter: no wildcards, no magic 'error' semantics.
 * Type safety comes from a generic `EventMap`.
 */

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (payload: T) => void;

const EMPTY = undefined;

/** A single typed event source. */
export class EventTarget2<T> {
  /** Live slots in `handlers`; holes (tombstones) are compacted after dispatch. */
  private handlers: (Listener<T> | undefined)[] = [];
  private onceFlags: boolean[] = [];
  /** Adds queued during dispatch. */
  private pendingAdds: { fn: Listener<T>; once: boolean }[] = [];
  /** > 0 while dispatching. */
  private dispatchDepth = 0;
  private tombstones = 0;
  private _count = 0;

  get length(): number {
    return this._count;
  }

  get hasListeners(): boolean {
    return this._count > 0;
  }

  on(fn: Listener<T>): Disposable {
    return this.add(fn, false);
  }

  once(fn: Listener<T>): Disposable {
    return this.add(fn, true);
  }

  private add(fn: Listener<T>, once: boolean): Disposable {
    if (this.dispatchDepth > 0) this.pendingAdds.push({ fn, once });
    else {
      this.handlers.push(fn);
      this.onceFlags.push(once);
    }
    this._count++;
    let active = true;
    const self = this;
    return {
      dispose() {
        if (!active) return;
        active = false;
        self.remove(fn);
      },
    };
  }

  off(fn: Listener<T>): boolean {
    return this.remove(fn);
  }

  private remove(fn: Listener<T>): boolean {
    let found = false;
    for (let i = 0; i < this.handlers.length; i++) {
      if (this.handlers[i] === fn) {
        this.handlers[i] = EMPTY;
        this.onceFlags[i] = false;
        this.tombstones++;
        found = true;
      }
    }
    for (let i = 0; i < this.pendingAdds.length; i++) {
      if (this.pendingAdds[i]!.fn === fn) {
        this.pendingAdds.splice(i, 1);
        found = true;
        break;
      }
    }
    if (found) this._count = Math.max(0, this._count - 1);
    if (found && this.dispatchDepth === 0) this.compact();
    return found;
  }

  /**
   * Emit synchronously to every listener. `payload` is passed through untouched; emitters are
   * expected to hand over either a primitive or a pooled object the listeners must not retain.
   */
  emit(payload: T): void {
    if (this._count === 0) return;
    this.dispatchDepth++;
    const handlers = this.handlers;
    let removedAny = false;
    for (let i = 0; i < handlers.length; i++) {
      const fn = handlers[i];
      if (!fn) continue;
      if (this.onceFlags[i]) {
        handlers[i] = EMPTY;
        this.onceFlags[i] = false;
        this.tombstones++;
        this._count--;
        removedAny = true;
      }
      try {
        fn(payload);
      } catch (e) {
        reportEmitError(e);
      }
    }
    this.dispatchDepth--;
    if (this.dispatchDepth === 0) {
      if (this.pendingAdds.length) {
        for (const p of this.pendingAdds) {
          this.handlers.push(p.fn);
          this.onceFlags.push(p.once);
        }
        this.pendingAdds.length = 0;
      }
      if (removedAny || this.tombstones > 0) this.compact();
    }
  }

  private compact(): void {
    if (this.tombstones === 0) return;
    const h = this.handlers;
    const o = this.onceFlags;
    let w = 0;
    for (let i = 0; i < h.length; i++) {
      const fn = h[i];
      if (!fn) continue;
      h[w] = fn;
      o[w] = o[i]!;
      w++;
    }
    h.length = w;
    o.length = w;
    this.tombstones = 0;
    this._count = w;
  }

  clear(): void {
    this.handlers.length = 0;
    this.onceFlags.length = 0;
    this.pendingAdds.length = 0;
    this.tombstones = 0;
    this._count = 0;
  }

  /** Debug helper. */
  snapshot(): { count: number; capacity: number } {
    return { count: this._count, capacity: this.handlers.length };
  }
}

let emitErrorHandler: ((e: unknown) => void) | null = null;

/** Install the engine-wide handler for listener exceptions (called once by `Engine`). */
export function setEmitErrorHandler(fn: ((e: unknown) => void) | null): void {
  emitErrorHandler = fn;
}

function reportEmitError(e: unknown): void {
  if (emitErrorHandler) emitErrorHandler(e);
  else if (typeof console !== "undefined") console.error("[forge] event listener threw", e);
}

/**
 * A named event bus, so subsystems communicate without importing each other.
 * `Events` is a plain interface mapping name → payload type.
 */
export class EventBus<Events extends Record<string, unknown> = Record<string, unknown>> {
  // `never` payload: per-name targets have heterogeneous payload types, and the only sound way to
  // key them by name is to erase the payload in the map and re-narrow on access.
  private targets = new Map<keyof Events, EventTarget2<never>>();

  target<K extends keyof Events>(name: K): EventTarget2<Events[K]> {
    let t = this.targets.get(name) as EventTarget2<Events[K]> | undefined;
    if (!t) {
      t = new EventTarget2<Events[K]>();
      this.targets.set(name, t as unknown as EventTarget2<never>);
    }
    return t;
  }

  on<K extends keyof Events>(name: K, fn: Listener<Events[K]>): Disposable {
    return this.target(name).on(fn);
  }

  once<K extends keyof Events>(name: K, fn: Listener<Events[K]>): Disposable {
    return this.target(name).once(fn);
  }

  off<K extends keyof Events>(name: K, fn: Listener<Events[K]>): boolean {
    return (this.targets.get(name) as EventTarget2<Events[K]> | undefined)?.off(fn) ?? false;
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    (this.targets.get(name) as EventTarget2<Events[K]> | undefined)?.emit(payload);
  }

  listenerCount<K extends keyof Events>(name: K): number {
    return this.targets.get(name)?.length ?? 0;
  }

  clear(): void {
    for (const t of this.targets.values()) t.clear();
    this.targets.clear();
  }

  /** Re-emit `source` under `name` on this bus. */
  bridge<K extends keyof Events>(name: K, source: EventTarget2<Events[K]>): Disposable {
    return source.on((p) => this.emit(name, p));
  }
}

/** Composite disposable, disposed in reverse registration order. */
export class DisposableGroup implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  constructor(items: Disposable[] = []) {
    this.items.push(...items);
  }

  add<D extends Disposable>(d: D): D {
    if (this.disposed) {
      d.dispose();
      return d;
    }
    this.items.push(d);
    return d;
  }

  get size(): number {
    return this.items.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const items = this.items;
    this.items = [];
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i]!.dispose();
      } catch (e) {
        reportEmitError(e);
      }
    }
  }
}

/** Convenience: an event that carries no payload. */
export class Signal extends EventTarget2<void> {
  fire(): void {
    this.emit(EMPTY as void);
  }
}
