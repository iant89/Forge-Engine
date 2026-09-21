/**
 * Narrowphase Collision Detection & Contact Manifold Generation.
 */

import { Vec3 } from "../math/vec.js";
import { RigidBody } from "./body.js";
import {
  SphereShape,
  BoxShape,
  PlaneShape,
  HeightfieldShape,
} from "./shapes.js";

export class ContactPoint {
  readonly point = new Vec3();
  readonly normal = new Vec3(); // points from bodyA to bodyB
  penetration = 0;

  // Lever arms from body centers of mass to contact point
  readonly rA = new Vec3();
  readonly rB = new Vec3();

  // Friction coordinate frame
  readonly tangent1 = new Vec3();
  readonly tangent2 = new Vec3();

  // Effective masses
  normalMass = 0;
  tangentMass1 = 0;
  tangentMass2 = 0;

  // Accumulated impulses (for warm starting)
  normalImpulse = 0;
  tangentImpulse1 = 0;
  tangentImpulse2 = 0;

  velocityBias = 0;
}

export class ContactManifold {
  readonly bodyA: RigidBody;
  readonly bodyB: RigidBody;
  readonly contacts: ContactPoint[] = [];
  friction = 0.5;
  restitution = 0.0;

  constructor(bodyA: RigidBody, bodyB: RigidBody) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    // Combine material coefficients: Coulomb geometric mean, restitution minimum
    this.friction = Math.sqrt(bodyA.friction * bodyB.friction);
    this.restitution = Math.min(bodyA.restitution, bodyB.restitution);
  }

  addContact(point: Vec3, normal: Vec3, penetration: number): ContactPoint {
    const cp = new ContactPoint();
    cp.point.copyFrom(point);
    cp.normal.copyFrom(normal);
    cp.penetration = penetration;

    // rA = point - posA
    cp.rA.set(point.x - this.bodyA.position.x, point.y - this.bodyA.position.y, point.z - this.bodyA.position.z);
    // rB = point - posB
    cp.rB.set(point.x - this.bodyB.position.x, point.y - this.bodyB.position.y, point.z - this.bodyB.position.z);

    // Form orthogonal tangent basis
    if (Math.abs(normal.x) >= 0.57735) {
      cp.tangent1.set(normal.y, -normal.x, 0).normalize();
    } else {
      cp.tangent1.set(0, normal.z, -normal.y).normalize();
    }
    Vec3.crossInto(normal, cp.tangent1, cp.tangent2);
    cp.tangent2.normalize();

    this.contacts.push(cp);
    return cp;
  }
}

// ------------------------------------------------------------------ Algorithms

export function collideSphereSphere(
  sA: SphereShape,
  bA: RigidBody,
  sB: SphereShape,
  bB: RigidBody,
): ContactManifold | null {
  const dx = bB.position.x - bA.position.x;
  const dy = bB.position.y - bA.position.y;
  const dz = bB.position.z - bA.position.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const radSum = sA.radius + sB.radius;

  if (distSq >= radSum * radSum) return null;

  const dist = Math.sqrt(distSq);
  const manifold = new ContactManifold(bA, bB);
  const normal = new Vec3();

  if (dist > 1e-6) {
    normal.set(dx / dist, dy / dist, dz / dist);
  } else {
    normal.set(0, 1, 0);
  }

  const penetration = radSum - dist;
  const point = new Vec3(
    bA.position.x + normal.x * (sA.radius - penetration * 0.5),
    bA.position.y + normal.y * (sA.radius - penetration * 0.5),
    bA.position.z + normal.z * (sA.radius - penetration * 0.5),
  );

  manifold.addContact(point, normal, penetration);
  return manifold;
}

export function collideSpherePlane(
  sphere: SphereShape,
  bA: RigidBody,
  plane: PlaneShape,
  bB: RigidBody,
): ContactManifold | null {
  // Distance from sphere center to plane
  const d =
    bA.position.x * plane.normal.x +
    bA.position.y * plane.normal.y +
    bA.position.z * plane.normal.z +
    plane.constant;

  if (d >= sphere.radius) return null;

  const penetration = sphere.radius - d;
  const manifold = new ContactManifold(bA, bB);
  // Normal points from sphere to plane (opposite of plane normal)
  const normal = new Vec3(-plane.normal.x, -plane.normal.y, -plane.normal.z);
  const point = new Vec3(
    bA.position.x - plane.normal.x * d,
    bA.position.y - plane.normal.y * d,
    bA.position.z - plane.normal.z * d,
  );

  manifold.addContact(point, normal, penetration);
  return manifold;
}

export function collideSphereBox(
  sphere: SphereShape,
  bA: RigidBody,
  box: BoxShape,
  bB: RigidBody,
): ContactManifold | null {
  // Transform sphere center into box local coordinate space
  const relX = bA.position.x - bB.position.x;
  const relY = bA.position.y - bB.position.y;
  const relZ = bA.position.z - bB.position.z;

  // Unrotate by box orientation
  const invRot = bB.rotation.clone().conjugate();
  const localPos = new Vec3(relX, relY, relZ);
  invRot.rotateVector(localPos, localPos);

  // Clamp to box half-extents
  const cx = Math.max(-box.halfExtents.x, Math.min(box.halfExtents.x, localPos.x));
  const cy = Math.max(-box.halfExtents.y, Math.min(box.halfExtents.y, localPos.y));
  const cz = Math.max(-box.halfExtents.z, Math.min(box.halfExtents.z, localPos.z));

  const diffX = localPos.x - cx;
  const diffY = localPos.y - cy;
  const diffZ = localPos.z - cz;
  const distSq = diffX * diffX + diffY * diffY + diffZ * diffZ;

  if (distSq >= sphere.radius * sphere.radius) return null;

  const dist = Math.sqrt(distSq);
  const localNormal = new Vec3();
  let penetration = 0;

  if (dist > 1e-6) {
    localNormal.set(diffX / dist, diffY / dist, diffZ / dist);
    penetration = sphere.radius - dist;
  } else {
    // Sphere center inside box: find closest face
    const dx = box.halfExtents.x - Math.abs(localPos.x);
    const dy = box.halfExtents.y - Math.abs(localPos.y);
    const dz = box.halfExtents.z - Math.abs(localPos.z);
    if (dx < dy && dx < dz) {
      localNormal.set(localPos.x >= 0 ? 1 : -1, 0, 0);
      penetration = sphere.radius + dx;
    } else if (dy < dz) {
      localNormal.set(0, localPos.y >= 0 ? 1 : -1, 0);
      penetration = sphere.radius + dy;
    } else {
      localNormal.set(0, 0, localPos.z >= 0 ? 1 : -1);
      penetration = sphere.radius + dz;
    }
  }

  // Rotate local normal back to world space
  const worldNormal = new Vec3();
  bB.rotation.rotateVector(localNormal, worldNormal);
  // Normal from bodyA (sphere) to bodyB (box) is -worldNormal
  worldNormal.negate();

  const worldContact = new Vec3(
    bA.position.x - worldNormal.x * (sphere.radius - penetration * 0.5),
    bA.position.y - worldNormal.y * (sphere.radius - penetration * 0.5),
    bA.position.z - worldNormal.z * (sphere.radius - penetration * 0.5),
  );

  const manifold = new ContactManifold(bA, bB);
  manifold.addContact(worldContact, worldNormal, penetration);
  return manifold;
}

export function collideBoxPlane(
  box: BoxShape,
  bA: RigidBody,
  plane: PlaneShape,
  bB: RigidBody,
): ContactManifold | null {
  const hx = box.halfExtents.x;
  const hy = box.halfExtents.y;
  const hz = box.halfExtents.z;

  let manifold: ContactManifold | null = null;
  const corner = new Vec3();
  const worldCorner = new Vec3();

  // Test 8 corners of the box
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        corner.set(sx * hx, sy * hy, sz * hz);
        bA.rotation.rotateVector(corner, worldCorner);
        worldCorner.x += bA.position.x;
        worldCorner.y += bA.position.y;
        worldCorner.z += bA.position.z;

        const d =
          worldCorner.x * plane.normal.x +
          worldCorner.y * plane.normal.y +
          worldCorner.z * plane.normal.z +
          plane.constant;

        if (d < 0) {
          manifold ??= new ContactManifold(bA, bB);
          const penetration = -d;
          // Normal from box to plane is -plane.normal
          const normal = new Vec3(-plane.normal.x, -plane.normal.y, -plane.normal.z);
          manifold.addContact(worldCorner, normal, penetration);
        }
      }
    }
  }

  return manifold;
}

export function collideSphereHeightfield(
  sphere: SphereShape,
  bA: RigidBody,
  hf: HeightfieldShape,
  bB: RigidBody,
): ContactManifold | null {
  const h = hf.sampleHeight(bA.position.x, bA.position.z);
  const bottomY = bA.position.y - sphere.radius;

  if (bottomY >= h) return null;

  const penetration = h - bottomY;
  const norm = hf.sampleNormal(bA.position.x, bA.position.z);
  // Normal points from sphere to heightfield: opposite of terrain normal
  const normal = new Vec3(-norm.x, -norm.y, -norm.z);

  const point = new Vec3(bA.position.x, h, bA.position.z);
  const manifold = new ContactManifold(bA, bB);
  manifold.addContact(point, normal, penetration);
  return manifold;
}

export function collideBoxHeightfield(
  box: BoxShape,
  bA: RigidBody,
  hf: HeightfieldShape,
  bB: RigidBody,
): ContactManifold | null {
  const hx = box.halfExtents.x;
  const hy = box.halfExtents.y;
  const hz = box.halfExtents.z;

  let manifold: ContactManifold | null = null;
  const corner = new Vec3();
  const worldCorner = new Vec3();

  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        corner.set(sx * hx, sy * hy, sz * hz);
        bA.rotation.rotateVector(corner, worldCorner);
        worldCorner.x += bA.position.x;
        worldCorner.y += bA.position.y;
        worldCorner.z += bA.position.z;

        const h = hf.sampleHeight(worldCorner.x, worldCorner.z);
        if (worldCorner.y < h) {
          manifold ??= new ContactManifold(bA, bB);
          const penetration = h - worldCorner.y;
          const norm = hf.sampleNormal(worldCorner.x, worldCorner.z);
          const normal = new Vec3(-norm.x, -norm.y, -norm.z);
          const point = new Vec3(worldCorner.x, h, worldCorner.z);
          manifold.addContact(point, normal, penetration);
        }
      }
    }
  }

  return manifold;
}

export function collideBoxBox(
  boxA: BoxShape,
  bA: RigidBody,
  boxB: BoxShape,
  bB: RigidBody,
): ContactManifold | null {
  // Candidate axes: face normals of A and B
  const uA = [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)];
  const uB = [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)];
  for (let i = 0; i < 3; i++) {
    bA.rotation.rotateVector(uA[i]!, uA[i]!);
    bB.rotation.rotateVector(uB[i]!, uB[i]!);
  }

  // Vector from center A to center B
  const D = new Vec3(
    bB.position.x - bA.position.x,
    bB.position.y - bA.position.y,
    bB.position.z - bA.position.z,
  );

  let minPenetration = Infinity;
  const bestAxis = new Vec3();

  // Test 3 face axes of A
  for (let i = 0; i < 3; i++) {
    const axis = uA[i]!;
    const projA =
      boxA.halfExtents.x * Math.abs(axis.dot(uA[0]!)) +
      boxA.halfExtents.y * Math.abs(axis.dot(uA[1]!)) +
      boxA.halfExtents.z * Math.abs(axis.dot(uA[2]!));
    const projB =
      boxB.halfExtents.x * Math.abs(axis.dot(uB[0]!)) +
      boxB.halfExtents.y * Math.abs(axis.dot(uB[1]!)) +
      boxB.halfExtents.z * Math.abs(axis.dot(uB[2]!));
    const dist = Math.abs(D.dot(axis));
    const overlap = projA + projB - dist;
    if (overlap <= 0) return null; // Separating axis found
    if (overlap < minPenetration) {
      minPenetration = overlap;
      bestAxis.copyFrom(axis);
      if (D.dot(axis) < 0) bestAxis.negate();
    }
  }

  // Test 3 face axes of B
  for (let i = 0; i < 3; i++) {
    const axis = uB[i]!;
    const projA =
      boxA.halfExtents.x * Math.abs(axis.dot(uA[0]!)) +
      boxA.halfExtents.y * Math.abs(axis.dot(uA[1]!)) +
      boxA.halfExtents.z * Math.abs(axis.dot(uA[2]!));
    const projB =
      boxB.halfExtents.x * Math.abs(axis.dot(uB[0]!)) +
      boxB.halfExtents.y * Math.abs(axis.dot(uB[1]!)) +
      boxB.halfExtents.z * Math.abs(axis.dot(uB[2]!));
    const dist = Math.abs(D.dot(axis));
    const overlap = projA + projB - dist;
    if (overlap <= 0) return null;
    if (overlap < minPenetration) {
      minPenetration = overlap;
      bestAxis.copyFrom(axis);
      if (D.dot(axis) < 0) bestAxis.negate();
    }
  }

  // Find incident face on Box B most anti-parallel to bestAxis
  const faceNormals = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];
  let minDot = Infinity;
  let incidentFaceIdx = 3;
  const worldNormal = new Vec3();

  for (let i = 0; i < 6; i++) {
    bB.rotation.rotateVector(faceNormals[i]!, worldNormal);
    const dot = worldNormal.dot(bestAxis);
    if (dot < minDot) {
      minDot = dot;
      incidentFaceIdx = i;
    }
  }

  // 4 corners of incident face in local space
  const hx = boxB.halfExtents.x;
  const hy = boxB.halfExtents.y;
  const hz = boxB.halfExtents.z;
  const localFaceCorners: Vec3[] = [];

  switch (incidentFaceIdx) {
    case 0: // +X
      localFaceCorners.push(new Vec3(hx, -hy, -hz), new Vec3(hx, hy, -hz), new Vec3(hx, hy, hz), new Vec3(hx, -hy, hz));
      break;
    case 1: // -X
      localFaceCorners.push(new Vec3(-hx, -hy, -hz), new Vec3(-hx, hy, -hz), new Vec3(-hx, hy, hz), new Vec3(-hx, -hy, hz));
      break;
    case 2: // +Y
      localFaceCorners.push(new Vec3(-hx, hy, -hz), new Vec3(hx, hy, -hz), new Vec3(hx, hy, hz), new Vec3(-hx, hy, hz));
      break;
    case 3: // -Y
      localFaceCorners.push(new Vec3(-hx, -hy, -hz), new Vec3(hx, -hy, -hz), new Vec3(hx, -hy, hz), new Vec3(-hx, -hy, hz));
      break;
    case 4: // +Z
      localFaceCorners.push(new Vec3(-hx, -hy, hz), new Vec3(hx, -hy, hz), new Vec3(hx, hy, hz), new Vec3(-hx, hy, hz));
      break;
    default: // -Z
      localFaceCorners.push(new Vec3(-hx, -hy, -hz), new Vec3(hx, -hy, -hz), new Vec3(hx, hy, -hz), new Vec3(-hx, hy, -hz));
      break;
  }

  const manifold = new ContactManifold(bA, bB);
  const worldCorner = new Vec3();

  for (let i = 0; i < 4; i++) {
    bB.rotation.rotateVector(localFaceCorners[i]!, worldCorner);
    worldCorner.x += bB.position.x;
    worldCorner.y += bB.position.y;
    worldCorner.z += bB.position.z;

    manifold.addContact(worldCorner, bestAxis, minPenetration);
  }

  return manifold;
}

export function collideBodies(bA: RigidBody, bB: RigidBody): ContactManifold | null {
  const sA = bA.shape;
  const sB = bB.shape;

  if (sA instanceof SphereShape && sB instanceof SphereShape) {
    return collideSphereSphere(sA, bA, sB, bB);
  }
  if (sA instanceof BoxShape && sB instanceof BoxShape) {
    return collideBoxBox(sA, bA, sB, bB);
  }
  if (sA instanceof SphereShape && sB instanceof PlaneShape) {
    return collideSpherePlane(sA, bA, sB, bB);
  }
  if (sB instanceof SphereShape && sA instanceof PlaneShape) {
    const m = collideSpherePlane(sB, bB, sA, bA);
    if (!m) return null;
    return flipManifold(m);
  }
  if (sA instanceof SphereShape && sB instanceof BoxShape) {
    return collideSphereBox(sA, bA, sB, bB);
  }
  if (sB instanceof SphereShape && sA instanceof BoxShape) {
    const m = collideSphereBox(sB, bB, sA, bA);
    if (!m) return null;
    return flipManifold(m);
  }
  if (sA instanceof BoxShape && sB instanceof PlaneShape) {
    return collideBoxPlane(sA, bA, sB, bB);
  }
  if (sB instanceof BoxShape && sA instanceof PlaneShape) {
    const m = collideBoxPlane(sB, bB, sA, bA);
    if (!m) return null;
    return flipManifold(m);
  }
  if (sA instanceof SphereShape && sB instanceof HeightfieldShape) {
    return collideSphereHeightfield(sA, bA, sB, bB);
  }
  if (sB instanceof SphereShape && sA instanceof HeightfieldShape) {
    const m = collideSphereHeightfield(sB, bB, sA, bA);
    if (!m) return null;
    return flipManifold(m);
  }
  if (sA instanceof BoxShape && sB instanceof HeightfieldShape) {
    return collideBoxHeightfield(sA, bA, sB, bB);
  }
  if (sB instanceof BoxShape && sA instanceof HeightfieldShape) {
    const m = collideBoxHeightfield(sB, bB, sA, bA);
    if (!m) return null;
    return flipManifold(m);
  }

  return null;
}

function flipManifold(m: ContactManifold): ContactManifold {
  const flipped = new ContactManifold(m.bodyB, m.bodyA);
  flipped.friction = m.friction;
  flipped.restitution = m.restitution;
  for (const c of m.contacts) {
    const invNorm = new Vec3(-c.normal.x, -c.normal.y, -c.normal.z);
    flipped.addContact(c.point, invNorm, c.penetration);
  }
  return flipped;
}
