/**
 * MechanicalSystem — drives {@link MechanicalRig}s every frame (Phase 16.6).
 *
 * The mechanical half of the animation band: `AnimationSystem` (order 300) poses clip-driven
 * skeletons, `MechanicalSystem` (order 310) poses machine joints from channels, and the transform
 * system (band 500) publishes both to the world matrices the renderer consumes.
 *
 * Per component, per frame:
 *  1. the component's {@link MechanicalChannelSource} writes this frame's channel values (the
 *     vehicle adapter reads wheel telemetry; a scripted rig reads whatever drives it), then
 *  2. the rig advances (limits + slew) and poses (composes `base ∘ motion`, solves aim joints).
 *
 * Ordering matters in one direction only: this system runs after the fixed simulation systems
 * (vehicles at 110, physics at 300 in the fixed band), so a channel source reads the state the
 * simulation just produced for this frame rather than the previous frame's.
 *
 * The component is a thin hook on the entity that owns the rig (usually the chassis): systems hold
 * behaviour, components hold state — the same split `AnimationComponent`/`AnimationSystem` uses.
 */

import { System, type SystemContext } from "../scene/systems.js";
import { Component, registerComponent } from "../scene/components.js";
import { MechanicalRig } from "./mechanical.js";

/**
 * Fills a rig's channels from whatever owns the state. Implemented by the subsystem that owns the
 * machine — `vehicles/wheelRig.ts` reads wheel telemetry — so `animation/` never has to import a
 * sibling.
 */
export interface MechanicalChannelSource {
  /** Called once per frame, before the rig advances. */
  writeChannels(rig: MechanicalRig): void;
}

/** Binds a {@link MechanicalRig} to an entity so `MechanicalSystem` drives it. */
export class MechanicalRigComponent extends Component {
  static readonly typeName = "MechanicalRig";
  readonly rig: MechanicalRig;
  /** Channel source; a rig with no source keeps the values scripts write directly. */
  source: MechanicalChannelSource | null;

  constructor(rig: MechanicalRig, source: MechanicalChannelSource | null = null) {
    super();
    this.rig = rig;
    this.source = source;
  }

  /** Detaching the component returns the machine to its authored pose. */
  override onDetach(): void {
    this.rig.reset();
  }
}

registerComponent(MechanicalRigComponent as never, {
  name: "MechanicalRig",
  allowMultiple: false,
  editorGroup: "Animation",
});

export class MechanicalSystem extends System {
  readonly name = "mechanical";
  override readonly order = 310;
  override readonly after = ["animation"];

  private rigCount = 0;
  private jointCount = 0;
  private posedCount = 0;
  private solvedCount = 0;
  private saturatedCount = 0;

  update(context: SystemContext): void {
    const store = context.world.store(MechanicalRigComponent);
    this.rigCount = 0;
    this.jointCount = 0;
    this.posedCount = 0;
    this.solvedCount = 0;
    this.saturatedCount = 0;

    for (let i = 0; i < store.count; i++) {
      const component = store.valueAt(i);
      if (!component.enabled) continue;
      const rig = component.rig;
      component.source?.writeChannels(rig);
      rig.step(context.dt);
      const stats = rig.stats();
      this.rigCount++;
      this.jointCount += stats.joints ?? 0;
      this.posedCount += stats.posed ?? 0;
      this.solvedCount += stats.solved ?? 0;
      this.saturatedCount += stats.saturated ?? 0;
    }
  }

  override stats(): Record<string, number | string | boolean> {
    return {
      mechanicalRigs: this.rigCount,
      mechanicalJoints: this.jointCount,
      mechanicalJointsPosed: this.posedCount,
      mechanicalJointsSolved: this.solvedCount,
      mechanicalJointsSaturated: this.saturatedCount,
    };
  }
}
