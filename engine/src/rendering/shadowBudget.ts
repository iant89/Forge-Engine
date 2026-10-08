/** Adaptive shadow-atlas sizing under an explicit memory budget. */
export const DEFAULT_SHADOW_MEMORY_BUDGET = 256 * 1024 * 1024;
export const SHADOW_TEXEL_BYTES = 4;

/**
 * Reduce a requested square map size by powers of two until all array layers fit the budget.
 * A 128px floor avoids making valid low-memory shadows disappear; zero layers retain the request.
 */
export function fitShadowMapSize(requested: number, layers: number, budgetBytes = DEFAULT_SHADOW_MEMORY_BUDGET, minimum = 128): number {
  let size = Math.max(1, Math.floor(requested));
  const count = Math.max(0, Math.floor(layers));
  const floor = Math.max(1, Math.min(size, Math.floor(minimum)));
  const budget = Math.max(SHADOW_TEXEL_BYTES, budgetBytes);
  while (count > 0 && size > floor && size * size * count * SHADOW_TEXEL_BYTES > budget) size = Math.max(floor, size >> 1);
  return size;
}

export function shadowAtlasBytes(mapSize: number, layers: number): number {
  return Math.max(0, Math.floor(mapSize)) ** 2 * Math.max(0, Math.floor(layers)) * SHADOW_TEXEL_BYTES;
}
