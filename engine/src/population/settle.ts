/**
 * Physics-based settling for world population objects (Phase 14 / 15.5).
 * Simulates gravity, terrain surface normal contact, static/kinetic friction,
 * and downslope sliding/rolling so every spawned object settles into natural
 * physical equilibrium upon world/chunk generation.
 */

import type { PopulationInstanceBlock } from "../scene/population.js";
import type { PopulationSurfaceSampler, ResolvedPopulationTypeSpec } from "./scatter.js";

export interface PopulationPhysicsSettlingOptions {
  /** Gravity acceleration magnitude in m/s² (default: 3.72 for Mars). */
  gravity?: number;
  /** Maximum settling physics steps to simulate per object (default: 60). */
  maxSteps?: number;
  /** Simulation timestep in seconds (default: 1 / 60). */
  dt?: number;
  /** Default friction coefficient for round objects (default: 0.60). */
  friction?: number;
  /** Friction coefficient for flat objects (default: 0.95). */
  flatFriction?: number;
  /** Linear damping factor (default: 0.20). */
  linearDamping?: number;
}

/**
 * Applies physical settling to every instance in a population block against the terrain surface.
 * Objects placed on slopes exceeding their angle of repose slide or roll downhill under gravity
 * and friction until coming to rest in hollows, valleys, or stable ground.
 *
 * @returns Number of instances settled.
 */
export function settlePopulationBlockWithPhysics(
  block: PopulationInstanceBlock,
  spec: ResolvedPopulationTypeSpec,
  sampler: PopulationSurfaceSampler,
  options: PopulationPhysicsSettlingOptions = {},
): number {
  if (block.count === 0) return 0;

  const g = options.gravity ?? 3.72;
  const maxSteps = options.maxSteps ?? 60;
  const dt = options.dt ?? 1 / 60;
  const defaultFriction = options.friction ?? 0.6;
  const flatFriction = options.flatFriction ?? 0.95;
  const linearDamping = options.linearDamping ?? 0.2;
  const eps = 0.2;

  let settledCount = 0;

  for (let k = 0; k < block.count; k++) {
    const p = k * 3;
    let x = block.positions[p]!;
    let z = block.positions[p + 2]!;
    let sx = block.scales[p]!;
    let sy = block.scales[p + 1]!;
    let sz = block.scales[p + 2]!;
    let rot = block.rotations[k]!;

    // A rock resting on the ground in nature topples over onto its widest, flattest face
    // (minimum gravitational potential energy). Ensure the thinnest dimension is vertical (sy),
    // toppling any slab standing on a narrow edge.
    const minDim = Math.min(sx, sy, sz);
    if (sy > minDim) {
      if (sx === minDim) {
        const temp = sx;
        sx = sy;
        sy = temp;
      } else {
        const temp = sz;
        sz = sy;
        sy = temp;
      }
      block.scales[p] = sx;
      block.scales[p + 1] = sy;
      block.scales[p + 2] = sz;
    }

    const isFlat = sy < 0.65 * Math.max(sx, sz);
    const mu = isFlat ? flatFriction : defaultFriction;
    const radius = Math.max(0.12, ((sx + sz) / 2) * 0.5);

    let vx = 0;
    let vz = 0;

    for (let s = 0; s < maxSteps; s++) {
      const hR = sampler.heightAt(x + eps, z);
      const hL = sampler.heightAt(x - eps, z);
      const hD = sampler.heightAt(x, z + eps);
      const hU = sampler.heightAt(x, z - eps);

      const dhdx = (hR - hL) / (2 * eps);
      const dhdz = (hD - hU) / (2 * eps);
      const gradMag = Math.hypot(dhdx, dhdz);
      const len = Math.hypot(dhdx, 1, dhdz);
      const ny = 1 / len;
      const sinTheta = gradMag / len;

      const speed = Math.hypot(vx, vz);

      // Downhill unit vector (opposite to height gradient)
      const ux = gradMag > 1e-4 ? -dhdx / gradMag : 0;
      const uz = gradMag > 1e-4 ? -dhdz / gradMag : 0;
      const aGrav = g * sinTheta;
      const maxStaticFric = mu * g * ny;

      if (speed < 0.01) {
        // If static friction resists downslope gravity, object is in static equilibrium!
        if (aGrav <= maxStaticFric) {
          vx = 0;
          vz = 0;
          break;
        }
        // Exceeds static friction: accelerates downhill
        const aNet = aGrav - maxStaticFric;
        vx += ux * aNet * dt;
        vz += uz * aNet * dt;
      } else {
        // Moving: kinetic friction opposes direction of motion
        const fricX = -(vx / speed) * mu * g * ny;
        const fricZ = -(vz / speed) * mu * g * ny;
        const gravX = ux * aGrav;
        const gravZ = uz * aGrav;
        const accX = gravX + fricX - linearDamping * vx;
        const accZ = gravZ + fricZ - linearDamping * vz;
        vx += accX * dt;
        vz += accZ * dt;
        const newSpeed = Math.hypot(vx, vz);
        if (newSpeed < 0.02 && aGrav <= maxStaticFric) {
          vx = 0;
          vz = 0;
          break;
        }
      }

      x += vx * dt;
      z += vz * dt;

      if (!isFlat) {
        const rollDist = speed * dt;
        rot += rollDist / radius;
      }
    }

    const groundH = sampler.heightAt(x, z);
    const finalY = groundH - spec.embed * sy;

    block.positions[p] = x;
    block.positions[p + 1] = finalY;
    block.positions[p + 2] = z;
    block.rotations[k] = rot;
    settledCount++;
  }

  block.markModified();
  return settledCount;
}
