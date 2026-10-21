/**
 * Viewport-independent transform gizmo math for Phase 26.4.
 *
 * The gizmo deliberately stops at geometry/math: a DOM shell, a Forge UI viewport, or an external
 * host supplies rays and commits the returned transform patch through EditorSession. Keeping picking
 * and drag math here makes snapping and axis behavior deterministic without coupling the editor to a
 * renderer or a browser event system.
 */

import { Quat, Vec3 } from "@forge/engine";
import type { EditorTransformPatch, EditorTransformState, EditorVec3 } from "./session.js";

export type GizmoMode = "translate" | "rotate" | "scale";
export type GizmoAxis = "x" | "y" | "z" | "xy" | "yz" | "xz" | "screen";

export interface GizmoRay {
  readonly origin: EditorVec3;
  readonly direction: EditorVec3;
}

export interface GizmoPick {
  readonly axis: GizmoAxis;
  readonly distance: number;
  readonly rayDistance: number;
}

export interface GizmoDrag {
  readonly mode: GizmoMode;
  readonly axis: GizmoAxis;
  readonly pivot: EditorVec3;
  readonly startPoint: EditorVec3;
  readonly startTransform: EditorTransformState;
  readonly rotationAxis: EditorVec3;
}

export interface GizmoDragOptions {
  readonly rotationAxis?: EditorVec3;
  readonly snap?: number;
  readonly scaleSensitivity?: number;
}

const AXES: Record<Exclude<GizmoAxis, "xy" | "yz" | "xz" | "screen">, EditorVec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** Pick the nearest axis segment from a world-space ray. */
export function pickGizmoAxis(
  ray: GizmoRay,
  pivot: EditorVec3,
  options: { readonly length?: number; readonly tolerance?: number; readonly axes?: readonly GizmoAxis[] } = {},
): GizmoPick | null {
  const length = Math.max(0.0001, options.length ?? 1);
  const tolerance = Math.max(0, options.tolerance ?? 0.12);
  const axes = options.axes ?? ["x", "y", "z"];
  const rayDirection = normalized(ray.direction);
  let best: GizmoPick | null = null;
  for (const axis of axes) {
    const direction = axisDirection(axis);
    if (!direction) continue;
    const closest = closestRayLine(ray.origin, rayDirection, pivot, direction);
    if (closest.lineParameter < -tolerance || closest.lineParameter > length + tolerance) continue;
    if (closest.distance > tolerance) continue;
    if (best === null || closest.rayParameter < best.rayDistance) {
      best = { axis, distance: closest.distance, rayDistance: closest.rayParameter };
    }
  }
  return best;
}

/** Start a deterministic drag from a picked axis/plane and a world-space hit point. */
export function beginGizmoDrag(
  mode: GizmoMode,
  axis: GizmoAxis,
  pivot: EditorVec3,
  startPoint: EditorVec3,
  startTransform: EditorTransformState,
  options: GizmoDragOptions = {},
): GizmoDrag {
  const rotationAxis = options.rotationAxis ?? axisDirection(axis) ?? [0, 1, 0];
  const normalizedAxis = normalized(rotationAxis);
  return {
    mode,
    axis,
    pivot: [...pivot] as EditorVec3,
    startPoint: [...startPoint] as EditorVec3,
    startTransform: cloneTransform(startTransform),
    rotationAxis: normalizedAxis,
  };
}

/** Convert a drag hit to an undoable local-transform patch. */
export function updateGizmoDrag(drag: GizmoDrag, point: EditorVec3, options: GizmoDragOptions = {}): EditorTransformPatch {
  const axis = axisDirection(drag.axis) ?? drag.rotationAxis;
  const delta = subtract(point, drag.startPoint);
  const signedDistance = dot(delta, axis);
  const snappedDistance = snapValue(signedDistance, options.snap ?? 0);

  if (drag.mode === "translate") {
    return {
      position: [
        drag.startTransform.position[0] + axis[0] * snappedDistance,
        drag.startTransform.position[1] + axis[1] * snappedDistance,
        drag.startTransform.position[2] + axis[2] * snappedDistance,
      ],
    };
  }

  if (drag.mode === "scale") {
    const sensitivity = Number.isFinite(options.scaleSensitivity) ? options.scaleSensitivity! : 1;
    const next = Math.max(0.001, drag.startTransform.scale[axisIndex(drag.axis)]! + snappedDistance * sensitivity);
    const scale = [...drag.startTransform.scale] as [number, number, number];
    if (drag.axis === "screen" || drag.axis === "xy" || drag.axis === "yz" || drag.axis === "xz") {
      scale[0] = Math.max(0.001, scale[0]! + snappedDistance * sensitivity);
      scale[1] = Math.max(0.001, scale[1]! + snappedDistance * sensitivity);
      scale[2] = Math.max(0.001, scale[2]! + snappedDistance * sensitivity);
    } else {
      scale[axisIndex(drag.axis)] = next;
    }
    return { scale };
  }

  const from = normalized(subtract(drag.startPoint, drag.pivot));
  const to = normalized(subtract(point, drag.pivot));
  const cross = crossProduct(from, to);
  const angle = Math.atan2(dot(drag.rotationAxis, cross), clamp(dot(from, to), -1, 1));
  const snappedAngle = snapValue(angle, options.snap ?? 0);
  const rotation = Quat.fromAxisAngle(new Vec3(...drag.rotationAxis), snappedAngle);
  rotation.multiply(new Quat(...drag.startTransform.rotation));
  return { rotation: [rotation.x, rotation.y, rotation.z, rotation.w] };
}

/** Snap an authored value; zero/invalid increments leave it unchanged. */
export function snapValue(value: number, increment: number): number {
  return Number.isFinite(increment) && increment > 0 ? Math.round(value / increment) * increment : value;
}

function axisDirection(axis: GizmoAxis): EditorVec3 | null {
  if (axis === "x" || axis === "y" || axis === "z") return AXES[axis];
  return null;
}

function axisIndex(axis: GizmoAxis): 0 | 1 | 2 {
  return axis === "y" ? 1 : axis === "z" ? 2 : 0;
}

function normalized(value: EditorVec3): EditorVec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 1e-8)) return [0, 1, 0];
  return [value[0] / length, value[1] / length, value[2] / length];
}

function subtract(a: EditorVec3, b: EditorVec3): EditorVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: EditorVec3, b: EditorVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossProduct(a: EditorVec3, b: EditorVec3): EditorVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cloneTransform(state: EditorTransformState): EditorTransformState {
  return {
    position: [...state.position] as EditorVec3,
    rotation: [...state.rotation] as EditorTransformState["rotation"],
    scale: [...state.scale] as EditorVec3,
  };
}

function closestRayLine(
  rayOrigin: EditorVec3,
  rayDirection: EditorVec3,
  lineOrigin: EditorVec3,
  lineDirection: EditorVec3,
): { rayParameter: number; lineParameter: number; distance: number } {
  const offset = subtract(lineOrigin, rayOrigin);
  const dotRayLine = dot(rayDirection, lineDirection);
  const rayOffset = dot(rayDirection, offset);
  const lineOffset = dot(lineDirection, offset);
  const denominator = 1 - dotRayLine * dotRayLine;
  let rayParameter: number;
  let lineParameter: number;
  if (Math.abs(denominator) < 1e-7) {
    rayParameter = Math.max(0, rayOffset);
    lineParameter = 0;
  } else {
    rayParameter = (rayOffset - dotRayLine * lineOffset) / denominator;
    lineParameter = (dotRayLine * rayOffset - lineOffset) / denominator;
    rayParameter = Math.max(0, rayParameter);
  }
  const rayPoint: EditorVec3 = [
    rayOrigin[0] + rayDirection[0] * rayParameter,
    rayOrigin[1] + rayDirection[1] * rayParameter,
    rayOrigin[2] + rayDirection[2] * rayParameter,
  ];
  const linePoint: EditorVec3 = [
    lineOrigin[0] + lineDirection[0] * lineParameter,
    lineOrigin[1] + lineDirection[1] * lineParameter,
    lineOrigin[2] + lineDirection[2] * lineParameter,
  ];
  return { rayParameter, lineParameter, distance: Math.hypot(rayPoint[0] - linePoint[0], rayPoint[1] - linePoint[1], rayPoint[2] - linePoint[2]) };
}
