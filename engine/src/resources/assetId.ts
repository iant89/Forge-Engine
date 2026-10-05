/**
 * `AssetId` — stable, structured resource identity (Phase 15.1).
 *
 * Before this, a resource id was "just a string" chosen by its loader, which has two failure
 * modes in a growing asset pipeline:
 *
 *  - **Rename/relocation sensitivity.** `texture:assets/rocks.png` dies when the file moves, and
 *    two names for the same bytes load two GPU copies.
 *  - **Stale-cache blindness.** Editing a file in place keeps its id, so the registry happily
 *    serves the old bytes forever (the `contentHash` check in `ResourceRegistry.acquire` is what
 *    fixes that half, and needs a canonical id format to compare against).
 *
 * The canonical form is `<kind>:<address>`:
 *
 *  - `texture:assets/rocks.png` — *path-addressed*: stable as long as the asset's location is.
 *  - `texture:c/9f86d081…~rocks.png` — *content-addressed*: `c/` + the full 64-hex SHA-256 of the
 *    bytes, with an optional `~display-name` for humans. Two loaders that see the same bytes get
 *    the same id, wherever the bytes came from.
 *
 * `parse` returns `null` for ids that do not follow the form (including the legacy bare ids
 * early tests and the chunk pool use, e.g. `"x"`); those remain legal registry keys, they just
 * carry no metadata. `forPath`/`forContent` validate their arguments and throw `UsageError`, so a
 * malformed id is a loud error at construction instead of a silent "two different ids" bug later.
 *
 * `hashContent` is the pipeline's one hasher: SHA-256 via WebCrypto (browser secure contexts and
 * Node ≥ 19). It is async by nature; the registry's loads are async too, so nothing here ever
 * blocks a frame.
 */

import { UsageError } from "../core/errors.js";

export interface AssetIdInfo {
  kind: string;
  address: "path" | "content";
  /** Path-addressed only. */
  path?: string;
  /** Content-addressed only: full 64-hex lowercase SHA-256. */
  hash?: string;
  /** Content-addressed only: optional human name. */
  name?: string;
}

const KIND_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export const AssetId = {
  /** Path-addressed id: `texture:assets/rocks.png`, `chunk:3,-1,2`. */
  forPath(kind: string, path: string): string {
    if (!KIND_RE.test(kind)) throw new UsageError(`AssetId.forPath: bad kind "${kind}" (expected letters, digits, _ or -, starting with a letter)`);
    if (path.length === 0) throw new UsageError("AssetId.forPath: path must be non-empty");
    return `${kind}:${path}`;
  },

  /** Content-addressed id: `texture:c/<sha256 hex>[~name]`. The hash is normalized to lowercase. */
  forContent(kind: string, hashHex: string, name?: string): string {
    if (!KIND_RE.test(kind)) throw new UsageError(`AssetId.forContent: bad kind "${kind}"`);
    const hash = hashHex.toLowerCase();
    if (!HASH_RE.test(hash)) {
      throw new UsageError(`AssetId.forContent: hash must be 64 lowercase hex chars (got ${hashHex.length} chars)`);
    }
    if (name !== undefined && name.length === 0) throw new UsageError("AssetId.forContent: name must be non-empty when given");
    return name === undefined ? `${kind}:c/${hash}` : `${kind}:c/${hash}~${name}`;
  },

  /**
   * Parse a canonical id. Returns `null` (never throws) for anything outside the form —
   * including legacy bare ids, which the registry still accepts as opaque keys.
   */
  parse(id: string): AssetIdInfo | null {
    if (typeof id !== "string" || id.length === 0) return null;
    const sep = id.indexOf(":");
    if (sep <= 0) return null;
    const kind = id.slice(0, sep);
    if (!KIND_RE.test(kind)) return null;
    const address = id.slice(sep + 1);
    if (address.startsWith("c/")) {
      const rest = address.slice(2);
      const tilde = rest.indexOf("~");
      const hashPart = tilde >= 0 ? rest.slice(0, tilde) : rest;
      const name = tilde >= 0 ? rest.slice(tilde + 1) : undefined;
      if (!HASH_RE.test(hashPart)) return null;
      if (name !== undefined && name.length === 0) return null;
      return { kind, address: "content", hash: hashPart, name };
    }
    if (address.length === 0) return null;
    return { kind, address: "path", path: address };
  },

  isValid(id: string): boolean {
    return AssetId.parse(id) !== null;
  },

  /** Kind prefix, or null when the id is not canonical. */
  kindOf(id: string): string | null {
    return AssetId.parse(id)?.kind ?? null;
  },

  /**
   * Short form for logs and UI: content-addressed ids print 8 hex chars + the name;
   * non-canonical ids print unchanged.
   */
  display(id: string): string {
    const info = AssetId.parse(id);
    if (!info) return id;
    if (info.address === "content") {
      const short = `${info.kind}:${info.hash!.slice(0, 8)}…`;
      return info.name !== undefined ? `${short}~${info.name}` : short;
    }
    return id;
  },
};

const HEX_DIGITS = "0123456789abcdef";

/**
 * SHA-256 of `bytes` as a 64-hex lowercase string — the hash behind content-addressed ids.
 * Uses WebCrypto, so it works in browser secure contexts and Node ≥ 19; it throws `UsageError`
 * (not a cryptic TypeError) where `crypto.subtle` is absent (plain-http browsers).
 */
export async function hashContent(bytes: ArrayBuffer | ArrayBufferView): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    throw new UsageError(
      "hashContent requires WebCrypto (crypto.subtle); serve the page over https/localhost or run on Node ≥ 19",
    );
  }
  // WebCrypto hashes exactly the view's byte range (offset + length respected), so no copy.
  const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) out += HEX_DIGITS[view[i] >> 4] + HEX_DIGITS[view[i] & 15];
  return out;
}
