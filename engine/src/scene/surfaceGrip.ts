import type { EntityWorld as World } from "./world.js";

/**
 * Phase 17.4: the tyre-grip factor the environment publishes for a world. `WeatherSystem`
 * (environment) writes it, `VehicleSystem` (vehicles) applies it to every vehicle's `surfaceGrip`
 * on its fixed step — the scene layer is the one both may import, so neither depends on the other.
 * `undefined` means nothing drives grip and vehicles keep their own value.
 */
const worldGrip = new WeakMap<World, number>();

export function setWorldSurfaceGrip(world: World, grip: number | undefined): void {
  if (grip === undefined) worldGrip.delete(world);
  else worldGrip.set(world, grip);
}

export function worldSurfaceGrip(world: World): number | undefined {
  return worldGrip.get(world);
}

/**
 * fe-38: a spatial grip multiplier for the world (mud, puddles, lying snow from a ground moisture
 * field). `VehicleSystem` multiplies it, sampled under the chassis, into the global factor above.
 */
export type SurfaceGripField = (x: number, z: number) => number;
const worldGripField = new WeakMap<World, SurfaceGripField>();

export function setWorldSurfaceGripField(world: World, field: SurfaceGripField | undefined): void {
  if (field === undefined) worldGripField.delete(world);
  else worldGripField.set(world, field);
}

export function worldSurfaceGripField(world: World): SurfaceGripField | undefined {
  return worldGripField.get(world);
}
