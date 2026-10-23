/**
 * Read-only rigid-body wireframes for Phase 21.5. The returned line segments are backend-agnostic;
 * a host can feed them to `Renderer.drawLine` without making physics depend on rendering.
 */

import { Vec3, type Vec3Ops } from "../math/vec.js";
import type { PhysicsWorld } from "../physics/world.js";
import { RigidBody } from "../physics/body.js";
import { collideBodies } from "../physics/collision.js";
import { BoxShape, CapsuleShape, CylinderShape, HeightfieldShape, PlaneShape, SphereShape } from "../physics/shapes.js";

export type PhysicsDebugLineKind = "shape" | "aabb" | "velocity" | "contact" | "contactNormal";

export interface PhysicsDebugLine {
  bodyId: number;
  /** The other body for contact lines; absent for shape/AABB/velocity lines. */
  otherBodyId?: number;
  kind: PhysicsDebugLineKind;
  start: [number, number, number];
  end: [number, number, number];
  /** Renderer packed color: 0xAARRGGBB. */
  color: number;
}

export interface PhysicsDebugView {
  bodyCount: number;
  processedBodies: number;
  truncatedBodies: number;
  /** Contact points represented by the optional contact overlay. */
  contactCount: number;
  truncatedContacts: number;
  lineCount: number;
  lines: PhysicsDebugLine[];
}

export interface PhysicsDebugOptions {
  /** Bound work and output size. Defaults to 256 bodies. */
  maxBodies?: number;
  /** Circle tessellation, clamped to 4..32. Default 12. */
  segments?: number;
  /** Draw broadphase AABBs as well as collider wireframes. */
  showAabbs?: boolean;
  /** Draw linear-velocity vectors. */
  showVelocity?: boolean;
  velocityScale?: number;
  /** Draw current narrowphase contact points and their normals. */
  showContacts?: boolean;
  /** Bound contact points independently of the body bound. Defaults to 512. */
  maxContacts?: number;
  /** Length of each contact-normal ray in world units. Defaults to 0.35. */
  contactNormalScale?: number;
  /** Half-width of the cross marking a contact point. Defaults to 0.04. */
  contactPointSize?: number;
  /** Half-width for infinite-plane wireframes. */
  planeExtent?: number;
  /** Skip oversized heightfield bounds to avoid a planet-sized debug rectangle. */
  maxHeightfieldExtent?: number;
  dynamicColor?: number;
  staticColor?: number;
  kinematicColor?: number;
  aabbColor?: number;
  velocityColor?: number;
  contactColor?: number;
  contactNormalColor?: number;
}

const DEFAULT_COLORS = {
  dynamic: 0xffffa000,
  static: 0xff00d080,
  kinematic: 0xff40a0ff,
  aabb: 0xffff40ff,
  velocity: 0xff40e0ff,
  contact: 0xffff4060,
  contactNormal: 0xffffd040,
} as const;

const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Return shape wireframes, with optional AABBs/velocity vectors, without mutating the world. */
export function physicsDebugDraw(world: PhysicsWorld, options: PhysicsDebugOptions = {}): PhysicsDebugView {
  const requestedBodies = options.maxBodies ?? 256;
  const maxBodies = Number.isFinite(requestedBodies) ? Math.max(0, Math.floor(requestedBodies)) : 256;
  const requestedSegments = options.segments ?? 12;
  const segments = Number.isFinite(requestedSegments) ? Math.max(4, Math.min(32, Math.floor(requestedSegments))) : 12;
  const lines: PhysicsDebugLine[] = [];
  const scratch = new PhysicsLineBuilder(lines);
  const processedBodies = Math.min(world.bodies.length, maxBodies);

  for (let i = 0; i < processedBodies; i++) {
    const body = world.bodies[i]!;
    const color = options[`${body.type}Color` as "dynamicColor" | "staticColor" | "kinematicColor"] ?? DEFAULT_COLORS[body.type];
    drawShape(scratch, body, color, segments, options.planeExtent ?? 10, options.maxHeightfieldExtent ?? 5000);
    if (options.showAabbs) scratch.worldAabb(body, body.aabb, options.aabbColor ?? DEFAULT_COLORS.aabb);
    if (options.showVelocity && body.type === "dynamic") {
      const scale = Number.isFinite(options.velocityScale) ? Math.max(0, options.velocityScale!) : 0.5;
      scratch.worldLine(
        body.id,
        "velocity",
        body.renderPosition,
        { x: body.renderPosition.x + body.linearVelocity.x * scale, y: body.renderPosition.y + body.linearVelocity.y * scale, z: body.renderPosition.z + body.linearVelocity.z * scale },
        options.velocityColor ?? DEFAULT_COLORS.velocity,
      );
    }
  }

  let contactCount = 0;
  let truncatedContacts = 0;
  if (options.showContacts && processedBodies > 1) {
    const maxContacts = Number.isFinite(options.maxContacts) ? Math.max(0, Math.floor(options.maxContacts!)) : 512;
    const pointSize = Number.isFinite(options.contactPointSize) ? Math.max(0, options.contactPointSize!) : 0.04;
    const normalScale = Number.isFinite(options.contactNormalScale) ? Math.max(0, options.contactNormalScale!) : 0.35;
    const contactColor = options.contactColor ?? DEFAULT_COLORS.contact;
    const normalColor = options.contactNormalColor ?? DEFAULT_COLORS.contactNormal;
    // This is deliberately a diagnostic-only narrowphase query. It creates fresh manifolds without
    // running the solver, changing body state, or replacing the world's listener/report stream. The
    // body bound keeps the O(n²) fallback bounded and mirrors the shapes the overlay actually drew.
    for (let i = 0; i < processedBodies; i++) {
      const bodyA = world.bodies[i]!;
      for (let j = i + 1; j < processedBodies; j++) {
        const bodyB = world.bodies[j]!;
        if (bodyA.invMass === 0 && bodyB.invMass === 0) continue;
        const manifold = collideBodies(bodyA, bodyB);
        if (!manifold) continue;
        for (const contact of manifold.contacts) {
          if (contactCount >= maxContacts) {
            truncatedContacts++;
            continue;
          }
          contactCount++;
          scratch.contact(bodyA.id, bodyB.id, contact.point, contact.normal, pointSize, normalScale, contactColor, normalColor);
        }
      }
    }
    // The nested loop above can encounter more points after the cap; report the count without
    // allocating a second manifold list. `truncatedContacts` already counts every omitted point.
  }

  return {
    bodyCount: world.bodies.length,
    processedBodies,
    truncatedBodies: world.bodies.length - processedBodies,
    contactCount,
    truncatedContacts,
    lineCount: lines.length,
    lines,
  };
}

/** Convenience bridge to a renderer-like sink, avoiding a physics → rendering dependency. */
export function drawPhysicsDebug(
  world: PhysicsWorld,
  drawLine: (start: Vec3Ops, end: Vec3Ops, color: number) => void,
  options: PhysicsDebugOptions = {},
): PhysicsDebugView {
  const view = physicsDebugDraw(world, options);
  for (const line of view.lines) {
    drawLine(new Vec3(...line.start), new Vec3(...line.end), line.color);
  }
  return view;
}

class PhysicsLineBuilder {
  private readonly localA = new Vec3();
  private readonly localB = new Vec3();
  private readonly worldA = new Vec3();
  private readonly worldB = new Vec3();

  constructor(private readonly lines: PhysicsDebugLine[]) {}

  localLine(body: RigidBody, ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number): void {
    this.localA.set(ax, ay, az);
    this.localB.set(bx, by, bz);
    body.renderRotation.rotateVector(this.localA, this.worldA);
    body.renderRotation.rotateVector(this.localB, this.worldB);
    this.worldA.add(body.renderPosition);
    this.worldB.add(body.renderPosition);
    this.push(body.id, "shape", this.worldA, this.worldB, color);
  }

  worldLine(id: number, kind: PhysicsDebugLineKind, a: Vec3Ops, b: Vec3Ops, color: number): void {
    this.push(id, kind, a, b, color);
  }

  contact(
    bodyId: number,
    otherBodyId: number,
    point: Vec3Ops,
    normal: Vec3Ops,
    pointSize: number,
    normalScale: number,
    pointColor: number,
    normalColor: number,
  ): void {
    // A three-axis cross remains visible even when the normal points into a collider or the camera
    // is edge-on. The normal ray is a separate kind so hosts can style/filter it independently.
    this.push(bodyId, "contact", { x: point.x - pointSize, y: point.y, z: point.z }, { x: point.x + pointSize, y: point.y, z: point.z }, pointColor, otherBodyId);
    this.push(bodyId, "contact", { x: point.x, y: point.y - pointSize, z: point.z }, { x: point.x, y: point.y + pointSize, z: point.z }, pointColor, otherBodyId);
    this.push(bodyId, "contact", { x: point.x, y: point.y, z: point.z - pointSize }, { x: point.x, y: point.y, z: point.z + pointSize }, pointColor, otherBodyId);
    this.push(bodyId, "contactNormal", point, { x: point.x + normal.x * normalScale, y: point.y + normal.y * normalScale, z: point.z + normal.z * normalScale }, normalColor, otherBodyId);
  }

  worldAabb(body: RigidBody, bounds: { min: Vec3Ops; max: Vec3Ops }, color: number): void {
    const { min, max } = bounds;
    const x = [min.x, max.x, max.x, min.x, min.x, max.x, max.x, min.x];
    const y = [min.y, min.y, min.y, min.y, max.y, max.y, max.y, max.y];
    const z = [min.z, min.z, max.z, max.z, min.z, min.z, max.z, max.z];
    for (const [i, j] of BOX_EDGES) this.localWorldLine(body.id, x[i]!, y[i]!, z[i]!, x[j]!, y[j]!, z[j]!, color);
  }

  aabb(bounds: { min: Vec3Ops; max: Vec3Ops }, id: number, color: number): void {
    const { min, max } = bounds;
    const x = [min.x, max.x, max.x, min.x, min.x, max.x, max.x, min.x];
    const y = [min.y, min.y, min.y, min.y, max.y, max.y, max.y, max.y];
    const z = [min.z, min.z, max.z, max.z, min.z, min.z, max.z, max.z];
    for (const [i, j] of BOX_EDGES) this.push(id, "aabb", { x: x[i]!, y: y[i]!, z: z[i]! }, { x: x[j]!, y: y[j]!, z: z[j]! }, color);
  }

  private localWorldLine(id: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number): void {
    this.push(id, "aabb", { x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }, color);
  }

  private push(id: number, kind: PhysicsDebugLineKind, a: Vec3Ops, b: Vec3Ops, color: number, otherBodyId?: number): void {
    this.lines.push({ bodyId: id, ...(otherBodyId === undefined ? {} : { otherBodyId }), kind, start: [a.x, a.y, a.z], end: [b.x, b.y, b.z], color: color >>> 0 });
  }
}

function drawShape(builder: PhysicsLineBuilder, body: RigidBody, color: number, segments: number, planeExtent: number, maxHeightfieldExtent: number): void {
  const shape = body.shape;
  if (shape instanceof SphereShape) {
    drawSphere(builder, body, 0, 0, 0, shape.radius, segments, color);
  } else if (shape instanceof BoxShape) {
    drawBox(builder, body, shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z, color);
  } else if (shape instanceof CylinderShape) {
    drawCylinder(builder, body, shape.radius, shape.halfHeight, segments, color);
  } else if (shape instanceof CapsuleShape) {
    drawCapsule(builder, body, shape.radius, shape.halfHeight, segments, color);
  } else if (shape instanceof PlaneShape) {
    drawPlane(builder, body, shape.normal, shape.constant, planeExtent, color);
  } else if (shape instanceof HeightfieldShape) {
    const bounds = shape.bounds;
    const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
    if (extent <= maxHeightfieldExtent) builder.aabb(bounds, body.id, color);
  }
}

function drawSphere(builder: PhysicsLineBuilder, body: RigidBody, cx: number, cy: number, cz: number, radius: number, segments: number, color: number): void {
  const planes: readonly [number, number][] = [[0, 1], [0, 2], [1, 2]];
  for (const [u, v] of planes) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + 1) / segments) * Math.PI * 2;
      const p = [cx, cy, cz];
      const q = [cx, cy, cz];
      p[u] += Math.cos(a) * radius;
      p[v] += Math.sin(a) * radius;
      q[u] += Math.cos(b) * radius;
      q[v] += Math.sin(b) * radius;
      builder.localLine(body, p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, color);
    }
  }
}

function drawBox(builder: PhysicsLineBuilder, body: RigidBody, hx: number, hy: number, hz: number, color: number): void {
  const corners = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
    [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  for (const [i, j] of BOX_EDGES) {
    const a = corners[i]!, b = corners[j]!;
    builder.localLine(body, a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, color);
  }
}

function drawCylinder(builder: PhysicsLineBuilder, body: RigidBody, radius: number, halfHeight: number, segments: number, color: number): void {
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const ax = Math.cos(a) * radius, az = Math.sin(a) * radius;
    const bx = Math.cos(b) * radius, bz = Math.sin(b) * radius;
    builder.localLine(body, ax, -halfHeight, az, bx, -halfHeight, bz, color);
    builder.localLine(body, ax, halfHeight, az, bx, halfHeight, bz, color);
  }
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    builder.localLine(body, x, -halfHeight, z, x, halfHeight, z, color);
  }
}

function drawCapsule(builder: PhysicsLineBuilder, body: RigidBody, radius: number, halfHeight: number, segments: number, color: number): void {
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const ax = Math.cos(a) * radius, az = Math.sin(a) * radius;
    const bx = Math.cos(b) * radius, bz = Math.sin(b) * radius;
    builder.localLine(body, ax, -halfHeight, az, bx, -halfHeight, bz, color);
    builder.localLine(body, ax, halfHeight, az, bx, halfHeight, bz, color);
    builder.localLine(body, ax, -halfHeight, az, ax, halfHeight, az, color);
  }
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const cx = Math.cos(angle), cz = Math.sin(angle);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI / 2;
      const b = ((i + 1) / segments) * Math.PI / 2;
      const topA = [radius * Math.sin(a) * cx, halfHeight + radius * Math.cos(a), radius * Math.sin(a) * cz];
      const topB = [radius * Math.sin(b) * cx, halfHeight + radius * Math.cos(b), radius * Math.sin(b) * cz];
      const bottomA = [radius * Math.sin(a) * cx, -halfHeight - radius * Math.cos(a), radius * Math.sin(a) * cz];
      const bottomB = [radius * Math.sin(b) * cx, -halfHeight - radius * Math.cos(b), radius * Math.sin(b) * cz];
      builder.localLine(body, ...topA as [number, number, number], ...topB as [number, number, number], color);
      builder.localLine(body, ...bottomA as [number, number, number], ...bottomB as [number, number, number], color);
    }
  }
}

function drawPlane(builder: PhysicsLineBuilder, body: RigidBody, normal: Vec3Ops, constant: number, extent: number, color: number): void {
  const n = new Vec3(normal.x, normal.y, normal.z).normalize();
  const helper = Math.abs(n.y) < 0.9 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
  const u = new Vec3(n.x, n.y, n.z).cross(helper).normalize();
  const v = new Vec3(n.x, n.y, n.z).cross(u).normalize();
  const center = new Vec3(-n.x * constant, -n.y * constant, -n.z * constant);
  const point = (su: number, sv: number) => [center.x + u.x * su * extent + v.x * sv * extent, center.y + u.y * su * extent + v.y * sv * extent, center.z + u.z * su * extent + v.z * sv * extent] as const;
  const corners = [point(-1, -1), point(1, -1), point(1, 1), point(-1, 1)];
  const line = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    builder.worldLine(body.id, "shape", { x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }, color);
  for (let i = 0; i < 4; i++) line(corners[i]!, corners[(i + 1) % 4]!);
  line(point(-1, 0), point(1, 0));
  line(point(0, -1), point(0, 1));
}
