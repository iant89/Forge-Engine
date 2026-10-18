/**
 * Audio resources (Phase 20.2): decoded clips as `ResourceRegistry` entries, so audio gets what
 * every other asset has — one load per id, refcounted handles, a byte budget with LRU eviction of
 * idle clips, content-hash invalidation, cancellation and validation.
 *
 *  - {@link audioClipDescriptor}: `audio:<url>` (the first source's url), fetched and decoded with the
 *    context's `decodeAudioData`. A clip may list **alternative sources** (`{ url, type }`): those the
 *    browser says it cannot play (`canPlayType`) are skipped, and a source that fails to fetch or
 *    decode falls through to the next, so `[opus, m4a]` plays on Safari versions without Opus.
 *    `bytes` is the *decoded* size (frames × channels × 4) — a 3 MB Ogg is 40 MB of PCM, and the
 *    budget has to count what is actually resident.
 *  - {@link proceduralClipDescriptor}: `audio:procedural/<name>` for clips synthesized in code
 *    (thunder), so they are cached, budgeted and shared like files.
 *  - {@link AudioBank}: a named set of clips loaded and released together (a level's sounds), with
 *    progress and per-key lookup.
 * Validation rejects empty or channel-less output and warns on clips long enough to be streamed
 * instead (20.3). Evicting a clip never cuts a voice that is playing it: Web Audio keeps a playing
 * buffer alive; the registry only drops its cache entry.
 */

import { AssetId } from "../resources/assetId.js";
import type { ResourceDescriptor, ResourceHandle } from "../resources/registry.js";
import type { AssetDiagnostic } from "../resources/validation.js";
import type { AudioClip } from "./types.js";

export const AUDIO_RESOURCE_KIND = "audio";

/** One encoding of a clip; `type` is a MIME type with codecs, e.g. `audio/ogg; codecs=opus`. */
export interface AudioSourceCandidate {
  url: string;
  type?: string;
}

export type AudioClipSource = string | readonly AudioSourceCandidate[];

export interface AudioClipOptions {
  /** Fetch implementation. Default `globalThis.fetch`. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  init?: RequestInit;
  /** Codec probe. Default: an `<audio>` element's `canPlayType` when a DOM exists, else "maybe". */
  canPlayType?: (type: string) => "" | "maybe" | "probably";
  /** SHA-256 of the bytes when known (re-acquiring with a different hash reloads). */
  contentHash?: string;
  /** Registry idle grace before eviction (ms). */
  idleMs?: number;
  priority?: number;
  tags?: readonly string[];
  /** Seconds beyond which validation warns that the clip should stream (20.3). Default 30. */
  streamAbove?: number;
  /** Explicit id (default `audio:<first url>`). */
  id?: string;
  /** Pre-load estimate for `AssetStreamer` admission (bytes). */
  estimatedBytes?: number;
}

/** Resident bytes of a decoded buffer: frames × channels × 4 (Web Audio stores float32 PCM). */
export function decodedAudioBytes(buffer: { length: number; numberOfChannels: number }): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

export function audioClipId(source: AudioClipSource): string {
  const first = typeof source === "string" ? source : source[0]?.url;
  if (!first) throw new TypeError("audioClipId: a clip needs at least one source");
  return AssetId.forPath(AUDIO_RESOURCE_KIND, first);
}

function defaultCanPlayType(type: string): "" | "maybe" | "probably" {
  const doc = (globalThis as { document?: { createElement(tag: string): { canPlayType?(t: string): string } } }).document;
  const el = doc?.createElement("audio");
  const answer = el?.canPlayType?.(type);
  return answer === "" || answer === "maybe" || answer === "probably" ? answer : "maybe";
}

/** Order candidates: "probably" first, then "maybe" and untyped; drop the ones the browser refuses. */
export function rankAudioSources(source: AudioClipSource, canPlayType: (type: string) => "" | "maybe" | "probably" = defaultCanPlayType): AudioSourceCandidate[] {
  const list = typeof source === "string" ? [{ url: source }] : [...source];
  const scored = list.map((c, i) => ({ c, i, s: c.type ? canPlayType(c.type) : "maybe" }));
  return scored
    .filter((x) => x.s !== "")
    .sort((a, b) => (a.s === b.s ? a.i - b.i : a.s === "probably" ? -1 : b.s === "probably" ? 1 : a.i - b.i))
    .map((x) => x.c);
}

function validateClip(streamAbove: number) {
  return (clip: AudioClip): AssetDiagnostic[] => {
    const out: AssetDiagnostic[] = [];
    const b = clip.buffer;
    if (b.numberOfChannels <= 0 || b.length <= 0) out.push({ severity: "error", code: "audio.empty", message: "decoded clip has no channels or no samples" });
    if (!(b.sampleRate > 0)) out.push({ severity: "error", code: "audio.sampleRate", message: `bad sample rate ${b.sampleRate}` });
    if (clip.duration > streamAbove) out.push({ severity: "warning", code: "audio.long", message: `${clip.duration.toFixed(1)} s decoded fully (${(decodedAudioBytes(b) / 1048576).toFixed(1)} MB); stream long clips instead` });
    return out;
  };
}

function clipOf(buffer: AudioBuffer, url: string | undefined, id: string): AudioClip {
  return { buffer, url, id, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate };
}

/** A registry descriptor that fetches and decodes a clip, falling back across alternative sources. */
export function audioClipDescriptor(context: BaseAudioContext, source: AudioClipSource, options: AudioClipOptions = {}): ResourceDescriptor<AudioClip> {
  const id = options.id ?? audioClipId(source);
  const fetcher = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  return {
    id,
    kind: AUDIO_RESOURCE_KIND,
    contentHash: options.contentHash,
    idleMs: options.idleMs,
    priority: options.priority,
    tags: options.tags,
    estimatedBytes: options.estimatedBytes,
    bytes: (clip) => decodedAudioBytes(clip.buffer),
    validate: validateClip(options.streamAbove ?? 30),
    async load(ctx) {
      const candidates = rankAudioSources(source, options.canPlayType);
      if (candidates.length === 0) throw new Error(`${id}: no playable source (every type was refused by canPlayType)`);
      const errors: string[] = [];
      for (const c of candidates) {
        if (ctx.signal.aborted) break;
        try {
          const response = await fetcher(c.url, options.init);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.arrayBuffer();
          if (ctx.signal.aborted) break;
          ctx.progress(0.5, `decoding ${c.url}`);
          const buffer = await context.decodeAudioData(data.slice(0));
          return clipOf(buffer, c.url, id);
        } catch (error) {
          errors.push(`${c.url}: ${error instanceof Error ? error.message : String(error)}`);
          ctx.logger?.warn(`audio ${id}: ${c.url} failed, trying the next source`);
        }
      }
      if (ctx.signal.aborted) throw new Error(`${id}: cancelled`);
      throw new Error(`${id}: every source failed (${errors.join("; ")})`);
    },
  };
}

/** A registry descriptor for a clip built in code (`build` runs once per load). */
export function proceduralClipDescriptor(name: string, build: () => AudioBuffer, options: Pick<AudioClipOptions, "idleMs" | "priority" | "tags" | "streamAbove"> = {}): ResourceDescriptor<AudioClip> {
  const id = AssetId.forPath(AUDIO_RESOURCE_KIND, `procedural/${name}`);
  return {
    id,
    kind: AUDIO_RESOURCE_KIND,
    idleMs: options.idleMs,
    priority: options.priority,
    tags: options.tags,
    bytes: (clip) => decodedAudioBytes(clip.buffer),
    validate: validateClip(options.streamAbove ?? 30),
    load: () => clipOf(build(), undefined, id),
  };
}

/** Anything that hands out clip handles: `AudioSystem` does. */
export interface AudioClipProvider {
  acquire(source: AudioClipSource | ResourceDescriptor<AudioClip>, options?: AudioClipOptions): ResourceHandle<AudioClip>;
}

/**
 * A named set of clips loaded and released together. `load()` resolves when every clip is ready
 * (rejecting with the first failure); `get(key)` returns a ready clip or null; `release()` drops
 * every handle, leaving the clips to the registry's idle eviction.
 */
export class AudioBank<K extends string = string> {
  private readonly handles = new Map<K, ResourceHandle<AudioClip>>();
  private released = false;

  constructor(readonly name: string, provider: AudioClipProvider, clips: Readonly<Record<K, AudioClipSource | ResourceDescriptor<AudioClip>>>, options: AudioClipOptions = {}) {
    for (const key of Object.keys(clips) as K[]) {
      this.handles.set(key, provider.acquire(clips[key], { ...options, tags: [...(options.tags ?? []), `bank:${name}`] }));
    }
  }

  get keys(): K[] {
    return [...this.handles.keys()];
  }

  /** 0..1: the fraction of clips ready. */
  get progress(): number {
    if (this.handles.size === 0) return 1;
    let ready = 0;
    for (const h of this.handles.values()) if (h.ready) ready++;
    return ready / this.handles.size;
  }

  get ready(): boolean {
    return this.progress === 1;
  }

  /** Keys whose load failed. */
  get failed(): K[] {
    return [...this.handles].filter(([, h]) => h.state === "failed").map(([k]) => k);
  }

  async load(): Promise<this> {
    await Promise.all([...this.handles.values()].map((h) => h.wait()));
    return this;
  }

  get(key: K): AudioClip | null {
    if (this.released) return null;
    return this.handles.get(key)?.currentValue ?? null;
  }

  /** Pin every clip against budget eviction (UI sounds that must never reload). */
  pin(): this {
    for (const h of this.handles.values()) h.pin();
    return this;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const h of this.handles.values()) {
      h.unpin();
      h.release();
    }
    this.handles.clear();
  }
}

