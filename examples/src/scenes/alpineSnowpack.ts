/**
 * Winter scene snowpack: a small game-scale amount keeps accumulation visible during a demo.
 *
 * The depth is the scene's own gameplay number (HUD, mission gate); what the player *sees* is the
 * engine's weather snow cover (`scene.settings.surface.snow`, 0..1), which the renderer settles on
 * every up-facing surface — ground, boulders, boughs, the truck's roof — and which the vehicle's
 * tyre-grip factor reads. {@link alpineSnowCover01} is the bridge between the two.
 */

/** The ground already holds a light pack when the demo opens, so it reads as winter from frame one. */
export const ALPINE_SNOWPACK_INITIAL_DEPTH_M = 0.15;
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

/**
 * The engine's snow shader saturates for flat ground at a cover of about 0.43 (`(cover·1.35 − drift)·4`
 * reaches 1 everywhere), so feeding it the raw cover would finish the visible burial in the first
 * fifth of the pack. The shader is given this remapped shade instead — 0.1 (a patchy dusting) up to
 * 0.46 (fully white) — so the ground, boulders and boughs whiten across the whole storm, while the
 * raw cover still drives tyre grip and the audio's snow damping.
 */
export const ALPINE_SNOW_SHADE_MIN = 0.1;
export const ALPINE_SNOW_SHADE_MAX = 0.46;

/** What the renderer's snow shader is given for a 0..1 pack cover. */
export function alpineSnowShade01(cover01: number): number {
  const c = Number.isFinite(cover01) ? Math.max(0, Math.min(1, cover01)) : 0;
  return ALPINE_SNOW_SHADE_MIN + (ALPINE_SNOW_SHADE_MAX - ALPINE_SNOW_SHADE_MIN) * c;
}

/** The engine weather snow cover (0 bare … 1 buried) for a pack depth in metres. */
export function alpineSnowCover01(depthM: number): number {
  if (!Number.isFinite(depthM)) return 0;
  return Math.max(0, Math.min(1, depthM / ALPINE_SNOWPACK_MAX_DEPTH_M));
}
