/** Spot-shadow slot limits (dependency-free so scene settings can clamp against them). */

/**
 * Hard ceiling on simultaneously shadowed spot lights (the shader's array length); maps share the
 * directional depth-array atlas. How many a frame actually uses is `settings.shadow.maxSpotShadows`
 * (default {@link DEFAULT_SPOT_SHADOWS}), capped by `RendererOptions.maxSpotShadows`.
 */
export const MAX_SPOT_SHADOWS = 8;
/** Default per-scene spot-shadow slot budget (`settings.shadow.maxSpotShadows`). */
export const DEFAULT_SPOT_SHADOWS = 4;
