/**
 * Near-field interactive terrain primitives (Phase 15.5 foundation).
 *
 * Population rendering remains instanced and render-only. This module provides the deterministic
 * identity/material/contact contract needed to promote a nearby rock to a physics proxy without
 * making every distant instance a rigid body. Scene integration and sand deformation follow in the
 * remaining 15.5 slices.
 */

import { RigidBody } from "../physics/body.js";
import type { Shape } from "../physics/shapes.js";
import type { Vec3Ops } from "../math/vec.js";

export type InteractiveRockOutcome = "none" | "pushed" | "blocked" | "crushed";

export interface InteractiveRockSpec {
  /** Stable `(seed, chunk, type, index)` identity; never use a transient GPU batch index. */
  readonly id: string;
  readonly shape: Shape;
  readonly mass: number;
  /** Minimum impact force that fractures the rock. */
  readonly crushStrength: number;
  /** Minimum rover force needed to move the rock. */
  readonly pushForce: number;
  /** Maximum height the rover can climb before treating this as an obstacle. */
  readonly climbHeight: number;
  readonly friction?: number;
  readonly restitution?: number;
}

/** Physical parameters for a near-field rock material. Values are gameplay-scale, not geological data. */
export interface InteractiveRockMaterial {
  readonly density: number;
  readonly friction: number;
  readonly restitution: number;
  /** Fracture force per unit volume, in N/m³. */
  readonly crushStrength: number;
  /** Portion of the rock's weight used as the minimum push force. */
  readonly pushCoefficient: number;
  readonly minimumPushForce: number;
  /** Multiplier from proxy radius to the rover's climbable height. */
  readonly climbHeightFactor: number;
}

/** Basalt/regolith gameplay profile used by the Mars Showcase. */
export const MARS_ROCK_MATERIAL: InteractiveRockMaterial = Object.freeze({
  density: 120,
  friction: 0.9,
  restitution: 0.05,
  // Rover contact must never fracture basalt. The weakest interactive proxy (a 12 cm sphere)
  // still needs several meganewtons, far above the 1025 kg rover's peak tractive/contact load;
  // the showcase's robotic arm is the only gameplay path that can split a rock.
  crushStrength: 1_000_000_000,
  pushCoefficient: 0.8,
  minimumPushForce: 80,
  climbHeightFactor: 1.4,
});

export interface InteractiveRockSpecOptions {
  readonly id: string;
  readonly shape: Shape;
  readonly material?: InteractiveRockMaterial;
  readonly climbRadius?: number;
}

/** Build a validated, material-derived rock spec from a collision shape. */
export function createInteractiveRockSpec(options: InteractiveRockSpecOptions): InteractiveRockSpec {
  const material = options.material ?? MARS_ROCK_MATERIAL;
  for (const [name, value] of Object.entries(material)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`interactive rock material ${name} must be a finite non-negative number`);
    }
  }
  if (!options.id) throw new RangeError("interactive rock id must not be empty");
  const unitMass = options.shape.computeMass(1).mass;
  const mass = Math.max(1e-3, unitMass * material.density);
  const radius = Math.max(0, options.climbRadius ?? 0.5);
  return {
    id: options.id,
    shape: options.shape,
    mass,
    crushStrength: Math.max(1, unitMass * material.crushStrength),
    pushForce: Math.max(material.minimumPushForce, mass * 3.72 * material.pushCoefficient),
    climbHeight: radius * material.climbHeightFactor,
    friction: material.friction,
    restitution: material.restitution,
  };
}

export interface RockContactInput {
  /** Rover mass in kilograms. */
  readonly roverMass: number;
  /** Relative speed along the contact normal in metres per second. */
  readonly relativeSpeed: number;
  /** Available tractive/contact force in newtons. */
  readonly availableForce: number;
  /** Estimated obstacle height at the contact in metres. */
  readonly obstacleHeight: number;
  /** Duration of the impact impulse in seconds. Defaults to 1/60. */
  readonly impactDuration?: number;
}

export interface RockContactAssessment {
  readonly outcome: InteractiveRockOutcome;
  readonly impactForce: number;
  readonly reason: "no-impact" | "crush" | "push" | "too-tall" | "too-heavy";
}

/**
 * Deterministic contact decision shared by gameplay, tests and a future physics bridge.
 *
 * This deliberately does not compare raw mass alone: a heavy rover may still fail to move a rock
 * when its available traction is low, while a light rover can move a small rock with enough speed.
 */
export function assessRockContact(spec: InteractiveRockSpec, input: RockContactInput): RockContactAssessment {
  const duration = Math.max(1e-3, input.impactDuration ?? 1 / 60);
  const speed = Math.max(0, input.relativeSpeed);
  const impactForce = (Math.max(0, input.roverMass) * speed) / duration;
  if (speed <= 1e-4) return { outcome: "none", impactForce, reason: "no-impact" };
  if (impactForce >= spec.crushStrength) return { outcome: "crushed", impactForce, reason: "crush" };
  if (input.obstacleHeight > spec.climbHeight && input.availableForce < spec.pushForce) {
    return { outcome: "blocked", impactForce, reason: "too-tall" };
  }
  if (input.availableForce >= spec.pushForce) return { outcome: "pushed", impactForce, reason: "push" };
  return { outcome: "blocked", impactForce, reason: "too-heavy" };
}

/**
 * A promoted near-field rock. The proxy owns its rigid body, but not the population render instance;
 * the caller applies `position`/`rotation` to the instance block and removes it when `broken`.
 */
export interface VehicleRockContactInput extends RockContactInput {
  /** Mutable rover velocity in world space; the bridge removes the component transferred to the rock. */
  readonly vehicleVelocity: Vec3Ops;
}

export interface RoverDamageState {
  hull: number;
  wheels: number;
  suspension: number;
  disabled: boolean;
}

/** Apply bounded impact damage; terrain contact and damage are intentionally separate systems. */
export function applyRoverImpactDamage(
  state: RoverDamageState,
  assessment: RockContactAssessment,
  _input: RockContactInput,
  obstacleHeight: number,
  dt: number,
): number {
  if (assessment.outcome !== "blocked" || state.disabled) return 0;
  const impactThreshold = 2500;
  const force = Math.max(0, assessment.impactForce - impactThreshold);
  const amount = Math.min(100, (force / 40000) * Math.max(0, dt) * 4);
  if (amount <= 0) return 0;
  state.hull = Math.min(100, state.hull + amount);
  state.suspension = Math.min(100, state.suspension + amount * Math.min(1.5, Math.max(0.25, obstacleHeight * 2)));
  if (obstacleHeight > 0.35) state.wheels = Math.min(100, state.wheels + amount * 0.35);
  state.disabled = state.hull >= 100 || state.suspension >= 100;
  return amount;
}

/**
 * Whether the rover can displace this rock at all, given the traction it has.
 *
 * {@link assessRockContact} reports `"none"` when the approach speed is ~0, so it cannot answer
 * this for a rock the rover is merely resting against — but contact resolution still has to know
 * whether the rock is a wall or something it may shove out of the way. Both blocked branches of
 * {@link assessRockContact} (`too-tall` and `too-heavy`) are exactly the cases where the rover's
 * available force falls short of `pushForce`, so this is the displacement test on its own.
 */
export function canDisplaceRock(spec: InteractiveRockSpec, availableForce: number): boolean {
  return Math.max(0, availableForce) >= spec.pushForce;
}

export interface RockSeparationInput {
  /** Rover centre, horizontal world space. */
  readonly roverX: number;
  readonly roverZ: number;
  /** Rock centre, horizontal world space. */
  readonly rockX: number;
  readonly rockZ: number;
  /** Horizontal reach of the rock's collision shape. */
  readonly rockRadius: number;
  /** Horizontal reach the rover occupies around its centre. */
  readonly roverRadius: number;
  /**
   * Overlap the rover may keep, in metres. An immovable rock gets 0 — the rover has nowhere else
   * to go — while a rock that yields gets a small slack, so a shove reads as the bumper settling
   * into the rock and the rock leading the rover away instead of the rover bouncing off a wall.
   */
  readonly slack: number;
  /** Heading used when the two centres coincide exactly and no contact normal can be derived. */
  readonly fallbackNormalX?: number;
  readonly fallbackNormalZ?: number;
}

export interface RockSeparation {
  /** Whether the two shapes touch at all. */
  readonly contacted: boolean;
  /** Raw overlap depth in metres; 0 when they are merely touching or apart. */
  readonly penetration: number;
  /** Unit contact normal, pointing from the rover towards the rock. */
  readonly normalX: number;
  readonly normalZ: number;
  /** World-space offset to add to the rover position to resolve the overlap past `slack`. */
  readonly correctionX: number;
  readonly correctionZ: number;
}

/**
 * Resolve a rover/rock overlap geometrically.
 *
 * Momentum transfer alone cannot keep the rover out of a rock: removing the inward velocity only
 * stops it moving *further* in, so whatever overlap the previous frames accumulated stays put, and
 * a rock that cannot get out of the way leaves the rover parked inside it. This is the missing
 * half — it measures the penetration and hands back the position correction that pushes the rover
 * back out along the contact normal.
 */
export function separateRoverFromRock(input: RockSeparationInput): RockSeparation {
  const range = Math.max(0, input.roverRadius) + Math.max(0, input.rockRadius);
  const dx = input.rockX - input.roverX;
  const dz = input.rockZ - input.roverZ;
  const distance = Math.hypot(dx, dz);
  let normalX: number;
  let normalZ: number;
  let depth = distance;
  if (distance > 1e-6) {
    normalX = dx / distance;
    normalZ = dz / distance;
  } else {
    // Centres coincide: there is no normal to derive, so fall back to the caller's heading rather
    // than returning a zero correction that would weld the rover to the rock's centre forever.
    depth = 0;
    const fx = input.fallbackNormalX ?? 0;
    const fz = input.fallbackNormalZ ?? 1;
    const length = Math.hypot(fx, fz);
    normalX = length > 1e-6 ? fx / length : 0;
    normalZ = length > 1e-6 ? fz / length : 1;
  }
  const penetration = Math.max(0, range - depth);
  const excess = penetration - Math.max(0, input.slack);
  if (excess <= 0) {
    return { contacted: depth <= range, penetration, normalX, normalZ, correctionX: 0, correctionZ: 0 };
  }
  return {
    contacted: true,
    penetration,
    normalX,
    normalZ,
    correctionX: -normalX * excess,
    correctionZ: -normalZ * excess,
  };
}

/**
 * Bridge one vehicle contact into both participants. Damage is intentionally not decided here;
 * this step only transfers normal momentum and leaves the impact assessment for the next phase item.
 *
 * The transfer is a fraction of the rover's normal-direction speed removed per contact call. A
 * blocked rock stops the rover (there is nowhere for the momentum to go); a pushed or crushed
 * rock only takes its share — scaled by the mass ratio, so shoving a pebble never grinds a
 * tonne-class rover to a halt while leaning on a boulder still does.
 */
export function bridgeRockContact(
  proxy: InteractiveRockProxy,
  input: VehicleRockContactInput,
  normal: Vec3Ops,
): RockContactAssessment {
  const assessment = proxy.contact(input, normal);
  const normalSpeed = input.vehicleVelocity.x * normal.x + input.vehicleVelocity.y * normal.y + input.vehicleVelocity.z * normal.z;
  if (normalSpeed <= 0) return assessment;
  const massShare = Math.max(0, proxy.spec.mass) / Math.max(1, input.roverMass);
  let transfer: number;
  if (assessment.outcome === "blocked") {
    transfer = 0.9;
  } else if (assessment.outcome === "pushed") {
    // A 30 kg rock takes ~3% per call; an 800 kg boulder takes the capped 25%.
    transfer = Math.min(0.25, Math.max(0.01, massShare));
  } else if (assessment.outcome === "crushed") {
    // Debris absorbs a little more than a clean push, but pulverising a pebble must not stop
    // the rover the way the old flat 1.0 did.
    transfer = Math.min(0.3, Math.max(0.02, massShare * 2));
  } else {
    transfer = 0;
  }
  input.vehicleVelocity.x -= normal.x * normalSpeed * transfer;
  input.vehicleVelocity.y -= normal.y * normalSpeed * transfer;
  input.vehicleVelocity.z -= normal.z * normalSpeed * transfer;
  return assessment;
}

/**
 * Lead factor for a velocity-matched shove: the rock targets 5% above the rover's approach speed
 * so the pair separates instead of grinding in sustained contact.
 */
export const PUSH_MATCH = 1.05;
/**
 * Separation bias (m/s) added to every matched shove, so even a creep-speed nudge parts the rock
 * from the bumper instead of re-contacting on the next call.
 */
export const PUSH_SEPARATION = 0.05;

export class InteractiveRockProxy {
  readonly spec: InteractiveRockSpec;
  readonly body: RigidBody;
  broken = false;
  lastAssessment: RockContactAssessment | null = null;

  constructor(spec: InteractiveRockSpec, position: Vec3Ops) {
    this.spec = spec;
    this.body = new RigidBody({
      type: "dynamic",
      shape: spec.shape,
      mass: spec.mass,
      position,
      friction: spec.friction ?? 0.8,
      restitution: spec.restitution ?? 0.05,
    });
  }

  /**
   * Apply a contact impulse after the vehicle layer has assessed the interaction.
   *
   * A push is velocity-matched, not force-accumulated: the rock is carried along at the rover's
   * approach speed (plus a small separation bias so the pair parts instead of resting in contact),
   * and only up to what the rover's available force can afford this call. The old
   * `availableForce × dt` kick landed every call regardless of the rock's speed, so a sub-kilo
   * pebble gained tens of m/s per frame from a slow nudge and shot across the terrain.
   */
  contact(input: RockContactInput, normal: Vec3Ops, impulseScale = 1): RockContactAssessment {
    const assessment = assessRockContact(this.spec, input);
    this.lastAssessment = assessment;
    if (assessment.outcome === "crushed") {
      this.broken = true;
      return assessment;
    }
    if (assessment.outcome === "pushed") {
      const rockNormalSpeed =
        this.body.linearVelocity.x * normal.x +
        this.body.linearVelocity.y * normal.y +
        this.body.linearVelocity.z * normal.z;
      const desired = Math.max(0, input.relativeSpeed) * PUSH_MATCH + PUSH_SEPARATION;
      const catchUp = desired - rockNormalSpeed;
      if (catchUp > 0) {
        // Authority: the Δv this call's share of the rover's force budget can buy. A light rock
        // matches the rover in a call or two; an 800 kg boulder needs a sustained shove.
        const duration = Math.max(1e-3, input.impactDuration ?? 1 / 60);
        const authority =
          (Math.max(0, input.availableForce) * Math.max(0, impulseScale) * duration) / Math.max(1e-3, this.spec.mass);
        const applied = Math.min(catchUp, authority) * this.spec.mass;
        this.body.applyImpulse({ x: normal.x * applied, y: normal.y * applied, z: normal.z * applied });
      }
    }
    return assessment;
  }
}
