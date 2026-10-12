/**
 * Multiple scattering (Phase 17.1): the second-and-later orders `AtmosphereModel` and the sky pass
 * leave out, precomputed into a small table.
 *
 * Single scattering makes the sky about 3× darker than a real one relative to the sun, keeps the
 * twilight far too short (the glow after sunset is almost entirely multiple scattering), and reads
 * yellow rather than white at the horizon on Earth. This module integrates the term the cheap way
 * the literature settled on: the higher orders are approximated by an isotropic source
 *
 *     J1(x) = (1 / 4π) ∫ L1(x, ω) dω       (the mean single-scattered radiance around x)
 *
 * which is nearly constant over directions, so the whole cascade of higher orders collapses into a
 * geometric series with the local scattering ratio ρ(x) once per channel:
 *
 *     L_ms(x) ≈ F(x) / (1 − ρ(x))         F(x) = (1 / 4π) ∫ T(x, ω) · σ_s(x) · L1(x, ω) dω
 *
 * `F` is what the table stores: the *source* the higher orders pour into x, per unit sun intensity,
 * per channel, already weighted by the transmittance from viewer to x. The result depends only on
 * the height above sea level and the sun's zenith cosine at x (the atmosphere is spherically
 * symmetric), so a `heightSamples × sunSamples` table covers every case the engine can present.
 *
 * `AtmosphereModel.skyRadiance` then adds
 *
 *     Σ samples  T_view(x, c) · (σ_R,c·ρ_R(x) + σ_M,c·ρ_M(x)) · J_ms,c(x)
 *
 * with one bilinear lookup per march step, and the sky shader adds the same term from the same
 * table through its own binding. Both readers share {@link MultiScatteringField.sample}, so the CPU
 * and GPU paths agree by construction; {@link MULTI_SCATTERING_GPU} is the resolution the compute
 * pass builds and {@link MULTI_SCATTERING_CPU} the finer one the reference and the tests use.
 *
 * Deliberate limits: no ground bounce (the planet is black below the horizon), no
 * wavelength-dependent phase for the higher orders (they are treated as isotropic), and a hard
 * clamp on the series ratio (`maxSeriesRatio`) where the atmosphere is dense enough that the series
 * would not converge. `docs/ENVIRONMENT.md` §8.
 */

import { type AtmosphereModel, clampMieAnisotropy, miePhase, rayleighPhase, raySphereEntry, raySphereExit } from "./atmosphere.js";

/** Resolution and cost knobs of one {@link MultiScatteringField}. */
export interface MultiScatteringConfig {
  /** Table rows: the height axis, `sqrt(h / atmosphereHeight)` (dense near the ground). */
  heightSamples: number;
  /** Table columns: the sun zenith cosine axis, uniform in μ (dense twilight). */
  sunSamples: number;
  /** Directions the isotropic mean integrates over, per texel (Fibonacci sphere). */
  directions: number;
  /** March segments per direction (cubic spacing, the sky integral's discretisation). */
  steps: number;
  /** Samples per transmittance-table entry. */
  lightSamples: number;
  /** τ-to-space table rows (height, same warp as the field's rows). */
  transmittanceHeights: number;
  /** τ-to-space table columns (μ, uniform). */
  transmittanceZeniths: number;
  /** Clamp on the per-channel series ratio ρ; `1` would divide by zero. */
  maxSeriesRatio: number;
}

/**
 * The reference/CPU resolution: a millisecond-scale rebuild when a day/night cycle moves the sun,
 * and the resolution the ambient (hemispherical) integrals use. Its 32 directions leave ~±17 % of
 * the sphere mean in daylight below ~25 km and a factor of ~2 at the terminator on either side of
 * 1.0 (`tests/environment/environment17.test.ts` pins the band against a 256-direction reference);
 * the device's {@link MULTI_SCATTERING_GPU} is the accurate one.
 */
export const MULTI_SCATTERING_CPU: Readonly<MultiScatteringConfig> = Object.freeze({
  heightSamples: 16,
  sunSamples: 16,
  directions: 32,
  steps: 12,
  lightSamples: 12,
  transmittanceHeights: 24,
  transmittanceZeniths: 32,
  maxSeriesRatio: 0.9,
});

/**
 * The resolution the GPU compute pass builds (`rendering/shaders/multiScattering.ts` reads every
 * number from here). The device can afford eight times the table, 1.5× the directions and twice the
 * march segments of {@link MULTI_SCATTERING_CPU}, which is what it takes to sit within ~±5 % of the
 * direct sphere mean at every height in daylight (`tests/environment/environment17.test.ts` pins
 * both).
 * `MultiScatteringField` accepts this config on the CPU too, which is how the tests compare the two
 * twins at identical numbers.
 */
export const MULTI_SCATTERING_GPU: Readonly<MultiScatteringConfig> = Object.freeze({
  heightSamples: 32,
  sunSamples: 32,
  directions: 48,
  steps: 24,
  lightSamples: 12,
  transmittanceHeights: 24,
  transmittanceZeniths: 32,
  maxSeriesRatio: 0.9,
});

/** Texels a building pass writes for a configuration (one invocation per texel). */
export function multiScatteringTexels(config: Readonly<MultiScatteringConfig> = MULTI_SCATTERING_GPU): number {
  return config.heightSamples * config.sunSamples;
}

/**
 * τ a blocked sun ray stores in the transmittance table: `exp(-τ)` is exactly 0 in both f64 and
 * f32, and interpolating it against a neighbouring lit entry stays 0 for all practical purposes.
 */
export const MS_BLOCKED_TAU = 1e30;

/** Floats per texel: `(J_ms.rgb / sunIntensity, mean ρ)`. */
export const MS_LUT_FLOATS_PER_TEXEL = 4;

/** Row coordinate of a height: `sqrt(h / atmosphereHeight)` — dense near the ground. */
export function multiScatteringHeightParam(height: number, atmosphereHeight: number): number {
  if (!(height > 0) || !(atmosphereHeight > 0)) return 0;
  const t = height / atmosphereHeight;
  return t >= 1 ? 1 : Math.sqrt(t);
}

/**
 * Column coordinate of a sun elevation cosine: `1/2 + sign(μ)·√|μ|/2`, dense around μ = 0.
 *
 * A uniform μ axis is the wrong shape for this table. What the table stores changes by *orders of
 * magnitude* when the sun crosses a given height's own horizon (the terminator), and that happens
 * within |μ| ≲ 0.1 — at 16 uniform columns the whole twilight band falls between two texels, which
 * measured 8-18× off against a converged reference. The square-root warp spends a third of the
 * columns inside |μ| < 0.15 and still covers the full sky monotonically.
 */
export function multiScatteringSunParam(muSun: number): number {
  if (muSun <= -1) return 0;
  if (muSun >= 1) return 1;
  return 0.5 + 0.5 * Math.sign(muSun) * Math.sqrt(Math.abs(muSun));
}

/** Inverse of {@link multiScatteringSunParam}: the μ of a column coordinate (a texel's centre). */
export function multiScatteringSunFromParam(param: number): number {
  const u = 2 * param - 1;
  return Math.sign(u) * u * u;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * The multiple-scattering table for one atmosphere. Build it from a model (`new MultiScatteringField(
 * model, MULTI_SCATTERING_CPU)`), install it on that model (`model.multiScattering = field`) so the
 * model's own radiance includes it, and/or let the renderer install the GPU twin.
 *
 * The build reads the model's params and never mutates them; if the params change afterwards the
 * field is stale and must be rebuilt (the renderer rebuilds when the sun or the atmosphere moves).
 * The model is borrowed, not owned: nothing here holds it alive.
 */
export class MultiScatteringField {
  /** `heightSamples × sunSamples × 4`: rgb = `J_ms / sunIntensity`, a = mean ρ. */
  readonly data: Float32Array;
  /** Per-channel ρ per texel (`3` floats), kept for diagnostics — not what the GPU stores. */
  readonly seriesRatio: Float64Array;
  /** How long {@link build} took, ms (the renderer logs/measures this; 0 until built). */
  buildMs = 0;

  private readonly model: AtmosphereModel;
  private readonly config: MultiScatteringConfig;
  private readonly directionCount: number;
  private readonly dirs: Float64Array;
  private readonly sunTransmittanceTable: Float64Array;

  constructor(model: AtmosphereModel, config: Readonly<MultiScatteringConfig> = MULTI_SCATTERING_GPU) {
    this.model = model;
    this.config = { ...config };
    this.data = new Float32Array(multiScatteringTexels(config) * MS_LUT_FLOATS_PER_TEXEL);
    this.seriesRatio = new Float64Array(multiScatteringTexels(config) * 3);
    this.sunTransmittanceTable = new Float64Array(config.transmittanceHeights * config.transmittanceZeniths * 3);
    this.directionCount = config.directions;
    this.dirs = new Float64Array(config.directions * 3);
    for (let d = 0; d < config.directions; d++) {
      const cosT = 1 - (2 * (d + 0.5)) / config.directions;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const phi = d * GOLDEN_ANGLE;
      this.dirs[d * 3] = sinT * Math.cos(phi);
      this.dirs[d * 3 + 1] = cosT;
      this.dirs[d * 3 + 2] = sinT * Math.sin(phi);
    }
    this.build();
  }

  /** The configuration this field was built with. */
  get configUsed(): Readonly<MultiScatteringConfig> {
    return this.config;
  }

  /** Index of the texel a nearest lookup resolves to (`height` clamped up, μ below the horizon → 0). */
  texelIndex(height: number, muSun: number): number {
    const { heightSamples: hs, sunSamples: ss } = this.config;
    const x = multiScatteringHeightParam(Math.max(0, height), this.model.params.atmosphereHeight) * (hs - 1);
    const y = multiScatteringSunParam(muSun) * (ss - 1);
    return Math.round(x) * ss + Math.round(y);
  }

  /**
   * Bilinear `(J_ms / sunIntensity)` at a point inside the atmosphere: the height picks the row, the
   * sun's cosine there picks the column. This is the one reader both the model and the shader use.
   */
  sample(height: number, muSun: number, out: Float64Array): Float64Array {
    const { heightSamples: hs, sunSamples: ss } = this.config;
    const x = multiScatteringHeightParam(Math.max(0, height), this.model.params.atmosphereHeight) * (hs - 1);
    const y = multiScatteringSunParam(muSun) * (ss - 1);
    const x0 = Math.min(hs - 2, Math.max(0, Math.floor(x)));
    const y0 = Math.min(ss - 2, Math.max(0, Math.floor(y)));
    const fx = x - x0;
    const fy = y - y0;
    const data = this.data;
    const o = (x0 * ss + y0) * MS_LUT_FLOATS_PER_TEXEL;
    for (let c = 0; c < 3; c++) {
      const a = data[o + c]!;
      const b = data[o + MS_LUT_FLOATS_PER_TEXEL + c]!;
      const d = data[o + ss * MS_LUT_FLOATS_PER_TEXEL + c]!;
      const e = data[o + (ss + 1) * MS_LUT_FLOATS_PER_TEXEL + c]!;
      out[c] = (a + (b - a) * fy) * (1 - fx) + (d + (e - d) * fy) * fx;
    }
    return out;
  }

  /** Nearest-texel value per channel (no interpolation) — what the tests pin directly. */
  texelValue(height: number, muSun: number, out: Float64Array): Float64Array {
    const o = this.texelIndex(height, muSun) * MS_LUT_FLOATS_PER_TEXEL;
    out[0] = this.data[o]!;
    out[1] = this.data[o + 1]!;
    out[2] = this.data[o + 2]!;
    return out;
  }

  /** Mean series ratio of a texel (the `a` channel as the GPU stores it). */
  meanRatio(height: number, muSun: number): number {
    return this.data[this.texelIndex(height, muSun) * MS_LUT_FLOATS_PER_TEXEL + 3]!;
  }

  /** Total scattering coefficient (Rayleigh + Mie) of the model's atmosphere, per channel. */
  totalScattering(out: Float64Array): Float64Array {
    const p = this.model.params;
    for (let c = 0; c < 3; c++) out[c] = p.rayleighScattering[c]! + p.mieScattering[c]!;
    return out;
  }

  // ------------------------------------------------------------------ build

  /**
   * Transmittance to space per channel at (height, μ): the table's τ, bilinear in (height, μ) and
   * then exponentiated (`MS_BLOCKED_TAU` below the horizon → exactly 0). The table's rows reuse the
   * field's height warp, so a lookup along the row axis at a table height is exact.
   */
  private sunTransmittance(height: number, muSun: number, out: Float64Array): Float64Array {
    const { transmittanceHeights: hs, transmittanceZeniths: ss } = this.config;
    const x = multiScatteringHeightParam(Math.max(0, height), this.model.params.atmosphereHeight) * (hs - 1);
    const y = multiScatteringSunParam(muSun) * (ss - 1);
    const x0 = Math.min(hs - 2, Math.max(0, Math.floor(x)));
    const y0 = Math.min(ss - 2, Math.max(0, Math.floor(y)));
    const fx = x - x0;
    const fy = y - y0;
    const table = this.sunTransmittanceTable;
    for (let c = 0; c < 3; c++) {
      const a = table[(x0 * ss + y0) * 3 + c]!;
      const b = table[(x0 * ss + y0 + 1) * 3 + c]!;
      const d = table[((x0 + 1) * ss + y0) * 3 + c]!;
      const e = table[((x0 + 1) * ss + y0 + 1) * 3 + c]!;
      out[c] = Math.exp(-((a + (b - a) * fy) * (1 - fx) + (d + (e - d) * fy) * fx));
    }
    return out;
  }

  /**
   * Optical depth to space from a table height, cubically spaced, per channel — the table's *own*
   * ray march rather than `AtmosphereModel.transmittance`'s.
   *
   * Two reasons. Cubic spacing: at μ ≈ 0 the path is ~1000 km long and twelve *uniform* samples
   * start 40 km up where there is almost no air left, so the sun comes out far too bright exactly
   * where twilight is decided (the tangent altitude is where the scattered light is made). And the
   * table stores τ, not transmittance: near each row's horizon τ changes by *orders of magnitude*
   * within one column, and interpolating τ (a smooth, nearly linear function of μ) is right where
   * interpolating exp(−τ) is wrong by the ratio of the two endpoints — that was worth up to 8× of
   * phantom twilight light before the change.
   *
   * A blocked ray stores {@link MS_BLOCKED_TAU}; exponential of it is 0, and the interpolation
   * degrades gracefully at the shadow edge instead of flipping a hard cut inside a column.
   */
  private opticalDepthToSpace(height: number, dx: number, dy: number, dz: number, out: Float64Array): Float64Array {
    const p = this.model.params;
    const oy = p.planetRadius + Math.max(0, height);
    if (raySphereEntry(0, oy, 0, dx, dy, dz, p.planetRadius) > 0) {
      out[0] = out[1] = out[2] = MS_BLOCKED_TAU;
      return out;
    }
    const tTop = raySphereExit(0, oy, 0, dx, dy, dz, p.planetRadius + p.atmosphereHeight);
    if (tTop <= 0) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const steps = this.config.lightSamples;
    let dR = 0;
    let dM = 0;
    let dO = 0;
    let tPrev = 0;
    for (let i = 0; i < steps; i++) {
      const u = (i + 1) / steps;
      const tNext = tTop * u * u * u;
      const ds = tNext - tPrev;
      const t = 0.5 * (tPrev + tNext);
      tPrev = tNext;
      const h = Math.sqrt((dx * t) ** 2 + (oy + dy * t) ** 2 + (dz * t) ** 2) - p.planetRadius;
      dR += Math.exp(-h / p.rayleighScaleHeight) * ds;
      dM += Math.exp(-h / p.mieScaleHeight) * ds;
      dO += this.model.ozoneDensity(h) * ds;
    }
    for (let c = 0; c < 3; c++) {
      out[c] = p.rayleighScattering[c]! * dR + p.mieExtinction[c]! * dM + p.ozoneAbsorption[c]! * dO;
    }
    return out;
  }

  /** Fill the τ-to-space table: one `(height, μ)` pair per entry (`MS_BLOCKED_TAU` = blocked). */
  private buildTransmittanceTable(): void {
    const p = this.model.params;
    const { transmittanceHeights: hs, transmittanceZeniths: ss } = this.config;
    const t = SCRATCH_TRANSMITTANCE;
    for (let i = 0; i < hs; i++) {
      const hParam = i / (hs - 1);
      const height = hParam * hParam * p.atmosphereHeight;
      for (let j = 0; j < ss; j++) {
        const mu = multiScatteringSunFromParam(j / (ss - 1));
        this.opticalDepthToSpace(height, Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0, t);
        const o = (i * ss + j) * 3;
        this.sunTransmittanceTable[o] = t[0]!;
        this.sunTransmittanceTable[o + 1] = t[1]!;
        this.sunTransmittanceTable[o + 2] = t[2]!;
      }
    }
  }

  /**
   * Integrate the isotropic-source term of every texel. For each of the `directions`:
   *
   *  - march `steps` segments along a ray that ends at the ground or the top of the atmosphere;
   *  - accumulate the view transmittance, and the mean single-scattered radiance the segment
   *    *scatters further* (`phase · T_view · T_sun · σ_s · ds`, the density profile folded in);
   *  - accumulate the same with `σ_s` alone: ρ is how much light one scattering event removes from
   *    the unscattered beam and re-emits into all directions — the series ratio.
   *
   * J_ms per channel is then `(σ_R·Ȓ + σ_M·M̄) / (1 − ρ)` scaled by nothing else: the table stores
   * it per unit sun intensity, which is what `SkyUniforms.sunIntensity` divides out on the device.
   */
  private build(): void {
    const started = Date.now();
    const p = this.model.params;
    const { heightSamples: hs, sunSamples: ss, steps } = this.config;
    // The source is an isotropic average: the Mie lobe in it is evaluated with the same cap the
    // engine's own hemispherical estimates use, or a forward-peaked lobe (Mars dust) biases the
    // 16-direction mean by whichever direction happens to sit nearest the sun.
    const g = clampMieAnisotropy(p.mieAnisotropy);
    this.buildTransmittanceTable();

    const accR = SCRATCH_ACC;
    const accM = SCRATCH_ACC2;
    const accRho = SCRATCH_ACC3;
    const viewOd = SCRATCH_VIEW_OD;
    const sunT = SCRATCH_SUN_T;

    for (let hi = 0; hi < hs; hi++) {
      const hParam = hi / (hs - 1);
      const height = hParam * hParam * p.atmosphereHeight;
      const r = p.planetRadius + height;
      for (let si = 0; si < ss; si++) {
        const muSun = multiScatteringSunFromParam(si / (ss - 1));
        const sunX = Math.sqrt(Math.max(0, 1 - muSun * muSun));
        const sunY = muSun;
        accR[0] = accR[1] = accR[2] = 0;
        accM[0] = accM[1] = accM[2] = 0;
        accRho[0] = accRho[1] = accRho[2] = 0;
        for (let d = 0; d < this.directionCount; d++) {
          const dx = this.dirs[d * 3]!;
          const dy = this.dirs[d * 3 + 1]!;
          const dz = this.dirs[d * 3 + 2]!;
          const cosScatter = dx * sunX + dy * sunY;
          const phaseR = rayleighPhase(cosScatter);
          const phaseM = miePhase(cosScatter, g);
          // Distance to the top of the atmosphere, and to the ground when the ray meets it first.
          const b = r * dy;
          const tExit = -b + Math.sqrt(Math.max(0, b * b - (r * r - (p.planetRadius + p.atmosphereHeight) ** 2)));
          const groundDisc = b * b - (r * r - p.planetRadius * p.planetRadius);
          const tGround = dy < 0 && groundDisc >= 0 ? -b - Math.sqrt(groundDisc) : -1;
          const tMax = tGround >= 0 && tGround < tExit ? tGround : tExit;
          if (!(tMax > 0)) continue;
          viewOd[0] = viewOd[1] = viewOd[2] = 0;
          let tPrev = 0;
          for (let i = 0; i < steps; i++) {
            // Cubic spacing, the same discretisation the sky integral uses: a slanted ray crosses
            // hundreds of kilometres but its in-scattered light comes from the first few tens, and
            // uniform segments put too few samples there (the error is a factor of two at the
            // horizon).
            const u = (i + 1) / steps;
            const tNext = tMax * u * u * u;
            const ds = tNext - tPrev;
            const t = 0.5 * (tPrev + tNext);
            tPrev = tNext;
            const px = dx * t;
            const py = r + dy * t;
            const pz = dz * t;
            const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
            const h = len - p.planetRadius;
            const dR = Math.exp(-h / p.rayleighScaleHeight) * ds;
            const dM = Math.exp(-h / p.mieScaleHeight) * ds;
            const dO = this.model.ozoneDensity(h) * ds;
            for (let c = 0; c < 3; c++) {
              viewOd[c]! += p.rayleighScattering[c]! * dR + p.mieExtinction[c]! * dM + p.ozoneAbsorption[c]! * dO;
            }
            const viewR = Math.exp(-viewOd[0]!);
            const viewG = Math.exp(-viewOd[1]!);
            const viewB = Math.exp(-viewOd[2]!);
            // The sun's transmittance to the scattering point: a blocked sun contributes nothing
            // to *this* order (the ground bounce it would need is out of scope for the table), and
            // the table's blocked entries carry that through the interpolation as τ = MS_BLOCKED_TAU.
            const localMu = (px * sunX + py * sunY) / len;
            this.sunTransmittance(h, localMu, sunT);
            const sunR = sunT[0]!;
            const sunG = sunT[1]!;
            const sunB = sunT[2]!;
            accR[0]! += phaseR * viewR * sunR * dR;
            accR[1]! += phaseR * viewG * sunG * dR;
            accR[2]! += phaseR * viewB * sunB * dR;
            accM[0]! += phaseM * viewR * sunR * dM;
            accM[1]! += phaseM * viewG * sunG * dM;
            accM[2]! += phaseM * viewB * sunB * dM;
            accRho[0]! += viewR * (p.rayleighScattering[0]! * dR + p.mieScattering[0]! * dM);
            accRho[1]! += viewG * (p.rayleighScattering[1]! * dR + p.mieScattering[1]! * dM);
            accRho[2]! += viewB * (p.rayleighScattering[2]! * dR + p.mieScattering[2]! * dM);
          }
        }
        const inv = 1 / this.directionCount;
        const o = (hi * ss + si) * MS_LUT_FLOATS_PER_TEXEL;
        let ratioSum = 0;
        for (let c = 0; c < 3; c++) {
          const rho = Math.min(this.config.maxSeriesRatio, Math.max(0, accRho[c]! * inv));
          this.seriesRatio[(hi * ss + si) * 3 + c] = rho;
          ratioSum += rho;
          // J_ms / sunIntensity: the isotropic source of the higher orders, summed as a series.
          this.data[o + c] =
            (p.rayleighScattering[c]! * accR[c]! * inv + p.mieScattering[c]! * accM[c]! * inv) / (1 - rho);
        }
        this.data[o + 3] = ratioSum / 3;
      }
    }
    this.buildMs = Date.now() - started;
  }
}

/** Scratch buffers: one field is built at a time, on one thread, so these are shared on purpose. */
const SCRATCH_TRANSMITTANCE = new Float64Array(3);
const SCRATCH_SUN_T = new Float64Array(3);
const SCRATCH_VIEW_OD = new Float64Array(3);
const SCRATCH_ACC = new Float64Array(3);
const SCRATCH_ACC2 = new Float64Array(3);
const SCRATCH_ACC3 = new Float64Array(3);
