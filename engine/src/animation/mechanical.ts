/**
 * Mechanical animation — joints driven by machine state instead of authored clips (Phase 16.6).
 *
 * A clip animates what an artist authored; a *mechanical* joint animates what the simulation is
 * doing: a wheel spins at its own ω, a steering knuckle yaws with Ackermann, a hub rides its
 * suspension travel, a damper telescopes to the hub it connects to. None of those have keyframes —
 * they are functions of physics state that changes every frame — so this module gives the animation
 * subsystem the other half of its contract: a rig of 1-DOF joints, posed from named *channels* a
 * source writes (`MechanicalChannelSource` in `mechanicalSystem.ts`).
 *
 * Design:
 *  - A joint binds one entity to one channel. The posed local transform is `base ∘ motion`, where
 *    `base` is the entity's authored local TRS captured by {@link MechanicalRig.addJoint}. Each
 *    frame recomputes from `base`, so re-posing is idempotent: no drift, no accumulated error.
 *  - Kinds:
 *      `revolute`  — angle about an axis fixed in the joint's parent frame (axle, hinge, turret).
 *      `prismatic` — offset along that axis (suspension travel, a sliding mount).
 *      `aim`       — an angle solved so the joint's local direction (default +Z) points at a target
 *                    entity: a trailing arm, a shock, a linkage that must track what the physics
 *                    moves. Solving reads the *store*, so a joint declared after the joints it
 *                    watches sees their pose from the same frame.
 *  - `min`/`max` clamp the driven value; `slew` (units/s) rate-limits how fast the joint can follow
 *    its channel, which is what makes an actuator read as mechanical instead of snapping; `wrap`
 *    keeps an odometer channel (wheel spin, growing without bound) inside (−π, π] and takes the
 *    short way round when slewing.
 *  - `stretch` on an `aim` joint scales the link along its local +Z to the target distance, so a
 *    telescoping link (a damper) reaches the hub instead of stopping short of it.
 *
 * Determinism: joints advance in insertion order, every value is a pure function of (channel, dt),
 * no RNG and no wall clock. Same channels + same dt ⇒ same poses, which is what lets a test pin a
 * suspension sweep.
 *
 * Dependency direction: `math` + `scene` only, like the rest of `animation/`. The source that fills
 * channels (vehicle telemetry, a drivetrain model, a scripted rig) lives with the subsystem that
 * owns the state — see `vehicles/wheelRig.ts` for the wheel-assembly binding.
 */

import { Mat4, Quat } from "../math/mat.js";
import { Vec3 } from "../math/vec.js";
import { TAU } from "../math/scalar.js";
import { UsageError } from "../core/errors.js";
import type { EntityId } from "../scene/entityId.js";
import { LOCAL_STRIDE, type TransformStore } from "../math/transform.js";
import type { EntityWorld } from "../scene/world.js";

/** What a joint does with its value. */
export type MechanicalJointKind = "revolute" | "prismatic" | "aim";

/** Axis / direction argument: any vector-like value (`Vec3`, a plain object, an array element). */
export interface AxisLike {
  x: number;
  y: number;
  z: number;
}

export interface MechanicalJointOptions {
  /** Entity whose local transform the joint drives. Must already have a transform. */
  entity: EntityId;
  /** Default `"revolute"`. */
  kind?: MechanicalJointKind;
  /**
   * Channel name this joint follows (required for `revolute`/`prismatic`, unused for `aim`).
   * Rig-local: the source that writes it and the joint that reads it agree by name.
   */
  channel?: string;
  /** Rotation axis (revolute) or translation axis (prismatic) in the joint's parent frame. */
  axis?: AxisLike;
  /** Multiplier applied to the channel value — e.g. −1 for a left-side wheel's spin. */
  ratio?: number;
  /** Constant added after `ratio` (e.g. a rest-pose offset). */
  bias?: number;
  /** Output clamp; a value the channel cannot exceed for the joint to be reached. */
  min?: number;
  max?: number;
  /** Maximum |d value / dt| in units per second; 0 (default) follows the channel directly. */
  slew?: number;
  /** Revolute only: wrap the posed angle into (−π, π]. Default `true`. */
  wrap?: boolean;
  /** `aim` only: entity the joint points at. */
  target?: EntityId;
  /** `aim` only: the joint-local direction that should point at the target. Default +Z. */
  direction?: AxisLike;
  /** `aim` only: scale local +Z so the link reaches the target (a telescoping link). */
  stretch?: boolean;
}

interface MechanicalJoint {
  readonly kind: MechanicalJointKind;
  readonly entity: EntityId;
  readonly channel: string | null;
  readonly axis: Vec3;
  readonly ratio: number;
  readonly bias: number;
  readonly min: number;
  readonly max: number;
  readonly slew: number;
  readonly wrap: boolean;
  readonly target: EntityId;
  readonly direction: Vec3;
  readonly stretch: boolean;
  readonly basePosition: Vec3;
  readonly baseRotation: Quat;
  readonly baseScale: Vec3;
  /** Distance from the joint to its target at bind time (the authored link length). */
  restDistance: number;
  /** Value the channel asks for this frame. */
  destination: number;
  /** Value the joint has actually reached (rate-limited toward `destination`). */
  value: number;
  /** Distance to the aim target in the joint's parent frame (0 for non-aim joints). */
  distance: number;
  /** The joint could not reach its destination this frame (rate-limited). */
  saturated: boolean;
}

/** Chain depth guard: deeper than the transform store's own 31-level bucketing is a cycle. */
const MAX_CHAIN = 32;

// Module scratch — this module is documented as allocation-free per frame, so every step shares
// these and no call may hold a reference across one.
const scratchMatrixA = new Mat4();
const scratchMatrixB = new Mat4();
const scratchMatrixC = new Mat4();
const scratchPos = new Vec3();
const scratchScale = new Vec3();
const scratchQuat = new Quat();
const scratchOffset = new Quat();
const scratchVecA = new Vec3();
const scratchVecB = new Vec3();
const scratchVecC = new Vec3();
const chain: number[] = [];

/** Wrap an angle into (−π, π]. */
function wrapAngle(radians: number): number {
  if (radians >= -Math.PI && radians <= Math.PI) return radians;
  let wrapped = radians % TAU;
  if (wrapped > Math.PI) wrapped -= TAU;
  else if (wrapped <= -Math.PI) wrapped += TAU;
  return wrapped;
}

/**
 * Compose an entity's world matrix from the *local* store, walking its parent chain. This reads the
 * live local data rather than the cached world matrix (which the transform system refreshes in band
 * 500, after the animation systems run), so a joint solved this frame sees a parent or target that
 * was posed earlier in the same pass.
 */
function composeChain(store: TransformStore, slot: number, out: Mat4): boolean {
  if (slot === 0) {
    out.setIdentity();
    return true;
  }
  chain.length = 0;
  let current = slot;
  let guard = 0;
  while (current !== 0 && guard++ < MAX_CHAIN) {
    chain.push(current);
    current = store.parent[current]!;
  }
  if (current !== 0) return false; // cycle, or a chain deeper than MAX_CHAIN
  out.setIdentity();
  const l = store.local;
  for (let i = chain.length - 1; i >= 0; i--) {
    const off = chain[i]! * LOCAL_STRIDE; // pos(3) pad(1) quat(4) scale(3) pad(1)
    scratchPos.set(l[off]!, l[off + 1]!, l[off + 2]!);
    scratchQuat.set(l[off + 4]!, l[off + 5]!, l[off + 6]!, l[off + 7]!);
    scratchScale.set(l[off + 8]!, l[off + 9]!, l[off + 10]!);
    scratchMatrixC.setCompose(scratchPos, scratchQuat, scratchScale);
    out.multiply(scratchMatrixC);
  }
  return true;
}

/**
 * A rig of mechanical joints. Create one per machine (a vehicle, an arm, a conveyor) and add its
 * joints in the order they should be solved; add a {@link MechanicalRigComponent} to an entity so
 * `MechanicalSystem` drives it every frame.
 */
export class MechanicalRig {
  private readonly world: EntityWorld;
  private readonly joints: MechanicalJoint[] = [];
  private readonly channels = new Map<string, number>();
  /** channel name -> index of the joint that follows it (the last one bound wins). */
  private readonly channelJoints = new Map<string, number>();
  private posedCount = 0;
  private solvedCount = 0;
  private saturatedCount = 0;
  /** `dt` of the last {@link advance}, reused by aim joints solved in {@link pose}. */
  private lastDt = 0;

  constructor(world: EntityWorld) {
    this.world = world;
  }

  /** Number of joints on the rig. */
  get jointCount(): number {
    return this.joints.length;
  }

  /** Number of channels written since the rig was created. */
  get channelCount(): number {
    return this.channels.size;
  }

  /**
   * Bind one entity to one channel (or to an aim target). The entity's current local TRS becomes the
   * joint's base pose, so author the machine in its rest state first.
   *
   * Returns the joint index (joints are posed in the order they were added).
   */
  addJoint(options: MechanicalJointOptions): number {
    const world = this.world;
    const kind: MechanicalJointKind = options.kind ?? "revolute";
    const slot = world.transformSlot(options.entity, false);
    if (slot === 0) {
      throw new UsageError(`MechanicalRig.addJoint: entity ${options.entity} has no transform`);
    }
    if ((kind === "revolute" || kind === "prismatic") && !options.channel) {
      throw new UsageError(`MechanicalRig.addJoint: a ${kind} joint needs a channel name`);
    }
    if (kind === "aim" && (options.target === undefined || options.target === 0)) {
      throw new UsageError("MechanicalRig.addJoint: an aim joint needs a target entity");
    }
    const axisOption = options.axis;
    const axis =
      axisOption === undefined
        ? new Vec3(kind === "aim" ? 1 : 1, 0, 0)
        : new Vec3(axisOption.x, axisOption.y, axisOption.z);
    if (!(axis.lengthSq() > 1e-12)) throw new UsageError("MechanicalRig.addJoint: axis must be non-zero");
    axis.normalize();
    const directionOption = options.direction;
    const direction =
      directionOption === undefined
        ? new Vec3(0, 0, 1)
        : new Vec3(directionOption.x, directionOption.y, directionOption.z);
    if (kind === "aim" && !(direction.lengthSq() > 1e-12)) {
      throw new UsageError("MechanicalRig.addJoint: aim direction must be non-zero");
    }
    direction.normalize();

    const store = world.transforms;
    const basePosition = new Vec3();
    const baseRotation = new Quat();
    const baseScale = new Vec3();
    store.getPosition(slot, basePosition);
    store.getRotation(slot, baseRotation);
    store.getScale(slot, baseScale);

    const joint: MechanicalJoint = {
      kind,
      entity: options.entity,
      channel: options.channel ?? null,
      axis,
      ratio: options.ratio ?? 1,
      bias: options.bias ?? 0,
      min: options.min ?? Number.NEGATIVE_INFINITY,
      max: options.max ?? Number.POSITIVE_INFINITY,
      slew: options.slew ?? 0,
      wrap: options.wrap ?? kind === "revolute",
      target: options.target ?? (0 as EntityId),
      direction,
      stretch: options.stretch ?? false,
      basePosition,
      baseRotation,
      baseScale,
      restDistance: 0,
      destination: 0,
      value: 0,
      distance: 0,
      saturated: false,
    };
    if (kind === "aim") {
      const offset = scratchVecA;
      if (this.localTargetOffset(joint, offset)) joint.restDistance = offset.length();
    }
    this.joints.push(joint);
    const index = this.joints.length - 1;
    if (joint.channel !== null) this.channelJoints.set(joint.channel, index);
    return index;
  }

  /** Write a channel value. Channels the rig has no joint for are kept (readable, harmless). */
  setChannel(name: string, value: number): void {
    this.channels.set(name, value);
  }

  /** Current channel value (0 when the source has never written it). */
  getChannel(name: string): number {
    return this.channels.get(name) ?? 0;
  }

  /**
   * *Posed* value of the joint bound to `channel` (0 when nothing is bound): radians for a revolute
   * joint, metres for a prismatic one. This is what the rig wrote, after `ratio`/`bias`, clamps and
   * slew — what a HUD or a verification gate should read back.
   */
  valueOf(channel: string): number {
    const index = this.channelJoints.get(channel);
    return index === undefined ? 0 : this.joints[index]!.value;
  }

  /** Whether the last advance rate-limited the joint bound to `channel`. */
  saturatedChannel(channel: string): boolean {
    const index = this.channelJoints.get(channel);
    return index === undefined ? false : this.joints[index]!.saturated;
  }

  /** Clear every channel — the next `advance` drives every joint back toward its rest value. */
  clearChannels(): void {
    this.channels.clear();
  }

  /** Posed value of a joint: radians for revolute/aim, metres for prismatic. */
  valueAt(index: number): number {
    return this.joints[index]?.value ?? 0;
  }

  /** Whether a joint was rate-limited on the last advance (it could not reach its destination). */
  saturatedAt(index: number): boolean {
    return this.joints[index]?.saturated ?? false;
  }

  /** Kind of a joint, for tooling and tests. */
  kindAt(index: number): MechanicalJointKind | null {
    return this.joints[index]?.kind ?? null;
  }

  /** Entity a joint drives, for tooling and tests. */
  entityAt(index: number): EntityId | null {
    return this.joints[index]?.entity ?? null;
  }

  /**
   * Advance every joint's value toward what its channel asks for: read the channel, apply
   * `ratio`/`bias`, clamp, and move toward it at most `slew · dt`. Aim joints are solved in
   * {@link pose} (they read the store, which `pose` is what writes) and slewed there with the same
   * `dt` this call was given.
   */
  advance(dt: number): void {
    this.lastDt = dt;
    const channels = this.channels;
    for (const joint of this.joints) {
      if (joint.kind !== "aim") {
        const raw = channels.get(joint.channel!) ?? 0;
        let destination = raw * joint.ratio + joint.bias;
        if (destination < joint.min) destination = joint.min;
        else if (destination > joint.max) destination = joint.max;
        if (joint.wrap) destination = wrapAngle(destination);
        joint.destination = destination;
        this.applySlew(joint, dt);
      }
    }
  }

  /** Move a joint toward its destination at most `slew · dt` (instantly when `slew` is 0). */
  private applySlew(joint: MechanicalJoint, dt: number): void {
    joint.saturated = false;
    if (joint.slew > 0 && dt > 0) {
      let delta = joint.destination - joint.value;
      if (joint.wrap) delta = wrapAngle(delta);
      const step = joint.slew * dt;
      if (delta > step) {
        joint.value = wrapAngle(joint.value + step);
        joint.saturated = true;
      } else if (delta < -step) {
        joint.value = wrapAngle(joint.value - step);
        joint.saturated = true;
      } else {
        joint.value = joint.destination;
      }
    } else {
      joint.value = joint.destination;
    }
    if (joint.saturated) this.saturatedCount++;
  }

  /**
   * Write every joint's current value into the transform store, in joint order. Channel joints
   * compose `base ∘ motion`; aim joints solve their angle from the target first, so a joint declared
   * after the joints it watches sees their pose from this same pass.
   */
  pose(): void {
    const world = this.world;
    const store = world.transforms;
    this.posedCount = 0;
    this.solvedCount = 0;
    for (const joint of this.joints) {
      const slot = world.transformSlot(joint.entity, false);
      if (slot === 0) continue; // entity destroyed since binding: leave it alone
      if (joint.kind === "aim") {
        const offset = scratchVecA;
        if (this.localTargetOffset(joint, offset)) {
          const distance = offset.length();
          const solved = this.solveAimAngle(joint, offset, distance);
          if (solved !== null) {
            joint.distance = distance;
            let destination = solved;
            if (destination < joint.min) destination = joint.min;
            else if (destination > joint.max) destination = joint.max;
            joint.destination = destination;
            this.applySlew(joint, this.lastDt);
            this.solvedCount++;
          }
        }
        scratchQuat.copyFrom(joint.baseRotation);
        scratchOffset.setAxisAngle(joint.axis, joint.value);
        scratchQuat.multiply(scratchOffset);
        store.setRotation(slot, scratchQuat);
        if (joint.stretch) {
          const ratio = joint.restDistance > 1e-6 ? joint.distance / joint.restDistance : 1;
          scratchScale.set(
            joint.baseScale.x,
            joint.baseScale.y,
            joint.baseScale.z * ratio,
          );
          store.setScale(slot, scratchScale.x, scratchScale.y, scratchScale.z);
        }
        this.posedCount++;
        continue;
      }

      if (joint.kind === "revolute") {
        scratchQuat.copyFrom(joint.baseRotation);
        scratchOffset.setAxisAngle(joint.axis, joint.value);
        scratchQuat.multiply(scratchOffset);
        store.setRotation(slot, scratchQuat);
      } else {
        scratchPos.set(
          joint.basePosition.x + joint.axis.x * joint.value,
          joint.basePosition.y + joint.axis.y * joint.value,
          joint.basePosition.z + joint.axis.z * joint.value,
        );
        store.setPosition(slot, scratchPos.x, scratchPos.y, scratchPos.z);
      }
      this.posedCount++;
    }
  }

  /** Advance and pose in one call — what `MechanicalSystem` runs per frame. */
  step(dt: number): void {
    this.advance(dt);
    this.pose();
  }

  /** Return every joint to its base pose (values 0) and write it. */
  reset(): void {
    for (const joint of this.joints) {
      joint.value = 0;
      joint.destination = 0;
      joint.saturated = false;
    }
    this.pose();
  }

  /** Counters from the last advance/pose, merged into engine stats by `MechanicalSystem`. */
  stats(): Record<string, number> {
    return {
      joints: this.joints.length,
      posed: this.posedCount,
      solved: this.solvedCount,
      saturated: this.saturatedCount,
    };
  }

  /**
   * Offset from the joint's base position to its aim target, expressed in the joint's *parent*
   * frame (the frame the joint's local transform lives in). Returns false when either entity is
   * gone or the chain cannot be composed.
   */
  private localTargetOffset(joint: MechanicalJoint, out: Vec3): boolean {
    const world = this.world;
    const store = world.transforms;
    const slot = world.transformSlot(joint.entity, false);
    if (slot === 0) return false;
    const targetSlot = world.transformSlot(joint.target, false);
    if (targetSlot === 0) return false;
    const parentSlot = store.parent[slot]!;
    if (!composeChain(store, parentSlot, scratchMatrixA)) return false;
    if (!composeChain(store, targetSlot, scratchMatrixB)) return false;
    if (!scratchMatrixA.invert()) return false;
    scratchMatrixB.multiplyMatrices(scratchMatrixA, scratchMatrixB);
    const elements = scratchMatrixB.elements();
    out.set(
      elements[12]! - joint.basePosition.x,
      elements[13]! - joint.basePosition.y,
      elements[14]! - joint.basePosition.z,
    );
    return true;
  }

  /**
   * Angle about `joint.axis` that points the joint's local `direction` at `offset` (the target
   * offset in the parent frame). The rest direction lives in the motion frame, so the parent-frame
   * direction is rotated into it by the inverse base rotation first; both are projected onto the
   * plane perpendicular to the hinge axis, which is what makes the solve exact for a 1-DOF linkage
   * and "closest reachable angle" for anything else. Returns null when the target lies on the axis
   * (no unique angle).
   */
  private solveAimAngle(joint: MechanicalJoint, offset: Vec3, distance: number): number | null {
    if (!(distance > 1e-9)) return null;
    // Direction to the target in the parent frame.
    scratchVecA.copyFrom(offset).scale(1 / distance);
    // Into the joint's motion frame: u = baseRotation⁻¹ · direction.
    scratchQuat.copyFrom(joint.baseRotation).conjugate();
    scratchQuat.rotateVector(scratchVecA, scratchVecB);
    // Project both the rest direction and the target direction onto the hinge plane.
    const axis = joint.axis;
    const restDot = joint.direction.x * axis.x + joint.direction.y * axis.y + joint.direction.z * axis.z;
    scratchVecC.set(
      joint.direction.x - axis.x * restDot,
      joint.direction.y - axis.y * restDot,
      joint.direction.z - axis.z * restDot,
    );
    const restLength = scratchVecC.length();
    if (!(restLength > 1e-9)) return null;
    scratchVecC.scale(1 / restLength);
    const targetDot = scratchVecB.x * axis.x + scratchVecB.y * axis.y + scratchVecB.z * axis.z;
    scratchVecB.x -= axis.x * targetDot;
    scratchVecB.y -= axis.y * targetDot;
    scratchVecB.z -= axis.z * targetDot;
    const targetLength = scratchVecB.length();
    if (!(targetLength > 1e-9)) return null;
    scratchVecB.scale(1 / targetLength);
    // Signed angle from the rest direction to the target direction about the axis.
    const crossX = scratchVecC.y * scratchVecB.z - scratchVecC.z * scratchVecB.y;
    const crossY = scratchVecC.z * scratchVecB.x - scratchVecC.x * scratchVecB.z;
    const crossZ = scratchVecC.x * scratchVecB.y - scratchVecC.y * scratchVecB.x;
    const sin = crossX * axis.x + crossY * axis.y + crossZ * axis.z;
    const cos = scratchVecC.x * scratchVecB.x + scratchVecC.y * scratchVecB.y + scratchVecC.z * scratchVecB.z;
    return Math.atan2(sin, cos);
  }
}
