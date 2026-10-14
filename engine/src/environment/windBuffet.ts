/**
 * Wind buffeting (fe-34): a camera (or any light, hand-held object) shaken by gusts — a pure,
 * deterministic offset/roll from smooth noise whose amplitude grows with the square of the wind and
 * jumps with each gust. Hosts add it to the camera transform after their controller runs.
 */

export interface WindBuffet {
  /** Positional jitter (m). */
  x: number;
  y: number;
  z: number;
  /** Roll / pitch jitter (rad). */
  roll: number;
  pitch: number;
}

function smooth(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (k: number): number => {
    const v = Math.sin(k * 91.7 + seed * 47.3) * 43758.5453;
    return v - Math.floor(v);
  };
  const u = f * f * (3 - 2 * f);
  return (h(i) * (1 - u) + h(i + 1) * u) * 2 - 1;
}

/**
 * Buffet at `seconds` for a wind speed (m/s) and gust 0..1. `strength` scales it (1 ≈ hand-held
 * camera on a beach: ~0.25 m and ~1.2° at 70 m/s in a gust). Zero in calm air.
 */
export function windBuffet(seconds: number, windSpeed: number, gust: number, strength = 1, out: WindBuffet = { x: 0, y: 0, z: 0, roll: 0, pitch: 0 }): WindBuffet {
  const w = Math.max(0, windSpeed) / 70;
  const a = strength * w * w * (0.45 + 0.9 * Math.max(0, Math.min(1, gust)));
  // Two bands: a slow lean (≈0.7 Hz) and a fast shudder (≈6 Hz).
  const slow = seconds * 0.7;
  const fast = seconds * 6.3;
  out.x = a * (0.18 * smooth(slow, 1) + 0.05 * smooth(fast, 2));
  out.y = a * (0.08 * smooth(slow, 3) + 0.04 * smooth(fast, 4));
  out.z = a * (0.18 * smooth(slow, 5) + 0.05 * smooth(fast, 6));
  out.roll = a * (0.016 * smooth(slow, 7) + 0.006 * smooth(fast, 8));
  out.pitch = a * (0.01 * smooth(slow, 9) + 0.005 * smooth(fast, 10));
  return out;
}
