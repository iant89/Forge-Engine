# Vehicles (Phase 6)

A raycast car: four wheels sample a heightfield, a spring/damper holds each one, and a Pacejka tire
turns the slip at that contact into a force. It is not a rigid body in the Phase 5 solver. The
chassis is a point mass plus a yaw inertia; pitch and roll are kinematic, taken from the ground
under the two axles, and are not integrated.

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
4. The chassis integrates the summed forces. Yaw comes from the moment about the centre of mass.
   Pitch and roll are rewritten from the axle heights; they are not a second integrator.

While a gear is engaged, reported RPM follows the driven wheels, but it does not stall below idle:
the crank holds `idleRpm` until wheel speed exceeds it (torque-converter slip). Neutral integrates
the crank on its own. Drive torque comes from `EngineModel` (torque curve, inertia, idle, redline)
through `Transmission`
(forward ratios, final drive, upshift/downshift RPM, a short shift where the clutch is open) and a
differential (`open`, `locked`, or `lsd`). Layout is `fwd`, `rwd`, or `awd`. Aero is `½ρCdAv²` drag
plus a lift coefficient; pass `aero: null` to turn it off. Reverse is a ratio (`gear = -1`); nothing
selects it automatically, and the playground has no reverse key.

Ground is a `GroundQuery` (`flatGround`, `slopeGround`, `heightFunctionGround`, or any
`sample(x, z, out)`). That is the terrain contact. It is not a triangle mesh query against the
Phase 4 chunks.

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

## Limitations

- No collision with meshes, props, or other vehicles. Only the ground query.
- Not in the Phase 5 contact solver. A car and a stack of boxes do not interact.
- Pitch and roll do not carry angular momentum. A sharp kink in the heightfield snaps the pose to
  the axles; it does not launch the chassis as a rigid body would.
- Wheel visuals are boxes. There is no tyre mesh, no suspension-arm skinning, and no steering wheel.
- Reverse and neutral are set on `transmission.gear`. The automatic only shifts among forward gears.
- The playground ramp is a visual plane posed to match the query. If you move the kink, move both.
