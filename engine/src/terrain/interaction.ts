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
  crushStrength: 12000,
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

  /** Apply a contact impulse after the vehicle layer has assessed the interaction. */
  contact(input: RockContactInput, normal: Vec3Ops, impulseScale = 1): RockContactAssessment {
    const assessment = assessRockContact(this.spec, input);
    this.lastAssessment = assessment;
    if (assessment.outcome === "crushed") {
      this.broken = true;
      return assessment;
    }
    if (assessment.outcome === "pushed") {
      const impulse = Math.max(0, input.availableForce) * Math.max(0, impulseScale) * (input.impactDuration ?? 1 / 60);
      this.body.applyImpulse({ x: normal.x * impulse, y: normal.y * impulse, z: normal.z * impulse });
    }
    return assessment;
  }
}
