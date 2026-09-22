/**
 * Simplified Pacejka "magic formula" for longitudinal and lateral tire force.
 *
 * `F = D · sin(C · atan(B·x − E·(B·x − atan(B·x))))`.
 * `D` is the peak force (typically `μ · Fz`). The function is odd in `x`, so a positive
 * longitudinal slip (wheel spinning faster than the ground) produces a positive drive force,
 * and a positive slip angle must be negated by the caller if the force should oppose the slip.
 *
 * This is the steady-state formula, not a combined-slip MF6.1 model. The vehicle applies a
 * friction circle after the two axes are evaluated. Coefficients are dimensionless except `D`.
 */

export interface PacejkaCoefficients {
  /** Stiffness factor. Larger → peak at a smaller slip. */
  B: number;
  /** Shape factor. ~1.65 longitudinal, ~1.3 lateral. */
  C: number;
  /** Peak value. For a tire this is `μ · normalLoad`. */
  D: number;
  /** Curvature factor. < 1 keeps a physical peak. */
  E: number;
}

export const DEFAULT_LONGITUDINAL: Omit<PacejkaCoefficients, "D"> = { B: 10, C: 1.65, E: 0.97 };
export const DEFAULT_LATERAL: Omit<PacejkaCoefficients, "D"> = { B: 8.5, C: 1.3, E: 0.97 };

/** Magic formula. Pure; no allocation. */
export function pacejka(slip: number, coeff: PacejkaCoefficients): number {
  const Bx = coeff.B * slip;
  const atanBx = Math.atan(Bx);
  return coeff.D * Math.sin(coeff.C * Math.atan(Bx - coeff.E * (Bx - atanBx)));
}

/**
 * Slip at which `|pacejka|` peaks for `D = 1`. Sampled, not solved in closed form — the formula's
 * peak has no cheap analytic inverse, and a 0.25% slip grid is finer than the ABS deadband.
 */
export function pacejkaPeakSlip(coeff: Omit<PacejkaCoefficients, "D">): number {
  let bestSlip = 0.1;
  let best = 0;
  for (let i = 1; i <= 400; i++) {
    const slip = i * 0.0025;
    const f = Math.abs(pacejka(slip, { ...coeff, D: 1 }));
    if (f > best) {
      best = f;
      bestSlip = slip;
    }
  }
  return bestSlip;
}

/** Shape factor at `slip` (force divided by `D`), in [-1, 1]. */
export function pacejkaShape(slip: number, coeff: Omit<PacejkaCoefficients, "D">): number {
  return pacejka(slip, { ...coeff, D: 1 });
}

/**
 * ∂F/∂slip. Used by the wheel integrator so a stiff tire is implicit instead of oscillating at 120 Hz.
 * Positive on the rising face, ~0 at the peak, negative past it.
 */
export function pacejkaDerivative(slip: number, coeff: PacejkaCoefficients): number {
  const Bx = coeff.B * slip;
  const atanBx = Math.atan(Bx);
  const u = Bx - coeff.E * (Bx - atanBx);
  const bx2 = Bx * Bx;
  const du = coeff.B * (1 - (coeff.E * bx2) / (1 + bx2));
  const atanU = Math.atan(u);
  return coeff.D * Math.cos(coeff.C * atanU) * coeff.C * (1 / (1 + u * u)) * du;
}
