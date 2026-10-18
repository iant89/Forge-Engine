/**
 * Deterministic transcendental functions (Phase 19.5): `DMath.sin`, `DMath.atan2`, `DMath.exp`, …
 * return the same bits in every JavaScript engine.
 *
 * ECMAScript leaves `Math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log`,
 * `log2`, `log10`, `pow` (and `**`), `cbrt` and `hypot`, among others, "implementation-approximated".
 * V8 ports fdlibm; JavaScriptCore (Safari) and SpiderMonkey call the platform's libm, so results can
 * differ in the last bit, and a simulation that feeds one of them back into its state diverges between
 * browsers within a few steps. `+ - * /`, `Math.sqrt` (correctly rounded), `Math.abs`, `floor`, `ceil`,
 * `round`, `trunc`, `sign`, `min`, `max`, `fround` and number parsing of literals of at most 17
 * significant digits are exact everywhere.
 *
 * Every function here is built only from those exact operations plus reads and writes of a double's
 * bit pattern, and `BigInt` for reducing huge trigonometric arguments, so its result is a pure
 * function of its input's bits (`tests/math/detmath.test.ts` pins a digest of a million results, and
 * `npm run check:replay-engines` recomputes it under JavaScriptCore). The algorithms are fdlibm's, as V8
 * runs them: in Node and Chrome `DMath.f(x) === Math.f(x)` bit for bit for asin, acos, atan, atan2,
 * exp, log, log2, log10 and cbrt, and for sin, cos and tan below 2^19·π/2, where fdlibm's Payne–Hanek
 * reduction is replaced by an exact `BigInt` one (≤ 1 ulp apart above it). `pow` is fdlibm's e_pow.c,
 * which V8 does not use (within 0.9 ulp of each other; both are correctly rounded in about 90% of
 * cases); `hypot` sums exact squares after an exact power-of-two scaling (≤ 1.1 ulp; V8's ≤ 1.9).
 * Special cases follow ECMAScript, e.g. `pow(±1, ±∞)` is NaN.
 *
 * Simulation code — anything a replay or a snapshot hash depends on — must call `DMath`, never the
 * approximated `Math` functions or `**`; `npm run lint:arch` enforces it for the simulation sources
 * (`DETERMINISTIC_SOURCES` in tools/lint-arch.mjs). Rendering, UI and audio keep the native functions.
 */

// ------------------------------------------------------------------ bit access

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE ? 1 : 0;
const LO = LITTLE ? 0 : 1;

/** High 32 bits of `x` as an unsigned integer. */
function highWord(x: number): number {
  F64[0] = x;
  return U32[HI]!;
}

function lowWord(x: number): number {
  F64[0] = x;
  return U32[LO]!;
}

function fromWords(hi: number, lo: number): number {
  U32[HI] = hi >>> 0;
  U32[LO] = lo >>> 0;
  return F64[0]!;
}

/** `x` with its low 32 bits cleared. */
function clearLow(x: number): number {
  F64[0] = x;
  U32[LO] = 0;
  return F64[0]!;
}

/** 2^n for -1022 <= n <= 1023, exactly. */
function pow2(n: number): number {
  return fromWords((0x3ff + n) << 20, 0);
}

/** x · 2^n, exactly (musl's scalbn: no double rounding in the subnormal range). */
function scalbn(x: number, n: number): number {
  let y = x;
  if (n > 1023) {
    y *= pow2(1023);
    n -= 1023;
    if (n > 1023) {
      y *= pow2(1023);
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    y *= pow2(-1022) * pow2(53);
    n += 1022 - 53;
    if (n < -1022) {
      y *= pow2(-1022) * pow2(53);
      n += 1022 - 53;
      if (n < -1022) n = -1022;
    }
  }
  return y * pow2(n);
}

// ------------------------------------------------------------------ π/2 reduction

const PIO4 = 0.7853981633974483;
const INVPIO2 = 0.6366197723675814;
const PIO2_1 = 1.5707963267341256;
const PIO2_1T = 6.077100506506192e-11;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_2T = 2.0222662487959506e-21;
const PIO2_3 = 2.0222662487111665e-21;
const PIO2_3T = 8.4784276603689e-32;

/** floor(2/π · 2^1280) and floor(π/2 · 2^128), for the exact reduction of huge arguments. */
const TWO_OVER_PI_BITS = 1280n;
const TWO_OVER_PI = BigInt(
  "0xa2f9836e4e441529fc2757d1f534ddc0db6295993c439041fe5163abdebbc561b7246e3a424dd2e006492eea09d1921cfe1deb1cb129a73ee88235f52ebb4484e99c7026b45f7e413991d639835339f49c845f8bbdf9283b1ff897ffde05980fef2f118b5a0a6d1f6d367ecf27cb09b74f463f669e5fea2d7527bac7ebe5f17b3d0739f78a5292ea6bfb5fb11f8d5d0856033046fc7b6babf0cfbc209af4361d",
);
const PIO2_FIXED = BigInt("0x1921fb54442d18469898cc51701b839a2"); // π/2 · 2^128
const MASK128 = (1n << 128n) - 1n;
const TWO_POW_256 = pow2(128) * pow2(128);
const TWO_POW_M256 = pow2(-128) * pow2(-128);

/** Shared out-parameters of `remPio2`: x = n·π/2 + (Y0 + Y1). */
let Y0 = 0;
let Y1 = 0;

/**
 * Reduce `x` (|x| > π/4, finite) to x - n·π/2 = Y0 + Y1 with |Y0| <= π/4, returning n. fdlibm's
 * reduction (as V8 runs it) below 2^19·π/2: a special case for |x| < 3π/4, then Cody–Waite in up to
 * three parts. Above it, an exact `BigInt` product with 1280 bits of 2/π, where fdlibm uses
 * Payne–Hanek in doubles (the integer form is simpler and just as exact).
 */
function remPio2(x: number): number {
  const hx = highWord(x);
  const negative = hx >>> 31 === 1;
  const ix = hx & 0x7fffffff;
  if (ix < 0x4002d97c) {
    // |x| < 3π/4: n = ±1
    if (!negative) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        Y0 = z - PIO2_1T;
        Y1 = z - Y0 - PIO2_1T;
      } else {
        z -= PIO2_2;
        Y0 = z - PIO2_2T;
        Y1 = z - Y0 - PIO2_2T;
      }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      Y0 = z + PIO2_1T;
      Y1 = z - Y0 + PIO2_1T;
    } else {
      z += PIO2_2;
      Y0 = z + PIO2_2T;
      Y1 = z - Y0 + PIO2_2T;
    }
    return -1;
  }
  if (ix <= 0x413921fb) {
    const t0 = Math.abs(x);
    const n = Math.trunc(t0 * INVPIO2 + 0.5);
    const fn = n;
    let r = t0 - fn * PIO2_1;
    let w = fn * PIO2_1T;
    Y0 = r - w;
    const j = ix >>> 20;
    let i = j - ((highWord(Y0) >>> 20) & 0x7ff);
    if (i > 16) {
      let t = r;
      w = fn * PIO2_2;
      r = t - w;
      w = fn * PIO2_2T - (t - r - w);
      Y0 = r - w;
      i = j - ((highWord(Y0) >>> 20) & 0x7ff);
      if (i > 49) {
        t = r;
        w = fn * PIO2_3;
        r = t - w;
        w = fn * PIO2_3T - (t - r - w);
        Y0 = r - w;
      }
    }
    Y1 = r - Y0 - w;
    if (negative) {
      Y0 = -Y0;
      Y1 = -Y1;
      return -n;
    }
    return n;
  }
  // Huge |x|: x = m · 2^e exactly, and x·(2/π) = m·T · 2^(e - 1280).
  const m = (BigInt((hx & 0xfffff) | 0x100000) << 32n) | BigInt(lowWord(x));
  const e = BigInt(((hx >>> 20) & 0x7ff) - 1075);
  const shift = TWO_OVER_PI_BITS - e; // fraction bits of the product (> 128 for every finite double)
  const p = m * TWO_OVER_PI;
  let n = Number((p >> shift) & 3n);
  let frac = (p >> (shift - 128n)) & MASK128; // [0, 1) in units of 2^-128
  if (frac >= 1n << 127n) {
    frac -= 1n << 128n; // round to the nearest quadrant: [-1/2, 1/2)
    n = (n + 1) & 3;
  }
  const r = frac * PIO2_FIXED; // units of 2^-256
  const hiPart = Number(r) * TWO_POW_M256;
  Y0 = hiPart;
  Y1 = Number(r - BigInt(hiPart * TWO_POW_256)) * TWO_POW_M256;
  if (negative) {
    Y0 = -Y0;
    Y1 = -Y1;
    n = -n;
  }
  return n;
}

// ------------------------------------------------------------------ sin / cos / tan kernels (|x| <= π/4)

const S1 = -0.16666666666666632;
const S2 = 0.00833333333332249;
const S3 = -0.0001984126982985795;
const S4 = 0.0000027557313707070068;
const S5 = -2.5050760253406863e-8;
const S6 = 1.58969099521155e-10;

function kSin(x: number, y: number, iy: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return x; // |x| < 2^-27
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 0.0416666666666666;
const C2 = -0.001388888888887411;
const C3 = 0.00002480158728947673;
const C4 = -2.7557314351390663e-7;
const C5 = 2.087572321298175e-9;
const C6 = -1.1359647557788195e-11;

function kCos(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1.0; // |x| < 2^-27
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1.0 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0); // x/4
  const hz = 0.5 * z - qx;
  const a = 1.0 - qx;
  return a - (hz - (z * r - x * y));
}

const T0 = 0.3333333333333341;
const T1 = 0.13333333333320124;
const T2 = 0.05396825397622605;
const T3 = 0.021869488294859542;
const T4 = 0.0088632398235993;
const T5 = 0.0035920791075913124;
const T6 = 0.0014562094543252903;
const T7 = 0.0005880412408202641;
const T8 = 0.0002464631348184699;
const T9 = 0.00007817944429395571;
const T10 = 0.00007140724913826082;
const T11 = -0.000018558637485527546;
const T12 = 0.00002590730518636337;
const PIO4LO = 3.061616997868383e-17;

/** tan on [-π/4, π/4] with tail `y`; `iy` is 1 for tan, -1 for -1/tan (fdlibm 5.3's kernel). */
function kTan(x: number, y: number, iy: number): number {
  const hx = highWord(x) | 0;
  const ix = hx & 0x7fffffff;
  if (ix < 0x3e300000 && Math.trunc(x) === 0) {
    // |x| < 2^-28
    if ((ix | lowWord(x) | (iy + 1)) === 0) return 1 / Math.abs(x);
    if (iy === 1) return x;
    const w = x + y;
    const z = clearLow(w);
    const v = y - (z - x);
    const a = -1 / w;
    const t = clearLow(a);
    const s = 1 + t * z;
    return t + a * (s + t * v);
  }
  if (ix >= 0x3fe59428) {
    // |x| >= 0.6744
    if (hx < 0) {
      x = -x;
      y = -y;
    }
    const z = PIO4 - x;
    const w = PIO4LO - y;
    x = z + w;
    y = 0.0;
  }
  const z = x * x;
  let w = z * z;
  let r = T1 + w * (T3 + w * (T5 + w * (T7 + w * (T9 + w * T11))));
  let v = z * (T2 + w * (T4 + w * (T6 + w * (T8 + w * (T10 + w * T12)))));
  let s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T0 * s;
  w = x + r;
  if (ix >= 0x3fe59428) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - ((w * w) / (w + v) - r)));
  }
  if (iy === 1) return w;
  const zz = clearLow(w);
  v = r - (zz - x);
  const a = -1.0 / w;
  const t = clearLow(a);
  s = 1.0 + t * zz;
  return t + a * (s + t * v);
}

function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kSin(x, 0.0, 0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x) & 3;
  if (n === 0) return kSin(Y0, Y1, 1);
  if (n === 1) return kCos(Y0, Y1);
  if (n === 2) return -kSin(Y0, Y1, 1);
  return -kCos(Y0, Y1);
}

function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kCos(x, 0.0);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x) & 3;
  if (n === 0) return kCos(Y0, Y1);
  if (n === 1) return -kSin(Y0, Y1, 1);
  if (n === 2) return -kCos(Y0, Y1);
  return kSin(Y0, Y1, 1);
}

function tan(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kTan(x, 0.0, 1);
  if (ix >= 0x7ff00000) return x - x;
  const n = remPio2(x);
  return kTan(Y0, Y1, 1 - ((n & 1) << 1));
}

// ------------------------------------------------------------------ inverse trigonometric

const ATANHI = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966] as const;
const ATANLO = [2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17] as const;
const AT0 = 0.3333333333333293;
const AT1 = -0.19999999999876483;
const AT2 = 0.14285714272503466;
const AT3 = -0.11111110405462356;
const AT4 = 0.09090887133436507;
const AT5 = -0.0769187620504483;
const AT6 = 0.06661073137387531;
const AT7 = -0.058335701337905735;
const AT8 = 0.049768779946159324;
const AT9 = -0.036531572744216916;
const AT10 = 0.016285820115365782;

function atan(x: number): number {
  const hx = highWord(x);
  const negative = hx >>> 31 === 1;
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    // |x| >= 2^66
    if (x !== x) return x;
    return negative ? -ATANHI[3] : ATANHI[3];
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        x = (2.0 * x - 1.0) / (2.0 + x);
      } else {
        id = 1;
        x = (x - 1.0) / (x + 1.0);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      x = (x - 1.5) / (1.0 + 1.5 * x);
    } else {
      id = 3;
      x = -1.0 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id as 0]! - (x * (s1 + s2) - ATANLO[id as 0]! - x);
  return negative ? -r : r;
}

const PI = 3.141592653589793;
const PI_LO = 1.2246467991473532e-16;

function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return x + y;
  const ix0 = highWord(x);
  const lx = lowWord(x);
  const iy0 = highWord(y);
  const ly = lowWord(y);
  if (ix0 === 0x3ff00000 && lx === 0) return atan(y); // x == 1
  const m = ((iy0 >>> 31) & 1) | ((ix0 >>> 30) & 2); // 2·sign(x) + sign(y)
  const ix = ix0 & 0x7fffffff;
  const iy = iy0 & 0x7fffffff;
  if ((iy | ly) === 0) {
    if (m <= 1) return y;
    return m === 2 ? PI : -PI;
  }
  if ((ix | lx) === 0) return m & 1 ? -PI / 2 : PI / 2;
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      if (m === 0) return PI / 4;
      if (m === 1) return -PI / 4;
      if (m === 2) return (3 * PI) / 4;
      return (-3 * PI) / 4;
    }
    if (m === 0) return 0.0;
    if (m === 1) return -0.0;
    if (m === 2) return PI;
    return -PI;
  }
  if (ix + (64 << 20) < iy || iy === 0x7ff00000) return m & 1 ? -PI / 2 : PI / 2;
  const z = m & 2 && iy + (64 << 20) < ix ? 0 : atan(Math.abs(y / x));
  if (m === 0) return z;
  if (m === 1) return -z;
  if (m === 2) return PI - (z - PI_LO);
  return z - PI_LO - PI;
}

const PIO2_HI = 1.5707963267948966;
const PIO2_LO = 6.123233995736766e-17;
const PS0 = 0.16666666666666666;
const PS1 = -0.3255658186224009;
const PS2 = 0.20121253213486293;
const PS3 = -0.04005553450067941;
const PS4 = 0.0007915349942898145;
const PS5 = 0.00003479331075960212;
const QS1 = -2.403394911734414;
const QS2 = 2.0209457602335057;
const QS3 = -0.6882839716054533;
const QS4 = 0.07703815055590194;

function rAsin(z: number): number {
  const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
  const q = 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  return p / q;
}

function asin(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (ix === 0x3ff00000 && lowWord(x) === 0) return x * PIO2_HI; // ±1
    return NaN;
  }
  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix < 0x3e500000) return x;
    return x + x * rAsin(x * x);
  }
  const z = (1 - Math.abs(x)) * 0.5;
  const s = Math.sqrt(z);
  const r = rAsin(z);
  let result: number;
  if (ix >= 0x3fef3333) {
    result = PIO2_HI - (2 * (s + s * r) - PIO2_LO);
  } else {
    const f = clearLow(s);
    const c = (z - f * f) / (s + f);
    result = 0.5 * PIO2_HI - (2 * s * r - (PIO2_LO - 2 * c) - (0.5 * PIO2_HI - 2 * f));
  }
  return hx >>> 31 ? -result : result;
}

function acos(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (ix === 0x3ff00000 && lowWord(x) === 0) return hx >>> 31 ? 2 * PIO2_HI : 0;
    return NaN;
  }
  if (ix < 0x3fe00000) {
    if (ix <= 0x3c600000) return PIO2_HI;
    return PIO2_HI - (x - (PIO2_LO - x * rAsin(x * x)));
  }
  if (hx >>> 31) {
    const z = (1.0 + x) * 0.5;
    const s = Math.sqrt(z);
    const w = rAsin(z) * s - PIO2_LO;
    return 2 * (PIO2_HI - (s + w));
  }
  const z = (1.0 - x) * 0.5;
  const s = Math.sqrt(z);
  const df = clearLow(s);
  const c = (z - df * df) / (s + df);
  const w = rAsin(z) * s + c;
  return 2 * (df + w);
}

// ------------------------------------------------------------------ exp / log

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INVLN2 = 1.4426950408889634;
const P1 = 0.16666666666666602;
const P2 = -0.0027777777777015593;
const P3 = 0.00006613756321437934;
const P4 = -0.0000016533902205465252;
const P5 = 4.1381367970572385e-8;
const EXP_OVERFLOW = 709.782712893384;
const EXP_UNDERFLOW = -745.1332191019411;

/** fdlibm's e_exp.c (FreeBSD's, which V8 runs). */
function exp(x: number): number {
  const hx0 = highWord(x);
  const xsb = hx0 >>> 31;
  const hx = hx0 & 0x7fffffff;
  if (hx >= 0x40862e42) {
    // |x| >= 709.78 or NaN
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lowWord(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0; // exp(±∞) = ∞, 0
    }
    if (x > EXP_OVERFLOW) return Infinity;
    if (x < EXP_UNDERFLOW) return 0;
  }
  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx > 0x3fd62e42) {
    // |x| > ln2 / 2
    if (hx < 0x3ff0a2b2) {
      // and |x| < 1.5 ln2. V8 returns E for exp(1): the reduction below gets its last bit wrong.
      if (x === 1) return Math.E;
      hi = xsb === 0 ? x - LN2_HI : x + LN2_HI;
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INVLN2 * x + (xsb === 0 ? 0.5 : -0.5));
      hi = x - k * LN2_HI; // exact
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    // |x| < 2^-28
    return 1 + x;
  }
  const t = x * x;
  const twopk = k >= -1021 ? fromWords((0x3ff + k) << 20, 0) : fromWords((0x3ff + (k + 1000)) << 20, 0);
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2.0) - x);
  const y = 1 - (lo - (x * c) / (2.0 - c) - hi);
  if (k >= -1021) {
    if (k === 1024) return y * 2.0 * pow2(1023);
    return y * twopk;
  }
  return y * twopk * pow2(-1000);
}

const LG1 = 0.6666666666666735;
const LG2 = 0.3999999999940942;
const LG3 = 0.2857142874366239;
const LG4 = 0.22222198432149784;
const LG5 = 0.1818357216161805;
const LG6 = 0.15313837699209373;
const LG7 = 0.14798198605116586;

/** Shared outputs of `logReduce`: x = 2^LK · (1 + LF), with LS = LF/(2+LF), LHFSQ = LF²/2, LR the polynomial. */
let LK = 0;
let LF = 0;
let LS = 0;
let LHFSQ = 0;
let LR = 0;

/**
 * fdlibm's shared log reduction. Returns a special result (±∞, NaN, 0 for x == 1) or undefined when
 * the outputs above hold the reduced argument.
 */
function logReduce(x: number): number | undefined {
  let hx = highWord(x);
  let k = 0;
  if (hx < 0x00100000 || hx >>> 31) {
    if ((hx & 0x7fffffff) === 0 && lowWord(x) === 0) return -Infinity; // ±0
    if (hx >>> 31) return NaN; // negative (or a NaN with the sign bit set)
    k -= 54; // subnormal: scale up
    x *= 18014398509481984; // 2^54
    hx = highWord(x);
  } else if (hx >= 0x7ff00000) {
    return x;
  } else if (hx === 0x3ff00000 && lowWord(x) === 0) {
    return 0;
  }
  hx += 0x3ff00000 - 0x3fe6a09e;
  k += (hx >>> 20) - 0x3ff;
  hx = (hx & 0x000fffff) + 0x3fe6a09e;
  x = fromWords(hx, lowWord(x));
  const f = x - 1.0;
  const hfsq = 0.5 * f * f;
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  LK = k;
  LF = f;
  LS = s;
  LHFSQ = hfsq;
  LR = t2 + t1;
  return undefined;
}

/** fdlibm's e_log.c (what V8 runs). */
function log(x: number): number {
  let hx = highWord(x) | 0;
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity; // ±0
    if (hx < 0) return NaN; // negative
    k -= 54; // subnormal: scale up
    x *= 18014398509481984; // 2^54
    hx = highWord(x) | 0;
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = fromWords(hx | (i ^ 0x3ff00000), lowWord(x)); // normalise x or x/2
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {
    // -2^-20 <= f < 2^-20
    if (f === 0) {
      if (k === 0) return 0;
      return k * LN2_HI + k * LN2_LO;
    }
    const R = f * f * (0.5 - 0.3333333333333333 * f);
    if (k === 0) return f - R;
    return k * LN2_HI - (R - k * LN2_LO - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f);
}

const IVLN10 = 0.4342944819032518;
const LOG10_2HI = 0.30102999566361177;
const LOG10_2LO = 3.694239077158931e-13;
const IVLN2HI = 1.4426950407214463;
const IVLN2LO = 1.6751713164886512e-10;

/** fdlibm's e_log10.c (what V8 runs): n·log10(2) + log10(m) through `log`. */
function log10(x: number): number {
  let hx = highWord(x) | 0;
  let lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= 18014398509481984;
    hx = highWord(x) | 0;
    lx = lowWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  if (hx === 0x3ff00000 && lx === 0) return 0;
  k += (hx >> 20) - 1023;
  const i = (k & 0x80000000) >>> 31;
  hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
  const y = k + i;
  x = fromWords(hx, lx);
  const z = y * LOG10_2LO + IVLN10 * log(x);
  return z + y * LOG10_2HI;
}

function log2(x: number): number {
  const special = logReduce(x);
  if (special !== undefined) return special;
  const hi = clearLow(LF - LHFSQ);
  const lo = LF - hi - LHFSQ + LS * (LHFSQ + LR);
  let valHi = hi * IVLN2HI;
  let valLo = (lo + hi) * IVLN2LO + lo * IVLN2HI;
  const y = LK;
  const w = y + valHi;
  valLo += y - w + valHi;
  valHi = w;
  return valLo + valHi;
}

// ------------------------------------------------------------------ pow (fdlibm's e_pow.c)

const DP_H1 = 0.5849624872207642;
const DP_L1 = 1.350039202129749e-8;
const TWO53 = 9007199254740992;
const L1 = 0.5999999999999946;
const L2 = 0.4285714285785502;
const L3 = 0.33333332981837743;
const L4 = 0.272728123808534;
const L5 = 0.23066074577556175;
const L6 = 0.20697501780033842;
const LG2_ = 0.6931471805599453;
const LG2_H = 0.6931471824645996;
const LG2_L = -1.904654299957768e-9;
const OVT = 8.008566259537294e-17;
const CP = 0.9617966939259756;
const CP_H = 0.9617967009544373;
const CP_L = -7.028461650952758e-9;
const IVLN2 = 1.4426950408889634;
const IVLN2_H = 1.4426950216293335;
const IVLN2_L = 1.9259629911266175e-8;

/** fdlibm's __ieee754_pow, with ECMAScript's NaN for (±1)^±∞ (V8 does the same). */
function pow(x: number, y: number): number {
  const hx = highWord(x) | 0;
  const lx = lowWord(x);
  const hy = highWord(y) | 0;
  const ly = lowWord(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;

  if ((iy | ly) === 0) return 1; // y == ±0
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return NaN;

  // yisint: 0 = not an integer, 1 = odd integer, 2 = even integer (only needed for x < 0).
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) yisint = 2;
    else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        const j = ly >>> (52 - k);
        if ((j << (52 - k)) >>> 0 === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        const j = iy >> (20 - k);
        if (j << (20 - k) === iy) yisint = 2 - (j & 1);
      }
    }
  }

  if (ly === 0) {
    if (iy === 0x7ff00000) {
      // y = ±∞
      if (ix === 0x3ff00000 && lx === 0) return NaN; // (±1)^±∞ is NaN in ECMAScript
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0;
      return hy < 0 ? -y : 0;
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1 / x : x; // y = ±1
    if (hy === 0x40000000) return x * x; // y = 2
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x); // y = 0.5, x >= +0
  }

  let ax = Math.abs(x);
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    // x = ±0, ±∞, ±1
    let z = ax;
    if (hy < 0) z = 1 / z;
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0) z = NaN; // (-1)^non-integer
      else if (yisint === 1) z = -z;
    }
    return z;
  }

  let n = (hx >>> 31) ^ 1; // 0 for negative x, else 1 (fdlibm's (hx>>31)+1)
  if ((n | yisint) === 0) return NaN; // negative^non-integer
  let s = 1;
  if ((n | (yisint - 1)) === 0) s = -1; // negative^odd

  let t1: number;
  let t2: number;
  if (iy > 0x41e00000) {
    // |y| > 2^31
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? Infinity : 0;
      if (ix >= 0x3ff00000) return hy > 0 ? Infinity : 0;
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * Infinity : s * 0;
    if (ix > 0x3ff00000) return hy > 0 ? s * Infinity : s * 0;
    // |1 - x| <= 2^-20: log(x) by its series.
    const t = ax - 1;
    const w = t * t * (0.5 - t * (0.3333333333333333 - t * 0.25));
    const u = IVLN2_H * t;
    const v = t * IVLN2_L - w * IVLN2;
    t1 = clearLow(u + v);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    if (ix < 0x00100000) {
      ax *= TWO53;
      n -= 53;
      ix = highWord(ax);
    }
    n += (ix >> 20) - 0x3ff;
    const j = ix & 0x000fffff;
    ix = j | 0x3ff00000;
    let k: number;
    if (j <= 0x3988e) k = 0; // |x| < √(3/2)
    else if (j < 0xbb67a) k = 1; // |x| < √3
    else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = fromWords(ix, lowWord(ax));
    const bp = k === 0 ? 1.0 : 1.5;
    const dpH = k === 0 ? 0 : DP_H1;
    const dpL = k === 0 ? 0 : DP_L1;
    // ss = s_h + s_l = (x - 1)/(x + 1) or (x - 1.5)/(x + 1.5)
    let u = ax - bp;
    let v = 1 / (ax + bp);
    const ss = u * v;
    const sH = clearLow(ss);
    let tH = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let tL = ax - (tH - bp);
    const sL = v * (u - sH * tH - sH * tL);
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sL * (sH + ss);
    s2 = sH * sH;
    tH = clearLow(3.0 + s2 + r);
    tL = r - (tH - 3.0 - s2);
    u = sH * tH;
    v = sL * tH + tL * ss;
    const pH = clearLow(u + v);
    const pL = v - (pH - u);
    const zH = CP_H * pH;
    const zL = CP_L * pH + pL * CP + dpL;
    const t = n;
    t1 = clearLow(zH + zL + dpH + t);
    t2 = zL - (t1 - t - dpH - zH);
  }

  // (y1 + y2)·(t1 + t2)
  const y1 = clearLow(y);
  const pL = (y - y1) * t1 + y * t2;
  let pH = y1 * t1;
  let z = pL + pH;
  let j = highWord(z) | 0;
  let i = lowWord(z);
  if (j >= 0x40900000) {
    // z >= 1024
    if (((j - 0x40900000) | i) !== 0) return s * Infinity;
    if (pL + OVT > z - pH) return s * Infinity;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    // z <= -1075
    if (((j - 0xc090cc00) | i) !== 0) return s * 0;
    if (pL <= z - pH) return s * 0;
  }
  // 2^(pH + pL)
  i = j & 0x7fffffff;
  let k = (i >> 20) - 0x3ff;
  n = 0;
  if (i > 0x3fe00000) {
    n = j + (0x00100000 >> (k + 1));
    k = ((n & 0x7fffffff) >> 20) - 0x3ff;
    const t = fromWords(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    pH -= t;
  }
  const t = clearLow(pL + pH);
  const u = t * LG2_H;
  const v = (pL - (t - pH)) * LG2_ + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  const tt = z * z;
  const tt1 = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * tt1) / (tt1 - 2) - (w + z * w);
  z = 1 - (r - z);
  j = highWord(z) | 0;
  j += n << 20;
  if (j >> 20 <= 0) z = scalbn(z, n);
  else z = fromWords(j, lowWord(z));
  return s * z;
}

// ------------------------------------------------------------------ cbrt / hypot

const B1 = 715094163;
const B2 = 696219795;
const CP0 = 1.87595182427177;
const CP1 = -1.8849797954337717;
const CP2 = 1.6214297201053545;
const CP3 = -0.758397934778766;
const CP4 = 0.14599619288661245;

function cbrt(x: number): number {
  const hx0 = highWord(x);
  const sign = hx0 & 0x80000000;
  let hx = hx0 & 0x7fffffff;
  if (hx >= 0x7ff00000) return x + x;
  let t: number;
  if (hx < 0x00100000) {
    // zero or subnormal
    t = x * 18014398509481984; // 2^54
    hx = highWord(t) & 0x7fffffff;
    if (hx === 0 && lowWord(t) === 0) return x;
    hx = Math.floor(hx / 3) + B2;
  } else {
    hx = Math.floor(hx / 3) + B1;
  }
  t = fromWords(sign | hx, 0);
  let r = t * t * (t / x);
  t = t * (CP0 + r * (CP1 + r * CP2) + r * r * r * (CP3 + r * CP4));
  // Round t away from zero to 23 bits.
  let lo = lowWord(t) + 0x80000000;
  let hi = highWord(t);
  if (lo >= 0x100000000) {
    lo -= 0x100000000;
    hi = (hi + 1) >>> 0;
  }
  t = fromWords(hi, lo & 0xc0000000);
  const s = t * t;
  r = x / s;
  const w = t + t;
  r = (r - t) / (w + r);
  return t + t * r;
}

const SPLIT = 134217729; // 2^27 + 1, Dekker's split

let HSUM_HI = 0;
let HSUM_LO = 0;

/** Add v² (exact, as hi + lo by Dekker's split) to the running sums. */
function addSquare(v: number): void {
  const xc = v * SPLIT;
  const xh = v - xc + xc;
  const xl = v - xh;
  const hi = v * v;
  const lo = xh * xh - hi + 2 * xh * xl + xl * xl;
  HSUM_HI += hi;
  HSUM_LO += lo;
}

/**
 * √(x² + y² + z² + w²) — ECMAScript `Math.hypot` for up to four arguments (missing ones are 0), with
 * its special cases: any ±∞ gives +∞, otherwise any NaN gives NaN.
 */
function hypot(x: number, y = 0, z = 0, w = 0): number {
  x = Math.abs(x);
  y = Math.abs(y);
  z = Math.abs(z);
  w = Math.abs(w);
  if (x === Infinity || y === Infinity || z === Infinity || w === Infinity) return Infinity;
  if (x !== x || y !== y || z !== z || w !== w) return NaN;
  const m = Math.max(x, y, z, w);
  if (m === 0) return 0;
  const biased = (highWord(m) >>> 20) & 0x7ff;
  if (biased === 0) {
    // The largest is subnormal: bring everything into the normal range first.
    const up = pow2(600);
    return scalbn(hypot(x * up, y * up, z * up, w * up), -600);
  }
  // Scale so the largest is in [1, 2): squares cannot overflow, and the scaling is exact.
  const scale = 1023 - biased;
  x = scalbn(x, scale);
  y = scalbn(y, scale);
  z = scalbn(z, scale);
  w = scalbn(w, scale);
  HSUM_HI = 0;
  HSUM_LO = 0;
  // Smallest first, so the large terms are added last.
  addSquare(w);
  addSquare(z);
  addSquare(y);
  addSquare(x);
  return scalbn(Math.sqrt(HSUM_LO + HSUM_HI), -scale);
}

// ------------------------------------------------------------------ public surface

/**
 * Engine-independent replacements for the `Math` functions ECMAScript leaves implementation-
 * approximated. Same names and special cases as `Math`; `hypot` takes up to four arguments.
 */
export const DMath = Object.freeze({
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  atan2,
  exp,
  log,
  log2,
  log10,
  pow,
  cbrt,
  hypot,
});

export type DeterministicMath = typeof DMath;

/**
 * The `Math` functions ECMAScript marks implementation-approximated, which therefore may differ between
 * JavaScript engines (and which simulation code must not call). `DMath` covers the ones the engine uses.
 */
export const APPROXIMATED_MATH_FUNCTIONS = Object.freeze([
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atanh",
  "atan2",
  "cbrt",
  "cos",
  "cosh",
  "exp",
  "expm1",
  "hypot",
  "log",
  "log1p",
  "log10",
  "log2",
  "pow",
  "sin",
  "sinh",
  "tan",
  "tanh",
] as const);
