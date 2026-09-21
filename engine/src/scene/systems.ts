/**
 * Systems: the behaviour half of the ECS.
 *
 * A system is a class with `name`, an `order` band, optional `before`/`after` constraints, and an
 * `update(context)`. The world's scheduler sorts them once per structural change and runs them in
 * that order every frame, with the same `SystemContext` handed to each — no hidden globals, no
 * "depends on registration order", and each system's failures are isolated (an exception is
 * reported and the next system still runs) so one broken gameplay system cannot black-screen the
 * frame.
 *
 * Order bands (documented numbers, not arbitrary ones) — see docs/ARCHITECTURE.md#frame-pipeline:
 *   0   pre            input snapshot, script onPreUpdate
 *   100 simulation     physics, vehicles (fixed-step substeps inside)
 *   200 gameplay       scripts (variable rate), AI
 *   300 animation      clip sampling, IK, skinning
 *   400 world          terrain streaming, weather, particle sim
 *   500 transforms     local→world composition
 *   600 visibility     culling, LOD selection
 *   700 rendering      renderable assembly, GPU submission
 *   800 audio          listener/source sync (after transforms exist, before frame end)
 *   900 debug          debug overlay + stats flush
 */

import type { EntityWorld } from "./world.js";
import type { Clock } from "../core/time.js";
import type { Logger } from "../core/log.js";
import type { Profiler } from "../debug/profiler.js";
import type { RenderFrameContext } from "./renderContext.js";

export interface SystemContext {
  readonly world: EntityWorld;
  readonly clock: Clock;
  readonly dt: number;
  readonly fixedDt: number;
  /** Number of fixed steps executed during this frame's simulation (0 on render-only frames). */
  readonly fixedSteps: number;
  /** [0,1) interpolation factor for rendering between fixed states. */
  readonly alpha: number;
  readonly elapsed: number;
  readonly frame: number;
  readonly logger: Logger;
  readonly profiler: Profiler;
  /** Rendering context, present only when a renderer is attached (keeps sim-only use possible). */
  readonly render?: RenderFrameContext;
  /** Scene-level services (asset manager, coordinate space, quality settings). */
  readonly services: SystemServices;
  /** Scratch object reused across frames — see `SystemScratch`. */
  readonly scratch: SystemScratch;
}

export interface SystemServices {
  get<T>(key: string): T | undefined;
  readonly engineConfig: Record<string, unknown>;
}

/**
 * Per-frame scratch shared by systems: transforms' changed-slot list, sort buffers, query row
 * caches. Keeping these here (instead of per-system) is what removes the "allocate a small array
 * every frame in every system" tax that JS engines usually eat.
 */
export class SystemScratch {
  readonly changedTransformSlots: number[] = [];
  readonly visibleEntities: number[] = [];
  readonly drawCommands: number[] = [];
  readonly floats: Float32Array;

  constructor(maxInstances = 4096) {
    this.floats = new Float32Array(maxInstances * 16);
  }

  beginFrame(): void {
    this.changedTransformSlots.length = 0;
    this.visibleEntities.length = 0;
    this.drawCommands.length = 0;
  }
}

export interface ISystem {
  readonly name: string;
  /** Coarse band; see the table above. */
  readonly order: number;
  /** Names that must run after this one. */
  readonly before?: readonly string[];
  /** Names that must run before this one. */
  readonly after?: readonly string[];
  enabled: boolean;
  update(context: SystemContext): void;
  /** Optional: called when the system is unregistered/disposed (free GPU resources here). */
  dispose?(): void;
  /** Optional: machine-readable counters merged into `engine.stats`. */
  stats?(): Record<string, number | string | boolean>;
}

/** Base class giving a system a name, a band, and enable/disable plumbing. */
export abstract class System implements ISystem {
  abstract readonly name: string;
  readonly order = 500;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  enabled = true;
  abstract update(context: SystemContext): void;

  dispose?(): void;
  stats?(): Record<string, number | string | boolean>;
}

/**
 * A system that runs a fixed-timestep inner loop (physics, vehicles, particle sim).
 *
 * The `fixedSteps`/`alpha` pair on the context is the *only* place the fixed clock is read by
 * simulation code, which is what makes "simulation is independent of frame rate" testable.
 */
export abstract class FixedSystem implements ISystem {
  abstract readonly name: string;
  readonly order: number = 100;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  enabled = true;
  /** Accumulated fixed-step count, exposed for determinism tests and replays. */
  stepsExecuted = 0;

  abstract fixedStep(context: SystemContext, stepIndex: number): void;

  update(context: SystemContext): void {
    for (let i = 0; i < context.fixedSteps; i++) {
      this.fixedStep(context, i);
      this.stepsExecuted++;
    }
  }

  dispose?(): void;
  stats?(): Record<string, number | string | boolean>;
}

/**
 * Default transform system: recomputes depth-ordered world matrices from local TRS changes.
 * Runs in band 500 (transforms), after simulation/gameplay/animation and before culling/rendering.
 */
export class TransformSystem extends System {
  readonly name = "transforms";
  override readonly order = 500;

  update(context: SystemContext): void {
    context.world.updateTransforms(context.scratch.changedTransformSlots);
  }
}

