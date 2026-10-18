/**
 * DMath test vectors (Phase 19.5): a fixed set of arguments for every `DMath` function, built only
 * from exact operations (an integer LCG, multiplication by powers of two), and a 64-bit digest of the
 * exact result bits. The digest is the same on every JavaScript engine — that is the property
 * `DMath` exists for — so `tests/math/detmath.test.ts` pins it, `npm run check:replay-engines`
 * recomputes it under JavaScriptCore, and the replay-verify page recomputes it in the browser.
 */

import { DMath, StateHasher } from "@forge/engine";

/** The digest every engine must produce for `dmathVectorDigest()` with the default count. */
export const DMATH_VECTOR_DIGEST = "3043a28ac1646a83";

type Fn = keyof typeof DMath;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

/** 2^k exactly, by repeated doubling or halving. */
function pow2(k: number): number {
  let v = 1;
  if (k >= 0) for (let i = 0; i < k; i++) v *= 2;
  else for (let i = 0; i < -k; i++) v /= 2;
  return v;
}

/** The arguments for one function: magnitudes spread over the binades that matter for it. */
export function dmathVectors(fn: Fn, count: number): number[][] {
  const rnd = lcg(0x5eed + fn.length * 7919 + fn.charCodeAt(0));
  const mag = (lo: number, hi: number): number => (1 + rnd()) * pow2(lo + Math.floor(rnd() * (hi - lo)));
  const sgn = (): number => (rnd() < 0.5 ? -1 : 1);
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    switch (fn) {
      case "sin":
      case "cos":
      case "tan":
        out.push([sgn() * mag(-30, 64)]);
        break;
      case "asin":
      case "acos":
        out.push([rnd() * 2 - 1]);
        break;
      case "atan":
        out.push([sgn() * mag(-40, 70)]);
        break;
      case "atan2":
        out.push([sgn() * mag(-20, 20), sgn() * mag(-20, 20)]);
        break;
      case "exp":
        out.push([(rnd() - 0.5) * 1500]);
        break;
      case "log":
      case "log2":
      case "log10":
        out.push([mag(-1074, 1024)]);
        break;
      case "pow":
        out.push([rnd() < 0.1 ? -mag(-8, 8) : mag(-12, 12), rnd() < 0.2 ? Math.floor((rnd() - 0.5) * 60) : (rnd() - 0.5) * 60]);
        break;
      case "cbrt":
        out.push([sgn() * mag(-1074, 1024)]);
        break;
      case "hypot":
        out.push([sgn() * mag(-20, 20), sgn() * mag(-20, 20), sgn() * mag(-20, 20)]);
        break;
    }
  }
  return out;
}

/** Digest of every function's results over its vectors (and per function, for diagnosis). */
export function dmathVectorDigest(count = 20000): { digest: string; functions: Record<string, string> } {
  const all = new StateHasher();
  const functions: Record<string, string> = {};
  for (const fn of Object.keys(DMath) as Fn[]) {
    const h = new StateHasher();
    const f = DMath[fn] as (...a: number[]) => number;
    for (const args of dmathVectors(fn, count)) h.f64(f(...args));
    functions[fn] = h.digest();
    all.str(fn).str(functions[fn]);
  }
  return { digest: all.digest(), functions };
}
