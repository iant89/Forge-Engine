/**
 * Fog transmittance (Phase 8a) — the CPU twin of `fogTransmittance` in the standard shader
 * (`rendering/shaders/common.ts`, `WGSL_FOG`). Both take the same inputs (`SceneSettings.fog`,
 * camera height, surface height, Euclidean distance) and must return the same number; the tests
 * compare this file against a brute-force integral of the height-fog density, and the shader text
 * is the same formula transcribed.
 *
 * Modes (`SceneSettings.fog.mode`):
 *  - `linear`: transmittance falls from 1 at `start` to 0 at `end`;
 *  - `exp2`:   `exp(−(d·density)²)`;
 *  - `height`: exponential density `density · exp(−falloff · (y − base))` integrated in closed
 *              form along the camera→surface segment, so fog pools in valleys and thins with height.
 *
 * The result is the fraction of the surface colour that survives; the shader blends
 * `mix(fogColor, color, transmittance)`.
 */

import type { SceneFogSettings } from "../scene/scene.js";

/** Numeric ids the shader receives in `fogParams.x`. */
export const FOG_MODE_ID = { none: 0, linear: 1, exp2: 2, height: 3 } as const;

export function fogTransmittanceLinear(distance: number, start: number, end: number): number {
  if (end <= start) return distance < end ? 1 : 0;
  const f = (end - distance) / (end - start);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

export function fogTransmittanceExp2(distance: number, density: number): number {
  const x = distance * density;
  return Math.exp(-x * x);
}

/**
 * Optical depth of `density · exp(−falloff · (y − base))` along a straight segment of length
 * `distance` from height `cameraY` to height `surfaceY` (closed form; the `|falloff·Δy|` → 0 limit
 * is the plain exponential fog).
 */
export function heightFogOpticalDepth(distance: number, cameraY: number, surfaceY: number, density: number, falloff: number, base: number): number {
  const dy = surfaceY - cameraY;
  const startDensity = density * Math.exp(-falloff * (cameraY - base));
  const k = falloff * dy;
  const factor = Math.abs(k) > 1e-4 ? (1 - Math.exp(-k)) / k : 1 - 0.5 * k;
  return startDensity * factor * distance;
}

export function fogTransmittanceHeight(distance: number, cameraY: number, surfaceY: number, density: number, falloff: number, base: number): number {
  return Math.exp(-heightFogOpticalDepth(distance, cameraY, surfaceY, density, falloff, base));
}

/** Transmittance for a scene's fog settings between the camera and a surface point. */
export function fogTransmittance(fog: SceneFogSettings, distance: number, cameraY: number, surfaceY: number): number {
  switch (fog.mode) {
    case "linear":
      return fogTransmittanceLinear(distance, fog.start, fog.end);
    case "exp2":
      return fogTransmittanceExp2(distance, fog.density);
    case "height":
      return fogTransmittanceHeight(distance, cameraY, surfaceY, fog.density, fog.heightFalloff, fog.heightBase);
    default:
      return 1;
  }
}
