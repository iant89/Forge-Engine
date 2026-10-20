/**
 * Geometry for the off-road hill course's two-stroke sport quad, modelled in the chassis frame of the
 * engine `Vehicle` (origin at `vehicle.position`, +Z forward, +X the quad's right, +Y up).
 *
 * Pure `GeometrySource` builders — no GPU, no scene — so the shape is unit-testable and can be
 * previewed offline (the same convention as `alpineRescueVehicle.ts`). Parts are merged per material:
 * the whole quad is six draws, and the wheels are built once each in the *wheel frame* (axle along +X,
 * outboard = +X) and shared by their axle. `VehicleSystem` poses a wheel entity in world space (never
 * parent it to the chassis), so the scene gives each wheel a root entity and hangs these meshes under
 * it. Fronts are narrower than rears, the way a sport quad's are (21×7 front, 20×10 rear).
 *
 * Proportions follow a 450-class sport quad on 0.27 m tyres: ≈1.9 m long over the bumpers, ≈1.22 m
 * wide over the rear tyres, bars at ≈1.0 m, with a steel tube frame, a hung engine under the tank,
 * long-travel fenders, nerf bars, front and rear racks, and — the part that says two-stroke — an
 * expansion-chamber exhaust: a slim header out of the front of the cylinder, a fat belly that swings
 * back under the rider's right foot, and a slim silencer to the tail.
 */

import { boxGeometrySource, cylinderGeometrySource, type GeometrySource } from "@forge/engine";
import {
  MeshBuilder,
  alignYTo,
  arcStripSource,
  chain,
  loftSource,
  revolveSource,
  roundedBoxSource,
  rotateX,
  rotateZ,
  translate,
  tubeBetween,
  type LoftStation,
  type RevolvePoint,
} from "./meshKit.js";

export interface QuadSpec {
  wheelbase: number;
  /** Distance between the left and right wheel centres (`config.track`). */
  track: number;
  wheelRadius: number;
  /** Distance from `vehicle.position` down to the hub at rest (suspension length under static load). */
  hubDrop: number;
  /** CG to front axle (the vehicle's `config.cgToFront`). */
  cgToFront: number;
  /** Tyre widths (m): a sport quad runs a narrow front and a wide rear. */
  frontTyreWidth: number;
  rearTyreWidth: number;
}

/** 21×7-10 front and 20×10-9 rear, in metres — the widths the model and the fenders are built for. */
export const QUAD_FRONT_TYRE_WIDTH = 0.19;
export const QUAD_REAR_TYRE_WIDTH = 0.24;

export interface QuadWheelSources {
  /** Knobby tyre: the carcass plus its tread lugs, one material. */
  tyre: GeometrySource;
  /** Rim barrel, dish, spokes, hub and lug nuts. */
  rim: GeometrySource;
  /** Inboard brake rotor and caliper. */
  brake: GeometrySource;
}

export interface QuadSources {
  /** Chassis-frame body parts, one source per material. */
  body: {
    /** Coloured plastics: tank and shrouds, the four fenders, the light pod, the tail. */
    plastic: GeometrySource;
    /** Seat, grips, levers and the footpeg pads. */
    trim: GeometrySource;
    /** Frame, A-arms, swingarm, rear axle, nerf bars, bumpers, racks, handlebars. */
    steel: GeometrySource;
    /** Crankcase, cylinder, head, carburettor, airbox, clutch cover. */
    engine: GeometrySource;
    /** Two-stroke pipe: header, expansion chamber, silencer. */
    exhaust: GeometrySource;
    /** Headlamp lens and tail lamp. */
    lamps: GeometrySource;
  };
  wheelFront: QuadWheelSources;
  wheelRear: QuadWheelSources;
  dims: QuadDims;
}

export interface QuadDims {
  /** Chassis-frame y of the ground plane at rest. */
  groundY: number;
  length: number;
  width: number;
  /** Chassis-frame y of the seat top and the handlebar centre. */
  seatY: number;
  barY: number;
  halfLength: number;
  wheelRadius: number;
  frontTyreWidth: number;
  rearTyreWidth: number;
  headlamp: readonly [number, number, number];
  taillamp: readonly [number, number, number];
  /** Silencer tip: where the pipe breathes out. */
  exhaustTip: readonly [number, number, number];
  /** Rider's eye for the first-person camera. */
  riderEye: readonly [number, number, number];
}

/** Tyre carcass profile (radius from the axle, distance along it) — rounded shoulders, flat tread. */
function tyreProfile(radius: number, half: number): RevolvePoint[] {
  const k = radius / 0.27;
  return [
    { radius: 0.152 * k, along: -half },
    { radius: 0.188 * k, along: -half * 0.97 },
    { radius: 0.232 * k, along: -half * 0.8 },
    { radius: 0.258 * k, along: -half * 0.42 },
    { radius: radius, along: 0 },
    { radius: 0.258 * k, along: half * 0.42 },
    { radius: 0.232 * k, along: half * 0.8 },
    { radius: 0.188 * k, along: half * 0.97 },
    { radius: 0.152 * k, along: half },
  ];
}

/** Rim profile: a straight barrel with a bead seat at each end. */
function rimProfile(radius: number, half: number): RevolvePoint[] {
  return [
    { radius: radius * 0.9, along: -half * 0.88 },
    { radius: radius, along: -half * 0.8 },
    { radius: radius, along: half * 0.8 },
    { radius: radius * 0.9, along: half * 0.88 },
  ];
}

function wheelSources(radius: number, tyreWidth: number, seedLugs: number): QuadWheelSources {
  const half = tyreWidth / 2;
  const rimR = radius * 0.575;

  // Tyre carcass, then the tread lugs: two chevron rows, each block a rounded box out at the tread
  // radius and rotated about the axle so it stands proud of the carcass.
  const tyreB = new MeshBuilder();
  tyreB.add(revolveSource(tyreProfile(radius, half), { segments: 28, uRepeat: 22, label: "quad-tyre" }));
  const lugDepth = 0.058;
  // Plain boxes: 26–30 lugs a wheel, so each one has to be cheap (a rounded box is ~300 tris).
  const lug = boxGeometrySource({ width: tyreWidth * 0.74, height: 0.028, depth: lugDepth });
  for (let row = 0; row < 2; row++) {
    const along = (row === 0 ? -1 : 1) * half * 0.34;
    for (let i = 0; i < seedLugs; i++) {
      // The rows are offset by half a pitch and lean outward, so the tread reads as a chevron.
      const a = ((i + row * 0.5) / seedLugs) * Math.PI * 2;
      tyreB.add(lug, chain(translate(0, radius + 0.008, along), rotateX(a)));
    }
  }
  const tyre = tyreB.build("quad-tyre");

  const rimB = new MeshBuilder();
  rimB.add(revolveSource(rimProfile(rimR, half), { segments: 22, uRepeat: 3, label: "quad-rim" }));
  // Outboard dish, then spokes radiating from a hub boss, then the nuts.
  rimB.add(revolveSource([
    { radius: 0.032, along: half * 0.62 },
    { radius: rimR * 0.55, along: half * 0.66 },
    { radius: rimR * 0.92, along: half * 0.78 },
  ], { segments: 20, label: "quad-rim-dish" }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.2;
    rimB.add(boxGeometrySource({ width: 0.022, height: rimR * 0.72, depth: 0.036 }), chain(translate(half * 0.6, rimR * 0.48, 0), rotateX(a)));
  }
  rimB.add(revolveSource([
    { radius: 0.0, along: half * 0.7 },
    { radius: 0.042, along: half * 0.68 },
    { radius: 0.05, along: half * 0.56 },
  ], { segments: 16, label: "quad-hub" }));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    rimB.add(cylinderGeometrySource({ radiusTop: 0.011, radiusBottom: 0.012, height: 0.026, radialSegments: 6, capped: true }), chain(rotateZ(-Math.PI / 2), translate(half * 0.68, 0.075, 0), rotateX(a)));
  }
  const rim = rimB.build("quad-rim");

  // Brake rotor inboard of the rim, with its caliper straddling the top of the disc.
  const brakeB = new MeshBuilder();
  brakeB.add(cylinderGeometrySource({ radiusTop: radius * 0.36, radiusBottom: radius * 0.36, height: 0.008, radialSegments: 22, capped: true }), chain(rotateZ(-Math.PI / 2), translate(-half * 0.5, 0, 0)));
  brakeB.add(cylinderGeometrySource({ radiusTop: 0.026, radiusBottom: 0.026, height: half * 0.34, radialSegments: 12, capped: true }), chain(rotateZ(-Math.PI / 2), translate(-half * 0.36, 0, 0)));
  brakeB.add(boxGeometrySource({ width: 0.036, height: 0.052, depth: 0.075 }), translate(-half * 0.5, radius * 0.34, 0));
  const brake = brakeB.build("quad-brake");

  return { tyre, rim, brake };
}

/** Build every part of the quad for `spec`. Deterministic. */
export function buildQuadSources(spec: QuadSpec): QuadSources {
  const { wheelRadius, hubDrop } = spec;
  const hubY = -hubDrop;
  const groundY = hubY - wheelRadius;
  const zf = spec.cgToFront;
  const zr = -(spec.wheelbase - spec.cgToFront);
  const halfTrack = spec.track / 2;

  // Reference levels (chassis frame).
  const frameY = groundY + 0.3;
  const caseY = groundY + 0.25;
  const headY = groundY + 0.56;
  const tankY = groundY + 0.6;
  const seatY = groundY + 0.79;
  const barY = groundY + 1.0;
  const fenderY = groundY + 0.64;
  const frontZ = zf + 0.32;
  const tailZ = zr - 0.3;
  /** Fender crown radius: clears the lugged tread, and most of the suspension's bump travel. */
  const archR = wheelRadius + 0.14;

  // ---------------------------------------------------------------- frame, bars, racks (steel)
  const steelB = new MeshBuilder();
  const tube = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    radius: number,
    segments = 8,
  ): void => {
    const t = tubeBetween(a, b, radius, segments);
    steelB.add(t.source, t.transform);
  };

  // Spine and the rear subframe that carries the seat and the rack.
  tube([0, frameY + 0.02, 0.3], [0, frameY - 0.02, -0.34], 0.028);
  for (const s of [-1, 1]) {
    tube([s * 0.03, frameY, -0.3], [s * 0.15, frameY + 0.1, -0.56], 0.021);
    tube([s * 0.15, frameY + 0.1, -0.56], [s * 0.02, seatY - 0.09, -0.66], 0.018);
  }
  tube([-0.15, frameY + 0.1, -0.56], [0.15, frameY + 0.1, -0.56], 0.018);

  // Steering head: the stem the bars clamp to, and the two downtubes that meet the front of the spine.
  const headTop: readonly [number, number, number] = [0, frameY + 0.36, 0.5];
  const headBottom: readonly [number, number, number] = [0, frameY + 0.12, 0.42];
  tube(headBottom, headTop, 0.031, 10);
  for (const s of [-1, 1]) {
    tube([s * 0.02, frameY + 0.04, 0.3], [s * 0.12, frameY + 0.12, 0.42], 0.022);
    tube([s * 0.12, frameY + 0.12, 0.42], [s * 0.02, headTop[1], headTop[2] - 0.02], 0.019);
  }

  // Front double A-arms and the steering knuckle each wheel pivots on.
  for (const s of [-1, 1]) {
    const knuckleX = s * halfTrack;
    tube([s * 0.13, frameY - 0.06, 0.34], [knuckleX, hubY - 0.04, zf - 0.02], 0.02);
    tube([s * 0.13, frameY - 0.06, 0.16], [knuckleX, hubY - 0.04, zf - 0.02], 0.02);
    tube([s * 0.13, frameY + 0.1, 0.34], [knuckleX, hubY + 0.11, zf - 0.02], 0.017);
    tube([knuckleX, hubY - 0.05, zf - 0.02], [knuckleX, hubY + 0.13, zf - 0.02], 0.024);
    // Shock body, eye to eye along the upper arm.
    tube([s * 0.16, frameY + 0.16, 0.24], [knuckleX * 0.86, hubY + 0.1, zf - 0.02], 0.026, 10);
  }

  // Swingarm, the solid rear axle a quad runs, and its shock.
  for (const s of [-1, 1]) {
    tube([s * 0.08, frameY - 0.04, -0.3], [s * (halfTrack - 0.06), hubY + 0.01, zr], 0.024);
    tube([s * (halfTrack - 0.06), hubY + 0.01, zr], [s * (halfTrack - 0.02), hubY, zr], 0.026);
    tube([s * 0.1, frameY + 0.06, -0.4], [s * (halfTrack - 0.12), hubY + 0.05, zr - 0.02], 0.023, 10);
  }
  tube([-halfTrack, hubY, zr], [halfTrack, hubY, zr], 0.028, 10);
  // Chain-driven sprocket on the axle's left, and the chain guard over it.
  steelB.add(cylinderGeometrySource({ radiusTop: 0.075, radiusBottom: 0.075, height: 0.014, radialSegments: 18, capped: true }), chain(rotateZ(-Math.PI / 2), translate(-halfTrack + 0.05, hubY, zr)));
  steelB.add(boxGeometrySource({ width: 0.02, height: 0.05, depth: 0.42 }), translate(-halfTrack + 0.05, hubY + 0.085, zr + 0.16));

  // Nerf bars with their foot loops and pegs: the tubes a quad is recognised by from the side.
  for (const s of [-1, 1]) {
    const x = halfTrack + 0.05;
    tube([s * (halfTrack - 0.02), frameY + 0.02, 0.14], [s * x, frameY + 0.08, 0.02], 0.017);
    tube([s * x, frameY + 0.08, 0.02], [s * x, frameY + 0.08, -0.44], 0.017);
    tube([s * x, frameY + 0.08, -0.44], [s * (halfTrack - 0.02), frameY + 0.02, -0.5], 0.017);
    for (const z of [-0.06, -0.22, -0.38]) tube([s * (halfTrack - 0.02), frameY - 0.06, z], [s * x, frameY + 0.06, z], 0.011);
    tube([s * (halfTrack - 0.06), frameY - 0.04, -0.14], [s * (halfTrack + 0.01), frameY - 0.04, -0.14], 0.016);
  }

  // Front bumper hoop and the rear rack (perimeter rails, cross bars, legs).
  for (const s of [-1, 1]) {
    tube([s * 0.14, frameY - 0.02, frontZ - 0.14], [s * 0.2, frameY + 0.08, frontZ], 0.019);
    tube([s * 0.2, frameY + 0.08, frontZ], [s * 0.2, frameY - 0.1, frontZ - 0.02], 0.019);
    tube([s * 0.2, frameY - 0.1, frontZ - 0.02], [s * 0.14, frameY - 0.08, frontZ - 0.16], 0.017);
  }
  tube([-0.2, frameY + 0.08, frontZ], [0.2, frameY + 0.08, frontZ], 0.019);
  tube([-0.2, frameY - 0.1, frontZ - 0.02], [0.2, frameY - 0.1, frontZ - 0.02], 0.017);
  const rackY = seatY - 0.02;
  const rackX = 0.22;
  const rackZ0 = -0.52;
  const rackZ1 = tailZ - 0.04;
  for (const s of [-1, 1]) {
    tube([s * rackX, rackY, rackZ0], [s * rackX, rackY, rackZ1], 0.014);
    tube([s * rackX, frameY + 0.06, rackZ0 + 0.04], [s * rackX, rackY, rackZ0], 0.013);
    tube([s * rackX, frameY + 0.02, rackZ1 + 0.08], [s * rackX, rackY, rackZ1], 0.013);
  }
  tube([-rackX, rackY, rackZ0], [rackX, rackY, rackZ0], 0.014);
  tube([-rackX, rackY, rackZ1], [rackX, rackY, rackZ1], 0.014);
  for (let i = 1; i <= 3; i++) {
    const z = rackZ0 + ((rackZ1 - rackZ0) * i) / 4;
    tube([-rackX, rackY, z], [rackX, rackY, z], 0.01);
  }

  // Handlebars: swept back from the stem, with a cross brace and the bar pads clamped on it.
  const stemTop: readonly [number, number, number] = [0, barY - 0.05, 0.5];
  for (const s of [-1, 1]) {
    tube(stemTop, [s * 0.12, barY + 0.01, 0.47], 0.014);
    tube([s * 0.12, barY + 0.01, 0.47], [s * 0.26, barY + 0.02, 0.42], 0.014);
    tube([s * 0.26, barY + 0.02, 0.42], [s * 0.33, barY - 0.01, 0.34], 0.013);
    tube([s * 0.12, barY + 0.01, 0.47], [s * 0.16, barY + 0.05, 0.4], 0.008);
  }
  tube([-0.16, barY + 0.05, 0.4], [0.16, barY + 0.05, 0.4], 0.008);
  const steel = steelB.build("quad-steel");

  // ---------------------------------------------------------------- engine (hung under the tank)
  const engineB = new MeshBuilder();
  engineB.add(roundedBoxSource({ width: 0.27, height: 0.22, depth: 0.32, radius: 0.035, segments: 3 }), translate(0, caseY, 0.0));
  // Cylinder and head, tilted forward the way a two-stroke's are, with the fins as thin plates.
  const tilt = rotateX(-0.22);
  engineB.add(roundedBoxSource({ width: 0.19, height: 0.17, depth: 0.19, radius: 0.02, segments: 2 }), chain(tilt, translate(0, caseY + 0.19, 0.04)));
  for (let i = 0; i < 5; i++) {
    engineB.add(boxGeometrySource({ width: 0.235, height: 0.012, depth: 0.235 }), chain(tilt, translate(0, caseY + 0.12 + i * 0.032, 0.04)));
  }
  engineB.add(roundedBoxSource({ width: 0.2, height: 0.07, depth: 0.2, radius: 0.018, segments: 2 }), chain(tilt, translate(0, headY, 0.035)));
  // Carburettor and airbox on the left, clutch cover and the oil tank on the right.
  engineB.add(cylinderGeometrySource({ radiusTop: 0.042, radiusBottom: 0.046, height: 0.12, radialSegments: 14, capped: true }), chain(rotateZ(Math.PI / 2), translate(-0.19, caseY + 0.14, -0.02)));
  engineB.add(roundedBoxSource({ width: 0.15, height: 0.17, depth: 0.2, radius: 0.04, segments: 3 }), translate(-0.24, caseY + 0.2, -0.2));
  engineB.add(cylinderGeometrySource({ radiusTop: 0.088, radiusBottom: 0.092, height: 0.045, radialSegments: 18, capped: true }), chain(rotateZ(-Math.PI / 2), translate(0.155, caseY - 0.02, -0.05)));
  engineB.add(roundedBoxSource({ width: 0.09, height: 0.16, depth: 0.11, radius: 0.03, segments: 2 }), translate(0.19, caseY + 0.14, -0.24));
  const engineSrc = engineB.build("quad-engine");

  // ---------------------------------------------------------------- two-stroke expansion chamber
  const exhaustB = new MeshBuilder();
  const portAt: readonly [number, number, number] = [0.1, caseY + 0.22, 0.14];
  const bendAt: readonly [number, number, number] = [0.24, caseY + 0.14, 0.02];
  const bellyEnd: readonly [number, number, number] = [0.27, hubY - 0.02, -0.42];
  const tipAt: readonly [number, number, number] = [0.24, seatY - 0.3, tailZ + 0.02];
  const headerSeg = tubeBetween(portAt, bendAt, 0.024, 12);
  exhaustB.add(headerSeg.source, headerSeg.transform);
  // The belly: a lathe that swells from the header, holds a fat middle and cones back to the
  // stinger — the tuned length that makes a two-stroke's mid-range. Built around +X, then turned
  // onto the pipe's own axis and dropped onto the header's end.
  const bellyLen = Math.hypot(bellyEnd[0] - bendAt[0], bellyEnd[1] - bendAt[1], bellyEnd[2] - bendAt[2]);
  const bellyProfile: RevolvePoint[] = [
    { radius: 0.024, along: 0 },
    { radius: 0.052, along: bellyLen * 0.14 },
    { radius: 0.078, along: bellyLen * 0.36 },
    { radius: 0.082, along: bellyLen * 0.55 },
    { radius: 0.062, along: bellyLen * 0.76 },
    { radius: 0.03, along: bellyLen * 0.93 },
    { radius: 0.026, along: bellyLen },
  ];
  exhaustB.add(
    revolveSource(bellyProfile, { segments: 22, uRepeat: 2, label: "quad-chamber" }),
    chain(
      rotateZ(Math.PI / 2),
      alignYTo(bellyEnd[0] - bendAt[0], bellyEnd[1] - bendAt[1], bellyEnd[2] - bendAt[2]),
      translate(bendAt[0], bendAt[1], bendAt[2]),
    ),
  );
  // Stinger, silencer can and its tip, plus the two hangers that hold the pipe off the frame.
  const stinger = tubeBetween(bellyEnd, [0.26, hubY + 0.14, -0.58], 0.02, 10);
  exhaustB.add(stinger.source, stinger.transform);
  const silencer = tubeBetween([0.26, hubY + 0.14, -0.58], tipAt, 0.038, 14);
  exhaustB.add(silencer.source, silencer.transform);
  exhaustB.add(cylinderGeometrySource({ radiusTop: 0.042, radiusBottom: 0.042, height: 0.02, radialSegments: 14, capped: true }), chain(alignYTo(tipAt[0] - 0.26, tipAt[1] - (hubY + 0.14), tipAt[2] + 0.58), translate(tipAt[0], tipAt[1], tipAt[2])));
  const hangerA = tubeBetween([0.12, frameY - 0.02, -0.1], [0.26, hubY + 0.02, -0.24], 0.008, 6);
  exhaustB.add(hangerA.source, hangerA.transform);
  const hangerB = tubeBetween([0.1, frameY + 0.04, -0.5], [0.25, seatY - 0.34, -0.66], 0.008, 6);
  exhaustB.add(hangerB.source, hangerB.transform);
  const exhaust = exhaustB.build("quad-exhaust");

  // ---------------------------------------------------------------- plastics (tank, shrouds, fenders)
  const plasticB = new MeshBuilder();
  // Tank and side shrouds: one loft from the steering head back under the seat, narrowing at the
  // knees so the rider can grip it.
  const tankStations: LoftStation[] = [
    { z: 0.44, halfWidth: 0.1, yBottom: tankY - 0.2, yTop: tankY - 0.06, radius: 0.05 },
    { z: 0.3, halfWidth: 0.17, yBottom: tankY - 0.26, yTop: tankY, radius: 0.06 },
    { z: 0.1, halfWidth: 0.21, yBottom: tankY - 0.28, yTop: tankY + 0.02, radius: 0.07 },
    { z: -0.12, halfWidth: 0.19, yBottom: tankY - 0.24, yTop: tankY - 0.02, radius: 0.06 },
    { z: -0.3, halfWidth: 0.15, yBottom: tankY - 0.18, yTop: tankY - 0.05, radius: 0.05 },
  ];
  plasticB.add(loftSource(tankStations, { cornerSegments: 4, uvMeters: 1.4, label: "quad-tank" }));
  // Radiator shrouds either side of the tank (an air-cooled two-stroke still wears them).
  for (const s of [-1, 1]) {
    plasticB.add(roundedBoxSource({ width: 0.05, height: 0.2, depth: 0.34, radius: 0.02, segments: 2 }), translate(s * 0.23, tankY - 0.14, 0.14));
  }

  // Front fender: a beak loft that rises to the light pod, plus a wing over each front tyre.
  const beakStations: LoftStation[] = [
    { z: 0.34, halfWidth: 0.19, yBottom: fenderY - 0.16, yTop: fenderY - 0.02, radius: 0.05 },
    { z: 0.52, halfWidth: 0.16, yBottom: fenderY - 0.13, yTop: fenderY + 0.01, radius: 0.05 },
    { z: frontZ - 0.06, halfWidth: 0.1, yBottom: fenderY - 0.06, yTop: fenderY + 0.04, radius: 0.04 },
    { z: frontZ + 0.02, halfWidth: 0.05, yBottom: fenderY + 0.0, yTop: fenderY + 0.06, radius: 0.03 },
  ];
  plasticB.add(loftSource(beakStations, { cornerSegments: 4, uvMeters: 1.2, label: "quad-front-fender" }));
  for (const s of [-1, 1]) {
    // A wing that follows the front tyre's crown: `arcStripSource` sweeps the YZ plane about +X
    // (angle measured from +Z toward +Y) with its profile spanning [0, width] along +X, so it lands
    // on the wheel centre with its inner face `archR` out — clear of the tread at full bump.
    plasticB.add(
      arcStripSource({ radius: archR, thickness: 0.045, width: 0.24, start: -Math.PI * 0.12, end: Math.PI * 0.62, segments: 12, label: "quad-front-wing" }),
      translate(s * (halfTrack - 0.12), hubY, zf),
    );
  }

  // Rear fenders: a tail loft behind the seat and a mudguard crown over each rear tyre.
  const tailStations: LoftStation[] = [
    { z: -0.5, halfWidth: 0.14, yBottom: seatY - 0.09, yTop: seatY - 0.01, radius: 0.04 },
    { z: -0.68, halfWidth: 0.15, yBottom: seatY - 0.08, yTop: seatY + 0.01, radius: 0.04 },
    { z: tailZ + 0.02, halfWidth: 0.11, yBottom: seatY - 0.05, yTop: seatY + 0.02, radius: 0.035 },
  ];
  plasticB.add(loftSource(tailStations, { cornerSegments: 4, uvMeters: 1.1, label: "quad-tail" }));
  for (const s of [-1, 1]) {
    plasticB.add(
      arcStripSource({ radius: archR, thickness: 0.05, width: 0.28, start: Math.PI * 0.3, end: Math.PI * 1.02, segments: 12, label: "quad-rear-wing" }),
      translate(s * (halfTrack - 0.14), hubY, zr),
    );
  }

  // Light pod behind the bars, and the number plate over the front fender's beak.
  plasticB.add(roundedBoxSource({ width: 0.24, height: 0.16, depth: 0.12, radius: 0.045, segments: 3 }), translate(0, barY - 0.1, 0.44));
  plasticB.add(boxGeometrySource({ width: 0.22, height: 0.17, depth: 0.02 }), chain(rotateX(0.3), translate(0, fenderY + 0.02, 0.4)));
  const plastic = plasticB.build("quad-plastic");

  // ---------------------------------------------------------------- trim (seat, grips, peg pads)
  const trimB = new MeshBuilder();
  trimB.add(loftSource([
    { z: -0.26, halfWidth: 0.14, yBottom: seatY - 0.11, yTop: seatY - 0.02, radius: 0.04 },
    { z: -0.44, halfWidth: 0.13, yBottom: seatY - 0.1, yTop: seatY, radius: 0.04 },
    { z: -0.62, halfWidth: 0.1, yBottom: seatY - 0.08, yTop: seatY + 0.01, radius: 0.035 },
  ], { cornerSegments: 4, uvMeters: 0.9, label: "quad-seat" }));
  for (const s of [-1, 1]) {
    // Grips over the bar ends, and the brake/throttle levers ahead of them.
    trimB.add(cylinderGeometrySource({ radiusTop: 0.017, radiusBottom: 0.019, height: 0.11, radialSegments: 12, capped: true }), chain(alignYTo(-s * 0.07, -0.03, -0.08), translate(s * 0.315, barY - 0.005, 0.375)));
    trimB.add(boxGeometrySource({ width: 0.016, height: 0.012, depth: 0.1 }), chain(rotateX(-0.2), translate(s * 0.26, barY - 0.03, 0.46)));
    trimB.add(boxGeometrySource({ width: 0.09, height: 0.014, depth: 0.13 }), translate(s * (halfTrack - 0.02), frameY - 0.045, -0.14));
  }
  const trim = trimB.build("quad-trim");

  // ---------------------------------------------------------------- lamps
  const lampB = new MeshBuilder();
  lampB.add(cylinderGeometrySource({ radiusTop: 0.055, radiusBottom: 0.055, height: 0.035, radialSegments: 18, capped: true }), chain(rotateX(Math.PI / 2), translate(0, barY - 0.1, 0.505)));
  lampB.add(boxGeometrySource({ width: 0.09, height: 0.045, depth: 0.03 }), translate(0, seatY + 0.0, tailZ + 0.04));
  const lamps = lampB.build("quad-lamps");

  return {
    body: { plastic, trim, steel, engine: engineSrc, exhaust, lamps },
    wheelFront: wheelSources(wheelRadius, spec.frontTyreWidth, 13),
    wheelRear: wheelSources(wheelRadius, spec.rearTyreWidth, 15),
    dims: {
      groundY,
      length: frontZ + 0.06 - (tailZ - 0.04),
      width: spec.track + spec.rearTyreWidth,
      seatY,
      barY,
      halfLength: (frontZ + 0.06 + (-(tailZ - 0.04))) / 2,
      wheelRadius,
      frontTyreWidth: spec.frontTyreWidth,
      rearTyreWidth: spec.rearTyreWidth,
      headlamp: [0, barY - 0.1, 0.53],
      taillamp: [0, seatY, tailZ + 0.02],
      exhaustTip: tipAt,
      riderEye: [0, seatY + 0.62, -0.34],
    },
  };
}

/** Texture-free helper used by tests and previews: every body source in one list. */
export function allQuadBodySources(sources: QuadSources): GeometrySource[] {
  return [...Object.values(sources.body), sources.wheelFront.tyre, sources.wheelFront.rim, sources.wheelFront.brake, sources.wheelRear.tyre, sources.wheelRear.rim, sources.wheelRear.brake];
}
