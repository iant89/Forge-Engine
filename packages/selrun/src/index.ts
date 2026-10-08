import assert from "node:assert/strict";

export type TestBody = () => void | Promise<void>;

interface Hook {
  readonly body: TestBody;
  readonly timeoutMs?: number;
}

interface HookScope {
  readonly name: string;
  readonly beforeAll: Hook[];
  readonly afterAll: Hook[];
  readonly beforeEach: Hook[];
  readonly afterEach: Hook[];
}

interface RegisteredCase {
  readonly name: string;
  readonly groups: readonly string[];
  readonly scopes: readonly HookScope[];
  readonly body?: TestBody;
  readonly skipReason?: string;
}

const rootScope: HookScope = { name: "", beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
const cases: RegisteredCase[] = [];
const groupStack: HookScope[] = [];
let finished = false;

function newScope(name: string): HookScope {
  return { name, beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
}

/** Register a section name for the cases declared by `body`. */
export function group(name: string, body: () => void): void {
  if (finished) throw new Error("selrun: cannot add a group after finish()");
  const label = name.trim();
  if (!label) throw new Error("selrun: group names must not be empty");
  groupStack.push(newScope(label));
  try {
    body();
  } finally {
    groupStack.pop();
  }
}

/** Register setup/cleanup for the current group (including nested groups). */
export function beforeEach(body: TestBody): void {
  registerHook("beforeEach", body);
}

export function afterEach(body: TestBody): void {
  registerHook("afterEach", body);
}

export function beforeAll(body: TestBody, timeoutMs?: number): void {
  registerHook("beforeAll", body, timeoutMs);
}

export function afterAll(body: TestBody, timeoutMs?: number): void {
  registerHook("afterAll", body, timeoutMs);
}

function registerHook(kind: keyof Omit<HookScope, "name">, body: TestBody, timeoutMs?: number): void {
  if (finished) throw new Error(`selrun: cannot register ${kind} after finish()`);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError(`selrun: ${kind} timeout must be positive`);
  }
  const scope = groupStack.at(-1) ?? rootScope;
  scope[kind].push({ body, timeoutMs });
}

/** Register a test case. Cases run in declaration order when `finish()` is awaited. */
export function test(name: string, body: TestBody): void {
  const scopes = [rootScope, ...groupStack];
  register({ name, groups: groupStack.map((scope) => scope.name), scopes, body });
}

/** Register a deliberately skipped test case, with a human-readable reason. */
export function skip(name: string, why: string): void {
  const scopes = [rootScope, ...groupStack];
  register({ name, groups: groupStack.map((scope) => scope.name), scopes, skipReason: why });
}

function register(testCase: RegisteredCase): void {
  if (finished) throw new Error("selrun: cannot register a test after finish()");
  if (!testCase.name.trim()) throw new Error("selrun: test names must not be empty");
  if (testCase.skipReason !== undefined && !testCase.skipReason.trim()) {
    throw new Error(`selrun: skipped case \"${testCase.name}\" needs a reason`);
  }
  cases.push(testCase);
}

/** Print the expected size of the linked serial suite list. `test:check` verifies the count. */
export function report(suiteCount: number): void {
  if (!Number.isSafeInteger(suiteCount) || suiteCount < 0) {
    throw new RangeError(`selrun: report count must be a non-negative integer, got ${suiteCount}`);
  }
  console.log(`selrun: ${suiteCount} linked suites`);
}

/** Run the registered cases and set a failing process status if any assertion fails. */
export async function finish(): Promise<void> {
  if (finished) throw new Error("selrun: finish() may only be called once per suite process");
  finished = true;

  let passed = 0;
  let skipped = 0;
  const failures: Array<{ name: string; error: unknown }> = [];
  const activeScopes: HookScope[] = [];
  const failedBeforeAll = new Set<HookScope>();

  const recordFailure = (name: string, error: unknown): void => {
    failures.push({ name, error });
    console.error(`  - FAIL ${name}`);
    console.error(formatError(error));
  };
  const runWithTimeout = async (body: TestBody, timeoutMs: number, label: string): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(body),
        new Promise<never>((_resolve, reject) => {
          timer = nativeSetTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) nativeClearTimeout(timer);
    }
  };
  const runHook = async (hook: Hook): Promise<void> => {
    await runWithTimeout(hook.body, hook.timeoutMs ?? 20_000, "hook");
  };
  const closeScope = async (scope: HookScope): Promise<void> => {
    for (const hook of [...scope.afterAll].reverse()) {
      try {
        await runHook(hook);
      } catch (error) {
        recordFailure(scope.name || "afterAll", error);
      }
    }
  };

  for (const testCase of cases) {
    const label = [...testCase.groups, testCase.name].join(" > ");
    if (testCase.skipReason !== undefined) {
      skipped++;
      console.log(`  - SKIP ${label} — ${testCase.skipReason}`);
      continue;
    }

    let common = 0;
    while (common < activeScopes.length && common < testCase.scopes.length && activeScopes[common] === testCase.scopes[common]) common++;
    while (activeScopes.length > common) await closeScope(activeScopes.pop()!);

    let groupSetupFailed = false;
    for (const scope of testCase.scopes.slice(common)) {
      activeScopes.push(scope);
      for (const hook of scope.beforeAll) {
        try {
          await runHook(hook);
        } catch (error) {
          failedBeforeAll.add(scope);
          groupSetupFailed = true;
          recordFailure(label, error);
          break;
        }
      }
    }
    if (testCase.scopes.some((scope) => failedBeforeAll.has(scope))) groupSetupFailed = true;

    let testError: unknown;
    if (!groupSetupFailed) {
      try {
        await runWithTimeout(async () => {
          for (const scope of testCase.scopes) {
            for (const hook of scope.beforeEach) await runHook(hook);
          }
          await testCase.body!();
        }, 20_000, `test ${label}`);
      } catch (error) {
        testError = error;
      }
    }

    for (const scope of [...testCase.scopes].reverse()) {
      for (const hook of [...scope.afterEach].reverse()) {
        try {
          await runHook(hook);
        } catch (error) {
          if (testError === undefined) testError = error;
          else recordFailure(label, error);
        }
      }
    }

    if (testError !== undefined) recordFailure(label, testError);
    else if (!groupSetupFailed) passed++;
  }

  while (activeScopes.length > 0) await closeScope(activeScopes.pop()!);

  console.log(
    `selrun: ${passed} passed, ${failures.length} failed, ${skipped} skipped (${cases.length} cases)`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

export interface PartialObject<T extends object = Record<string, unknown>> {
  readonly [partialMatcher]: "object";
  readonly value: T;
}

export interface PartialArray<T = unknown> {
  readonly [partialMatcher]: "array";
  readonly value: readonly T[];
}

export interface PartialString {
  readonly [partialMatcher]: "string";
  readonly value: string;
}

const partialMatcher = Symbol("selrun.partialMatcher");
type PartialMatcher = PartialObject | PartialArray | PartialString;

/** Asymmetric matching values used only inside `assertMatches` expectations. */
export function objectContaining<T extends object>(value: T): PartialObject<T> {
  return { [partialMatcher]: "object", value };
}

export function arrayContaining<T>(value: readonly T[]): PartialArray<T> {
  return { [partialMatcher]: "array", value };
}

export function stringContaining(value: string): PartialString {
  return { [partialMatcher]: "string", value };
}

/** Assert an exact deep match while honoring the asymmetric values above. */
export function assertMatches(actual: unknown, expected: unknown, message?: string): void {
  if (!matches(actual, expected, false)) {
    throw new assert.AssertionError({
      message: message ?? "values do not match",
      actual,
      expected,
      operator: "matches",
    });
  }
}

export function assertNotMatches(actual: unknown, expected: unknown, message?: string): void {
  if (matches(actual, expected, false)) {
    throw new assert.AssertionError({
      message: message ?? "values unexpectedly match",
      actual,
      expected,
      operator: "doesNotMatch",
    });
  }
}

/** Assert a recursive partial-object match (the behavior of `toMatchObject`). */
export function assertMatchObject(actual: unknown, expected: unknown, message?: string): void {
  if (!matches(actual, expected, true)) {
    throw new assert.AssertionError({
      message: message ?? "object does not contain the expected values",
      actual,
      expected,
      operator: "matchObject",
    });
  }
}

export function assertNotMatchObject(actual: unknown, expected: unknown, message?: string): void {
  if (matches(actual, expected, true)) {
    throw new assert.AssertionError({
      message: message ?? "object unexpectedly contains the expected values",
      actual,
      expected,
      operator: "doesNotMatchObject",
    });
  }
}

function matches(actual: unknown, expected: unknown, partial: boolean): boolean {
  if (isPartialMatcher(expected)) {
    switch (expected[partialMatcher]) {
      case "object":
        return matches(actual, expected.value, true);
      case "array":
        return Array.isArray(actual) && expected.value.every((candidate) => actual.some((value) => matches(value, candidate, false)));
      case "string":
        return typeof actual === "string" && actual.includes(expected.value);
    }
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((value, index) => matches(actual[index], value, partial));
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const expectedKeys = Reflect.ownKeys(expected).filter((key) => Object.prototype.propertyIsEnumerable.call(expected, key));
    const actualKeys = Reflect.ownKeys(actual).filter((key) => Object.prototype.propertyIsEnumerable.call(actual, key));
    if (!partial && expectedKeys.length !== actualKeys.length) return false;
    return expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(actual, key) && matches(actual[key as keyof typeof actual], expected[key as keyof typeof expected], partial));
  }

  try {
    assert.deepEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function isPartialMatcher(value: unknown): value is PartialMatcher {
  return typeof value === "object" && value !== null && partialMatcher in value;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Assert the `toContain` contract for strings, arrays, typed arrays, Sets, and Maps. */
export function assertContains(actual: unknown, expected: unknown, message?: string): void {
  if (!contains(actual, expected)) {
    throw new assert.AssertionError({ message: message ?? "value was not contained", actual, expected, operator: "contains" });
  }
}

export function assertNotContains(actual: unknown, expected: unknown, message?: string): void {
  if (contains(actual, expected)) {
    throw new assert.AssertionError({ message: message ?? "value was unexpectedly contained", actual, expected, operator: "doesNotContain" });
  }
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
  if (Array.isArray(actual) || ArrayBuffer.isView(actual)) {
    return Array.from(actual as ArrayLike<unknown>).some((item) => Object.is(item, expected));
  }
  if (actual instanceof Set || actual instanceof Map) return actual.has(expected);
  return false;
}

/** Match the decimal precision threshold used by common `toBeCloseTo` matchers. */
export function assertCloseTo(actual: number, expected: number, precision = 2, message?: string): void {
  const difference = Math.abs(expected - actual);
  const threshold = 0.5 * 10 ** -precision;
  if (!(difference < threshold || Object.is(actual, expected))) {
    throw new assert.AssertionError({
      message: message ?? `expected ${actual} to be close to ${expected} (precision ${precision})`,
      actual,
      expected,
      operator: "closeTo",
    });
  }
}

export function assertNotCloseTo(actual: number, expected: number, precision = 2, message?: string): void {
  const difference = Math.abs(expected - actual);
  const threshold = 0.5 * 10 ** -precision;
  if (difference < threshold || Object.is(actual, expected)) {
    throw new assert.AssertionError({
      message: message ?? `expected ${actual} not to be close to ${expected} (precision ${precision})`,
      actual,
      expected,
      operator: "notCloseTo",
    });
  }
}

/** Assert a path is an own or inherited property (optionally a dotted path). */
export function assertHasProperty(actual: unknown, property: string | readonly PropertyKey[], message?: string): void {
  if (!hasProperty(actual, property)) {
    throw new assert.AssertionError({ message: message ?? `expected property ${String(property)}`, actual, expected: property, operator: "hasProperty" });
  }
}

export function assertNotHasProperty(actual: unknown, property: string | readonly PropertyKey[], message?: string): void {
  if (hasProperty(actual, property)) {
    throw new assert.AssertionError({ message: message ?? `unexpected property ${String(property)}`, actual, expected: property, operator: "doesNotHaveProperty" });
  }
}

function hasProperty(value: unknown, path: string | readonly PropertyKey[]): boolean {
  const parts: readonly PropertyKey[] = typeof path === "string" ? path.split(".") : path;
  let current: unknown = value;
  for (const part of parts) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null || !(part in current)) return false;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return true;
}

/** Tiny call recorder for a dependency explicitly replaced by a test. */
export interface CallRecorder<A extends readonly unknown[] = readonly unknown[]> {
  (...args: A): void;
  readonly calls: A[];
  readonly called: boolean;
}

export function callRecorder<A extends readonly unknown[] = readonly unknown[]>(): CallRecorder<A> {
  const calls: A[] = [];
  const record = ((...args: A): void => { calls.push(args); }) as CallRecorder<A>;
  Object.defineProperties(record, {
    calls: { enumerable: true, get: () => calls },
    called: { enumerable: true, get: () => calls.length > 0 },
  });
  return record;
}

export type SpyFunction<F extends (...args: any[]) => any> = F & {
  readonly mock: { readonly calls: Parameters<F>[] };
  mockRestore?: () => void;
};
export type SpiedFunction<F extends (...args: any[]) => any> = SpyFunction<F> & { mockRestore: () => void };

/** Wrap a fake implementation while recording each invocation and its arguments. */
export function spyFunction<F extends (...args: any[]) => any = (...args: any[]) => any>(implementation?: F): SpyFunction<F> {
  const calls: Parameters<F>[] = [];
  const invoke = implementation ?? (() => undefined) as F;
  const spy = function (this: unknown, ...args: Parameters<F>) {
    calls.push(args);
    return invoke.apply(this, args);
  } as SpyFunction<F>;
  Object.defineProperty(spy, "mock", { enumerable: true, get: () => ({ calls }) });
  return spy;
}

/** Spy on one existing method; `mockRestore()` restores the original property descriptor. */
export function spyOn<T extends object, K extends keyof T>(target: T, key: K): SpiedFunction<Extract<T[K], (...args: any[]) => any>> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const original = target[key];
  if (typeof original !== "function") throw new TypeError(`selrun: ${String(key)} is not a function`);
  const spy = spyFunction(original as Extract<T[K], (...args: any[]) => any>);
  Object.defineProperty(target, key, { configurable: true, enumerable: descriptor?.enumerable ?? true, writable: true, value: spy });
  spy.mockRestore = () => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };
  return spy as SpiedFunction<Extract<T[K], (...args: any[]) => any>>;
}

function callCount(value: unknown): number {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return 0;
  const mock = (value as { mock?: { calls?: unknown } }).mock;
  if (mock && Array.isArray(mock.calls)) return mock.calls.length;
  const calls = (value as { calls?: unknown }).calls;
  return Array.isArray(calls) ? calls.length : 0;
}

export function assertCalled(value: unknown, message?: string): void {
  assert.ok(callCount(value) > 0, message);
}

export function assertNotCalled(value: unknown, message?: string): void {
  assert.equal(callCount(value), 0, message);
}

export function assertCallCount(value: unknown, expected: number, message?: string): void {
  assert.equal(callCount(value), expected, message);
}

const savedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

/** Replace a global for the current process; `unstubAllGlobals()` restores its descriptor. */
export function stubGlobal(key: PropertyKey, value: unknown): void {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const previous = savedGlobals.get(key);
  Object.defineProperty(globalThis, key, {
    configurable: true,
    enumerable: previous?.enumerable ?? true,
    writable: true,
    value,
  });
}

export function unstubAllGlobals(): void {
  for (const [key, descriptor] of [...savedGlobals.entries()].reverse()) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  savedGlobals.clear();
}

interface FakeTimer {
  readonly handle: object;
  readonly callback: (...args: unknown[]) => void;
  readonly args: readonly unknown[];
  dueAt: number;
  readonly interval: number;
  active: boolean;
}

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const fakeTimers = new Map<number, FakeTimer>();
let fakeClock = 0;
let nextTimerId = 1;
let fakeTimersEnabled = false;

function scheduleFakeTimer(callback: (...args: unknown[]) => void, delay: number, interval: number, args: readonly unknown[]): object {
  const id = nextTimerId++;
  const handle = { __selrunTimer: id };
  fakeTimers.set(id, { handle, callback, args, dueAt: fakeClock + Math.max(0, delay), interval, active: true });
  return handle;
}

function timerId(handle: unknown): number | undefined {
  if (typeof handle !== "object" || handle === null || !("__selrunTimer" in handle)) return undefined;
  const id = (handle as { __selrunTimer?: unknown }).__selrunTimer;
  return typeof id === "number" ? id : undefined;
}

function clearFakeTimer(handle: unknown): void {
  const id = timerId(handle);
  if (id !== undefined) {
    const timer = fakeTimers.get(id);
    if (timer) timer.active = false;
  }
}

/** Replace global timers with a deterministic clock until `useRealTimers()` is called. */
export function useFakeTimers(): void {
  if (fakeTimersEnabled) return;
  fakeTimersEnabled = true;
  fakeClock = 0;
  fakeTimers.clear();
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0, ...args: unknown[]) =>
    scheduleFakeTimer(callback as (...args: unknown[]) => void, Number(delay) || 0, 0, args) as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
  globalThis.setInterval = ((callback: TimerHandler, delay = 0, ...args: unknown[]) => {
    const interval = Math.max(1, Number(delay) || 0);
    return scheduleFakeTimer(callback as (...args: unknown[]) => void, interval, interval, args) as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => clearFakeTimer(handle)) as unknown as typeof clearTimeout;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => clearFakeTimer(handle)) as unknown as typeof clearInterval;
}

/** Advance virtual time and run every due timeout/interval in due-time then registration order. */
export function advanceTimersByTime(milliseconds: number): void {
  if (!fakeTimersEnabled) throw new Error("selrun: advanceTimersByTime() requires useFakeTimers()");
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError("selrun: timer advance must be non-negative");
  const end = fakeClock + milliseconds;
  let executions = 0;
  while (true) {
    let nextId: number | undefined;
    let nextTimer: FakeTimer | undefined;
    for (const [id, timer] of fakeTimers) {
      if (!timer.active || timer.dueAt > end) continue;
      if (!nextTimer || timer.dueAt < nextTimer.dueAt || (timer.dueAt === nextTimer.dueAt && id < nextId!)) {
        nextId = id;
        nextTimer = timer;
      }
    }
    if (!nextTimer || nextId === undefined) break;
    fakeClock = nextTimer.dueAt;
    if (nextTimer.interval > 0) nextTimer.dueAt += nextTimer.interval;
    else nextTimer.active = false;
    nextTimer.callback(...nextTimer.args);
    if (++executions > 100_000) throw new Error("selrun: timer advance exceeded 100000 callbacks");
  }
  fakeClock = end;
}

/** Restore native process timers and discard outstanding fake timers. */
export function useRealTimers(): void {
  if (!fakeTimersEnabled) return;
  fakeTimersEnabled = false;
  fakeTimers.clear();
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  globalThis.setInterval = nativeSetInterval;
  globalThis.clearInterval = nativeClearInterval;
}

/** Assert a synchronous throw, treating a string expectation as a message substring. */
export function assertThrows(
  body: () => unknown,
  expected?: string | RegExp | (new (...args: any[]) => Error) | ((error: unknown) => boolean),
  message?: string,
): void {
  if (typeof expected === "string") {
    let thrown = false;
    let error: unknown;
    try {
      body();
    } catch (caught) {
      thrown = true;
      error = caught;
    }
    assert.ok(thrown, message ?? "expected function to throw");
    const detail = error instanceof Error ? error.message : String(error);
    assert.ok(detail.includes(expected), message ?? `expected thrown message to include ${JSON.stringify(expected)}, got ${JSON.stringify(detail)}`);
    return;
  }
  const nativeThrows = assert.throws as unknown as (action: () => unknown, expected?: unknown, message?: string) => void;
  nativeThrows(body, expected, message);
}

/** Assert a rejected promise, treating a string expectation as a message substring. */
export async function assertRejects(
  actual: PromiseLike<unknown> | (() => PromiseLike<unknown>),
  expected?: string | RegExp | (new (...args: any[]) => Error) | ((error: unknown) => boolean),
  message?: string,
): Promise<void> {
  const action = async (): Promise<unknown> => await (typeof actual === "function" ? actual() : actual);
  const nativeRejects = assert.rejects as unknown as (action: () => Promise<unknown>, expected?: unknown, message?: string) => Promise<void>;
  if (typeof expected === "string") {
    await nativeRejects(action, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      assert.ok(detail.includes(expected), message ?? `expected rejection message to include ${JSON.stringify(expected)}, got ${JSON.stringify(detail)}`);
      return true;
    }, message);
    return;
  }
  await nativeRejects(action, expected, message);
}
