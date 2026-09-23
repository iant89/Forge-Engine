# Vehicles (Phase 6 / 11)

A raycast car: four wheels sample a `GroundQuery` (preferably a physics-backed heightfield /
raycast query — Phase 11), a spring/damper holds each one, and a Pacejka tire turns the slip at that
contact into a force. The chassis is a point mass plus yaw/pitch/roll inertias; yaw comes from
tire-plane moments, while pitch and roll integrate from suspension reaction torques plus a soft
geometric spring (no tire pitch/roll moments this phase). An optional kinematic chassis box in the
physics world lets props collide with the car.

## Demo

`npm run demo`, then **Vehicle (P6)**, or open `?scene=vehicle`.

WASD or the arrow keys drive. Space is the handbrake. On a phone (or a window narrower than 820px)
a translucent stick sits in the bottom-left — the knob appears when you touch it and stays inside
the circle — and two round buttons sit bottom-right, A for gas and B for brake, in the same cluster
a controller uses. Pushing the stick up is also gas and pulling it down is also brake; left and
right steer. Drag orbits, the scroll wheel zooms, and the orbit target follows the chassis.
Arrow-key panning is off in this scene: both the orbit controller and the car listen on `window`,
so leaving keyboard pan on would steer the camera instead of the car (`OrbitControls` `keyboard: false`).

The pad is flat until `z = 18`, then a 12° ramp — the same angle as the slope-traversal test. The
yellow posts are scenery. The car does not collide with them; contact is the ground query only.

`VehicleSystem` is registered once on that scene's world and is the only caller of `vehicle.step`.
The scene `update` writes `vehicle.input` and does not step. A second step would double-integrate.

## What a step does

`Vehicle.step(dt, ground)` substeps at 1/120 s. Each substep:

1. Samples the ground under each hub. Compression is the spring travel; the force is spring plus damper.
2. Solves longitudinal slip (`balanceLongitudinal`) so tire torque balances drive minus brake, and
   stays on the rising face of the Pacejka curve. Explicit Euler on the wheel speed limit-cycles at
   this rate, which is why the slip is solved rather than integrated. An unaided wheel whose demand
   exceeds the peak is allowed to spin up on the residual torque, so traction control has a higher
   slip to compare against. TC clamps a driven wheel to `tcSlip` (0.12). ABS keeps a braking wheel
   from locking past `absSlip` (the Pacejka peak). An undriven, unbraked wheel is set to free-roll
   (`ω = vLong / radius`, κ = 0).
3. Lateral force is Pacejka in slip angle, combined with the longitudinal force under a friction
   circle of `μ · normalLoad`.
4. The chassis integrates the summed forces. Yaw comes from tire-plane moments about the CG.
   Pitch and roll come from suspension support reaction torques about the CG, plus — while three or
   more wheels plant — a soft spring that tracks the geometric axle orientation so a parked car
   settles. Sparse contact / airborne wheels keep their angular rates (no tire pitch/roll moments).

While a gear is engaged, reported RPM follows the driven wheels, but it does not stall below idle:
the crank holds `idleRpm` until wheel speed exceeds it (torque-converter slip). Neutral integrates
the crank on its own. Drive torque comes from `EngineModel` (torque curve, inertia, idle, redline)
through `Transmission`
(forward ratios, final drive, upshift/downshift RPM, a short shift where the clutch is open) and a
differential (`open`, `locked`, or `lsd`). Layout is `fwd`, `rwd`, or `awd`. Aero is `½ρCdAv²` drag
plus a lift coefficient; pass `aero: null` to turn it off. Reverse is a ratio (`gear = -1`); nothing
selects it automatically, and the playground has no reverse key.

Ground is a `GroundQuery` (`flatGround`, `slopeGround`, `heightFunctionGround`,
`physicsGroundQuery`, `physicsRaycastGroundQuery`, or any `sample(x, z, out)`). Phase 11 expects
the vehicle query and the physics heightfield collider to share one sampler so visual terrain,
collision, and wheel contact agree.

For **heightfield-only / terrain** vehicle contact, use `physicsGroundQuery` (or an equivalent
heightfield sampler). `physicsRaycastGroundQuery` casts a downward ray from a **fixed world-Y
origin** at `maxDistance * 0.5` (default origin Y = 32). Heightfields or other colliders that sit
**above** that origin are outside the ray and can miss or fall back incorrectly — do not use the
raycast helper as the sole ground query for pure HF terrain.

## Using it

```ts
import { Vehicle, VehicleComponent, VehicleSystem, createVehicleConfig, flatGround } from "@forge/engine";

const ground = flatGround(0);
const vehicle = new Vehicle(createVehicleConfig({ mass: 1400, mu: 1.05 }));
vehicle.placeOnGround(ground);

scene.world.registerSystem(new VehicleSystem()); // once, on this world
const body = scene.createTransformedEntity("chassis", vehicle.position.clone());
const component = new VehicleComponent(vehicle, ground);
component.wheelEntities = wheelEntityIds; // optional visuals, same order as vehicle.wheels
body.add(component);

// each frame, input only:
vehicle.input.throttle = 1;
```

`VehicleComponent` does not step. `VehicleSystem` (order 110, before `transforms`) calls `step`
once per fixed step and writes the chassis transform plus each wheel entity. Wheel spin is an euler
`(spin, yaw + steer, 0)` on a box, which is enough to see the wheels turn and not a tyre mesh.

## What is tested

`tests/vehicles.test.ts` (15):

- Pacejka is odd, zero at zero slip, and peaks near the sampled slip.
- A constant torque produces the analytic RPM (`I·α = τ`); the rev limiter holds.
- The gearbox shifts up at `upshiftRpm` and down at `downshiftRpm`.
- An open diff splits torque equally; an LSD biases it toward the slower wheel.
- Aero drag matches `½ρCdAv²`.
- Static load transfer: rearward under `+ax`, forward under braking.
- TC scales drive torque down once slip exceeds the threshold.
- A 1000 kg, μ = 1 car stops from 20 m/s within 15% of `v² / (2μg)`, and not shorter than 75% of that.
- A 12° slope is climbed when μ exceeds `tan θ` (height and z both increase).
- On the chassis, acceleration shifts load rearward and braking shifts it forward.
- Full throttle upshifts within 2.5 s on a short gearbox.
- With TC, peak driven |κ| stays under 0.35 and at least 0.15 below the same launch with TC off.
- The same inputs produce the same pose, yaw, RPM, and gear.
- `VehicleSystem` steps once per fixed step and writes the chassis transform.

## Sharing one PhysicsWorld (Vehicle + ECS)

`ForgeJSPhysics` and `PhysicsSystem` each **create their own** `PhysicsWorld` by default
(single-owner). That is intentional: a demo that only drives a vehicle never needs an ECS physics
system, and a prop scene never needs a vehicle backend.

If you register **both** without sharing, you silently get **two worlds**. A heightfield or
chassis on the vehicle backend is invisible to ECS rigid bodies, and vice versa.

To share one world:

```ts
import {
  ForgeJSPhysics,
  PhysicsSystem,
  VehicleComponent,
  VehicleSystem,
  createVehicleChassis,
} from "@forge/engine";

const backend = new ForgeJSPhysics(); // owns the world
// or: const backend = ForgeJSPhysics.wrap(existingWorld);

scene.world.registerSystem(new VehicleSystem());
scene.world.registerSystem(new PhysicsSystem({ world: backend.world }));
// equivalent: new PhysicsSystem({ backend })

backend.setHeightfield(shape);
const chassis = createVehicleChassis(vehicle, backend);
// Assign so PhysicsSystem drives the kinematic collider via Transform pose-delta
// (same path as RigidBodyComponent kinematics). Without this, props collide with a
// ghost at the spawn pose while the car has already driven away.
vehicleComponent.chassisBody = chassis;
// chassis + heightfield are visible to PhysicsSystem.world (same identity)
```

Rules of thumb:

- Default remains single-owner (`new ForgeJSPhysics()` / `new PhysicsSystem()` with no `world`).
- Adopt with `{ world }`, `{ backend }`, or `ForgeJSPhysics.wrap(world)`.
- When adopting, explicitly provided `gravity` / `fixedDt` / `solverOptions` are **copied onto the
  shared world** (they are not silently ignored). Omit a field to leave the adopted world's value
  unchanged. Example: `new PhysicsSystem({ world: backend.world, gravity: { x: 0, y: 0, z: 0 } })`
  zeros gravity on that shared world.
- When sharing, **one** side should call `step` (typically `PhysicsSystem` in an ECS scene). Stepping
  both the backend and the system double-integrates. `PhysicsSystem` uses `world.stepOnce(fixedDt)`
  so adopted worlds get exactly one solver step per ECS fixed step (no accumulator 0/N).
- Assign `VehicleComponent.chassisBody` after `createVehicleChassis`. `VehicleSystem` writes the
  chassis `Transform`; `PhysicsSystem` distributes that frame's pose delta across its substeps.
  Do **not** call `syncVehicleChassis` every vehicle fixed step in this recipe — FixedSystems are
  not interleaved, so snapping the chassis to the end pose/ω before physics runs leaves hitch
  frames (`fixedSteps>1`) contacting a parked body. (`syncVehicleChassis` remains for manual
  one-to-one `vehicle.step` / `world.step` loops outside ECS.)
- `PhysicsSystem.dispose()` clears the world only when it owns it (`ownsWorld === true`). Even
  when `ownsWorld === false`, it still **removes bodies it spawned** for `RigidBodyComponent`
  entities (so shared backends do not keep ghost colliders after a scene reload) and **nulls**
  those components' `body` handles so a replacement `PhysicsSystem` re-adds on the next fixed
  step. It does not remove bodies it did not create (e.g. `VehicleComponent.chassisBody` /
  manually `addBody`'d props).
- Despawning a prop (`destroyEntity` / `removeComponent(RigidBodyComponent)`) removes the
  system-spawned body from the shared `PhysicsWorld` immediately via the component detach hook
  — ghosts do not linger until `PhysicsSystem.dispose()`.
- `ForgeJSPhysics.clear()` **throws** when `ownsWorld === false` so a shared world cannot be
  silently wiped by a non-owner.


## Limitations

- Wheel contact is a physics heightfield / raycast query, not a triangle mesh against Phase 4 chunks.
- `physicsRaycastGroundQuery` uses a fixed world-Y ray origin (`maxDistance * 0.5`). Prefer
  `physicsGroundQuery` for heightfield-only / terrain vehicle ground when colliders may sit above
  that origin.
- `PhysicsWorld.raycast` / `physicsRaycastGroundQuery` treat non-heightfield `BoxShape` hits as
  **AABB-only** (axis-aligned bounds), not oriented OBB. Rotated decks / ramps are unsupported for
  wheel rays in Phase 11 — prefer `physicsGroundQuery` (HF) rather than a rotated box collider as
  ground. OBB box rays are intentionally out of scope this phase.
- The chassis collider is kinematic: props bounce off the car, but the car is not pushed by the
  sequential-impulse solver (drive forces still come from the raycast vehicle integrator).
- Pitch and roll integrate with rates (Phase 11.4); a soft geometric spring helps planted wheels
  settle on slopes. Extreme heightfield kinks can still excite that spring.
- Wheel visuals are boxes. There is no tyre mesh, no suspension-arm skinning, and no steering wheel.
- Reverse and neutral are set on `transmission.gear`. The automatic only shifts among forward gears.
- The playground ramp is a visual plane posed to match the query. If you move the kink, move both —
  or register one `HeightfieldShape` on the physics backend and use `physicsGroundQuery`.
- Telemetry: call `vehicle.telemetry()` for wheel load, travel, slip, tire force, RPM, gear, ω, contact.
