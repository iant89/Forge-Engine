/** Winter scene snowpack: a small game-scale amount keeps accumulation visible during a demo. */
export const ALPINE_SNOWPACK_INITIAL_DEPTH_M = 0.035;
export const ALPINE_SNOWPACK_MAX_DEPTH_M = 0.55;
export const ALPINE_SNOWPACK_RATE_MPS = 0.006;

/**
 * Deposit snow on the alpine route. The visual snowfall is already classified as snow by this
 * winter scene, so precipitation directly contributes to the pack; dry weather leaves it settled.
 */
export function advanceAlpineSnowpack(depthM: number, precipitation01: number, dtSeconds: number): number {
  const depth = Number.isFinite(depthM) ? Math.max(0, Math.min(ALPINE_SNOWPACK_MAX_DEPTH_M, depthM)) : 0;
  const precipitation = Number.isFinite(precipitation01) ? Math.max(0, Math.min(1, precipitation01)) : 0;
  const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
  return Math.min(ALPINE_SNOWPACK_MAX_DEPTH_M, depth + precipitation * ALPINE_SNOWPACK_RATE_MPS * dt);
}
