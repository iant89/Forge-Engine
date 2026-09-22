/**
 * What a wheel needs from the world: a height and a unit normal at an XZ position.
 *
 * The vehicle does not import the terrain subsystem. A `TerrainWorld` satisfies this with
 * `(x, z) => ({ height: terrain.getHeightAt(x, z), normal })`, and tests pass a slope or a plane.
 */

export interface GroundSample {
  height: number;
  /** Unit normal, pointing out of the surface (typically +Y-ish). */
  nx: number;
  ny: number;
  nz: number;
}

export interface GroundQuery {
  sample(x: number, z: number, out: GroundSample): void;
}

export function flatGround(height = 0): GroundQuery {
  return {
    sample(_x, _z, out) {
      out.height = height;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
    },
  };
}

/**
 * A constant incline. `angleRad` > 0 raises the surface along `axis` (+Z by default), so a vehicle
 * facing +Z is driving uphill. The normal is `normalize(−∂h/∂x, 1, −∂h/∂z)`.
 */
export function slopeGround(angleRad: number, axis: "x" | "z" = "z"): GroundQuery {
  const slope = Math.tan(angleRad);
  const nx = axis === "x" ? -slope : 0;
  const nz = axis === "z" ? -slope : 0;
  const len = Math.hypot(nx, 1, nz);
  return {
    sample(x, z, out) {
      out.height = (axis === "x" ? x : z) * slope;
      out.nx = nx / len;
      out.ny = 1 / len;
      out.nz = nz / len;
    },
  };
}

/** Wrap a height function. The normal is a central difference, so the function must be defined nearby. */
export function heightFunctionGround(heightAt: (x: number, z: number) => number, step = 0.25): GroundQuery {
  return {
    sample(x, z, out) {
      out.height = heightAt(x, z);
      const dx = (heightAt(x + step, z) - heightAt(x - step, z)) / (2 * step);
      const dz = (heightAt(x, z + step) - heightAt(x, z - step)) / (2 * step);
      const nx = -dx;
      const ny = 1;
      const nz = -dz;
      const len = Math.hypot(nx, ny, nz) || 1;
      out.nx = nx / len;
      out.ny = ny / len;
      out.nz = nz / len;
    },
  };
}
