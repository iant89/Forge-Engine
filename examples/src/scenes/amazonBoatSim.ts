/**
 * The launch: a planing deep-V hull floated on the same Gerstner surface the water shader draws.
 *
 * Why the hull is a *function* and not a mesh: `hullHalfWidth(t, h)` below is the lofting spec for the
 * visual hull *and* the only source of flotation geometry here, so the boat you see is literally the boat
 * that floats — draft, trim, roll stiffness and grounding contact all fall out of the shape instead of
 * being tuned against it. The same discipline keeps the physics honest with the renderer: `sampleGerstner`
 * and the water program evaluate the same sum from the same uniforms, so the surface a panel reads here is
 * the surface that pixel shows there.
 *
 * The model is a waterplane-column hull. The deck plan is cut into columns; each carries a vertical
 * buoyancy force `ρ·g·A·submergedHeight` plus damping against the water's own vertical motion, and the
 * *distribution* of those forces is what pitches and rolls the boat. This is the classical marine
 * hydrostatics discretisation (it reproduces the waterplane's second moments, hence metacentric roll
 * stiffness, to within a few percent), and it gives the interesting behaviour for free: a crest under one
 * shoulder rolls her, a crest amidships bridges her and pitches her, running bow-first into a chop slaps,
 * and grounding on a bar trims her over.
 *
 * Hydrodynamic forces act on velocity *relative to the water*, which is what makes the current matter:
 * 4 knots over the ground with the flow is 1.5 knots over the hull, so the rudder goes slack and the bow
 * drifts wide of the bend. Longitudinally the drag hump near Froude 0.42 is the hull-speed wall — a
 * displacement hull cannot get out of its own trough, and this one has to climb it on planing lift, which
 * is exactly what a lightly loaded launch does going upriver.
 *
 * Axes: right-handed, +Y up, +Z forward, so +X is to **port** and a rotation about +Z raises port —
 * positive `roll` therefore means starboard down, as the HUD reports it. `pitch` is bow-up positive,
 * which is a rotation about +X of the *negative* angle; `bodyToWorld` and `applyBoatPose` both apply that
 * sign, and the rotation order matches `Quat.setEulerComponents` (yaw, then pitch, then roll) so a
 * transform written from these angles lands the hull exactly where the integrator put it.
 */

import { clamp, createWaterSample, damp, sampleGerstner, type GerstnerWave, type Transform } from "@forge/engine";

/** River water with silt in it: denser than fresh, so the hull rides a few millimetres higher. */
export const WATER_DENSITY = 1006;
const GRAVITY = 9.81;

/** Length overall, stem to transom (metres). */
export const BOAT_LOA = 9.4;
/** Maximum beam, at the gunwale sheer. */
export const BOAT_BEAM = 2.92;
/** Keel to deck at the transom: the hull's structural depth. */
export const BOAT_DEPTH = 1.02;
/** Chine height above the keel amidships, as a fraction of the depth. */
const CHINE_FRACTION = 0.44;
/** Half-beam at the chine, as a fraction of the maximum: how hard the V's shoulder is. */
const CHINE_RATIO = 0.58;
/** Mass centre: 0.44 of LOA forward of the transom, 0.62 m above the keel line. */
const CG_FROM_TRANSOM = 0.44;
const CG_HEIGHT = 0.62;
/** Panel grid: 8 rows × 3 columns of waterplane columns over this slice of the length. */
const PANEL_ROWS = 8;
const PANEL_COLS = 3;
const PANEL_TAIL_T = 0.045;
const PANEL_NOSE_T = 0.93;

/** Displacement mass with engines, fuel, batteries and the load carried upriver. */
export const BOAT_MASS = 1260;
/** Redline of the twin outboards. */
export const BOAT_MAX_RPM = 5400;
export const BOAT_IDLE_RPM = 780;
/** Static thrust in newtons at wide-open throttle; the terminal-speed test is what sets this. */
const THRUST_COEFFICIENT = 12000;
/** Astern thrust is the same prop turning the other way through a smaller bucket. */
const REVERSE_SCALE = 0.38;
/** Rudder angle at full lock (rad), and how fast the helm gets there and centres again (rates, 1/s). */
export const BOAT_HELM_MAX = 0.58;
const HELM_RATE = 1.9;
const HELM_RETURN = 2.6;
/** Engine spool rate (1/s): slower astern, because the prop has to stop spinning before it can push back. */
const SPOOL_AHEAD = 0.85;
const SPOOL_ASTERN = 0.7;
/** Wash speed at redline (m/s): what the rudder feels with the boat still alongside the dock. */
const WASH_SPEED = 7.6;
/**
 * Prop wash does not start from nothing at idle: the leg sits in the same diameter of disc whether the
 * engine is loafing or at redline, so even idle rpm throws enough wash over the rudder to answer the helm
 * leaving the dock. This is the floor of `WASH_SPEED` at idle rpm, scaling up to the full figure at redline.
 */
const WASH_IDLE_FLOOR = 0.32;

function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Lofting station: the hull's shape at one frame along the length. */
export interface HullProfile {
  /** Half-beam at the gunwale (metres). */
  halfBeam: number;
  /** Keel height *above* the amidships keel line: the rocker, so it is positive toward the bow. */
  keelY: number;
  /** Sheer (deck) height above the amidships keel line. */
  deckY: number;
  /** Chine height above this station's keel. */
  chineY: number;
}

/**
 * Lofting station at `t`, where 0 is the transom and 1 the stem.
 *
 * Full aft, fine forward: a planing hull needs its buoyancy at the back to get on plane, so `halfBeam`
 * holds near the maximum until 60 % of the length and then falls away, while `keelY` rises steeply into
 * the entry — that hook is what stops the bow tripping in a head sea. `deckY` lifts at both ends (the
 * sheer), which is what keeps river water off the foredeck when running into a chop.
 */
export function hullProfileAt(t: number): HullProfile {
  const a = clamp(t, 0, 1);
  const forward = smooth01((a - 0.6) / 0.4);
  const transomFlare = 0.92 + 0.08 * smooth01(a / 0.12);
  const halfBeam = BOAT_BEAM * 0.5 * (1 - 0.94 * forward) * transomFlare;
  const rise = smooth01((a - 0.4) / 0.6);
  const keelY = 0.36 * rise + 0.06 * smooth01((a - 0.88) / 0.12);
  const deckY = BOAT_DEPTH + 0.24 * smooth01((a - 0.5) / 0.5) + 0.06 * smooth01((0.14 - a) / 0.14);
  const chineY = BOAT_DEPTH * CHINE_FRACTION * (1 - 0.5 * rise);
  return { halfBeam, keelY, deckY, chineY };
}

/**
 * Half-width of the hull at station `t`, `h` metres above that station's keel.
 *
 * Below the chine the section is a constant-deadrise V, so width grows linearly with height — that is what
 * makes the entry soft in a head sea. Above it the sides flare outward more slowly than the V would
 * continue to, which keeps the widest point low (good for planing) and the freeboard narrow (good for
 * seeing the bank from the helm).
 */
export function hullHalfWidth(t: number, h: number): number {
  const profile = hullProfileAt(t);
  const halfBeam = Math.max(0.02, profile.halfBeam);
  const chine = Math.max(0.05, profile.chineY);
  if (h <= 0) return halfBeam * 0.05;
  if (h <= chine) return (halfBeam * CHINE_RATIO * h) / chine;
  const over = clamp((h - chine) / Math.max(0.05, profile.deckY - profile.keelY - chine), 0, 1);
  return halfBeam * (CHINE_RATIO + (1 - CHINE_RATIO) * Math.pow(over, 0.8));
}

/** One vertical column of the hull: a planform patch with the height of hull standing above it. */
export interface HullPanel {
  /** Lateral centre, port positive. */
  x: number;
  /** Longitudinal centre, forward positive (origin: keel amidships). */
  z: number;
  /** Station this column was cut at. */
  t: number;
  /** Keel height at the column. */
  keelY: number;
  /** Deck height at the column: buoyancy stops here, which is how the boat would ship water. */
  deckY: number;
  /** Planform area at the design waterline (m²). */
  area: number;
  /** Height of the column, keel to deck (m). */
  height: number;
  /** Metres of height per table entry. */
  heightStep: number;
  /**
   * Displaced volume (m³) of this column when it stands `k · heightStep` in the water, and the waterplane
   * width (m) at the same heights. Both come from `hullHalfWidth`, so a column is not a rectangular box
   * but the real slice of V the hull carves at that height: at a shallow draft a deep-V displaces almost
   * nothing, the chine engages hard when it buries, and the flare carries the boat as it rises on the
   * plane. The volume table is what buoyancy integrates, the width table is what damping and the static
   * solve differentiate.
   */
  volume: Float32Array;
  width: Float32Array;
  /** Load this column carries at rest (N), from the static solve. */
  load: number;
}

/** Entries in a column's hydrostatic table. */
const PANEL_TABLE_ENTRIES = 20;

export interface BoatConfig {
  readonly mass: number;
  readonly panels: readonly HullPanel[];
  /** Draft solved from the lofting so the column loads balance the weight (m). */
  readonly draft: number;
  /** Trim solved at rest, radians bow-up. */
  readonly trimDesign: number;
  /** Initial metacentric height at rest (m): roll stiffness in the units a naval architect uses. */
  readonly gm: number;
  /** Small-angle roll period at rest (s), from `gm`. */
  readonly rollPeriod: number;
  /** Heave damping ratio, as a fraction of critical (the columns' damping is derived from it). */
  readonly heaveDampingRatio: number;
  /** Extra exponential decay on the attitude rates: energy lost to eddies, spray and swamping wash. */
  readonly attitudeDamping: number;
  /** Accelerating the boat accelerates water with it, and it differs a lot per axis. */
  readonly surgeAddedMass: number;
  readonly swayAddedMass: number;
  readonly heaveAddedMass: number;
  /** `½ρ·Cf·Awet·v²` skin friction, with the wetted area tracked from the columns' submersions. */
  readonly frictionCf: number;
  /** Wave-making hump: strength (as a multiplier on skin friction), centre Froude number, width. */
  readonly waveDragGain: number;
  readonly waveDragFroude: number;
  readonly waveDragWidth: number;
  /** Above-water hull area the air drag sees, and the drag coefficient applied to it. */
  readonly airDragArea: number;
  readonly airDragCf: number;
  /**
   * Planing-lift curve slope, as `dCl/d(tan trim_eff)`, and how far *forward of the wetted centroid* the
   * centre of pressure sits: the pressure peak of a planing bottom is at its spray root, not at its middle.
   */
  readonly liftCoefficient: number;
  readonly liftLever: number;
  /**
   * Rocker: how much the V's planing form shifts the lift curve toward bow-up per unit of Froude number.
   * This is an *angle of attack* offset, not a second lift force — modelling the rocker as its own force
   * double-counts it and throws the boat out of the water.
   */
  readonly rockerLift: number;
  /**
   * Angular rate of attack the leg trim buys (trimming the leg up squares the transom against the water) and
   * the damping that bleeds the pitch oscillation a hull climbing onto the plane always overshoots.
   */
  readonly legTrimAngle: number;
  /** Pitch damping (N·m·s/rad) from the waterplane's fore-aft flow: without it the trim rings for minutes. */
  readonly pitchDamping: number;
  /**
   * Thrust lost to a ventilating propeller at full trim-up (worst in the flat, when the boat is still behind
   * her own transom wave), and the yaw damping the tilted leg buys at speed.
   */
  readonly legTrimThrustLoss: number;
  readonly legTrimYawHelp: number;
  /**
   * Effective frontal area of the outboard leg and how much of it the water still sees: hard down the
   * gearcase and anti-ventilation plate are drag, trimmed out they almost clear the surface.
   */
  readonly legDragArea: number;
  readonly legDragDown: number;
  readonly legDragClear: number;
  /** Rudder: side force per unit sin(deflection) per unit² of effective flow, and its lever arm. */
  readonly rudderGain: number;
  readonly rudderLever: number;
  /** Fraction of the propeller wash that reaches the rudder when the boat is still. */
  readonly washSteering: number;
  /** Crossflow (leeway) drag on the hull's lateral projected area, and its share of the yaw damping. */
  readonly crossflowGain: number;
  /** Weather helm: how hard the hull turns into the relative flow. */
  readonly weathervaneGain: number;
  readonly yawDamping: number;
  /** Keel contact: stiffness per metre of penetration, its damping, and Coulomb scrub friction. */
  readonly groundStiffness: number;
  readonly groundDamping: number;
  readonly groundFriction: number;
  /** Terminal speed in flat water at wide-open throttle (m/s): the thrust curve is tuned to it. */
  readonly hullSpeed: number;
  readonly inertiaRoll: number;
  readonly inertiaPitch: number;
  readonly inertiaYaw: number;
  /** Mass centre in body coordinates, so the weight moment and the trim solve agree. */
  readonly cgX: number;
  readonly cgY: number;
  readonly cgZ: number;
}

export interface BoatInput {
  /** 0..1 throttle, applied to ahead or astern according to `gear`. */
  throttle: number;
  /** Commanded helm: −1 hard-over starboard, +1 hard-over port. */
  steer: number;
  /** 1 ahead, 0 neutral, −1 astern. */
  gear: number;
  /** Outboard leg trim −1..1: −1 down in the hole (thrust, trim, drag), +1 up (shallow, flatter, slower). */
  trim: number;
}

export function createBoatInput(): BoatInput {
  return { throttle: 0, steer: 0, gear: 0, trim: 0 };
}

/** What the hull needs from the world: the scene supplies the river, a test supplies a plane. */
export interface BoatEnvironment {
  /** Mean water surface height — the shader's `level`, and the river's stage. */
  level: number;
  /** The Gerstner set, shared with `scene.settings.water.waves` so CPU and GPU agree. */
  waves: readonly GerstnerWave[];
  /** Wave clock in seconds: the same value the water program advances. */
  time: number;
  /** Bed (terrain) elevation under a point. */
  bedElevation(x: number, z: number): number;
  /** Water velocity at a point, written into `out`: the river's current. */
  currentAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number };
}

export interface BoatState {
  /** World position of the keel amidships — the model's local origin. */
  x: number;
  y: number;
  z: number;
  heading: number;
  roll: number;
  pitch: number;
  /** World-frame velocity (m/s). */
  vx: number;
  vy: number;
  vz: number;
  /** Body-frame rates (rad/s): the Euler derivatives of `roll`, `pitch`, `heading`. */
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  rpm: number;
  /** Helm angle actually achieved, after the rate limit (rad, port positive). */
  helm: number;
  /**
   * Outboard leg trim, 0 = down in the hole, 1 = fully trimmed up. The driver's shallow-water and
   * rough-water control: up cuts thrust and drops the bow but keeps the prop clear of a bar, down buys
   * thrust and steerage at the cost of drag and a bow that likes to trip.
   */
  legTrim: number;
  grounded: boolean;
  /** Deepest keel penetration into the bed (m). */
  penetration: number;
  /** Impact strength 0..1, decaying: drives hull-slap audio and spray bursts. */
  slap: number;
  /** Wake/foam strength 0..1, from speed, prop wash and how hard the hull is hitting the water. */
  wake: number;
  /** Crest-to-trough across the panel grid (m): how bouncy it is out there. */
  seaState: number;
  /** Speed through the water, ahead positive (m/s): what the hydrodynamics see. */
  speedWater: number;
  /** Speed over the ground (m/s): what a mark on the bank appears to move at. */
  speedGround: number;
  /** Drift angle (rad): how far the bow points off the track. */
  slip: number;
  /** Mean, forward and aft draft readings (m). */
  draft: number;
  draftForward: number;
  draftAft: number;
  /** Freeboard amidships (m): how close the river is to coming over the side. */
  freeboard: number;
  /** 0 in her trough, 1 when she is flat on top and the transom is ventilating. */
  planing: number;
  /** Simulated seconds since `resetBoat`. */
  time: number;
}

export function createBoatState(): BoatState {
  return {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    rollRate: 0,
    pitchRate: 0,
    yawRate: 0,
    rpm: BOAT_IDLE_RPM,
    helm: 0,
    legTrim: 0,
    grounded: false,
    penetration: 0,
    slap: 0,
    wake: 0,
    seaState: 0,
    speedWater: 0,
    speedGround: 0,
    slip: 0,
    draft: 0,
    draftForward: 0,
    draftAft: 0,
    freeboard: BOAT_DEPTH,
    planing: 0,
    time: 0,
  };
}

/**
 * Build the panel grid and solve the static floatation.
 *
 * Draft and trim are *found*, not declared: the columns fill until their buoyancy balances the weight,
 * then the attitude is solved until the pitching moment about the mass centre vanishes. That is what keeps
 * the model self-consistent — change the hull, or add 300 kg of cargo, and the boat settles deeper and by
 * the stern without a single constant being retuned. `gm` and the roll period come out of the same sums, so
 * a test can assert the boat is stiff enough not to capsize and slow enough not to snap between crests.
 */
export function createBoatConfig(overrides: Partial<BoatConfig> = {}): BoatConfig {
  const mass = overrides.mass ?? BOAT_MASS;
  const length = BOAT_LOA;
  const dz = (length * (PANEL_NOSE_T - PANEL_TAIL_T)) / PANEL_ROWS;
  const zStart = -length * 0.5 + length * PANEL_TAIL_T;
  const panels: HullPanel[] = [];
  // Per-column hydrostatics, integrated from the lofting once at build time: `volume[k]` is the m³ this
  // column displaces when its keel stands k·heightStep under the surface, `width[k]` its waterplane width
  // there. Runtime queries interpolate, so nothing in the integrator needs to know the hull's shape — and
  // because the tables come from `hullHalfWidth`, a column is not a rectangular box but the real slice of
  // V the hull carves at that height: at a shallow draft a deep-V displaces almost nothing, the chine
  // engages hard when it buries, and the flare carries the boat as it rises onto the plane.
  for (let i = 0; i < PANEL_ROWS; i++) {
    const z = zStart + dz * (i + 0.5);
    const t = clamp((z + length * 0.5) / length, 0, 1);
    const profile = hullProfileAt(t);
    const columnWidth = Math.max(0.05, 2 * profile.halfBeam) / PANEL_COLS;
    const height = Math.max(0.08, profile.deckY - profile.keelY);
    const step = height / (PANEL_TABLE_ENTRIES - 1);
    const volume = new Float32Array(PANEL_TABLE_ENTRIES);
    const widths = new Float32Array(PANEL_TABLE_ENTRIES);
    let cumulative = 0;
    for (let k = 0; k < PANEL_TABLE_ENTRIES; k++) {
      const w = (2 * hullHalfWidth(t, k * step)) / PANEL_COLS;
      widths[k] = w;
      if (k > 0) cumulative += w * step;
      volume[k] = cumulative;
    }
    for (let j = 0; j < PANEL_COLS; j++) {
      panels.push({
        x: -profile.halfBeam + columnWidth * (j + 0.5),
        z,
        t,
        keelY: profile.keelY,
        deckY: profile.deckY,
        area: columnWidth * dz,
        height,
        heightStep: step,
        volume,
        width: widths,
        load: 0,
      });
    }
  }

  const cgX = 0;
  const cgY = CG_HEIGHT;
  const cgZ = -length * 0.5 + CG_FROM_TRANSOM * length;

  // How much of a column is under water when the keel amidships sits `draft` below the surface and the hull
  // is trimmed by `trim` radians. The lever and the height both use the *same* rotation the integrator
  // uses, and the pitch moment is taken about the keel amidships exactly as `integrate` does, because the
  // design attitude has to be an equilibrium of the model that runs — a static solve that measures its
  // moment a little differently (about the mass centre, along a body axis, without the pendulum term)
  // leaves the boat drifting several degrees and a hand's width off its own waterline on the first step.
  const attitude = new Float64Array(9);
  const keelDepth = (trim: number): ((panel: HullPanel) => number) => {
    bodyToWorld({ heading: 0, roll: 0, pitch: trim }, attitude);
    const ry = attitude[4] ?? 1;
    const rz = attitude[5] ?? 0;
    return (panel) => panel.keelY * ry + panel.z * rz;
  };
  const floatation = (d: number, trim: number): { force: number; moment: number } => {
    const depthOf = keelDepth(trim);
    bodyToWorld({ heading: 0, roll: 0, pitch: trim }, attitude);
    let force = 0;
    let moment = 0;
    for (const panel of panels) {
      const submerged = clamp(d - depthOf(panel), 0, panel.height);
      if (submerged <= 0) continue;
      const buoyant = WATER_DENSITY * GRAVITY * columnVolumeAt(panel, submerged);
      force += buoyant;
      // Bow-up moment of a world-vertical force at this body point: `F(rz·R00 − rx·R20)`, which is the
      // runtime's `r × F` reduced to the one component the trim equation cares about.
      const rx = (attitude[0] ?? 1) * panel.x + (attitude[2] ?? 0) * panel.z;
      const rz = (attitude[6] ?? 0) * panel.x + (attitude[8] ?? 1) * panel.z;
      moment += buoyant * (rz * (attitude[0] ?? 1) - rx * (attitude[6] ?? 0));
    }
    // The weight, at its own height: a CG above the keel line reduces the restoring (the `KG` term) and a
    // CG aft of mid-length is what makes her sit by the stern.
    const gravity = mass * GRAVITY;
    const cRx = (attitude[0] ?? 1) * cgX + (attitude[1] ?? 0) * cgY + (attitude[2] ?? 0) * cgZ;
    const cRz = (attitude[6] ?? 0) * cgX + (attitude[7] ?? 0) * cgY + (attitude[8] ?? 1) * cgZ;
    force -= gravity;
    moment += -gravity * (cRz * (attitude[0] ?? 1) - cRx * (attitude[6] ?? 0));
    return { force, moment };
  };

  let draft = 0.3;
  let trimDesign = 0;
  for (let pass = 0; pass < 24; pass++) {
    let draftLo = 0.002;
    let draftHi = BOAT_DEPTH;
    for (let k = 0; k < 40; k++) {
      const mid = (draftLo + draftHi) * 0.5;
      if (floatation(mid, trimDesign).force < 0) draftLo = mid;
      else draftHi = mid;
    }
    const nextDraft = (draftLo + draftHi) * 0.5;
    let trimLo = -0.12;
    let trimHi = 0.12;
    for (let k = 0; k < 40; k++) {
      const mid = (trimLo + trimHi) * 0.5;
      // The bow-up moment falls as the bow comes up, so a positive residual means the
      // equilibrium sits at a higher trim, not a lower one.
      if (floatation(nextDraft, mid).moment > 0) trimLo = mid;
      else trimHi = mid;
    }
    const nextTrim = (trimLo + trimHi) * 0.5;
    const settled = Math.abs(nextTrim - trimDesign) < 1e-5 && Math.abs(nextDraft - draft) < 1e-5;
    draft = nextDraft;
    trimDesign = nextTrim;
    if (settled) break;
  }

  const columnSubmersion = (panel: HullPanel, under: number): number => clamp(under, 0, panel.height);
  const columnVolume = columnVolumeAt;
  const columnWidthAtLocal = columnWidthAt;

  // The design-waterline areas, now that the attitude is known: these are what the damping law scales by,
  // and `boatWaterplaneArea` reports the sum as the hull's hydrostatic stiffness.
  bodyToWorld({ heading: 0, roll: 0, pitch: trimDesign }, attitude);
  const restRy = attitude[4] ?? 1;
  const restRz = attitude[5] ?? 0;
  const restSubmersion = (panel: HullPanel): number =>
    columnSubmersion(panel, draft - (panel.keelY * restRy + panel.z * restRz));
  for (const panel of panels) {
    panel.area = columnWidthAtLocal(panel, restSubmersion(panel)) * dz;
  }

  let waterplaneArea = 0;
  let inertiaTransverse = 0;
  for (const panel of panels) {
    panel.load = WATER_DENSITY * GRAVITY * columnVolume(panel, restSubmersion(panel));
    waterplaneArea += panel.area;
    inertiaTransverse += panel.area * panel.x * panel.x;
  }
  const volume = mass / WATER_DENSITY;
  const kb = draft * 0.5;
  const bm = inertiaTransverse / Math.max(0.05, volume);
  const gm = kb + bm - cgY;
  const inertiaRoll = mass * Math.pow(0.42 * BOAT_BEAM, 2);
  const inertiaPitch = mass * Math.pow(0.28 * length, 2);
  const inertiaYaw = mass * Math.pow(0.25 * length, 2);
  const rollPeriod = 2 * Math.PI * Math.sqrt(inertiaRoll / Math.max(1, mass * GRAVITY * Math.max(0.05, gm)));

  return {
    mass,
    panels,
    draft,
    trimDesign,
    gm,
    rollPeriod,
    heaveDampingRatio: 0.35,
    attitudeDamping: 1.15,
    surgeAddedMass: 0.16,
    swayAddedMass: 0.85,
    heaveAddedMass: 0.7,
    frictionCf: 0.0046,
    waveDragGain: 1.5,
    waveDragFroude: 0.42,
    waveDragWidth: 0.16,
    airDragArea: 2.4,
    airDragCf: 1.05,
    liftCoefficient: 0.3,
    liftLever: 0.105 * length,
    rockerLift: 0.012,
    legTrimAngle: 0.03,
    pitchDamping: 5200,
    legTrimThrustLoss: 0.3,
    legTrimYawHelp: 0.9,
    legDragArea: 0.045,
    legDragDown: 1.0,
    legDragClear: 0.8,
    rudderGain: 260,
    rudderLever: 0.46 * length,
    washSteering: 0.9,
    crossflowGain: 0.9,
    weathervaneGain: 190,
    yawDamping: 1.2,
    groundStiffness: 320000,
    groundDamping: 40000,
    groundFriction: 0.58,
    hullSpeed: 13.5,
    inertiaRoll,
    inertiaPitch,
    inertiaYaw,
    cgX,
    cgY,
    cgZ,
    ...overrides,
  };
}

/** Rotation of the hull's frame, row-major by world row (`m[r*3+c]` is world axis `r` from body axis `c`).
 *
 * The construction is `Ry(heading)·Rx(−pitch)·Rz(roll)`, written out with the pitch sine folded in — the
 * same order `Quat.setEulerComponents` builds,
 * which is what lets `applyBoatPose` hand the attitude to the scene graph without a second convention.
 */
export function bodyToWorld(state: { heading: number; roll: number; pitch: number }, out: Float64Array): Float64Array {
  const cy = Math.cos(state.heading);
  const sy = Math.sin(state.heading);
  const cp = Math.cos(state.pitch);
  const sp = Math.sin(state.pitch);
  const cr = Math.cos(state.roll);
  const sr = Math.sin(state.roll);
  out[0] = cy * cr - sy * sp * sr;
  out[1] = -cy * sr - sy * sp * cr;
  out[2] = sy * cp;
  out[3] = cp * sr;
  out[4] = cp * cr;
  out[5] = sp;
  out[6] = -sy * cr - cy * sp * sr;
  out[7] = sy * sr - cy * sp * cr;
  out[8] = cy * cp;
  return out;
}

/** Body offset → world offset. */
function toWorld(
  m: Float64Array,
  bx: number,
  by: number,
  bz: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  out.x = (m[0] ?? 1) * bx + (m[1] ?? 0) * by + (m[2] ?? 0) * bz;
  out.y = (m[3] ?? 0) * bx + (m[4] ?? 1) * by + (m[5] ?? 0) * bz;
  out.z = (m[6] ?? 0) * bx + (m[7] ?? 0) * by + (m[8] ?? 1) * bz;
  return out;
}

/** World vector → body components (the transpose of a rotation). */
function toBody(
  m: Float64Array,
  wx: number,
  wy: number,
  wz: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  out.x = (m[0] ?? 1) * wx + (m[3] ?? 0) * wy + (m[6] ?? 0) * wz;
  out.y = (m[1] ?? 0) * wx + (m[4] ?? 1) * wy + (m[7] ?? 0) * wz;
  out.z = (m[2] ?? 0) * wx + (m[5] ?? 0) * wy + (m[8] ?? 1) * wz;
  return out;
}

/** Total planform area of the column grid at the design waterline (m²): heave stiffness. */
export function boatWaterplaneArea(panels: readonly HullPanel[]): number {
  let area = 0;
  for (const panel of panels) area += panel.area;
  return area;
}

/** Summed waterplane width of the column grid (m): how the heave damping is shared between columns. */
export function boatWaterplaneWidth(panels: readonly HullPanel[]): number {
  let width = 0;
  for (const panel of panels) width += columnWidthAt(panel, panel.height * 0.35);
  return width;
}

/** Linear read of a column's displaced-volume table (m³) at `submerged` metres of water over its keel. */
function columnVolumeAt(panel: HullPanel, submerged: number): number {
  const k = submerged / panel.heightStep;
  const k0 = Math.min(PANEL_TABLE_ENTRIES - 2, Math.max(0, Math.floor(k)));
  const frac = clamp(k - k0, 0, 1);
  return (panel.volume[k0] ?? 0) * (1 - frac) + (panel.volume[k0 + 1] ?? 0) * frac;
}

/** Linear read of a column's waterplane width (m) at `submerged` metres. */
function columnWidthAt(panel: HullPanel, submerged: number): number {
  const k = submerged / panel.heightStep;
  const k0 = Math.min(PANEL_TABLE_ENTRIES - 2, Math.max(0, Math.floor(k)));
  const frac = clamp(k - k0, 0, 1);
  return (panel.width[k0] ?? 0) * (1 - frac) + (panel.width[k0 + 1] ?? 0) * frac;
}

const scratchMatrix = new Float64Array(9);
const scratchSurface = createWaterSample();
const scratchEarlier = createWaterSample();
const scratchOffset = { x: 0, y: 0, z: 0 };
const scratchForce = { x: 0, y: 0, z: 0 };
const scratchWorld = { x: 0, y: 0, z: 0 };
const scratchFlow = { x: 0, y: 0, z: 0 };
const scratchGravity = { x: 0, y: 0, z: 0 };
const scratchDeck = { x: 0, y: 0, z: 0 };
const scratchCurrent = { x: 0, z: 0 };

/** Accumulated body-frame force and moment about the keel amidships. */
interface Load {
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
}

/** Add a body-frame force applied at a body-frame point. */
function addLoad(load: Load, fx: number, fy: number, fz: number, px: number, py: number, pz: number): void {
  load.fx += fx;
  load.fy += fy;
  load.fz += fz;
  load.tx += py * fz - pz * fy;
  load.ty += pz * fx - px * fz;
  load.tz += px * fy - py * fx;
}

const load: Load = { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0 };

/**
 * Advance the boat by `dt`, in substeps of at most `maxSubstep`.
 *
 * Fixed substeps matter more here than for a land vehicle: the waterplane is a stiff spring (tens of kN/m
 * in heave) and thrust arrives in impulses, so a single 1/30 s step either diverges or makes the boat hop.
 * Everything reads and writes `state` in place and nothing allocates, because this runs in the frame loop.
 */
export function stepBoat(
  state: BoatState,
  config: BoatConfig,
  input: BoatInput,
  env: BoatEnvironment,
  dt: number,
  maxSubstep = 1 / 120,
): void {
  const remaining = clamp(dt, 0, 0.25);
  if (remaining <= 0) return;
  const steps = Math.min(10, Math.max(1, Math.ceil(remaining / Math.max(1e-4, maxSubstep))));
  const h = remaining / steps;
  for (let step = 0; step < steps; step++) integrate(state, config, input, env, h);
  state.time += remaining;
}

/** Set the boat afloat at a spot on the water, at its solved draft and trim, dead in the water. */
export function resetBoat(
  state: BoatState,
  config: BoatConfig,
  env: BoatEnvironment,
  x: number,
  z: number,
  heading: number,
): void {
  state.x = x;
  state.z = z;
  state.y = env.level - config.draft;
  state.heading = heading;
  state.pitch = config.trimDesign;
  state.roll = 0;
  state.vx = 0;
  state.vy = 0;
  state.vz = 0;
  state.rollRate = 0;
  state.pitchRate = 0;
  state.yawRate = 0;
  state.rpm = BOAT_IDLE_RPM;
  state.helm = 0;
  state.legTrim = 0;
  state.grounded = false;
  state.penetration = 0;
  state.slap = 0;
  state.wake = 0;
  state.seaState = 0;
  state.speedWater = 0;
  state.speedGround = 0;
  state.slip = 0;
  state.draft = config.draft;
  state.draftForward = config.draft;
  state.draftAft = config.draft;
  state.freeboard = BOAT_DEPTH - config.draft;
  state.planing = 0;
  state.time = 0;
}

/**
 * A short wind sea for the river, in the shape the water shader and the CPU sampler both agree on.
 *
 * Four trains only (`MAX_WATER_WAVES`), none shorter than 16 m: below that the water surface's own vertex
 * grid cannot resolve a crest, and the boat would be riding water nobody can see — the sampler and the
 * shader drift apart and the hull starts to be pushed by waves that are not drawn. The wavelengths come from
 * deep-water dispersion (λ ≈ 1.56·T²) for a fetch-limited 3-8 s sea, the amplitude is shared out so that
 * `height` reads as significant wave height (four times the surface's standard deviation), each crest is held under the breaking limit, and every train
 * travels with the wind, which on a river means downstream: a chop running up a current is a much steeper,
 * much shorter sea than the one described here, and the scene raises it explicitly when that is the weather.
 */
export function riverChop(height: number, windHeading = 0, downstream = 1): GerstnerWave[] {
  const period = [3.4, 4.6, 6.1, 7.9];
  const share = [0.17, 0.29, 0.34, 0.2];
  const waves: GerstnerWave[] = [];
  for (let i = 0; i < period.length; i++) {
    const seconds = period[i] ?? 4;
    const wavelength = Math.max(16, 1.56 * seconds * seconds);
    const amplitude = (share[i] ?? 0) * height * 0.62;
    // Each train leaves the wind a little to one side: a sea whose crests ran exactly across the river would
    // give the boat nothing to roll on, and chop is felt as roll long before it is felt as pitch.
    const bearing = windHeading + (i - 1.5) * 0.38;
    waves.push({
      directionX: Math.sin(bearing) * downstream,
      directionZ: Math.cos(bearing) * downstream,
      wavelength,
      amplitude: Math.min(amplitude, 0.11 * wavelength),
      speed: Math.sqrt((GRAVITY * wavelength) / (Math.PI * 2)),
      steepness: clamp(amplitude / Math.max(0.05, 0.12 * wavelength), 0.15, 0.85),
      phase: i * 1.7,
    });
  }
  return waves;
}

/** Water surface height at a world point — the shader's answer on the CPU. Uses a shared scratch sample. */
export function waterSurfaceHeight(env: BoatEnvironment, x: number, z: number, out = createWaterSample()): number {
  return env.level + sampleGerstner(env.waves, x, z, env.time, out).y;
}

function integrate(state: BoatState, config: BoatConfig, input: BoatInput, env: BoatEnvironment, h: number): void {
  const m = bodyToWorld(state, scratchMatrix);
  const panels = config.panels;
  const weight = config.mass * GRAVITY;

  // ------------------------------------------------------------------ helm and engine
  const helmTarget = clamp(input.steer, -1, 1) * BOAT_HELM_MAX;
  const helmStep = HELM_RATE * h;
  state.helm += clamp(helmTarget - state.helm, -helmStep, helmStep);
  if (input.steer === 0) state.helm = damp(state.helm, 0, HELM_RETURN, h);
  const gear = input.gear > 0 ? 1 : input.gear < 0 ? -1 : 0;
  // The leg moves on a hydraulic ram: a second or so of travel, so trimming out at speed is a decision.
  state.legTrim = damp(state.legTrim, clamp((clamp(input.trim, -1, 1) + 1) * 0.5, 0, 1), 1.1, h);
  const demandedRpm =
    gear === 0 ? BOAT_IDLE_RPM : BOAT_IDLE_RPM + (BOAT_MAX_RPM - BOAT_IDLE_RPM) * clamp(input.throttle, 0, 1);
  state.rpm = damp(state.rpm, demandedRpm, gear < 0 ? SPOOL_ASTERN : SPOOL_AHEAD, h);
  const rpmRatio = state.rpm / BOAT_MAX_RPM;
  const wash = WASH_SPEED * (WASH_IDLE_FLOOR + (1 - WASH_IDLE_FLOOR) * rpmRatio);

  // Relative flow over the hull, in body axes: subtracting the current is the whole point of a river sim.
  env.currentAt(state.x, state.z, scratchCurrent);
  toBody(m, state.vx - scratchCurrent.x, state.vy, state.vz - scratchCurrent.z, scratchFlow);
  const u = scratchFlow.z;
  const v = scratchFlow.x;
  const speed = Math.abs(u);
  const froude = speed / Math.max(1, Math.sqrt(GRAVITY * BOAT_LOA));

  // ------------------------------------------------------------------ weight, in body axes
  // Gravity goes through the same accumulator as everything else, at the mass centre: that is what makes
  // the boat slide down a wave face and what holds the static trim solved in `createBoatConfig`.
  toBody(m, 0, -weight, 0, scratchGravity);
  load.fx = 0;
  load.fy = 0;
  load.fz = 0;
  load.tx = 0;
  load.ty = 0;
  load.tz = 0;
  addLoad(load, scratchGravity.x, scratchGravity.y, scratchGravity.z, config.cgX, config.cgY, config.cgZ);

  // ------------------------------------------------------------------ hydrostatics per column
  const planform = Math.max(0.5, boatWaterplaneArea(panels));
  const planformWidth = Math.max(0.5, boatWaterplaneWidth(panels));
  const heaveCoefficient = 2 * config.heaveDampingRatio * Math.sqrt(WATER_DENSITY * GRAVITY * planform * config.mass);
  let minSurface = Infinity;
  let maxSurface = -Infinity;
  let wettedArea = 0;
  let wettedPlanform = 0;
  let planformMoment = 0;
  let transomSubmersion = 0;
  let bowSubmersion = 0;
  let freeboard = BOAT_DEPTH;
  let slapImpulse = 0;
  let aftKeelY = state.y;
  let foreKeelY = state.y;
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i]!;
    toWorld(m, panel.x, panel.keelY, panel.z, scratchOffset);
    const px = state.x + scratchOffset.x;
    const py = state.y + scratchOffset.y;
    const pz = state.z + scratchOffset.z;
    const surface = sampleGerstner(env.waves, px, pz, env.time, scratchSurface);
    const surfaceY = env.level + surface.y;
    if (surfaceY < minSurface) minSurface = surfaceY;
    if (surfaceY > maxSurface) maxSurface = surfaceY;
    // The least freeboard anywhere on the boat, not the amidships one: the low spot in the sheer is where
    // river water comes aboard, and that is the number worth warning about.
    toWorld(m, panel.x, panel.deckY, panel.z, scratchDeck);
    freeboard = Math.min(freeboard, state.y + scratchDeck.y - surfaceY);
    if (i === 0) aftKeelY = py;
    if (i === panels.length - 1) foreKeelY = py;
    const submerged = clamp(surfaceY - py, 0, panel.deckY - panel.keelY);
    if (i === 0) transomSubmersion = submerged;
    if (i === panels.length - 1) bowSubmersion = submerged;
    if (submerged <= 0) continue;
    // Skin-friction reference area: the wetted planform patch plus the strip of side below it. The side
    // term is capped by the column's own depth so a hull buried to the gunwale cannot invent drag forever.
    const sideShare = 0.55 * clamp(submerged / Math.max(0.1, panel.height), 0, 1);
    wettedArea += panel.area * (1 + sideShare);
    const contact = clamp(submerged / 0.05, 0, 1);
    wettedPlanform += panel.area * contact;
    // Where the water is actually pushing, lengthwise: this is the self-limiting part of the trim balance.
    // As the bow comes up the run dries out and the centre of pressure slides aft toward the transom, from
    // where its lift pitches her bow down again — which is why a boat with the leg hard trimmed out falls off.
    planformMoment += panel.area * contact * panel.z;
    // Buoyancy acts along the *surface* normal, not straight up: a wave face pushes the hull, which is why
    // a boat squats at the top of a swell and surfs down its back.
    const nLen = Math.max(0.2, Math.hypot(surface.nx, surface.ny, surface.nz));
    const pressure = WATER_DENSITY * GRAVITY * columnVolumeAt(panel, submerged);
    // Damping is measured against the water's own vertical motion, so a rising face *lifts* instead of
    // damping; the wave's velocity comes from the same sampler a frame back.
    const earlier = sampleGerstner(env.waves, px, pz, env.time - 0.05, scratchEarlier);
    const waterRise = (surface.y - earlier.y) / 0.05;
    const hullRise = state.vy + angularVerticalRate(state, m, panel.x, panel.keelY, panel.z);
    // Slam damping is the one term that can run away: a hull re-entering at 30 m/s would otherwise be
    // kicked out again harder than it came in. Real water does not have that much momentum to give, so the
    // relative rate is clamped to a physically available one.
    const closing = clamp(hullRise - waterRise, -14, 14);
    const damping = -heaveCoefficient * (columnWidthAt(panel, submerged) / Math.max(0.2, planformWidth)) * closing;
    const share = pressure / nLen;
    // The water's push is a world vector — the surface normal times the column's pressure, plus the vertical
    // damping — and `addLoad` accumulates in body axes, so it crosses over once, here. Getting this wrong is
    // invisible in flat water and turns every wave face into a sideways force.
    scratchWorld.x = surface.nx * share;
    scratchWorld.y = surface.ny * share + damping;
    scratchWorld.z = surface.nz * share;
    toBody(m, scratchWorld.x, scratchWorld.y, scratchWorld.z, scratchForce);
    addLoad(load, scratchForce.x, scratchForce.y, scratchForce.z, panel.x, panel.keelY, panel.z);
    // Slap: a panel that was dry a moment ago and now bites into the surface at speed.
    if (closing < -1.1 && submerged < 0.18) slapImpulse = Math.max(slapImpulse, -closing);
  }

  // ------------------------------------------------------------------ planing lift
  // Dynamic lift on the wetted run, applied forward of the mass centre: on a launch with twin outboards
  // bolted to the transom the centre of pressure of the planing surface is *ahead* of the weight, which is
  // exactly why the bow comes up as the throttle does. It is integrated over the columns that are actually
  // in contact, so a hull that has risen out of the water stops being lifted and settles back — the
  // feedback loop that makes planing self-limiting instead of a launch into the air.
  const trimRad = clamp(state.pitch - config.trimDesign, -0.2, 0.3);
  // Rocker and leg trim are angle-of-attack offsets rather than extra forces: the bottom's own curvature
  // matters most while the boat is still in displacement mode, and a leg run hard down squares the transom
  // off against the flow.
  const trimEffective = clamp(
    trimRad + state.legTrim * config.legTrimAngle + config.rockerLift * (1 - clamp(froude, 0, 1)),
    -0.2,
    0.28,
  );
  const liftCurve = clamp(config.liftCoefficient * Math.tan(trimEffective), -0.14, 0.32);
  const planingArea = Math.max(0.2, wettedPlanform);
  // Bounded by the displacement: dynamic lift can hold the boat up, it cannot launch her.
  const lift = clamp(0.5 * WATER_DENSITY * u * u * liftCurve * planingArea, -0.35 * weight, 0.95 * weight);
  // The lift acts at the wetted run's centroid, nudged forward by the pressure peak at the spray root.
  const centreOfPressure = planformMoment / Math.max(0.5, wettedPlanform) + config.liftLever;
  addLoad(load, 0, lift, 0, 0, config.cgY, centreOfPressure);

  // ------------------------------------------------------------------ drag
  // Skin friction over the *wetted* surface, times the wave-making hump that peaks near Froude 0.42: this
  // is the hull-speed wall, and because the area it scales with shrinks as the boat rises on the plane, the
  // way through the wall is the lift term above rather than more throttle. Above-water drag is what caps the
  // top speed of a light launch, and the interference drag of a leg left hard down is what makes trimming
  // out worth doing on a long flat run.
  const waveHump = Math.exp(-Math.pow((froude - config.waveDragFroude) / config.waveDragWidth, 2));
  const friction =
    0.5 *
    WATER_DENSITY *
    config.frictionCf *
    Math.max(1.5, wettedArea) *
    u *
    speed *
    (1 + config.waveDragGain * waveHump);
  const airDrag = 0.5 * 1.225 * config.airDragCf * config.airDragArea * u * speed;
  // The gearcase and anti-ventilation plate are the last things in the water: hard down they are a 60 kN/m²
  // parachute, trimmed out they nearly vanish, so the drag falls with the square of what is still wet.
  const legDrag =
    0.5 *
    WATER_DENSITY *
    u *
    Math.abs(u) *
    config.legDragArea *
    (config.legDragDown - config.legDragClear * state.legTrim);
  addLoad(load, 0, 0, -(friction + airDrag + legDrag), 0, 0.1, config.cgZ);
  // Crossflow drag on the sides and the rockered bottom: the whole of a planing hull's lateral grip, since
  // there is no keel to speak of. Quadratic, so a fast boat skids less than a slow one sliding sideways.
  const lateralArea = Math.max(0.3, 1.6 * BOAT_LOA * (config.draft + 0.4 * Math.max(transomSubmersion, bowSubmersion)));
  const crossflow = 0.5 * WATER_DENSITY * config.crossflowGain * lateralArea * v * Math.abs(v);
  addLoad(load, -crossflow, 0, -0.16 * Math.abs(crossflow) * Math.sign(u), 0, 0.25, 0);

  // ------------------------------------------------------------------ thrust and rudder
  // Propeller unloading as the boat climbs into its own wave, the thrust lost to a ventilating prop at full
  // trim-up, and the harder loss when the transom is being dragged along a bar.
  const unload = clamp(1 - (0.34 * speed) / config.hullSpeed, 0.3, 1);
  // A propeller in air makes noise, not thrust: `wettedPlanform` is the boat's own report of how much of her
  // bottom is still in contact with the river, and it is the hard negative feedback that keeps a hop from
  // turning into a launch.
  const water = clamp(wettedPlanform / 2.2, 0, 1);
  const grip =
    (1 - config.legTrimThrustLoss * state.legTrim * (1 - clamp(froude, 0, 1) * 0.6) - (state.grounded ? 0.55 : 0)) *
    water;
  const thrust =
    (gear > 0 ? 1 : gear < 0 ? -REVERSE_SCALE : 0) *
    THRUST_COEFFICIENT *
    rpmRatio *
    rpmRatio *
    unload *
    clamp(grip, 0.05, 1);
  // The propeller pushes along the boat's own Z axis, at the leg: below the keel line, which pitches the bow
  // up, and angled upward by however much the leg is trimmed in, which lifts the stern and drops the bow —
  // the two effects that decide whether a hull comes onto the plane or digs its transom in. No empirical
  // trim couple is needed on top of them, and adding one hides the balance the driver is actually feeling.
  addLoad(load, 0, thrust * (0.075 * state.legTrim - 0.02), thrust, 0, -0.14 - 0.16 * state.legTrim, -0.5 * BOAT_LOA);
  // A steerable outboard turns the jet: side force goes with sin(deflection) and with the square of the
  // effective flow over the leg, which is boat speed blended with propeller wash so she answers the helm
  // even at tickover.
  const effectiveFlow = Math.sqrt(u * u + wash * wash * config.washSteering);
  const rudderForce =
    config.rudderGain * Math.sin(state.helm) * effectiveFlow * (0.35 + 0.65 * smooth01(effectiveFlow / 2));
  addLoad(load, -rudderForce, 0, 0, 0, 0.15, -0.5 * BOAT_LOA * 0.94);
  // Weather helm: the hull turns into the relative flow. Reversing takes the steerage way out of it.
  load.ty += config.weathervaneGain * v * (u >= 0 ? 1 : -0.3);
  load.ty -= config.yawDamping * config.inertiaYaw * state.yawRate;
  // A trimmed-out leg is a strake: it holds a straight line at speed, which is why outboards have it.
  load.ty -= config.legTrimYawHelp * state.legTrim * config.inertiaYaw * state.yawRate * clamp(froude, 0, 1.5);
  if (gear < 0 && speed < 1.4) load.ty += -config.rudderLever * rudderForce * 0.25;

  // ------------------------------------------------------------------ grounding
  let penetration = 0;
  let grounded = false;
  for (let i = 0; i < panels.length; i += 2) {
    const panel = panels[i]!;
    toWorld(m, panel.x, panel.keelY, panel.z, scratchOffset);
    const px = state.x + scratchOffset.x;
    const pz = state.z + scratchOffset.z;
    const bed = env.bedElevation(px, pz);
    const depth = bed - (state.y + scratchOffset.y);
    if (depth <= 0) continue;
    grounded = true;
    if (depth > penetration) penetration = depth;
    const bedDx = (env.bedElevation(px + 0.8, pz) - env.bedElevation(px - 0.8, pz)) / 1.6;
    const bedDz = (env.bedElevation(px, pz + 0.8) - env.bedElevation(px, pz - 0.8)) / 1.6;
    const nLen = Math.max(0.4, Math.hypot(bedDx, 1, bedDz));
    const hullDown = state.vy + angularVerticalRate(state, m, panel.x, panel.keelY, panel.z);
    const normal = Math.max(
      0,
      config.groundStiffness * Math.min(depth, 0.5) - config.groundDamping * Math.max(0, -hullDown),
    );
    // The bed's normal, in body axes: the ground holds the keel off the bar *and* slides it down the slope.
    toBody(m, (-bedDx / nLen) * normal, normal / nLen, (-bedDz / nLen) * normal, scratchForce);
    const share = 1 / Math.max(1, Math.ceil(panels.length / 2));
    addLoad(
      load,
      scratchForce.x * share,
      scratchForce.y * share,
      scratchForce.z * share,
      panel.x,
      panel.keelY,
      panel.z,
    );
    const tangential = Math.hypot(state.vx, state.vz);
    if (tangential > 0.02) {
      const frictionForce = Math.min(tangential * 6000 + 3000, config.groundFriction * normal);
      toBody(
        m,
        (-state.vx / tangential) * frictionForce * share,
        0,
        (-state.vz / tangential) * frictionForce * share,
        scratchForce,
      );
      load.fx += scratchForce.x;
      load.fz += scratchForce.z;
    }
  }
  state.grounded = grounded;
  state.penetration = penetration;

  // ------------------------------------------------------------------ integrate
  const ax = load.fx / (config.mass * (1 + config.swayAddedMass));
  // Heave is bounded by displacement too: a steep wave face can take the boat's weight off the hull (and
  // put it back), but the water underneath cannot hand her more than she is worth.
  const netHeave = clamp(load.fy, -0.8 * weight, 1.15 * weight);
  const ay = netHeave / (config.mass * (1 + config.heaveAddedMass));
  const az = load.fz / (config.mass * (1 + config.surgeAddedMass));
  state.vx += ((m[0] ?? 1) * ax + (m[1] ?? 0) * ay + (m[2] ?? 0) * az) * h;
  state.vy += ((m[3] ?? 0) * ax + (m[4] ?? 1) * ay + (m[5] ?? 0) * az) * h;
  state.vz += ((m[6] ?? 0) * ax + (m[7] ?? 0) * ay + (m[8] ?? 1) * az) * h;
  // `pitch` is bow-up while a positive body-X rotation drops the bow, hence the sign flip. The Euler
  // coupling terms are dropped: with roll under ~25° and pitch under ~12° they are second-order.
  const attitudeDecay = Math.exp(-config.attitudeDamping * h);
  state.rollRate = (state.rollRate + (load.tz / config.inertiaRoll) * h) * attitudeDecay;
  state.pitchRate =
    (state.pitchRate + ((-load.tx - config.pitchDamping * state.pitchRate) / config.inertiaPitch) * h) * attitudeDecay;
  state.yawRate =
    (state.yawRate + (load.ty / config.inertiaYaw) * h) *
    Math.exp(-(config.attitudeDamping + 0.6 * clamp(speed / 4, 0, 2)) * h);

  state.x += state.vx * h;
  state.y += state.vy * h;
  state.z += state.vz * h;
  state.roll = clamp(state.roll + state.rollRate * h, -0.9, 0.9);
  state.pitch = clamp(state.pitch + state.pitchRate * h, -0.22, 0.2);
  state.heading += state.yawRate * h;
  if (grounded && penetration > 0.02) {
    // Hard aground: the keel is being dragged over a bar, so bleed off the along-track speed fast rather
    // than letting the boat plane over gravel at full throttle.
    const scrub = Math.exp(-Math.min(1, h * 9) * 0.9);
    state.vx *= scrub;
    state.vz *= scrub;
  }

  // ------------------------------------------------------------------ readouts
  state.speedWater = u;
  state.speedGround = Math.hypot(state.vx, state.vz);
  state.slip = speed + Math.abs(v) > 0.25 ? Math.atan2(v, Math.max(0.25, speed)) : 0;
  const surfaceMean = Number.isFinite(minSurface) ? (minSurface + maxSurface) * 0.5 : env.level;
  state.seaState = Number.isFinite(minSurface) && Number.isFinite(maxSurface) ? maxSurface - minSurface : 0;
  state.draft = clamp(surfaceMean - state.y, 0, BOAT_DEPTH);
  state.draftAft = clamp(minSurface - aftKeelY, 0, BOAT_DEPTH);
  state.draftForward = clamp(minSurface - foreKeelY, 0, BOAT_DEPTH);
  state.freeboard = clamp(freeboard, 0, BOAT_DEPTH + 1);
  state.planing = clamp((froude - 0.4) / 0.3, 0, 1) * clamp(1 - transomSubmersion / 0.28, 0, 1);
  state.wake = clamp(
    0.12 * rpmRatio +
      0.85 * smooth01(froude * 1.05) +
      (grounded ? 0.5 : 0) +
      0.25 * clamp(transomSubmersion / 0.3, 0, 1),
    0,
    1,
  );
  state.slap = Math.max(state.slap * Math.exp(-h / 0.45), clamp(slapImpulse / 5, 0, 1));
}

/**
 * Vertical velocity of a hull point at body offset (rx, ry, rz), from the rigid-body rates alone.
 *
 * `ω × r` with the angular velocity carried in body axes as `(−pitchRate, yawRate, rollRate)` — pitch is
 * bow-up positive while a positive rotation about the port axis drops the bow — and the result is turned
 * into its world-Y component by the same matrix the caller is already holding. Added to the hull's heave
 * velocity this gives the rate at which each column is driving into, or lifting out of, the water.
 */
function angularVerticalRate(state: BoatState, m: Float64Array, rx: number, ry: number, rz: number): number {
  const wx = -state.pitchRate;
  const wy = state.yawRate;
  const wz = state.rollRate;
  const cx = wy * rz - wz * ry;
  const cy = wz * rx - wx * rz;
  const cz = wx * ry - wy * rx;
  return (m[3] ?? 0) * cx + (m[4] ?? 1) * cy + (m[5] ?? 0) * cz;
}

/**
 * Write the pose onto an entity transform: the only place this module touches the scene graph, and the
 * reason the model and the physics can never disagree — one call, six numbers, no allocation.
 */
export function applyBoatPose(transform: Transform, state: BoatState, lift = 0): void {
  transform.setPosition(state.x, state.y + lift, state.z);
  transform.setRotationEuler(-state.pitch, state.heading, state.roll);
}
