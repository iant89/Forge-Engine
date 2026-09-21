/**
 * The narrow contract systems use to reach the renderer.
 *
 * The scene layer must not import the renderer (that would make `scene` depend on `rendering`,
 * breaking the one-way dependency rule in docs/ARCHITECTURE.md). So the renderer implements this
 * interface and hands it to systems through `SystemContext.render`. If it is absent, the world runs
 * headless — which is exactly what the entity/physics benchmarks need.
 */

import type { Vec3 } from "../math/vec.js";
import type { Double3 } from "../math/double3.js";
import type { AABB } from "../math/geometry.js";
import type { EntityId } from "./entityId.js";

export interface RenderFrameContext {
  readonly width: number;
  readonly height: number;
  readonly deviceLost: boolean;
  /** Camera pose in render-local coordinates (already relative to the coordinate-space origin). */
  readonly cameraPositionRender: Vec3;
  readonly cameraPositionWorld: Double3;

  /** Reserve per-frame GPU write space for an instanced draw. */
  writeInstanceData(index: number, matrix: Float32Array, color: number, emissive: number): void;
  instanceCount: number;

  /** Register a shadow-casting light for the current frame. */
  addShadowCaster(direction: Vec3, color: Vec3, intensity: number): void;

  /** Override the sky/atmosphere parameters for this frame (used by the planet demo). */
  setSkyOverride(params: Partial<SkyParams>): void;

  /** Draw debug geometry (valid only during the frame in which it is called). */
  drawLine(a: Vec3, b: Vec3, color?: number): void;
  drawAabb(box: AABB, color?: number): void;
  drawSphere(center: Vec3, radius: number, color?: number): void;
  drawGizmo(position: Vec3, size?: number): void;
  drawVector(origin: Vec3, dir: Vec3, scale?: number, color?: number): void;
  drawLabel(position: Vec3, text: string): void;

  /** Request a re-render even when the loop is idle (editor camera moves, etc.). */
  invalidate(): void;

  /** Pick a pixel against what the renderer knows about (uses its depth/G-buffer, not a rerender). */
  pickAt?(x: number, y: number): PickResult | null;
}

export interface PickResult {
  entity: EntityId;
  distance: number;
  position: Vec3;
  normal: Vec3;
  triangleIndex: number;
}

export interface SkyParams {
  sunDirection: Vec3;
  sunIntensity: number;
  turbidity: number;
  albedo: number;
  rayleigh: number;
  mie: number;
  exposure: number;
  nightEnabled: boolean;
  starBrightness: number;
  moonDirection: Vec3;
  moonIntensity: number;
}
