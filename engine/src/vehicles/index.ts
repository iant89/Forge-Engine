export {
  pacejka,
  pacejkaPeakSlip,
  pacejkaShape,
  DEFAULT_LONGITUDINAL,
  DEFAULT_LATERAL,
  type PacejkaCoefficients,
} from "./pacejka.js";
export {
  EngineModel,
  Transmission,
  splitDriveTorque,
  aeroLoads,
  tractionControlScale,
  absBrakeScale,
  ZERO_AERO,
  type EngineModelOptions,
  type TransmissionOptions,
  type DrivetrainLayout,
  type DifferentialType,
  type WheelTorqueInput,
  type AeroConfig,
} from "./drivetrain.js";
export { ElectricMotor, ReductionDrive, type ElectricMotorOptions } from "./electric.js";
export { flatGround, slopeGround, heightFunctionGround, type GroundQuery, type GroundSample } from "./ground.js";
export {
  physicsGroundQuery,
  physicsRaycastGroundQuery,
  assertTerrainAgreement,
  type PhysicsRaycastGroundOptions,
} from "./physicsGround.js";
export {
  createVehicleChassis,
  syncVehicleChassis,
  type VehicleChassisOptions,
} from "./chassis.js";
export {
  computeWheelLoads,
  axleLoad,
  distributeWheelLoads,
  type WheelLoadInput,
  type WheelLoads,
  type NWheelLoadInput,
} from "./loads.js";
export {
  Vehicle,
  createVehicleConfig,
  type VehicleConfig,
  type VehicleOptions,
  type VehicleInput,
  type VehicleWheelConfig,
  type WheelState,
  type VehicleTelemetry,
  type WheelTelemetry,
} from "./vehicle.js";
export { VehicleComponent, createVehicleComponent } from "./components.js";
export { VehicleSystem } from "./system.js";
export {
  createVehicleDamageZones,
  applyBodyDamage,
  applyWheelDamage,
  computeBodyCrushOffset,
  WHEEL_DETACH_DAMAGE,
  WHEEL_BEND_MAX,
  BODY_CRUSH_SPAN_X,
  BODY_CRUSH_SPAN_Z,
  BODY_CRUSH_MAX,
  BODY_CRUSH_SINK,
  type VehicleDamageZones,
} from "./damage.js";
