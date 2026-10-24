/**
 * The Mars Orbit Explorer's real-elevation (MOLA) atlas: which size this device downloads, and the
 * loader that fetches it. Pure policy + a thin controller over the engine's `MarsHeightAtlasStreamer`;
 * the scene decides *when* (the globe waits for the base level, the ground waits for the faces under
 * the chosen site).
 *
 * Sizes (docs/MARS-TERRAIN.md "Real elevation"): `phone` 6×512² (~2 MB), `tablet` 6×1024² (~7.6 MB),
 * `desktop` = the tablet level (orbit) plus the 6×2048² faces (~28 MB total) fetched lazily, one face at
 * a time, only for the face(s) under the site the viewer lands on. `?mola=phone|tablet|desktop` forces a
 * size, `?mola=off` turns real elevation off (procedural Mars, the pre-fe-40 behaviour).
 */

import {
  MarsHeightAtlasStreamer,
  chooseMarsAtlasSize,
  createMarsAtlasIndexedDbCache,
  marsAtlasPlan,
  type MarsAtlasCache,
  type MarsAtlasSize,
  type MarsHeightAtlas,
} from "@forge/engine";

export type MarsOrbitAtlasStatus = "off" | "loading" | "ready" | "failed";

export interface MarsOrbitAtlasInfo {
  status: MarsOrbitAtlasStatus;
  /** The size chosen for this device (null when off). */
  size: MarsAtlasSize | null;
  /** Why that size: `?mola=`, or the tier/device inputs. */
  reason: string;
  /** Finest resolution (nodes per face edge) loaded anywhere, 0 when none. */
  resolution: number;
  facesBase: number;
  facesDetail: number;
  /** Bytes fetched over the network / face files served from IndexedDB. */
  bytesDownloaded: number;
  cacheHits: number;
  error: string | null;
}

export interface MarsOrbitAtlasOptions {
  /** `?mola=` value: `off`, a size, or anything else / null for automatic. */
  mola?: string | null;
  tier: "low" | "medium" | "high";
  /** Directory URL holding `manifest.json` (default `<BASE_URL>mars/mola/`). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** `null` = no cache; `undefined` = IndexedDB when available. */
  cache?: MarsAtlasCache | null;
  /** Override device detection (tests). */
  device?: { phone?: boolean; mobile?: boolean; deviceMemoryGB?: number };
}

export interface MarsOrbitAtlasController {
  readonly info: MarsOrbitAtlasInfo;
  /** The atlas (null when off or failed). Faces appear as they load. */
  readonly atlas: MarsHeightAtlas | null;
  /** Resolves once the base level is loaded (or the load failed / is off): never rejects. */
  readonly ready: Promise<void>;
  /** True when every face the ground around `dir` needs is already loaded at the finest level. */
  groundReady(dir: { x: number; y: number; z: number }, radiusRad: number): boolean;
  /** Load the finest-level faces around a site (a no-op for `phone`/`tablet`); never rejects. */
  loadGround(dir: { x: number; y: number; z: number }, radiusRad: number): Promise<void>;
  dispose(): void;
}

/** Device facts for {@link chooseMarsAtlasSize} from the browser (all optional / tolerant of non-browsers). */
export function detectMolaDevice(): { phone: boolean; mobile: boolean; deviceMemoryGB?: number } {
  const g = globalThis as {
    navigator?: { userAgent?: string; maxTouchPoints?: number; deviceMemory?: number; platform?: string };
    screen?: { width?: number; height?: number };
  };
  const nav = g.navigator;
  const ua = nav?.userAgent ?? "";
  const touch = (nav?.maxTouchPoints ?? 0) > 1;
  // iPadOS reports a Mac UA; a Mac with multi-touch is an iPad.
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch);
  const phoneUa = /iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua);
  const mobile = phoneUa || ipad || /Android|Mobile/.test(ua);
  const short = Math.min(g.screen?.width ?? 1e5, g.screen?.height ?? 1e5);
  const phone = phoneUa || (mobile && !ipad && short < 600);
  const out: { phone: boolean; mobile: boolean; deviceMemoryGB?: number } = { phone, mobile };
  if (typeof nav?.deviceMemory === "number" && nav.deviceMemory > 0) out.deviceMemoryGB = nav.deviceMemory;
  return out;
}

function defaultBaseUrl(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}mars/mola/`;
}

export function createMarsOrbitAtlas(options: MarsOrbitAtlasOptions): MarsOrbitAtlasController {
  const info: MarsOrbitAtlasInfo = {
    status: "off",
    size: null,
    reason: "",
    resolution: 0,
    facesBase: 0,
    facesDetail: 0,
    bytesDownloaded: 0,
    cacheHits: 0,
    error: null,
  };
  const mola = options.mola?.toLowerCase() ?? null;
  let streamer: MarsHeightAtlasStreamer | null = null;
  let disposed = false;
  const abort = new AbortController();

  if (mola === "off") {
    info.reason = "?mola=off";
    return {
      info,
      atlas: null,
      ready: Promise.resolve(),
      groundReady: () => true,
      loadGround: () => Promise.resolve(),
      dispose: () => undefined,
    };
  }

  const device = options.device ?? detectMolaDevice();
  const size = chooseMarsAtlasSize({ override: mola, tier: options.tier, phone: device.phone, mobile: device.mobile, deviceMemoryGB: device.deviceMemoryGB });
  const plan = marsAtlasPlan(size);
  info.size = size;
  info.status = "loading";
  info.reason =
    mola === size
      ? `?mola=${size}`
      : `tier ${options.tier}${device.phone ? ", phone" : device.mobile ? ", mobile" : ""}${device.deviceMemoryGB !== undefined ? `, ${device.deviceMemoryGB} GB` : ""}`;

  const refresh = (): void => {
    if (!streamer) return;
    const s = streamer.streamStats;
    info.bytesDownloaded = s.bytesDownloaded;
    info.cacheHits = s.cacheHits;
    info.resolution = streamer.atlas.resolutions[0] ?? 0;
    info.facesBase = streamer.facesReady(plan.base).length;
    info.facesDetail = plan.detail ? streamer.facesReady(plan.detail).length : 0;
  };

  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const ready = (async () => {
    try {
      const cache = options.cache !== undefined ? options.cache : await createMarsAtlasIndexedDbCache().catch(() => null);
      if (disposed) return;
      streamer = await MarsHeightAtlasStreamer.open(baseUrl, {
        fetchImpl: options.fetchImpl,
        cache,
        signal: abort.signal,
        onFace: refresh,
      });
      if (!streamer.manifest.sizes[size]) throw new Error(`size "${size}" is not in the manifest`);
      await streamer.loadSize(plan.base);
      refresh();
      info.status = "ready";
    } catch (error) {
      info.status = "failed";
      info.error = error instanceof Error ? error.message : String(error);
      streamer = null;
    }
  })();

  return {
    info,
    get atlas() {
      return streamer?.atlas ?? null;
    },
    ready,
    groundReady(dir, radiusRad) {
      if (!streamer || !plan.detail) return true;
      const entry = streamer.manifest.sizes[plan.detail];
      if (!entry) return true;
      return streamer.atlas.facesNear(dir.x, dir.y, dir.z, radiusRad).every((f) => streamer!.atlas.hasFace(f, entry.res));
    },
    async loadGround(dir, radiusRad) {
      if (!streamer || !plan.detail) return;
      try {
        await streamer.loadNear(plan.detail, dir, radiusRad);
      } catch (error) {
        // Not fatal: the ground keeps the base level's heights.
        info.error = error instanceof Error ? error.message : String(error);
      }
      refresh();
    },
    dispose() {
      disposed = true;
      abort.abort();
    },
  };
}
