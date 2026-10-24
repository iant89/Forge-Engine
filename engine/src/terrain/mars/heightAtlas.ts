/**
 * Real Mars elevation on the port's cube sphere: a baked **height atlas** and the code that reads it.
 *
 * The atlas is the USGS/NASA MOLA global DEM (MGS MOLA, 463 m/px, metres above the MOLA areoid)
 * resampled — offline, by `tools/bake-mola-atlas.mjs`, never in CI or in the browser — onto exactly the
 * grid `cubeSphere.ts` defines: six faces, spherified-cube warp, `(u, v)` in `[-1, 1]`, face order
 * `+X −X +Y −Y +Z −Z`. Each face is a `res × res` **node-registered** grid (node `i` sits at
 * `u = -1 + 2i/(res-1)`, the same convention `MarsGlobalFieldSet` uses), so the nodes on a shared cube
 * edge are the *same points* on the sphere and carry the same value: the six faces join with no seam.
 * Each stored face carries a one-texel **apron** (`res + 2` per side) baked from the real data at the
 * extended chart, which is what lets bicubic filtering run right up to a face edge with no cross-face
 * lookup.
 *
 * Lat/lon follow `marsLatLonToDirection` (`lon = atan2(z, x)`, east-positive, `y` = north pole), the
 * same labelling the MOLA GeoTIFF uses, so Olympus Mons (18.65°N, 226.2°E) is where the real one is.
 *
 * Three sizes exist so a phone never downloads what a desktop wants (`phone` 512², `tablet` 1024²,
 * `desktop` 2048² per face). Values are 16-bit quantised between the manifest's `minM`/`maxM` and the
 * face files are `gzip(delta-predicted planar uint16)`; {@link decodeMarsAtlasFace} reverses that with
 * the platform's `DecompressionStream`.
 *
 * Browser-first like the rest of the terrain port: nothing here touches the filesystem. A Node tool
 * passes the same bytes in through {@link MarsHeightAtlas.addFace}.
 */

import { UsageError } from "../../core/errors.js";
import {
  MARS_FACE_COUNT,
  marsDirectionToFaceUVExact,
  marsFaceUVToDirection,
  type MarsFaceUV,
} from "./cubeSphere.js";

/** The three baked sizes, smallest first. */
export const MARS_ATLAS_SIZES = ["phone", "tablet", "desktop"] as const;
export type MarsAtlasSize = (typeof MARS_ATLAS_SIZES)[number];

/** The manifest's `format` field. */
export const MARS_ATLAS_FORMAT = "forge-mars-height-atlas";

/** One face file in the manifest. */
export interface MarsAtlasFaceEntry {
  /** Path relative to the manifest. */
  file: string;
  /** File size in bytes (gzip-compressed). */
  bytes: number;
  /** Lower-case hex SHA-256 of the file; also the IndexedDB cache key. */
  sha256: string;
}

export interface MarsAtlasSizeEntry {
  /** Nodes per face edge (not counting the apron). */
  res: number;
  /** Texels per stored face edge (`res + 2 * apron`). */
  stored: number;
  /** Approximate node spacing at a face centre, metres. */
  nodeSpacingM: number;
  /** Six faces, in face order. */
  faces: MarsAtlasFaceEntry[];
  /** Sum of the face files' bytes. */
  totalBytes: number;
}

export interface MarsAtlasManifest {
  format: typeof MARS_ATLAS_FORMAT;
  version: number;
  source: { name: string; resolutionM: number; datum: string; [key: string]: unknown };
  /** Quantisation range: stored `q` (0..65535) → `minM + q / 65535 * (maxM - minM)` metres. */
  range: { minM: number; maxM: number };
  /** Number of apron texels around each face (1). */
  apron: number;
  /** `"gzip-grad16"`: gzip of the gradient-predicted, byte-planar uint16 face. */
  encoding: string;
  sizes: Partial<Record<MarsAtlasSize, MarsAtlasSizeEntry>>;
}

/** Validate and normalise a manifest parsed from JSON. Throws {@link UsageError} on anything off. */
export function parseMarsAtlasManifest(json: unknown): MarsAtlasManifest {
  const m = json as Partial<MarsAtlasManifest> | null;
  if (!m || typeof m !== "object" || m.format !== MARS_ATLAS_FORMAT) {
    throw new UsageError(`Mars height atlas: manifest.format must be "${MARS_ATLAS_FORMAT}"`);
  }
  if (m.version !== 1) throw new UsageError(`Mars height atlas: unsupported manifest version ${String(m.version)}`);
  if (m.encoding !== "gzip-grad16") throw new UsageError(`Mars height atlas: unsupported encoding ${String(m.encoding)}`);
  const range = m.range;
  if (!range || !(range.maxM > range.minM) || !Number.isFinite(range.minM) || !Number.isFinite(range.maxM)) {
    throw new UsageError("Mars height atlas: manifest.range needs finite minM < maxM");
  }
  if (m.apron !== 1) throw new UsageError(`Mars height atlas: unsupported apron ${String(m.apron)}`);
  if (!m.sizes || typeof m.sizes !== "object") throw new UsageError("Mars height atlas: manifest.sizes missing");
  for (const name of MARS_ATLAS_SIZES) {
    const s = m.sizes[name];
    if (!s) continue;
    if (!Number.isInteger(s.res) || s.res < 8 || s.res > 8192 || s.stored !== s.res + 2 * m.apron) {
      throw new UsageError(`Mars height atlas: size "${name}" has an invalid res/stored`);
    }
    if (!Array.isArray(s.faces) || s.faces.length !== MARS_FACE_COUNT) {
      throw new UsageError(`Mars height atlas: size "${name}" needs ${MARS_FACE_COUNT} faces`);
    }
  }
  return m as MarsAtlasManifest;
}

// ------------------------------------------------------------------------------------- codec

const clampI = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * Predict-and-split filter applied before gzip (the baker's side): each texel becomes the difference
 * from the "gradient" predictor `left + up - upLeft` (first row: left; first column: up), mod 65536,
 * and the result is stored byte-planar (all low bytes, then all high bytes). Smooth terrain turns into
 * a field of near-zero residuals that deflate shrinks ~2–3× better than the raw words.
 */
export function marsAtlasFilter(q: Uint16Array, stored: number): Uint8Array {
  const count = stored * stored;
  if (q.length < count) throw new UsageError(`marsAtlasFilter: expected ${count} texels, got ${q.length}`);
  const out = new Uint8Array(count * 2);
  for (let y = 0; y < stored; y++) {
    for (let x = 0; x < stored; x++) {
      const i = y * stored + x;
      let pred: number;
      if (y === 0) pred = x === 0 ? 0 : q[i - 1]!;
      else if (x === 0) pred = q[i - stored]!;
      else pred = q[i - 1]! + q[i - stored]! - q[i - stored - 1]!;
      const d = (q[i]! - pred) & 0xffff;
      out[i] = d & 0xff;
      out[count + i] = d >> 8;
    }
  }
  return out;
}

/** Inverse of {@link marsAtlasFilter}. */
export function marsAtlasUnfilter(bytes: Uint8Array, stored: number): Uint16Array {
  const count = stored * stored;
  if (bytes.length < count * 2) {
    throw new UsageError(`marsAtlasUnfilter: expected ${count * 2} bytes, got ${bytes.length}`);
  }
  const q = new Uint16Array(count);
  for (let y = 0; y < stored; y++) {
    for (let x = 0; x < stored; x++) {
      const i = y * stored + x;
      let pred: number;
      if (y === 0) pred = x === 0 ? 0 : q[i - 1]!;
      else if (x === 0) pred = q[i - stored]!;
      else pred = q[i - 1]! + q[i - stored]! - q[i - stored - 1]!;
      q[i] = (pred + (bytes[i]! | (bytes[count + i]! << 8))) & 0xffff;
    }
  }
  return q;
}

/** Quantise metres to the atlas's 16-bit code (clamped to the range). */
export function marsAtlasQuantize(metres: number, minM: number, maxM: number): number {
  return clampI(Math.round(((metres - minM) / (maxM - minM)) * 65535), 0, 65535);
}

/** gunzip with the platform's `DecompressionStream` (Chromium, Safari 16.4+, Firefox 113+, Node 18+). */
export async function marsAtlasGunzip(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!Ctor) throw new UsageError("Mars height atlas: this browser has no DecompressionStream (Safari < 16.4); falling back to procedural terrain");
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([view as BlobPart]).stream().pipeThrough(new Ctor("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gzip'd face file → its `stored × stored` quantised texels. */
export async function decodeMarsAtlasFace(bytes: ArrayBuffer | Uint8Array, stored: number): Promise<Uint16Array> {
  return marsAtlasUnfilter(await marsAtlasGunzip(bytes), stored);
}

// ---------------------------------------------------------------------------------- the atlas

interface AtlasLevel {
  res: number;
  stored: number;
  faces: (Uint16Array | undefined)[];
}

export type MarsAtlasFilter = "bilinear" | "bicubic";

/**
 * Real-Mars elevations by direction.
 *
 * Holds up to one {@link addFace}d level per resolution; a sample uses the **finest level that has the
 * face under the direction**, so a coarse global level (all six faces) can sit under a finer level that
 * is only loaded where the camera is. Nothing is interpolated *between* levels — near a face edge where
 * only one side has the fine level the values differ by that level's resampling error (metres to a few
 * tens of metres), which {@link facesNear} lets a caller avoid by loading the neighbours too.
 */
export class MarsHeightAtlas {
  readonly minM: number;
  readonly maxM: number;
  private readonly scale: number;
  /** Levels, finest first. */
  private levels: AtlasLevel[] = [];
  private readonly scratchUV: MarsFaceUV = { face: 0, u: 0, v: 0 };

  constructor(range: { minM: number; maxM: number }) {
    if (!(range.maxM > range.minM)) throw new UsageError("MarsHeightAtlas: range needs minM < maxM");
    this.minM = range.minM;
    this.maxM = range.maxM;
    this.scale = (range.maxM - range.minM) / 65535;
  }

  /** Register one decoded face (`(res + 2)²` texels, apron included) of the level with `res` nodes per edge. */
  addFace(res: number, face: number, texels: Uint16Array): void {
    if (!Number.isInteger(face) || face < 0 || face >= MARS_FACE_COUNT) throw new UsageError(`MarsHeightAtlas.addFace: bad face ${face}`);
    const stored = res + 2;
    if (!Number.isInteger(res) || res < 4 || texels.length < stored * stored) {
      throw new UsageError(`MarsHeightAtlas.addFace: res ${res} needs ${stored * stored} texels, got ${texels.length}`);
    }
    let level = this.levels.find((l) => l.res === res);
    if (!level) {
      level = { res, stored, faces: new Array<Uint16Array | undefined>(MARS_FACE_COUNT).fill(undefined) };
      this.levels.push(level);
      this.levels.sort((a, b) => b.res - a.res);
    }
    level.faces[face] = texels;
  }

  /** Resolutions (nodes per face edge) that have at least one face, finest first. */
  get resolutions(): number[] {
    return this.levels.map((l) => l.res);
  }

  /** Faces held at `res` (default: any level), ascending. */
  facesLoaded(res?: number): number[] {
    const out: number[] = [];
    for (let f = 0; f < MARS_FACE_COUNT; f++) {
      if (this.levels.some((l) => (res === undefined || l.res === res) && l.faces[f])) out.push(f);
    }
    return out;
  }

  hasFace(face: number, res?: number): boolean {
    return this.levels.some((l) => (res === undefined || l.res === res) && !!l.faces[face]);
  }

  /** True when every face has data at some level. */
  get complete(): boolean {
    return this.facesLoaded().length === MARS_FACE_COUNT;
  }

  /** Bytes of texel data held. */
  get bytes(): number {
    let total = 0;
    for (const l of this.levels) for (const f of l.faces) if (f) total += f.byteLength;
    return total;
  }

  /** Finest resolution available for the face under a direction, or 0 when that face is not loaded. */
  resolutionAt(dx: number, dy: number, dz: number): number {
    const uv = marsDirectionToFaceUVExact({ x: dx, y: dy, z: dz }, undefined, this.scratchUV);
    for (const l of this.levels) if (l.faces[uv.face]) return l.res;
    return 0;
  }

  /**
   * Elevation in metres (above the MOLA datum) at a unit direction, or `NaN` when the direction's face
   * is not loaded. `bicubic` (Catmull–Rom, the default) keeps slopes continuous across texels, which
   * the ground terrain needs for lighting; `bilinear` is the cheap one for coarse previews.
   */
  sample(dx: number, dy: number, dz: number, filter: MarsAtlasFilter = "bicubic", maxRes = Infinity): number {
    const uv = marsDirectionToFaceUVExact({ x: dx, y: dy, z: dz }, undefined, this.scratchUV);
    let level: AtlasLevel | undefined;
    for (const l of this.levels) {
      if (l.res <= maxRes && l.faces[uv.face]) {
        level = l;
        break;
      }
    }
    if (!level) return Number.NaN;
    return this.readLevel(level, uv.face, uv.u, uv.v, filter);
  }

  /** Elevation at a face-local `(u, v)` of a specific level (the apron makes `|u|, |v|` slightly above 1 valid). */
  sampleFaceUV(face: number, u: number, v: number, res: number, filter: MarsAtlasFilter = "bicubic"): number {
    const level = this.levels.find((l) => l.res === res);
    if (!level?.faces[face]) return Number.NaN;
    return this.readLevel(level, face, u, v, filter);
  }

  private readLevel(level: AtlasLevel, face: number, u: number, v: number, filter: MarsAtlasFilter): number {
    const data = level.faces[face]!;
    const res = level.res;
    const n = level.stored;
    const fx = ((u + 1) / 2) * (res - 1);
    const fy = ((v + 1) / 2) * (res - 1);
    const x0 = clampI(Math.floor(fx), 0, res - 2);
    const y0 = clampI(Math.floor(fy), 0, res - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    // Texel (node i, node j) lives at stored index (j + 1) * n + (i + 1).
    const base = (y0 + 1) * n + (x0 + 1);
    let q: number;
    if (filter === "bilinear") {
      const a = data[base]!;
      const b = data[base + 1]!;
      const c = data[base + n]!;
      const d = data[base + n + 1]!;
      q = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    } else {
      // Catmull–Rom weights per axis.
      const tx2 = tx * tx;
      const tx3 = tx2 * tx;
      const ty2 = ty * ty;
      const ty3 = ty2 * ty;
      const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx;
      const wx1 = 1.5 * tx3 - 2.5 * tx2 + 1;
      const wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx;
      const wx3 = 0.5 * tx3 - 0.5 * tx2;
      const wy0 = -0.5 * ty3 + ty2 - 0.5 * ty;
      const wy1 = 1.5 * ty3 - 2.5 * ty2 + 1;
      const wy2 = -1.5 * ty3 + 2 * ty2 + 0.5 * ty;
      const wy3 = 0.5 * ty3 - 0.5 * ty2;
      const r0 = base - n - 1;
      const row = (o: number): number => data[o]! * wx0 + data[o + 1]! * wx1 + data[o + 2]! * wx2 + data[o + 3]! * wx3;
      q = row(r0) * wy0 + row(r0 + n) * wy1 + row(r0 + 2 * n) * wy2 + row(r0 + 3 * n) * wy3;
    }
    return this.minM + q * this.scale;
  }

  /**
   * Faces whose chart a disc of angular radius `radiusRad` around a direction can touch, the
   * direction's own face first. A caller about to read terrain within `radiusRad` of a site loads
   * exactly these so no sample falls on an unloaded (or coarser) neighbour.
   */
  facesNear(dx: number, dy: number, dz: number, radiusRad: number): number[] {
    const len = Math.hypot(dx, dy, dz) || 1;
    const c = { x: dx / len, y: dy / len, z: dz / len };
    const own = marsDirectionToFaceUVExact(c).face;
    const faces = [own];
    // Two tangents.
    const ref = Math.abs(c.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    let t1 = { x: c.y * ref.z - c.z * ref.y, y: c.z * ref.x - c.x * ref.z, z: c.x * ref.y - c.y * ref.x };
    const l1 = Math.hypot(t1.x, t1.y, t1.z);
    t1 = { x: t1.x / l1, y: t1.y / l1, z: t1.z / l1 };
    const t2 = { x: c.y * t1.z - c.z * t1.y, y: c.z * t1.x - c.x * t1.z, z: c.x * t1.y - c.y * t1.x };
    const cr = Math.cos(radiusRad);
    const sr = Math.sin(radiusRad);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const p = {
        x: c.x * cr + (t1.x * ca + t2.x * sa) * sr,
        y: c.y * cr + (t1.y * ca + t2.y * sa) * sr,
        z: c.z * cr + (t1.z * ca + t2.z * sa) * sr,
      };
      const f = marsDirectionToFaceUVExact(p).face;
      if (!faces.includes(f)) faces.push(f);
    }
    return faces;
  }
}

/**
 * Bake-side helper: the unit direction of stored texel `(i, j)` (`0..res+1`, the apron at `0` and
 * `res + 1`) of a face — what the baker evaluates MOLA at, and what a test compares reads against.
 */
export function marsAtlasTexelDirection(face: number, res: number, i: number, j: number): { x: number; y: number; z: number } {
  const u = -1 + (2 * (i - 1)) / (res - 1);
  const v = -1 + (2 * (j - 1)) / (res - 1);
  return marsFaceUVToDirection(face, u, v);
}

// --------------------------------------------------------------------------- size selection

export interface MarsAtlasSizeInputs {
  /** `?mola=phone|tablet|desktop` — wins over everything. Anything else is ignored. */
  override?: string | null;
  /** The demo's device tier (`?tier=` or `classifyDeviceTier`). */
  tier?: "low" | "medium" | "high";
  /** A phone-class device (mobile UA with a small screen). */
  phone?: boolean;
  /** A tablet-class or other touch/mobile device. */
  mobile?: boolean;
  /** `navigator.deviceMemory` (GB), when the browser reports it. */
  deviceMemoryGB?: number;
}

/** True for a valid size name. */
export function isMarsAtlasSize(value: unknown): value is MarsAtlasSize {
  return typeof value === "string" && (MARS_ATLAS_SIZES as readonly string[]).includes(value);
}

/**
 * Which atlas size a device should download: `?mola=` if given; otherwise the smaller of what the
 * tier allows (`low` phone, `medium` tablet, `high` desktop) and what the device can hold (a phone-class
 * device: `phone`; any other mobile/touch device: at most `tablet`; ≤ 2 GB of memory: `phone`; ≤ 4 GB:
 * at most `tablet`).
 */
export function chooseMarsAtlasSize(inputs: MarsAtlasSizeInputs): MarsAtlasSize {
  if (isMarsAtlasSize(inputs.override)) return inputs.override;
  const rank = (s: MarsAtlasSize): number => MARS_ATLAS_SIZES.indexOf(s);
  let size: MarsAtlasSize = inputs.tier === "low" ? "phone" : inputs.tier === "medium" ? "tablet" : "desktop";
  const cap = (limit: MarsAtlasSize): void => {
    if (rank(size) > rank(limit)) size = limit;
  };
  if (inputs.phone) cap("phone");
  else if (inputs.mobile) cap("tablet");
  if (inputs.deviceMemoryGB !== undefined) {
    if (inputs.deviceMemoryGB <= 2) cap("phone");
    else if (inputs.deviceMemoryGB <= 4) cap("tablet");
  }
  return size;
}

/**
 * What a size needs on the wire: `base` is loaded whole (all six faces — the orbit globe reads the
 * whole planet), and `detail`, when present, is a finer level fetched per face only where the viewer
 * lands. The desktop atlas is `tablet` + lazy `desktop` faces: the 2048² faces are ~2.6 km/texel, far
 * finer than a 1° globe needs, so loading all six of them just to draw an orbit view would be wasted.
 */
export function marsAtlasPlan(size: MarsAtlasSize): { base: MarsAtlasSize; detail: MarsAtlasSize | null } {
  return size === "desktop" ? { base: "tablet", detail: "desktop" } : { base: size, detail: null };
}

// ----------------------------------------------------------------------------- IndexedDB cache

/** A byte cache for face files, keyed by the file's SHA-256 (so a re-bake can never serve stale data). */
export interface MarsAtlasCache {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
}

/**
 * An IndexedDB-backed {@link MarsAtlasCache}, or `null` when IndexedDB is unavailable or refuses to
 * open (private mode, blocked storage). Failures after open are swallowed: a cache miss only costs a
 * download.
 */
export async function createMarsAtlasIndexedDbCache(dbName = "forge-mars-height-atlas"): Promise<MarsAtlasCache | null> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("faces");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (!db) return null;
  return {
    get: (key) =>
      new Promise((resolve) => {
        try {
          const req = db.transaction("faces", "readonly").objectStore("faces").get(key);
          req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
    put: (key, bytes) =>
      new Promise((resolve) => {
        try {
          const tx = db.transaction("faces", "readwrite");
          tx.objectStore("faces").put(bytes, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      }),
  };
}

// ----------------------------------------------------------------------------------- streamer

export interface MarsAtlasStreamerOptions {
  fetchImpl?: typeof fetch;
  cache?: MarsAtlasCache | null;
  signal?: AbortSignal;
  /** Called after every face finishes (downloaded or from cache). */
  onFace?: (info: { size: MarsAtlasSize; face: number; bytes: number; fromCache: boolean }) => void;
}

export interface MarsAtlasStreamStats {
  /** Face files fetched over the network / served from the cache. */
  downloaded: number;
  cacheHits: number;
  /** Bytes over the network (compressed). */
  bytesDownloaded: number;
  /** Sizes that have at least one face loaded. */
  sizes: MarsAtlasSize[];
}

/**
 * Loads a manifest's face files into a {@link MarsHeightAtlas}: whole sizes or single faces, each file
 * at most once (concurrent requests share one promise), through an optional {@link MarsAtlasCache}.
 */
export class MarsHeightAtlasStreamer {
  readonly atlas: MarsHeightAtlas;
  readonly manifest: MarsAtlasManifest;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: MarsAtlasCache | null;
  private readonly signal: AbortSignal | undefined;
  private readonly onFace: MarsAtlasStreamerOptions["onFace"];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly done = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly stats: MarsAtlasStreamStats = { downloaded: 0, cacheHits: 0, bytesDownloaded: 0, sizes: [] };

  constructor(manifest: MarsAtlasManifest, baseUrl: string, options: MarsAtlasStreamerOptions = {}) {
    this.manifest = manifest;
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.cache = options.cache ?? null;
    this.signal = options.signal;
    this.onFace = options.onFace;
    this.atlas = new MarsHeightAtlas(manifest.range);
  }

  /** Fetch + parse `<baseUrl>/manifest.json` and build a streamer for it. */
  static async open(baseUrl: string, options: MarsAtlasStreamerOptions = {}): Promise<MarsHeightAtlasStreamer> {
    const dir = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const f = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const response = await f(`${dir}manifest.json`, { signal: options.signal });
    if (!response.ok) throw new UsageError(`Mars height atlas: GET ${dir}manifest.json failed with ${response.status}`);
    return new MarsHeightAtlasStreamer(parseMarsAtlasManifest(await response.json()), dir, options);
  }

  get streamStats(): MarsAtlasStreamStats {
    return { ...this.stats, sizes: [...this.stats.sizes] };
  }

  /** Faces of `size` already decoded into the atlas. */
  facesReady(size: MarsAtlasSize): number[] {
    const entry = this.manifest.sizes[size];
    return entry ? this.atlas.facesLoaded(entry.res) : [];
  }

  /** Whole-size load (every face). Resolves when all are in; rejects with the first failure. */
  loadSize(size: MarsAtlasSize): Promise<void> {
    return this.loadFaces(size, [0, 1, 2, 3, 4, 5]);
  }

  /** Load specific faces of a size. */
  async loadFaces(size: MarsAtlasSize, faces: readonly number[]): Promise<void> {
    await Promise.all(faces.map((f) => this.loadFace(size, f)));
  }

  /** Load the faces a disc around a direction touches (see {@link MarsHeightAtlas.facesNear}). */
  loadNear(size: MarsAtlasSize, dir: { x: number; y: number; z: number }, radiusRad: number): Promise<void> {
    return this.loadFaces(size, this.atlas.facesNear(dir.x, dir.y, dir.z, radiusRad));
  }

  /** The error message of a face that failed, for HUDs. */
  failure(size: MarsAtlasSize, face: number): string | undefined {
    return this.failed.get(`${size}/${face}`);
  }

  loadFace(size: MarsAtlasSize, face: number): Promise<void> {
    const key = `${size}/${face}`;
    if (this.done.has(key)) return Promise.resolve();
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const entry = this.manifest.sizes[size];
    if (!entry) return Promise.reject(new UsageError(`Mars height atlas: size "${size}" is not in the manifest`));
    const file = entry.faces[face];
    if (!file) return Promise.reject(new UsageError(`Mars height atlas: size "${size}" has no face ${face}`));
    const task = (async () => {
      let bytes: ArrayBuffer | undefined;
      let fromCache = false;
      if (this.cache) {
        bytes = await this.cache.get(file.sha256).catch(() => undefined);
        if (bytes && bytes.byteLength === file.bytes) fromCache = true;
        else bytes = undefined;
      }
      if (!bytes) {
        const response = await this.fetchImpl(`${this.baseUrl}${file.file}`, { signal: this.signal });
        if (!response.ok) throw new UsageError(`Mars height atlas: GET ${file.file} failed with ${response.status}`);
        bytes = await response.arrayBuffer();
        if (bytes.byteLength !== file.bytes) {
          throw new UsageError(`Mars height atlas: ${file.file} is ${bytes.byteLength} bytes, the manifest says ${file.bytes}`);
        }
      }
      let texels: Uint16Array;
      try {
        texels = await decodeMarsAtlasFace(bytes, entry.stored);
      } catch (error) {
        // A corrupt cache entry must not poison later runs: only cache after a successful decode.
        throw error instanceof Error ? error : new UsageError(String(error));
      }
      if (!fromCache && this.cache) void this.cache.put(file.sha256, bytes).catch(() => undefined);
      this.atlas.addFace(entry.res, face, texels);
      this.done.add(key);
      if (fromCache) this.stats.cacheHits++;
      else {
        this.stats.downloaded++;
        this.stats.bytesDownloaded += bytes.byteLength;
      }
      if (!this.stats.sizes.includes(size)) this.stats.sizes.push(size);
      this.onFace?.({ size, face, bytes: bytes.byteLength, fromCache });
    })()
      .catch((error: unknown) => {
        this.failed.set(key, error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }
}
