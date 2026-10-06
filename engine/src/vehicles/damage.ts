/**
 * Area-dependent vehicle damage: per-panel crush zones and per-wheel damage.
 *
 * Mechanical wear (`doDamage` in terrain/interaction.ts) only tracks numbers. This module adds
 * *where* the damage landed so scenes can show it: which body panels are crushed in, which
 * wheels are bent, and when a wheel is torn off entirely. All helpers are pure and deterministic
 * (no RNG); the scene owns the live state and applies the visuals.
 */

/** Per-panel crush, 0 (pristine) .. 1 (fully crushed in). */
export interface VehicleDamageZones {
  front: number;
  rear: number;
  left: number;
  right: number;
}

/** Fresh, undamaged zones. */
export function createVehicleDamageZones(): VehicleDamageZones {
  return { front: 0, rear: 0, left: 0, right: 0 };
}

/**
 * Add `amount` of crush across the zones an impact direction implies. `forward`/`right` are the
 * contact normal's components in vehicle frame (both roughly in [-1, 1]); +forward means the
 * impact pushed the vehicle backward, i.e. the nose took it. A dead-on hit loads one zone; a
 * corner hit splits by |component| share so diagonal rams dent two adjacent panels.
 */
export function applyBodyDamage(
  zones: VehicleDamageZones,
  forward: number,
  right: number,
  amount: number,
): void {
  if (!(amount > 0)) return;
  const f = Math.abs(forward);
  const r = Math.abs(right);
  const total = f + r;
  if (!(total > 0)) return;
  const frontShare = forward > 0 ? f / total : 0;
  const rearShare = forward < 0 ? f / total : 0;
  const rightShare = right > 0 ? r / total : 0;
  const leftShare = right < 0 ? r / total : 0;
  zones.front = Math.min(1, zones.front + amount * frontShare);
  zones.rear = Math.min(1, zones.rear + amount * rearShare);
  zones.left = Math.min(1, zones.left + amount * leftShare);
  zones.right = Math.min(1, zones.right + amount * rightShare);
}

/**
 * Add `amount` of damage to one wheel (clamped 0..1). Indices follow the vehicle's wheel order
 * (front-left first for the showcase rover).
 */
export function applyWheelDamage(wheels: number[], index: number, amount: number): void {
  if (index < 0 || index >= wheels.length || !(amount > 0)) return;
  wheels[index] = Math.min(1, wheels[index] + amount);
}

/** Wheel damage at or above this tears the wheel off (disabled + hidden + dropped as a prop). */
export const WHEEL_DETACH_DAMAGE = 1;

/**
 * Camber tilt (radians) for a damaged-but-attached wheel. A fully battered wheel leans ~26° with
 * matching toe — visibly mangled without clipping the deck on the showcase rover.
 */
export const WHEEL_BEND_MAX = 0.45;

/** Crush ramp: a part this far into a zone (model-space metres) takes the zone's full inset. */
export const BODY_CRUSH_SPAN_Z = 1.6;
export const BODY_CRUSH_SPAN_X = 1.4;
/** How far a fully crushed panel sinks inward (model-space metres). */
export const BODY_CRUSH_MAX = 0.3;
/** How far a fully crushed panel sags downward (model-space metres). */
export const BODY_CRUSH_SINK = 0.1;

/**
 * Crush offset for a body part whose model-space bounds centre is (x, z): panels sink inward
 * with their zone's damage, scaled by how far into that zone they sit, plus a downward sag.
 * Centre parts (x = z = 0) never move, so the deck and instruments stay put while the nose,
 * tail and rocker panels crumple around them. Writes into `out` and returns it.
 */
export function computeBodyCrushOffset(
  x: number,
  z: number,
  zones: VehicleDamageZones,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const frontness = Math.min(1, Math.max(0, z / BODY_CRUSH_SPAN_Z));
  const rearness = Math.min(1, Math.max(0, -z / BODY_CRUSH_SPAN_Z));
  const rightness = Math.min(1, Math.max(0, x / BODY_CRUSH_SPAN_X));
  const leftness = Math.min(1, Math.max(0, -x / BODY_CRUSH_SPAN_X));
  out.z = (-zones.front * frontness + zones.rear * rearness) * BODY_CRUSH_MAX;
  out.x = (-zones.right * rightness + zones.left * leftness) * BODY_CRUSH_MAX;
  out.y =
    -(zones.front * frontness + zones.rear * rearness + zones.left * leftness + zones.right * rightness) *
    BODY_CRUSH_SINK;
  return out;
}
