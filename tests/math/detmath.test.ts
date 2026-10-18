/**
 * @suite math:detmath
 * @group unit
 * @covers engine/src/math/detmath.ts
 * @covers engine/src/math/index.ts
 * @covers examples/src/replay/dmathVectors.ts
 * @desc Phase 19.5 DMath: the pinned engine-independent digest of its results, bit-for-bit agreement with V8's fdlibm (asin, acos, atan, atan2, exp, log, log2, log10, cbrt; sin/cos/tan below 2^19·π/2), ECMAScript special cases, exact huge-argument reduction, pow and hypot accuracy, and no engine-dependent operation inside it
 */

export const suite = {
  name: "math:detmath",
  group: "unit",
  covers: ["engine/src/math/detmath.ts", "engine/src/math/index.ts", "examples/src/replay/dmathVectors.ts"],
  desc: "Phase 19.5 DMath: the pinned engine-independent digest of its results, bit-for-bit agreement with V8's fdlibm (asin, acos, atan, atan2, exp, log, log2, log10, cbrt; sin/cos/tan below 2^19·π/2), ECMAScript special cases, exact huge-argument reduction, pow and hypot accuracy, and no engine-dependent operation inside it",
};

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finish, group, test } from "selrun";
import { APPROXIMATED_MATH_FUNCTIONS, DMath } from "@forge/engine";
import { DMATH_VECTOR_DIGEST, dmathVectorDigest, dmathVectors } from "../../examples/src/replay/dmathVectors.js";

type Fn = keyof typeof DMath;
const call = (fn: Fn, args: number[]): number => (DMath[fn] as (...a: number[]) => number)(...args);
const native = (fn: Fn, args: number[]): number => (Math[fn] as (...a: number[]) => number)(...args);

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);
/** Distance in units in the last place (0 for identical bits, or two NaNs). */
function ulps(a: number, b: number): number {
  if (Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))) return 0;
  F64[0] = a;
  const x = U64[0]!;
  F64[0] = b;
  const y = U64[0]!;
  // Same sign: the bit patterns are ordered. Different signs only happen around zero here.
  return Number(x > y ? x - y : y - x);
}

group("engine independence", () => {
  test("the digest of every function's results over its test vectors is pinned (check:replay-engines recomputes it under JavaScriptCore)", () => {
    const { digest, functions } = dmathVectorDigest();
    assert.equal(digest, DMATH_VECTOR_DIGEST, `per function: ${JSON.stringify(functions)}`);
  });

  test("DMath calls no engine-dependent Math function and no ** (only exact operations)", () => {
    const source = readFileSync(new URL("../../engine/src/math/detmath.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const name of APPROXIMATED_MATH_FUNCTIONS) assert.ok(!new RegExp(`\\bMath\\.${name}\\s*\\(`).test(source), `Math.${name}`);
    assert.ok(!/[\w)\]]\s*\*\*\s*[\w(]/.test(source), "**");
    // And at run time: nothing approximated is reached even through a helper.
    const saved = new Map<string, unknown>();
    const math = Math as unknown as Record<string, unknown>;
    let calls = 0;
    for (const name of APPROXIMATED_MATH_FUNCTIONS) {
      saved.set(name, math[name]);
      const original = math[name] as (...a: number[]) => number;
      math[name] = (...a: number[]) => {
        calls++;
        return original.apply(Math, a);
      };
    }
    try {
      for (const fn of Object.keys(DMath) as Fn[]) for (const args of dmathVectors(fn, 500)) call(fn, args);
      call("sin", [1e300]);
      call("pow", [1.0000001, 3e9]);
    } finally {
      for (const [name, f] of saved) math[name] = f;
    }
    assert.equal(calls, 0);
  });
});

group("agreement with V8 (fdlibm)", () => {
  test("asin, acos, atan, atan2, exp, log, log2, log10 and cbrt return V8's bits exactly", () => {
    for (const fn of ["asin", "acos", "atan", "atan2", "exp", "log", "log2", "log10", "cbrt"] as const) {
      let differ = 0;
      for (const args of dmathVectors(fn, 20000)) if (!Object.is(call(fn, args), native(fn, args))) differ++;
      assert.equal(differ, 0, fn);
    }
  });

  test("sin, cos and tan return V8's bits below 2^19·π/2; above it the exact BigInt reduction stays within 1 ulp", () => {
    const limit = 2 ** 19 * (Math.PI / 2);
    for (const fn of ["sin", "cos", "tan"] as const) {
      let small = 0;
      let large = 0;
      for (const args of dmathVectors(fn, 20000)) {
        const e = ulps(call(fn, args), native(fn, args));
        if (Math.abs(args[0]!) < limit) small = Math.max(small, e);
        else large = Math.max(large, e);
      }
      assert.equal(small, 0, `${fn} below the limit`);
      assert.ok(large <= 1, `${fn} above the limit: ${large} ulp`);
    }
    // Known values: sin(1e22) needs the reduction to ~70 bits of 2/π beyond the argument.
    assert.equal(DMath.sin(1e22), -0.8522008497671888);
    assert.ok(ulps(DMath.cos(1e22), Math.cos(1e22)) <= 1);
    assert.ok(ulps(DMath.sin(2 ** 1000), Math.sin(2 ** 1000)) <= 1);
    assert.ok(ulps(DMath.sin(-Number.MAX_VALUE), Math.sin(-Number.MAX_VALUE)) <= 1);
  });

  test("pow (fdlibm's e_pow) and hypot are within 1 and 3 ulp of V8's own", () => {
    let pow = 0;
    for (const args of dmathVectors("pow", 20000)) pow = Math.max(pow, ulps(call("pow", args), native("pow", args)));
    let hypot = 0;
    for (const args of dmathVectors("hypot", 20000)) hypot = Math.max(hypot, ulps(call("hypot", args), native("hypot", args)));
    assert.ok(pow <= 1, `pow ${pow} ulp`);
    assert.ok(hypot <= 3, `hypot ${hypot} ulp`);
    // Exact cases.
    assert.equal(DMath.pow(2, 10), 1024);
    assert.equal(DMath.pow(10, -2), Math.pow(10, -2));
    assert.equal(DMath.pow(-2, 3), -8);
    assert.equal(DMath.pow(9, 0.5), 3);
    assert.equal(DMath.hypot(3, 4), 5);
    assert.equal(DMath.hypot(3, 4, 12), 13);
    assert.equal(DMath.hypot(1e300, 1e300), Math.SQRT2 * 1e300);
    assert.equal(DMath.hypot(3e-320, 4e-320), 5e-320);
    assert.equal(DMath.hypot(-5), 5);
  });
});

group("special cases (ECMAScript)", () => {
  test("NaN, ±0, ±∞ and the edges agree with the specification for every function", () => {
    const specials = [NaN, 0, -0, Infinity, -Infinity, 1, -1, 0.5, -0.5, 2, -2, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Math.PI, -Math.PI / 2, 1e-310];
    for (const fn of Object.keys(DMath) as Fn[]) {
      const arity = fn === "atan2" || fn === "pow" ? 2 : 1;
      for (const a of specials) {
        if (arity === 1) {
          const d = call(fn, [a]);
          const m = native(fn, [a]);
          assert.ok(ulps(d, m) <= (fn === "sin" || fn === "cos" || fn === "tan" ? 1 : 0), `${fn}(${a}) = ${d}, Math gives ${m}`);
          continue;
        }
        for (const b of specials) {
          const d = call(fn, [a, b]);
          const m = native(fn, [a, b]);
          assert.ok(ulps(d, m) <= (fn === "pow" ? 1 : 0), `${fn}(${a}, ${b}) = ${d}, Math gives ${m}`);
        }
      }
    }
    assert.ok(Number.isNaN(DMath.pow(1, Infinity)) && Number.isNaN(DMath.pow(-1, -Infinity)), "(±1)^±∞ is NaN in ECMAScript, unlike C");
    assert.ok(Object.is(DMath.pow(-0, 3), -0) && DMath.pow(-0, -3) === -Infinity);
    assert.equal(DMath.hypot(NaN, Infinity), Infinity, "∞ wins over NaN");
    assert.ok(Number.isNaN(DMath.hypot(NaN, 1)));
    assert.ok(Object.is(DMath.atan2(-0, 1), -0) && DMath.atan2(0, -1) === Math.PI && DMath.atan2(-0, -0) === -Math.PI);
  });
});

await finish();
