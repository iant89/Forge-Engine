/**
 * Replay channels: the named, fixed-size groups of numbers a recording captures as "input".
 *
 * A channel is whatever the simulation reads that does not come from the simulation itself: a
 * vehicle's controls, a character's move vector, a turret's aim. The recorder reads every channel
 * once per frame (after the game's input code, before the simulation); the player writes the
 * recorded values back at the same point, overriding live devices.
 *
 * Values are plain doubles stored exactly (JSON keeps a double's shortest round-trip form), so a
 * played-back value is bit-identical to the recorded one. Booleans are 0/1.
 */

import { UsageError } from "../core/errors.js";
import type { Vehicle } from "../vehicles/vehicle.js";

export interface ReplayChannel {
  /** Unique within a recording; the player matches channels by name. */
  readonly name: string;
  /** Number of values; fixed for the channel's lifetime. */
  readonly size: number;
  /** Write the current values into `out[0..size)`. */
  read(out: number[]): void;
  /** Apply recorded values (length `size`). */
  write(values: readonly number[]): void;
}

/**
 * A vehicle's controls: throttle, brake, steer, handbrake, parking brake and the selected gear.
 * The gear is written through `selectGear` so the shift timer and shift count behave as they did
 * when the game shifted (the recording only contains gears the vehicle accepted).
 */
export function vehicleInputChannel(name: string, vehicle: Vehicle): ReplayChannel {
  const input = vehicle.input;
  return {
    name,
    size: 6,
    read(out) {
      out[0] = input.throttle;
      out[1] = input.brake;
      out[2] = input.steer;
      out[3] = input.handbrake;
      out[4] = input.parkingBrake;
      out[5] = vehicle.gear;
    },
    write(v) {
      input.throttle = v[0]!;
      input.brake = v[1]!;
      input.steer = v[2]!;
      input.handbrake = v[3]!;
      input.parkingBrake = v[4]!;
      const gear = v[5]!;
      if (vehicle.gear !== gear) vehicle.selectGear(gear as -1 | 0 | 1, Infinity);
    },
  };
}

/** Numeric or boolean fields of one object (booleans recorded as 0/1). */
export function fieldsChannel<T extends object>(name: string, target: T, keys: readonly (keyof T & string)[]): ReplayChannel {
  const rec = target as Record<string, unknown>;
  for (const k of keys) {
    const t = typeof rec[k];
    if (t !== "number" && t !== "boolean") throw new UsageError(`replay channel "${name}": field "${k}" is ${t}, not a number or boolean`);
  }
  const bools = keys.map((k) => typeof rec[k] === "boolean");
  return {
    name,
    size: keys.length,
    read(out) {
      keys.forEach((k, i) => (out[i] = bools[i] ? (rec[k] ? 1 : 0) : (rec[k] as number)));
    },
    write(v) {
      keys.forEach((k, i) => (rec[k] = bools[i] ? v[i] !== 0 : v[i]));
    },
  };
}
