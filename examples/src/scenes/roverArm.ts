/**
 * Perseverance robotic arm — unfold/stow choreography plus thumbstick jogging. Pure state (no
 * engine, DOM or GPU objects) so it runs, and is unit-tested, in Node. The Mars scene owns one
 * controller, feeds it stick / keyboard axes every frame and writes `pose()` onto the five joint
 * pivots of the GLB's `arm` chain (emitted by scripts/convert-perseverance.mjs).
 *
 * Joints — index · name · axis in the stowed frame · what + does:
 *   0 azimuth   +Y  swings the arm about the vertical mount ring (stowed, the arm lies across the
 *                   nose pointing at the rover's left; +90° points it forward, more turns it right)
 *   1 shoulder  −Z  raises the upper arm
 *   2 elbow     −Z  raises the forearm tip
 *   3 wrist     −Z  pitches the turret up; slaved while jogging (see below)
 *   4 turret    +Y  spins the instrument turret about the wrist post
 * Angles are radians relative to the stowed pose, which is how the NASA model ships.
 *
 * Unfold: `setDeployed(true)` runs a normalised progress 0 → 1 over {@link ARM_DEPLOY_SECONDS}
 * through a keyframed choreography — lift the turret off the deck, swing the folded arm out in
 * front of the rover, then open the elbow up and over the top into the ready pose (upper arm
 * raised, forearm angled down, turret held level with the drill pointing at the ground). The elbow
 * deliberately takes the long way round: the short way swings the turret through the ground. Stow
 * plays the same path backwards. Progress is acceleration-limited, so reversing mid-way eases
 * instead of snapping.
 *
 * Jogging: only once fully unfolded ({@link RoverArmController.unfolded}). Each axis drives one
 * joint's velocity (deflection × max rate, first-order smoothed for a little mechanical inertia),
 * clamped to joint limits. The wrist is slaved so the turret keeps its pitch while the shoulder and
 * elbow move (the drill stays pointing down). A ground guard refuses shoulder/elbow motion that
 * would take the turret joint below {@link ARM_MIN_TURRET_HEIGHT} above the wheels' contact plane.
 * Jog offsets fade out during the first half of a stow and reset at full stow, so the next unfold
 * returns to the ready pose.
 */

/** Joint names in chain order (matches the GLB `arm` chain and {@link RoverArmController.pose}). */
export const ARM_JOINTS = ["azimuth", "shoulder", "elbow", "wrist", "turret"] as const;
export const ARM_JOINT_COUNT = ARM_JOINTS.length;

/** Seconds for a full unfold (or stow) at cruise speed. */
export const ARM_DEPLOY_SECONDS = 6;
/** Seconds to reach cruise speed from rest (reversing takes twice this). */
const ARM_RAMP_SECONDS = 0.35;
/** Time constant of the jog-rate smoothing: how quickly a joint follows the stick. */
const ARM_JOG_SMOOTH_SECONDS = 0.14;
/** A coasting joint slower than this (rad/s, ≈0.1°/s) is at rest. */
const JOG_REST_RATE = 2e-3;

const DEG = Math.PI / 180;

/**
 * Stowed link directions in the arm plane, in degrees above the reach direction (the plane's
 * horizontal once the arm is swung forward): upper arm J2→J3 and forearm J3→J4. Measured from the
 * GLB joint offsets; `tests/roverGlb.test.ts` re-derives them so a reconversion cannot drift.
 */
export const ARM_STOWED_UPPER_ARM_DEG = 16.2;
export const ARM_STOWED_FOREARM_DEG = 178.16;
/** The turret axis (the J5 post) is vertical when stowed. */
const ARM_STOWED_TURRET_PITCH_DEG = 90;

/**
 * Ready pose as link directions in the arm plane: upper arm 35° up, forearm 45° below the
 * horizontal, turret axis level (pointing away from the rover) and spun −90° so the drill faces
 * the ground. Joint angles follow from the stowed directions.
 */
const READY_UPPER_ARM_DEG = 35;
const READY_FOREARM_DEG = -45;
const READY_TURRET_PITCH_DEG = 0;
const READY_SHOULDER_DEG = READY_UPPER_ARM_DEG - ARM_STOWED_UPPER_ARM_DEG;
/** −241.96°: the long way round (up and over the top). The short way, +118.04°, digs in. */
const READY_ELBOW_DEG =
  READY_FOREARM_DEG - READY_UPPER_ARM_DEG - (ARM_STOWED_FOREARM_DEG - ARM_STOWED_UPPER_ARM_DEG);
const READY_WRIST_DEG = READY_TURRET_PITCH_DEG - ARM_STOWED_TURRET_PITCH_DEG - READY_SHOULDER_DEG - READY_ELBOW_DEG;

/** Ready pose joint angles in degrees, {@link ARM_JOINTS} order. */
export const ARM_READY_DEG: readonly number[] = [90, READY_SHOULDER_DEG, READY_ELBOW_DEG, READY_WRIST_DEG, -90];

type Keys = readonly (readonly [t: number, deg: number])[];

/**
 * The unfold choreography: per joint, (progress, degrees) keys eased with smoothstep, so every
 * joint starts and stops gently at each key. Stages overlap slightly so the motion flows:
 *   0.00–0.14  lift  — the elbow opens a little and the wrist compensates: the turret rises
 *                      straight off the deck without tilting. The shoulder must stay put here —
 *                      the stowed upper arm sits right against the front housing (the source's
 *                      `lab` node) and pitching it up cuts ~10 cm into it (voxel sweep).
 *   0.16–0.48  swing — azimuth 0 → 90°: the folded arm swings out in front of the rover
 *   0.42–0.92  reach — the elbow opens up and over, the wrist brings the turret level and the
 *                      shoulder rises to its ready angle, now clear of the body
 *   0.60–0.97  aim   — the turret spins the drill to face the ground
 */
const LIFT_ELBOW_DEG = -25;
const LIFT_WRIST_DEG = -LIFT_ELBOW_DEG;
const R = ARM_READY_DEG;
const CHOREOGRAPHY: readonly Keys[] = [
  [[0, 0], [0.16, 0], [0.48, R[0]!], [1, R[0]!]],
  [[0, 0], [0.4, 0], [0.86, R[1]!], [1, R[1]!]],
  [[0, 0], [0.14, LIFT_ELBOW_DEG], [0.42, LIFT_ELBOW_DEG], [0.9, R[2]!], [1, R[2]!]],
  [[0, 0], [0.14, LIFT_WRIST_DEG], [0.42, LIFT_WRIST_DEG], [0.92, R[3]!], [1, R[3]!]],
  [[0, 0], [0.6, 0], [0.97, R[4]!], [1, R[4]!]],
];

/** Progress at and below which jog offsets have fully faded out on the way in. */
const JOG_FADE_START = 0.5;

/**
 * Jog limits in degrees. Azimuth and turret spin are absolute joint angles (stowed = 0). The
 * shoulder is limited by the upper arm's direction above the horizontal, and the elbow by the
 * forearm's angle relative to the upper arm (0° = straight, negative = folded down) — which is
 * what actually bounds the reach: −10° almost straight … −120° folded back. A 1–2.5 cm voxel
 * sweep of the model over this whole box (with the ground guard) finds no self-collision; folding
 * further at the azimuth extremes drives the turret into the front hazcams / calibration target,
 * or the forearm into the front-right wheel and rocker.
 */
const LIMIT_AZIMUTH_DEG = [30, 150] as const;
const LIMIT_UPPER_ARM_DEG = [-20, 75] as const;
const LIMIT_ELBOW_RELATIVE_DEG = [-120, -10] as const;
const LIMIT_TURRET_SPIN_DEG = [-270, 90] as const;

/** Offset limits (radians from the ready pose) per joint; the wrist is slaved, not limited. */
const OFFSET_LIMITS: readonly (readonly [number, number])[] = [
  [(LIMIT_AZIMUTH_DEG[0] - R[0]!) * DEG, (LIMIT_AZIMUTH_DEG[1] - R[0]!) * DEG],
  [(LIMIT_UPPER_ARM_DEG[0] - READY_UPPER_ARM_DEG) * DEG, (LIMIT_UPPER_ARM_DEG[1] - READY_UPPER_ARM_DEG) * DEG],
  [
    (LIMIT_ELBOW_RELATIVE_DEG[0] - (READY_FOREARM_DEG - READY_UPPER_ARM_DEG)) * DEG,
    (LIMIT_ELBOW_RELATIVE_DEG[1] - (READY_FOREARM_DEG - READY_UPPER_ARM_DEG)) * DEG,
  ],
  [-Infinity, Infinity],
  [(LIMIT_TURRET_SPIN_DEG[0] - R[4]!) * DEG, (LIMIT_TURRET_SPIN_DEG[1] - R[4]!) * DEG],
];

/** Maximum jog rates at full stick deflection, degrees per second. */
export const ARM_JOG_RATE_DEG = { swing: 30, shoulder: 20, elbow: 30, turret: 60 } as const;

/**
 * Planar arm geometry for the ground guard, in metres: the shoulder pitch joint (J2) height above
 * the wheels' contact plane, and each link's stowed vector in the arm plane (u = reach, v = up):
 * upper arm J2→J3, forearm J3→J4, wrist link J4→J5. Measured from the GLB (see the test).
 */
export const ARM_SHOULDER_HEIGHT = 0.82275;
export const ARM_LINKS_UV: readonly (readonly [number, number])[] = [
  [0.78691, 0.2286],
  [-0.7529, 0.02423],
  [-0.17571, 0.15246],
];
/** Lowest the turret joint may be jogged, metres above the contact plane (the turret body reaches ≈0.47 m below it). */
export const ARM_MIN_TURRET_HEIGHT = 0.5;

/** Jog axes, each −1…1 (sticks are dead-zoned by the input layer). */
export interface ArmJogInput {
  /** Left stick X: swing the arm (+ = toward the rover's right). */
  swing: number;
  /** Left stick Y: raise (+) / lower the shoulder. */
  shoulder: number;
  /** Right stick Y: raise (+) / lower the elbow. */
  elbow: number;
  /** Right stick X: spin the turret (+ = clockwise seen from behind the turret). */
  turret: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Keyframed angle (radians) of `joint` at progress `t`, smoothstep-eased within each segment. */
export function choreographyAngle(joint: number, t: number): number {
  const keys = CHOREOGRAPHY[joint];
  if (!keys || keys.length === 0) return 0;
  const first = keys[0]!;
  if (t <= first[0]) return first[1] * DEG;
  for (let k = 1; k < keys.length; k++) {
    const b = keys[k]!;
    if (t <= b[0]) {
      const a = keys[k - 1]!;
      const u = b[0] > a[0] ? smoothstep((t - a[0]) / (b[0] - a[0])) : 1;
      return (a[1] + (b[1] - a[1]) * u) * DEG;
    }
  }
  return keys[keys.length - 1]![1] * DEG;
}

/** How much of the jog offset applies at progress `t`: 1 when unfolded, 0 from mid-stow down. */
export function jogWeight(t: number): number {
  return smoothstep((t - JOG_FADE_START) / (1 - JOG_FADE_START));
}

/**
 * Height of the turret joint (J5) above the contact plane for the given pitch-joint angles
 * (radians, stowed = 0). Azimuth does not matter: it turns about the vertical.
 */
export function turretJointHeight(shoulder: number, elbow: number, wrist: number): number {
  const s1 = shoulder;
  const s2 = s1 + elbow;
  const s3 = s2 + wrist;
  const [l1, l2, l3] = ARM_LINKS_UV as readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
  // A positive pitch turns a link counter-clockwise in the (reach, up) plane.
  return (
    ARM_SHOULDER_HEIGHT +
    l1[0] * Math.sin(s1) + l1[1] * Math.cos(s1) +
    l2[0] * Math.sin(s2) + l2[1] * Math.cos(s2) +
    l3[0] * Math.sin(s3) + l3[1] * Math.cos(s3)
  );
}

/** Jog-driven joints (the wrist, index 3, is slaved). */
const JOG_JOINTS = [0, 1, 2, 4] as const;

export class RoverArmController {
  private target = false;
  private t = 0;
  private tVel = 0;
  /** Jog offsets from the ready pose, radians, {@link ARM_JOINTS} order (the wrist is derived). */
  private readonly offset = new Float64Array(ARM_JOINT_COUNT);
  /** Smoothed jog rates, radians / second (the wrist entry is unused). */
  private readonly rate = new Float64Array(ARM_JOINT_COUNT);
  private readonly cmd = new Float64Array(ARM_JOINT_COUNT);

  /** Commanded state: true = unfold and stay out, false = stow. */
  get deployed(): boolean {
    return this.target;
  }

  /** Choreography progress: 0 stowed … 1 unfolded. */
  get progress(): number {
    return this.t;
  }

  /** Fully unfolded and commanded out: jogging (and the arm sticks) are live. */
  get unfolded(): boolean {
    return this.target && this.t >= 1;
  }

  /** Command unfold (true) or stow (false). Safe to call every frame; only a change matters. */
  setDeployed(deployed: boolean): void {
    this.target = deployed;
  }

  /**
   * Advance by `dt` seconds. `input` is ignored unless {@link unfolded}. Returns true when the pose
   * changed, so the caller can skip writing transforms otherwise.
   */
  update(dt: number, input: ArmJogInput | null): boolean {
    if (!(dt > 0)) return false;
    let changed = false;

    // Choreography progress with an acceleration limit, so starts, stops and reversals ease.
    const goal = this.target ? 1 : 0;
    const cruise = 1 / ARM_DEPLOY_SECONDS;
    const wantVel = this.t < goal ? cruise : this.t > goal ? -cruise : 0;
    const maxDv = (cruise / ARM_RAMP_SECONDS) * dt;
    this.tVel += clamp(wantVel - this.tVel, -maxDv, maxDv);
    if (this.tVel !== 0) {
      const before = this.t;
      this.t = clamp(this.t + this.tVel * dt, 0, 1);
      if ((this.t === 1 && this.tVel > 0) || (this.t === 0 && this.tVel < 0)) this.tVel = 0;
      changed = this.t !== before;
    }

    // Jog: stick deflection → joint rate → offset. Rates decay whenever jogging is not live
    // (including right after a stow starts, so an in-flight jog coasts to a stop).
    const src = this.unfolded ? input : null;
    const cmd = this.cmd;
    cmd[0] = src ? clamp(src.swing, -1, 1) * ARM_JOG_RATE_DEG.swing * DEG : 0;
    cmd[1] = src ? clamp(src.shoulder, -1, 1) * ARM_JOG_RATE_DEG.shoulder * DEG : 0;
    cmd[2] = src ? clamp(src.elbow, -1, 1) * ARM_JOG_RATE_DEG.elbow * DEG : 0;
    // Clockwise seen from behind the turret (its axis points away from the viewer) is negative.
    cmd[4] = src ? -clamp(src.turret, -1, 1) * ARM_JOG_RATE_DEG.turret * DEG : 0;
    const k = 1 - Math.exp(-dt / ARM_JOG_SMOOTH_SECONDS);
    let moving = false;
    for (const j of JOG_JOINTS) {
      const r = this.rate[j]! + (cmd[j]! - this.rate[j]!) * k;
      // Snap an idle coast below ~0.1°/s to rest (invisible) so a released joint settles in
      // well under a second and the scene stops rewriting transforms.
      this.rate[j] = cmd[j] === 0 && Math.abs(r) < JOG_REST_RATE ? 0 : r;
      if (this.rate[j] !== 0) moving = true;
    }
    if (moving && this.t > 0) changed = this.jog(dt) || changed;

    if (this.t === 0 && !this.target) {
      // Fully stowed: forget the jog so the next unfold ends in the ready pose.
      this.offset.fill(0);
      this.rate.fill(0);
    }
    return changed;
  }

  /** Joint angles (radians, stowed = 0) for the current state, {@link ARM_JOINTS} order. */
  pose(out: Float64Array = new Float64Array(ARM_JOINT_COUNT)): Float64Array {
    const w = jogWeight(this.t);
    for (let j = 0; j < ARM_JOINT_COUNT; j++) out[j] = choreographyAngle(j, this.t) + w * this.offset[j]!;
    return out;
  }

  /** Jog offset of `joint` from the ready pose, degrees (HUD / automation). */
  jogDegrees(joint: number): number {
    return (this.offset[joint] ?? 0) / DEG;
  }

  /** Integrate the smoothed rates into the offsets under joint limits and the ground guard. */
  private jog(dt: number): boolean {
    const o = this.offset;
    let moved = false;
    for (const j of JOG_JOINTS) {
      const rate = this.rate[j]!;
      if (rate === 0) continue;
      const prev = o[j]!;
      const limits = OFFSET_LIMITS[j]!;
      const wanted = prev + rate * dt;
      const next = clamp(wanted, limits[0], limits[1]);
      if (next !== wanted) this.rate[j] = 0; // hit a stop: no wind-up against it
      if (next === prev) continue;
      if (j === 1 || j === 2) {
        // Pitch joints: the wrist follows so the turret keeps its pitch, and the ground guard
        // refuses a step that takes the turret joint lower once it is already too low.
        const h0 = this.turretHeight();
        o[j] = next;
        o[3] = -(o[1]! + o[2]!);
        const h1 = this.turretHeight();
        if (h1 < ARM_MIN_TURRET_HEIGHT && h1 < h0) {
          o[j] = prev;
          o[3] = -(o[1]! + o[2]!);
          this.rate[j] = 0;
          continue;
        }
      } else {
        o[j] = next;
      }
      moved = true;
    }
    return moved;
  }

  /** Turret joint height for the ready pose plus the current jog offsets. */
  private turretHeight(): number {
    const o = this.offset;
    return turretJointHeight((R[1]! * DEG) + o[1]!, (R[2]! * DEG) + o[2]!, (R[3]! * DEG) + o[3]!);
  }
}
