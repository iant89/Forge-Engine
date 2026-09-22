/**
 * Error types and assertion helpers.
 *
 * Engine failures are typed so user code can distinguish "you misused the API" (programming
 * error, throws), "the platform cannot do this" (capability error, degrades or reports) and
 * "an asset/IO thing failed" (recoverable, surfaces as a rejected promise).
 */

export class ForgeError extends Error {
  /** Stable machine-readable code, e.g. `E_GPU_DEVICE_LOST`. */
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code = "E_FORGE", details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** The caller used the API in a way the engine does not support. Always a bug in user code. */
export class UsageError extends ForgeError {
  constructor(message: string, details?: unknown) {
    super(message, "E_USAGE", details);
  }
}

/** A requested capability is unavailable (feature, limit, format). Callers may fall back. */
export class CapabilityError extends ForgeError {
  constructor(message: string, details?: unknown) {
    super(message, "E_CAPABILITY", details);
  }
}

/** WebGPU initialization failed entirely. */
export class UnsupportedPlatformError extends CapabilityError {
  constructor(message: string, details?: unknown) {
    super(message, details);
    this.name = "UnsupportedPlatformError";
  }
}

/** Asset load failure (network, decode, or format not supported by this build). */
export class AssetError extends ForgeError {
  readonly url: string;

  constructor(message: string, url: string, code = "E_ASSET") {
    super(message, code);
    this.url = url;
  }
}

/** Thrown when a released/invalidated resource handle is used. */
export class ResourceLifecycleError extends ForgeError {
  constructor(message: string, details?: unknown) {
    super(message, "E_RESOURCE_LIFECYCLE", details);
  }
}

/** Raised when a subsystem's internal invariants are violated (should never happen). */
export class InternalError extends ForgeError {
  constructor(message: string, details?: unknown) {
    super(message, "E_INTERNAL", details);
  }
}

export class ObjectDisposedError extends ForgeError {
  constructor(what: string) {
    super(`${what} has been disposed and cannot be used.`, "E_DISPOSED");
  }
}

/**
 * A task handler that cannot run in a worker (it needs the DOM, a live `GraphicsDevice`, or other
 * main-thread state). Throwing this from a handler is the *supported* way to say so: the worker
 * reports it back, and the scheduler re-runs the task inline instead of failing it. Handlers that
 * simply are not installed in the worker are treated the same way, so a partially registered
 * worker degrades instead of breaking a streaming pipeline.
 */
export class InlineOnlyError extends ForgeError {
  constructor(message = "task handler requires the main thread") {
    super(message, "E_INLINE_ONLY");
  }
}

/**
 * Invariants are checked in development and reported (not thrown) in production builds, since
 * a released engine should prefer a dropped frame over taking down the page.
 */
let assertionsEnabled = true;

export function setAssertionsEnabled(enabled: boolean): void {
  assertionsEnabled = enabled;
}

export function assertionsEnabledValue(): boolean {
  return assertionsEnabled;
}

export function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (condition) return;
  const text = details === undefined ? message : `${message} (${safeString(details)})`;
  if (assertionsEnabled) throw new InternalError(text);
  // eslint-disable-next-line no-console
  console.error(`[forge:assert-disabled] ${text}`);
}

export function assertDefined<T>(value: T | null | undefined, name: string): NonNullable<T> {
  if (value === null || value === undefined) throw new UsageError(`Expected ${name} to be defined`);
  return value;
}

export function assertPositive(name: string, value: number): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new UsageError(`${name} must be a positive finite number, got ${value}`);
  }
}

export function assertInRange(name: string, value: number, min: number, max: number): void {
  if (!(value >= min && value <= max) || !Number.isFinite(value)) {
    throw new UsageError(`${name} must be within [${min}, ${max}], got ${value}`);
  }
}

export function assertInt(name: string, value: number): void {
  if (!Number.isInteger(value)) throw new UsageError(`${name} must be an integer, got ${value}`);
}

/** Exhaustive-switch helper: a missing case becomes a compile error. */
export function assertNever(value: never, context = "exhaustive switch"): never {
  throw new InternalError(`${context}: unexpected value ${safeString(value)}`);
}

function safeString(v: unknown): string {
  try {
    if (typeof v === "object" && v !== null) return JSON.stringify(v);
    return String(v);
  } catch {
    return "<unstringifiable>";
  }
}
