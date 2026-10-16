/**
 * Typed script events (Phase 18.4).
 *
 * ```ts
 * const Damaged = defineEvent<{ amount: number; from: EntityId }>("Damaged");
 *
 * class Health extends Script {
 *   override onCreate(): void {
 *     this.on(Damaged, (e) => (this.hp -= e.amount), { entity: this.entity! }); // only hits on me
 *   }
 * }
 * class Turret extends Script {
 *   fire(target: Entity): void {
 *     this.emit(Damaged, { amount: 10, from: this.entityId! }, { to: target });
 *   }
 * }
 * ```
 *
 * - **Typed tokens.** `defineEvent<T>(name)` returns an {@link EventType}; the payload type travels
 *   with the token, so emitters and listeners in different modules agree without a shared global map.
 * - **Channels.** An event goes to the world channel, or with `{ to: entity }` to that entity's
 *   channel. A listener subscribes to one channel (`{ entity }` picks the entity's; default world).
 * - **Delivery.** `emit` delivers now, synchronously, in subscription order. `post` queues the event;
 *   queued events are delivered first-in first-out at the start of the next script phase (before
 *   that phase's timers, coroutines and hooks), so they arrive at a defined point of the frame.
 *   Events posted while the queue is being delivered wait for the following phase.
 * - **Script listeners** (`Script.on`) run under the same isolation as hooks (phase "event"): a throw
 *   is recorded, rolls back the handler's structural changes and counts toward `faultAfter`, and the
 *   emitter and the other listeners are unaffected. They receive events only while their script is
 *   active and enabled (events arriving otherwise are not kept), and are removed when it is destroyed
 *   or faulted. **Host listeners** (`runtime.events.on`) are plain callbacks with the error caught
 *   and recorded.
 * - **Re-entrancy.** Handlers may emit, subscribe and unsubscribe; a listener added during a dispatch
 *   first hears the next one. Nested `emit` deeper than `maxEventDepth` (default 16) is refused with
 *   a usage error, so an event loop cannot recurse without bound.
 */

import type { EntityId } from "../scene/entityId.js";
import type { Disposable } from "../core/events.js";
import type { ScriptContext } from "./script.js";

/** A typed event token; create with {@link defineEvent}. */
export interface EventType<T> {
  readonly name: string;
  /** @internal Unique per definition (two definitions with the same name are different events). */
  readonly id: number;
  /** Type carrier only; never set. */
  readonly __payload?: T;
}

let nextEventId = 1;

/** Define an event and its payload type. */
export function defineEvent<T = void>(name: string): EventType<T> {
  return Object.freeze({ name, id: nextEventId++ }) as EventType<T>;
}

/** Payload type of an event token. */
export type EventPayload<E> = E extends EventType<infer T> ? T : never;

export type ScriptEventHandler<T> = (payload: T, context: ScriptContext) => void;
export type HostEventHandler<T> = (payload: T) => void;

export interface EventListenOptions {
  /** Listen on this entity's channel instead of the world channel. */
  entity?: { readonly id: EntityId } | EntityId;
  /** Remove the listener after its first delivery. */
  once?: boolean;
}

export interface EventSendOptions {
  /** Deliver on this entity's channel instead of the world channel. */
  to?: { readonly id: EntityId } | EntityId;
}

/** @internal */
export function channelOf(target: { readonly id: EntityId } | EntityId | undefined): EntityId {
  if (target === undefined) return 0 as EntityId;
  return typeof target === "number" ? target : target.id;
}

/** @internal One subscription. `owner` is the script, or null for a host listener. */
export class EventSubscription implements Disposable {
  alive = true;

  constructor(
    readonly type: EventType<unknown>,
    readonly channel: EntityId,
    readonly owner: object | null,
    readonly handler: (payload: unknown, context: ScriptContext) => void,
    readonly once: boolean,
    private readonly onDispose: (s: EventSubscription) => void,
  ) {}

  dispose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.onDispose(this);
  }
}

/** Public face of the runtime's event bus for host (non-script) code. */
export interface ScriptEvents {
  /** Subscribe a host callback (errors are caught and recorded, not isolated per script). */
  on<T>(type: EventType<T>, handler: HostEventHandler<T>, options?: EventListenOptions): Disposable;
  /** Deliver now. */
  emit<T>(type: EventType<T>, payload: T, options?: EventSendOptions): void;
  /** Queue for the start of the next script phase. */
  post<T>(type: EventType<T>, payload: T, options?: EventSendOptions): void;
  /** Live listeners on a channel (diagnostics). */
  listenerCount(type: EventType<unknown>, options?: EventListenOptions): number;
}

/**
 * @internal Subscriptions per (event, channel), the post queue and the emit depth guard. Delivery
 * itself is the runtime's (`deliver`), which wraps script listeners in hook isolation.
 */
export class EventRouter {
  private readonly channels = new Map<number, Map<EntityId, EventSubscription[]>>();
  private queue: Array<{ type: EventType<unknown>; payload: unknown; channel: EntityId }> = [];
  private depth = 0;
  private sweepPending = false;
  /** Events delivered (emit + post), for stats. */
  delivered = 0;

  constructor(
    private readonly deliver: (sub: EventSubscription, payload: unknown) => void,
    private readonly maxDepth: number,
  ) {}

  subscribe(type: EventType<unknown>, channel: EntityId, owner: object | null, handler: (payload: unknown, context: ScriptContext) => void, once: boolean): EventSubscription {
    let byChannel = this.channels.get(type.id);
    if (!byChannel) this.channels.set(type.id, (byChannel = new Map()));
    let list = byChannel.get(channel);
    if (!list) byChannel.set(channel, (list = []));
    const sub = new EventSubscription(type, channel, owner, handler, once, () => this.markDead());
    list.push(sub);
    return sub;
  }

  emit(type: EventType<unknown>, payload: unknown, channel: EntityId): void {
    if (this.depth >= this.maxDepth) {
      throw new Error(`event "${type.name}": nested emit deeper than ${this.maxDepth} (an event loop?)`);
    }
    const list = this.channels.get(type.id)?.get(channel);
    if (!list || list.length === 0) return;
    this.depth++;
    try {
      // Listeners added during this dispatch are past `n` and first hear the next one.
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const sub = list[i]!;
        if (!sub.alive) continue;
        if (sub.once) sub.dispose();
        this.delivered++;
        this.deliver(sub, payload);
      }
    } finally {
      this.depth--;
      if (this.depth === 0 && this.sweepPending) this.sweep();
    }
  }

  post(type: EventType<unknown>, payload: unknown, channel: EntityId): void {
    this.queue.push({ type, payload, channel });
  }

  /** Deliver everything queued before this call, in order. */
  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    for (const e of batch) this.emit(e.type, e.payload, e.channel);
  }

  get queued(): number {
    return this.queue.length;
  }

  count(type: EventType<unknown>, channel: EntityId): number {
    let n = 0;
    for (const s of this.channels.get(type.id)?.get(channel) ?? []) if (s.alive) n++;
    return n;
  }

  /** Drop an entity's channels (the entity is gone). */
  dropChannel(channel: EntityId): void {
    for (const byChannel of this.channels.values()) {
      const list = byChannel.get(channel);
      if (!list) continue;
      for (const s of list) s.alive = false;
      byChannel.delete(channel);
    }
  }

  clear(): void {
    for (const byChannel of this.channels.values()) for (const list of byChannel.values()) for (const s of list) s.alive = false;
    this.channels.clear();
    this.queue = [];
  }

  private markDead(): void {
    if (this.depth > 0) this.sweepPending = true;
    else this.sweep();
  }

  /** Remove dead subscriptions (never during a dispatch, so indices stay stable). */
  private sweep(): void {
    this.sweepPending = false;
    for (const byChannel of this.channels.values()) {
      for (const [channel, list] of byChannel) {
        let w = 0;
        for (let r = 0; r < list.length; r++) if (list[r]!.alive) list[w++] = list[r]!;
        list.length = w;
        if (w === 0) byChannel.delete(channel);
      }
    }
  }
}
