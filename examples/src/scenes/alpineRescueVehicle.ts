/**
 * Geometry for the Alpine rescue 4×4: a boxy mountain-rescue wagon modelled in the chassis frame of
 * the engine `Vehicle` (origin at `vehicle.position`, +Z forward, +X the vehicle's right, +Y up).
 *
 * Pure `GeometrySource` builders — no GPU, no scene — so the shape is unit-testable and can be
 * previewed offline. Parts are merged per material: the whole body is a dozen draws, and the wheel
 * assembly (tyre, rim, hub) is built once in the *wheel frame* (axle along +X, outboard = +X) and
 * shared by all four wheels. `VehicleSystem` poses a wheel entity in world space (never parent it to
 * the chassis), so the scene gives each wheel a root entity and hangs these meshes under it.
 *
 * Proportions follow a Land-Cruiser-class expedition wagon on 0.84 m winter tyres: 4.7 m long,
 * ≈2.05 m wide over the flares, 2.0 m tall, with a lofted body (hood, cowl, tail) whose lower edge
 * lifts into real wheel arches, a glass greenhouse behind a raked windscreen, a white roof, a
 * roof rack with emergency light bar, steel bumpers with a winch, flares, steps and mirrors.
 */

import { boxGeometrySource, cylinderGeometrySource, type GeometrySource } from "@forge/engine";
import {
  MeshBuilder,
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
} from "./meshKit.js";

export interface RescueTruckSpec {
  wheelbase: number;
  track: number;
  wheelRadius: number;
  /** Distance from `vehicle.position` down to the hub at rest (suspension length under static load). */
  hubDrop: number;
  /** CG to front axle (the vehicle's `config.cgToFront`). */
  cgToFront: number;
}

export interface RescueTruckSources {
  /** Chassis-frame body parts, one source per material. */
  body: {
    paint: GeometrySource;
    roof: GeometrySource;
    glass: GeometrySource;
    trim: GeometrySource;
    steel: GeometrySource;
    underbody: GeometrySource;
    headlamps: GeometrySource;
    tailLamps: GeometrySource;
    amber: GeometrySource;
    reverse: GeometrySource;
    stripe: GeometrySource;
    lightBar: GeometrySource;
  };
  /** Light-bar modules, built apart so the scene can swap their emissive state. */
  flashers: { red: GeometrySource; blue: GeometrySource; redAt: readonly [number, number, number]; blueAt: readonly [number, number, number] };
  /** Wheel-frame parts shared by the four wheels (axle +X, outboard +X). */
  wheel: { tyre: GeometrySource; rimDisc: GeometrySource; rimSpokes: GeometrySource; hub: GeometrySource };
  /** The spare on the tailgate: a wheel-frame assembly turned (yaw) to face aft, at this chassis-frame position. */
  spare: { position: readonly [number, number, number]; yaw: number };
  dims: RescueTruckDims;
}

export interface RescueTruckDims {
  /** Chassis-frame y of the ground plane at rest. */
  groundY: number;
  length: number;
  width: number;
  roofY: number;
  rackTopY: number;
  halfLength: number;
  headlamps: ReadonlyArray<readonly [number, number, number]>;
  exhaust: readonly [number, number, number];
  tailLamps: ReadonlyArray<readonly [number, number, number]>;
  /** Where the loaded medical case rides (roof rack centre, case base). */
  cargo: readonly [number, number, number];
  wheelRadius: number;
  wheelWidth: number;
}

/** Tyre profile (radius, along-axle) — flat tread between ±0.09, rounded shoulders, bulged sidewall. */
function tyreProfile(radius: number, half: number): Array<{ radius: number; along: number }> {
  const k = radius / 0.42;
  const h = half / 0.15;
  const pts: Array<[number, number]> = [
    [0.265, -0.115], [0.3, -0.138], [0.35, -0.15], [0.395, -0.146], [0.412, -0.128], [0.42, -0.095],
    [0.42, 0.095], [0.412, 0.128], [0.395, 0.146], [0.35, 0.15], [0.3, 0.138], [0.265, 0.115],
  ];
  return pts.map(([r, a]) => ({ radius: r * k, along: a * h }));
}

/** Build every part of the truck for `spec`. Deterministic. */
export function buildRescueTruckSources(spec: RescueTruckSpec): RescueTruckSources {
  const { wheelRadius, hubDrop } = spec;
  const hubY = -hubDrop;
  const groundY = hubY - wheelRadius;
  const zf = spec.cgToFront;
  const zr = -(spec.wheelbase - spec.cgToFront);
  const wheelWidth = 0.3;

  // Body reference levels (chassis frame).
  const sillY = groundY + 0.34;
  const beltY = groundY + 1.14;
  const roofY = groundY + 2.02;
  const archR = wheelRadius + 0.14; // clears the tyre at full bump
  const bodyHalf = 0.95;
  const frontZ = 2.3;
  const tailZ = -2.28;

  // ---------------------------------------------------------------- lower body (paint)
  const archBottom = (z: number): number => {
    let y = sillY;
    for (const wz of [zf, zr]) {
      const dz = z - wz;
      if (Math.abs(dz) < archR) y = Math.max(y, hubY + Math.sqrt(archR * archR - dz * dz));
    }
    return y;
  };
  const stations: LoftStation[] = [];
  const push = (z: number, halfWidth: number, yTop: number, yBottom = archBottom(z), radius = 0.085): void => {
    stations.push({ z, halfWidth, yBottom, yTop, radius });
  };
  const topAt = (z: number): number => {
    // Tail face, flat belt through the cabin, a cowl step, then the hood sloping to the nose.
    if (z <= -2.18) return beltY - 0.12 + ((z - tailZ) / (-2.18 - tailZ)) * 0.12;
    if (z <= 0.82) return beltY;
    if (z <= 0.86) return beltY + 0.06;
    return beltY + 0.06 - ((z - 0.86) / (frontZ - 0.86)) * 0.16;
  };
  const widthAt = (z: number): number => {
    if (z < -2.0) return bodyHalf - 0.06 * ((-2.0 - z) / (-2.0 - tailZ));
    if (z > 1.5) return bodyHalf - 0.09 * ((z - 1.5) / (frontZ - 1.5));
    return bodyHalf;
  };
  // Station set: the ends, the cowl step (a crease), and dense sampling through each arch.
  const zs = new Set<number>([tailZ, tailZ + 0.1, 0.82, 0.86, 1.6, 2.1, frontZ]);
  for (let z = -1.9; z < 0.82; z += 0.35) zs.add(Math.round(z * 1000) / 1000);
  const sorted = [...zs].sort((a, b) => a - b);
  const archSamples = (wz: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= 14; i++) out.push(wz + archR * Math.cos(Math.PI - (Math.PI * i) / 14));
    return out;
  };
  const inArch = (z: number): boolean => [zf, zr].some((wz) => Math.abs(z - wz) < archR + 0.02);
  const baseZs = sorted.filter((z) => !inArch(z));
  const allZs = [...baseZs, ...archSamples(zf), ...archSamples(zr)].sort((a, b) => a - b);
  for (const z of allZs) {
    const w = widthAt(z);
    const top = topAt(z);
    // Arch edges are creases: the body drops vertically between the sill line and the arch's
    // springing point (two stations at one z), so the opening reads as a cut-out, not a ramp.
    const entering = [zf, zr].some((wz) => Math.abs(z - (wz - archR)) < 1e-6);
    const leaving = [zf, zr].some((wz) => Math.abs(z - (wz + archR)) < 1e-6);
    if (entering) {
      push(z, w, top, sillY);
      push(z, w, top, hubY);
    } else if (leaving) {
      push(z, w, top, hubY);
      push(z, w, top, sillY);
    } else {
      push(z, w, top);
    }
  }
  const lowerBody = loftSource(stations, { cornerSegments: 4, label: "truck-lower-body" });

  // ---------------------------------------------------------------- cabin glass + pillars + roof
  const gh = 0.86;
  const glassStations: LoftStation[] = [
    { z: 0.88, halfWidth: gh, yBottom: beltY - 0.02, yTop: beltY + 0.1, radius: 0.05 },
    { z: 0.62, halfWidth: gh, yBottom: beltY - 0.02, yTop: beltY + 0.46, radius: 0.06 },
    { z: 0.4, halfWidth: gh, yBottom: beltY - 0.02, yTop: roofY - 0.14, radius: 0.07 },
    { z: 0.2, halfWidth: gh, yBottom: beltY - 0.02, yTop: roofY - 0.02, radius: 0.07 },
    { z: -1.95, halfWidth: gh, yBottom: beltY - 0.02, yTop: roofY - 0.02, radius: 0.07 },
    { z: -2.06, halfWidth: gh - 0.02, yBottom: beltY - 0.02, yTop: roofY - 0.08, radius: 0.06 },
  ];
  const glass = loftSource(glassStations, { cornerSegments: 3, label: "truck-glass" });

  const roofB = new MeshBuilder();
  roofB.add(roundedBoxSource({ width: 1.84, height: 0.09, depth: 2.34, radius: 0.04, segments: 3 }), translate(0, roofY - 0.005, -0.9));
  // A-pillar fairing, a gutter lip front and back.
  const roof = roofB.build("truck-roof");

  const paintB = new MeshBuilder();
  paintB.add(lowerBody);
  // Cabin pillars in body colour: A (raked), B, C.
  const pillar = (a: readonly [number, number, number], b: readonly [number, number, number], r: number): void => {
    const t = tubeBetween(a, b, r, 6);
    paintB.add(t.source, t.transform);
  };
  for (const s of [-1, 1]) {
    pillar([s * 0.87, beltY + 0.02, 0.86], [s * 0.86, roofY - 0.04, 0.2], 0.036);
    paintB.add(boxGeometrySource({ width: 0.04, height: roofY - beltY - 0.06, depth: 0.1 }), translate(s * 0.865, (roofY + beltY) / 2 - 0.02, -0.36));
    paintB.add(boxGeometrySource({ width: 0.04, height: roofY - beltY - 0.1, depth: 0.14 }), translate(s * 0.86, (roofY + beltY) / 2 - 0.05, -1.82));
  }
  // Door-shut lines and handles are trim; the cowl panel and hood scoop are paint.
  paintB.add(roundedBoxSource({ width: 0.7, height: 0.05, depth: 0.55, radius: 0.02, segments: 2 }), translate(0, beltY + 0.1, 1.2));
  const paint = paintB.build("truck-paint");

  // ---------------------------------------------------------------- trim (black plastic / rubber)
  const trimB = new MeshBuilder();
  // Grille with ribs, bezelled headlamps, bumper skins.
  trimB.add(roundedBoxSource({ width: 1.06, height: 0.4, depth: 0.1, radius: 0.025, segments: 2 }), translate(0, sillY + 0.55, frontZ - 0.02));
  for (let i = 0; i < 5; i++) trimB.add(boxGeometrySource({ width: 0.98, height: 0.012, depth: 0.02 }), translate(0, sillY + 0.4 + i * 0.075, frontZ + 0.04));
  const bezel = cylinderGeometrySource({ radiusTop: 0.15, radiusBottom: 0.15, height: 0.07, radialSegments: 16, capped: true });
  for (const s of [-1, 1]) trimB.add(bezel, chain(rotateX(Math.PI / 2), translate(s * 0.7, sillY + 0.63, frontZ - 0.015)));
  // Front bumper (steel-black), side steps, rear bumper.
  trimB.add(roundedBoxSource({ width: 2.02, height: 0.3, depth: 0.36, radius: 0.06, segments: 3 }), translate(0, sillY + 0.08, frontZ + 0.12));
  trimB.add(roundedBoxSource({ width: 1.98, height: 0.32, depth: 0.4, radius: 0.06, segments: 3 }), translate(0, sillY + 0.1, tailZ - 0.1));
  trimB.add(roundedBoxSource({ width: 1.1, height: 0.07, depth: 0.3, radius: 0.02, segments: 2 }), translate(0, sillY + 0.29, tailZ - 0.2));
  for (const s of [-1, 1]) {
    trimB.add(roundedBoxSource({ width: 0.2, height: 0.07, depth: 1.62, radius: 0.03, segments: 2 }), translate(s * 1.0, sillY - 0.04, -0.02));
    for (const z of [-0.65, 0.55]) trimB.add(boxGeometrySource({ width: 0.12, height: 0.12, depth: 0.05 }), translate(s * 0.95, sillY + 0.04, z));
  }
  // Wheel-arch flares: arcs over the opening, standing proud of the body side.
  for (const wz of [zf, zr]) {
    for (const s of [-1, 1]) {
      const arc = arcStripSource({ radius: archR - 0.005, thickness: 0.05, width: 0.14, start: 0.0, end: Math.PI, segments: 20 });
      const x0 = s > 0 ? bodyHalf - 0.04 : -(bodyHalf - 0.04) - 0.14;
      trimB.add(arc, translate(x0 + (s > 0 ? 0 : 0), hubY, wz));
    }
  }
  // Mirrors (housing + arm), door handles, shut lines, a snorkel up the right A-pillar.
  for (const s of [-1, 1]) {
    trimB.add(roundedBoxSource({ width: 0.12, height: 0.22, depth: 0.1, radius: 0.03, segments: 2 }), translate(s * 1.09, beltY + 0.34, 0.52));
    const arm = tubeBetween([s * 0.9, beltY + 0.2, 0.68], [s * 1.04, beltY + 0.36, 0.54], 0.012, 6);
    trimB.add(arm.source, arm.transform);
    // Door handles and shut lines stay on the door panels between the arches (z ∈ [-0.8, 0.8]) and
    // the quarter panel behind the rear arch — never across a wheel opening.
    for (const z of [0.05, -0.62]) trimB.add(roundedBoxSource({ width: 0.04, height: 0.035, depth: 0.16, radius: 0.012, segments: 2 }), translate(s * 0.965, beltY - 0.06, z));
    for (const z of [0.58, -0.2, -0.76]) trimB.add(boxGeometrySource({ width: 0.012, height: 0.7, depth: 0.012 }), translate(s * 0.953, beltY - 0.35, z));
    trimB.add(boxGeometrySource({ width: 0.012, height: 0.5, depth: 0.012 }), translate(s * 0.945, beltY - 0.25, tailZ + 0.2));
  }
  // The intake rises out of the front fender at hood level (not from inside the wheel arch).
  const snorkelA = tubeBetween([0.92, beltY - 0.05, 1.0], [0.92, roofY - 0.45, 0.9], 0.04, 8);
  trimB.add(snorkelA.source, snorkelA.transform);
  const snorkelB = tubeBetween([0.92, roofY - 0.45, 0.9], [0.92, roofY + 0.02, 0.78], 0.04, 8);
  trimB.add(snorkelB.source, snorkelB.transform);
  trimB.add(roundedBoxSource({ width: 0.1, height: 0.1, depth: 0.14, radius: 0.025, segments: 2 }), translate(0.92, roofY + 0.08, 0.72));
  // Under-nose skid plate.
  trimB.add(roundedBoxSource({ width: 1.2, height: 0.05, depth: 0.5, radius: 0.015, segments: 2 }), translate(0, sillY - 0.11, frontZ - 0.15));
  const trim = trimB.build("truck-trim");

  // ---------------------------------------------------------------- steel (bull bar, winch, hooks, rack, antenna)
  const steelB = new MeshBuilder();
  const tube = (a: readonly [number, number, number], b: readonly [number, number, number], r: number): void => {
    const t = tubeBetween(a, b, r, 8);
    steelB.add(t.source, t.transform);
  };
  const barZ = frontZ + 0.3;
  for (const s of [-1, 1]) {
    tube([s * 0.7, sillY + 0.0, barZ - 0.1], [s * 0.7, sillY + 0.62, barZ], 0.035);
    tube([s * 0.7, sillY + 0.62, barZ], [s * 0.55, sillY + 0.76, barZ - 0.08], 0.03);
  }
  tube([-0.7, sillY + 0.62, barZ], [0.7, sillY + 0.62, barZ], 0.035);
  tube([-0.55, sillY + 0.76, barZ - 0.08], [0.55, sillY + 0.76, barZ - 0.08], 0.03);
  // Winch drum and fairlead, tow hooks.
  steelB.add(cylinderGeometrySource({ radiusTop: 0.075, radiusBottom: 0.075, height: 0.5, radialSegments: 12, capped: true }), chain(rotateZ(Math.PI / 2), translate(0, sillY + 0.02, frontZ + 0.1)));
  steelB.add(roundedBoxSource({ width: 0.34, height: 0.05, depth: 0.1, radius: 0.015, segments: 2 }), translate(0, sillY + 0.11, frontZ + 0.32));
  for (const s of [-1, 1]) steelB.add(roundedBoxSource({ width: 0.07, height: 0.05, depth: 0.12, radius: 0.015, segments: 2 }), translate(s * 0.55, sillY - 0.12, frontZ + 0.32));
  // Roof rack: perimeter rails, cross bars and feet.
  const rackY = roofY + 0.13;
  const rackZ0 = 0.04;
  const rackZ1 = -1.92;
  const rackX = 0.74;
  for (const s of [-1, 1]) {
    tube([s * rackX, rackY, rackZ0], [s * rackX, rackY, rackZ1], 0.016);
    for (const z of [rackZ0 - 0.0, rackZ1 + 0.0]) tube([s * rackX, roofY + 0.02, z], [s * rackX, rackY, z], 0.014);
  }
  tube([-rackX, rackY, rackZ0], [rackX, rackY, rackZ0], 0.016);
  tube([-rackX, rackY, rackZ1], [rackX, rackY, rackZ1], 0.016);
  for (let i = 1; i <= 5; i++) {
    const z = rackZ0 + ((rackZ1 - rackZ0) * i) / 6;
    tube([-rackX, rackY, z], [rackX, rackY, z], 0.012);
  }
  // Whip antenna on a spring base, rear left.
  steelB.add(cylinderGeometrySource({ radiusTop: 0.035, radiusBottom: 0.05, height: 0.08, radialSegments: 10, capped: true }), translate(-0.68, roofY + 0.04, -1.8));
  tube([-0.68, roofY + 0.08, -1.8], [-0.7, roofY + 1.05, -1.84], 0.006);
  // Tow hitch receiver.
  steelB.add(roundedBoxSource({ width: 0.16, height: 0.1, depth: 0.28, radius: 0.02, segments: 2 }), translate(0, sillY - 0.06, tailZ - 0.34));
  const steel = steelB.build("truck-steel");

  // ---------------------------------------------------------------- underbody
  const underB = new MeshBuilder();
  underB.add(boxGeometrySource({ width: 1.5, height: 0.34, depth: 4.1 }), translate(0, sillY + 0.02, -0.05));
  const underbody = underB.build("truck-underbody");

  // ---------------------------------------------------------------- lamps
  const lampB = new MeshBuilder();
  const lens = cylinderGeometrySource({ radiusTop: 0.105, radiusBottom: 0.105, height: 0.06, radialSegments: 16, capped: true });
  const headlamps: Array<readonly [number, number, number]> = [];
  for (const s of [-1, 1]) {
    lampB.add(lens, chain(rotateX(Math.PI / 2), translate(s * 0.7, sillY + 0.63, frontZ + 0.03)));
    headlamps.push([s * 0.7, sillY + 0.63, frontZ + 0.06]);
  }
  const headlampsSrc = lampB.build("truck-headlamps");

  const tailB = new MeshBuilder();
  const tailLamps: Array<readonly [number, number, number]> = [];
  for (const s of [-1, 1]) {
    tailB.add(roundedBoxSource({ width: 0.2, height: 0.38, depth: 0.06, radius: 0.02, segments: 2 }), translate(s * 0.82, sillY + 0.62, tailZ - 0.02));
    tailLamps.push([s * 0.82, sillY + 0.62, tailZ - 0.06]);
  }
  const tailLampsSrc = tailB.build("truck-tail-lamps");

  const amberB = new MeshBuilder();
  for (const s of [-1, 1]) {
    amberB.add(roundedBoxSource({ width: 0.12, height: 0.07, depth: 0.05, radius: 0.015, segments: 2 }), translate(s * 0.88, sillY + 0.42, frontZ - 0.01));
    amberB.add(roundedBoxSource({ width: 0.1, height: 0.07, depth: 0.05, radius: 0.015, segments: 2 }), translate(s * 0.86, sillY + 0.42, tailZ + 0.0));
    amberB.add(roundedBoxSource({ width: 0.04, height: 0.06, depth: 0.14, radius: 0.015, segments: 2 }), translate(s * (bodyHalf + 0.02), sillY + 0.5, zf + 0.3));
  }
  const amber = amberB.build("truck-amber");

  const reverseB = new MeshBuilder();
  for (const s of [-1, 1]) reverseB.add(roundedBoxSource({ width: 0.1, height: 0.07, depth: 0.05, radius: 0.015, segments: 2 }), translate(s * 0.66, sillY + 0.4, tailZ - 0.02));
  const reverse = reverseB.build("truck-reverse");

  // ---------------------------------------------------------------- light bar + flashers
  const barB = new MeshBuilder();
  barB.add(roundedBoxSource({ width: 1.2, height: 0.09, depth: 0.3, radius: 0.025, segments: 2 }), translate(0, rackY + 0.05, 0.0));
  for (const s of [-1, 1]) barB.add(boxGeometrySource({ width: 0.04, height: 0.06, depth: 0.2 }), translate(s * 0.5, rackY - 0.005, 0.0));
  // Clear work/flood lamps either side of the centre.
  for (const s of [-1, 1]) barB.add(roundedBoxSource({ width: 0.2, height: 0.075, depth: 0.2, radius: 0.02, segments: 2 }), translate(s * 0.18, rackY + 0.125, 0.02));
  const lightBar = barB.build("truck-light-bar");
  const flasherGeo = (): GeometrySource => roundedBoxSource({ width: 0.34, height: 0.1, depth: 0.22, radius: 0.025, segments: 2 });
  const flashers = {
    red: flasherGeo(),
    blue: flasherGeo(),
    redAt: [-0.44, rackY + 0.145, 0.0] as const,
    blueAt: [0.44, rackY + 0.145, 0.0] as const,
  };

  // ---------------------------------------------------------------- hi-vis stripe (UV-mapped for a checker texture)
  const stripeB = new MeshBuilder();
  const stripeLen = 1.52;
  const stripeH = 0.2;
  for (const s of [-1, 1]) {
    const panel = boxGeometrySource({ width: 0.012, height: stripeH, depth: stripeLen });
    stripeB.add(panel, translate(s * (bodyHalf + 0.004), sillY + 0.45, -0.0));
  }
  const stripe = stripeB.build("truck-stripe");

  // ---------------------------------------------------------------- wheel (axle +X, outboard +X)
  const tyre = revolveSource(tyreProfile(wheelRadius, wheelWidth / 2), { segments: 32, uRepeat: 28, label: "truck-tyre" });
  const rimR = wheelRadius * 0.645;
  const discB = new MeshBuilder();
  // Barrel (visible lip ring) and a recessed dish with a hub boss.
  discB.add(revolveSource([{ radius: rimR * 0.96, along: -0.115 }, { radius: rimR, along: -0.1 }, { radius: rimR, along: 0.118 }, { radius: rimR * 0.97, along: 0.128 }], { segments: 28 }));
  discB.add(revolveSource([{ radius: 0.0, along: 0.098 }, { radius: 0.075, along: 0.098 }, { radius: 0.082, along: 0.078 }, { radius: rimR * 0.9, along: 0.07 }, { radius: rimR * 0.95, along: 0.1 }], { segments: 28 }));
  const rimDisc = discB.build("truck-rim-disc");
  const spokeB = new MeshBuilder();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    spokeB.add(roundedBoxSource({ width: 0.026, height: rimR * 0.78, depth: 0.05, radius: 0.01, segments: 2 }), chain(translate(0.088, rimR * 0.5, 0), rotateX(a)));
  }
  const rimSpokes = spokeB.build("truck-rim-spokes");
  const hubB = new MeshBuilder();
  hubB.add(revolveSource([{ radius: 0.0, along: 0.118 }, { radius: 0.055, along: 0.116 }, { radius: 0.066, along: 0.1 }], { segments: 16 }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    hubB.add(cylinderGeometrySource({ radiusTop: 0.0125, radiusBottom: 0.0135, height: 0.035, radialSegments: 6, capped: true }), chain(rotateZ(-Math.PI / 2), translate(0.1, 0.098, 0), rotateX(a)));
  }
  const hub = hubB.build("truck-hub");

  // The spare rides on the tailgate facing aft: the wheel frame turned so +X points to -Z.
  const spare = { position: [0, sillY + 0.62, tailZ - 0.2] as const, yaw: Math.PI / 2 };

  return {
    body: { paint, roof, glass, trim, steel, underbody, headlamps: headlampsSrc, tailLamps: tailLampsSrc, amber, reverse, stripe, lightBar },
    flashers,
    wheel: { tyre, rimDisc, rimSpokes, hub },
    spare,
    dims: {
      groundY,
      length: frontZ + 0.42 - (tailZ - 0.4),
      width: 2 * (bodyHalf + 0.12),
      roofY,
      rackTopY: rackY + 0.02,
      halfLength: (frontZ + 0.42 + (-tailZ + 0.4)) / 2,
      headlamps,
      exhaust: [-0.62, sillY - 0.06, tailZ - 0.08],
      tailLamps,
      cargo: [0, rackY + 0.02, -0.9],
      wheelRadius,
      wheelWidth,
    },
  };
}

/** Texture-free helper used by tests and previews: every body source in one list. */
export function allBodySources(sources: RescueTruckSources): GeometrySource[] {
  return [
    ...Object.values(sources.body),
    sources.flashers.red,
    sources.flashers.blue,
  ];
}

