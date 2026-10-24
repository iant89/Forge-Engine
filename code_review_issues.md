# Forge Engine - Code Review Issues

Repository: https://github.com/iant89/Forge-Engine
Branch: main
Reviewed commit: 8f5420ff4d5f5d9ac4c6f3cb86a8bb5bce5f6780
Review type: Initial source-level code review
Status: Open

## 1. Purpose

This document records the concrete issues identified during the
initial source-level review of Forge Engine.

The purpose is to provide actionable findings that can be converted
into implementation tasks, regression tests, and verified fixes.

Only identified issues are listed as findings. Areas that have not
been fully investigated are recorded separately and must not be
treated as confirmed defects.

## 2. Issue Summary

| ID | Severity | Subsystem | Issue | Status |
|----|----------|-----------|-------|--------|
| CR-001 | HIGH | ECS / Entity IDs | Entity generation truncated to 8 bits | FIXED (CPU gates verified; Phase 4 integration pending) |
| CR-002 | MEDIUM | Core / Object Pool | Duplicate and foreign object releases are not rejected | FIXED (CPU gates verified; Phase 4 integration pending) |
| CR-003 | MEDIUM | Physics | Invalid timestep configuration is not validated | OPEN |

Severity definitions:

- CRITICAL: Immediate risk of severe engine failure, data corruption,
  or a fundamental security boundary violation.
- HIGH: A correctness defect that can cause substantial engine state
  corruption or unpredictable behavior.
- MEDIUM: A correctness or reliability defect requiring specific
  conditions to trigger.
- LOW: A limited-impact defect or maintainability issue.

## 3. CR-001: Entity Generation Truncation

Severity: HIGH
Subsystem: Entity Component System
Primary files:
- engine/src/scene/entityId.ts
- engine/src/core/pool.ts
- engine/src/scene/world.ts

### Description

Entity IDs allocate 20 bits to the entity slot and 12 bits to the
generation counter.

However, the shared handle encoder in pool.ts masks the generation
to only 8 bits.

Relevant implementation:

    export function makeHandle(slot: number, generation: number): number {
      return ((slot << 8) | (generation & 0xff)) >>> 0;
    }

The ECS uses makeHandle() when validating entity IDs.

This means that the upper four bits of the entity generation do not
participate in the free-list handle validation.

### Impact

After an entity slot has been reused sufficiently many times, the
generation can wrap around its lower eight bits.

An old entity ID can then match a newly created entity occupying the
same slot.

This violates the expected stale-entity protection guarantee.

Potential consequences include:

- Accessing components belonging to a different entity.
- Applying operations to the wrong entity.
- Incorrect script references.
- Difficult-to-reproduce lifecycle and simulation bugs.

### Required Fix

1. Inspect the complete entity ID and free-list implementations.
2. Establish one consistent slot and generation representation.
3. Preserve all 12 generation bits during entity validation.
4. Ensure that entity generation comparisons use the complete
   generation value.
5. Check every call site of makeHandle() before changing its encoding.
6. Avoid silently changing unrelated pool handle contracts.
7. Add regression tests for generation wraparound.

### Regression Tests

- Create and destroy an entity repeatedly in the same slot.
- Retain an entity ID from an earlier generation.
- Reuse the slot more than 256 times.
- Verify that every stale ID remains invalid.
- Verify that the newest ID remains valid.
- Verify that component access using stale IDs is rejected.
- Verify that entity destruction and slot reuse remain correct.

### Acceptance Criteria

- Entity validation preserves the complete generation value.
- Stale entity IDs cannot resolve to a newer entity merely because
  their lower eight generation bits match.
- Existing ECS tests pass.
- New wraparound regression tests pass.

### Resolution (2026-10-24, branch `code-review-issues`)

Confirmed by reproduction before the fix, through the public API only:

- A stale ID resolved again after **128** reuses of its slot, not 256. A
  slot's generation advances twice per create/destroy cycle (allocate and
  release), so the 8-bit comparison wraps every 128 cycles.
- Additional defect found while inspecting `world.ts`:
  `EntityWorld.liveEntityIds()` rebuilt each ID from the 8-bit handle
  generation, so from the 128th reuse onward it returned IDs that differed
  from the live entity's real ID.

Fix (`engine/src/scene/world.ts`):

- `exists()` now checks that the slot is allocated and live and compares the
  slot's full generation (masked to the ID's 12 `GEN_BITS`) with the ID's
  generation. It no longer goes through `makeHandle`/`FreeList.isValid`.
- `liveEntityIds()` builds IDs with `idForSlot()`, using the full generation.
- `createEntity()` no longer applies a redundant `& 0xffff` mask.
- `makeHandle`, `FreeList` and their exported 8-bit handle contract are
  unchanged (pinned by `tests/core/runtimeApi.test.ts`). No public
  declarations changed; `npm run api:check` passes without an update.

Documentation: the `entityId.ts` header (it said 16+16 bits) and
`ARCHITECTURE.md` §6 now describe the real 20+12 layout. The lossy
`entityIdToHandle` is marked as unsuitable for validation, and
`docs/VERIFICATION.md` describes the new test.

Inherent limit: the ID has 12 generation bits, so the 2,049th occupant of a
slot is bit-identical to the first. This is the documented period of the ID
format, not a validation gap. The regression test pins it.

Evidence:

- New test `tests/scene/ecs.test.ts` "stale IDs stay invalid across every
  reuse of their slot ... (CR-001)": 2,048 reuses of one slot. Every earlier
  ID is rejected by `exists`, `getComponent`, `hasComponent`, `facade`,
  `addComponent` and `destroyEntity`. `liveEntityIds()` is exact, and a
  neighbouring entity is untouched. The test fails without the fix and
  passes with it.
- `npm run typecheck`, `test:check`, `lint:arch`, `api:check`, `docs:check`,
  `check:wgsl` and `check:replay-engines` pass.
- `npm test`: 167 suites passed, 3 failed. None of the failures involve
  this change:
  - `tests/examples/marsShowcaseDamage.test.ts` (2 checks) and
    `tests/examples/marsShowcaseCollision.test.ts` (1 check) fail
    identically on unmodified `main` 2ae14b0.
  - `tests/core/tasks.test.ts` ("reports an unrunnable handler back with
    inlineFallback") failed once under full-suite load with an undefined
    worker response. It passed 3 of 3 isolated runs with the fix and also
    passed on `main`.
- Not run: the real-WebGPU browser gate and benchmarks (Phase 4).

## 4. CR-002: Object Pool Allows Duplicate Releases

Severity: MEDIUM
Subsystem: Core / Object Pool
Primary file:
- engine/src/core/pool.ts

### Description

ObjectPool.release() checks the outstanding-object counter but does
not verify that the released object:

- Was obtained from this particular pool.
- Is currently leased to a caller.
- Has not already been released.

The current counter-based validation is insufficient to guarantee
that an individual object is released exactly once.

### Impact

A duplicate release can place the same object into the free list
multiple times.

Two later obtain() calls may consequently return the same object
to separate callers.

Both callers can then mutate the same underlying instance.

Potential consequences include:

- Corrupted temporary data.
- Aliasing between supposedly independent objects.
- Incorrect rendering or physics calculations.
- Intermittent failures caused by pooled object reuse.
- Incorrect pool accounting.

### Required Fix

1. Inspect all ObjectPool consumers and their ownership contracts.
2. Track which objects are currently leased.
3. Reject releases of objects that are not leased by the pool.
4. Remove an object from the leased set before retaining it.
5. Preserve reset() behavior and maxRetained semantics.
6. Ensure that discarded objects are no longer considered leased.
7. Provide a clear development-time error for invalid releases.
8. Avoid introducing unnecessary per-frame allocations in hot paths.

A Set<T> is a reasonable initial implementation for tracking leased
objects. Benchmark the additional bookkeeping if the pool is used
in particularly performance-sensitive paths.

### Regression Tests

- Obtain one object and release it once.
- Attempt to release the same object twice.
- Verify that the second release is rejected.
- Attempt to release an object created outside the pool.
- Obtain multiple objects and verify that they are distinct.
- Verify that a failed release does not corrupt the outstanding
  counter or free list.
- Verify that reset() is called exactly once per successful release.
- Verify maxRetained behavior.
- Verify that discarded objects cannot be obtained again.

### Acceptance Criteria

- No object can appear multiple times in the free list.
- Foreign objects cannot be inserted into the pool.
- Outstanding-object accounting remains consistent.
- Existing pool consumers continue to work correctly.
- Performance-sensitive uses remain within acceptable overhead.

### Resolution (2026-10-24, branch `code-review-issues`)

Confirmed: with a second object still leased, releasing the same object
twice passed the `outstanding > 0` check and pushed it onto the free list
twice. Two later `obtain()` calls then returned the same instance.

Consumers: none inside the engine, editor, examples or benchmarks.
`ObjectPool` is exported public API, and its only user is
`tests/core/runtimeApi.test.ts`. No consumer ownership contract needed
changing, and no hot path pays for the new bookkeeping, so no benchmark was
run.

Fix (`engine/src/core/pool.ts`):

- The private `outstanding` counter is now the `Set` of currently leased
  objects. `obtain()` adds to it, and `release()` deletes from it before
  resetting or retaining the object.
- An object that is not in the set (double release, foreign object, or one
  already discarded over `maxRetained`) fails `assert` with a message that
  names the pool. A rejected release does not reset the object or change
  any counter. With assertions disabled, the release is reported and ignored.
- `stats.outstanding`/`leaked` report the set's size. `reset()`,
  `maxRetained`, `prewarm` and `drain()` semantics are unchanged.
- The emitted `pool.d.ts` is byte-identical (private member names are
  hashed, their types are not), so the approved `ObjectPool` contract is
  unchanged. `npm run api:check` passes without an update.

Evidence:

- Two new checks in `tests/core/runtimeApi.test.ts`:
  - "rejects double and foreign releases without corrupting the free list":
    double and foreign release, reset counts, unchanged stats, distinct
    later leases, and the assertions-disabled path.
  - "discarded objects leave the pool for good and stay unreleasable":
    discard plus a re-release while another object is leased, and the
    `prewarm` objects.

  Both fail without the fix and pass with it.
- `npm run typecheck`, `test:check`, `lint:arch`, `api:check`, `docs:check`
  and `check:wgsl` pass.
- `npm test`: 167 suites passed and 3 failed, the same failures as in the
  CR-001 resolution. `tests/core/tasks.test.ts` "inlineFallback" has now
  failed in both full-suite runs while passing in isolation, which points to
  an order dependency rather than a random flake. It is unrelated to this
  change and should be investigated separately.

## 5. CR-003: Physics World Accepts Invalid Timesteps

Severity: MEDIUM
Subsystem: Physics
Primary file:
- engine/src/physics/world.ts

### Description

The PhysicsWorld constructor assigns fixedDt and maxSubsteps without
validating their values.

The applyOptions() method can also update configuration without
sufficient validation.

The simulation uses fixedDt in accumulator and interpolation
calculations. Invalid values can consequently contaminate simulation
state.

The public stepOnce(dt) method also requires a clearly defined
timestep contract.

### Impact

Potential invalid inputs include:

- fixedDt = 0
- fixedDt < 0
- fixedDt = NaN
- fixedDt = Infinity
- maxSubsteps <= 0
- Non-integer maxSubsteps
- Invalid stepOnce() durations

These inputs can result in invalid interpolation factors, unexpected
simulation behavior, or non-finite values propagating through physics
calculations.

### Required Fix

1. Define valid timestep and substep configuration contracts.
2. Validate fixedDt during construction.
3. Validate fixedDt whenever applyOptions() updates it.
4. Require fixedDt to be finite and strictly positive.
5. Require maxSubsteps to be a positive integer.
6. Validate stepOnce(dt) according to its documented contract.
7. Define explicitly whether a zero-duration step is a no-op.
8. Ensure rejected configuration changes do not partially mutate
   the existing valid configuration.
9. Check other public physics entry points for equivalent validation
   gaps.

### Regression Tests

- Reject zero fixedDt.
- Reject negative fixedDt.
- Reject NaN fixedDt.
- Reject infinite fixedDt.
- Reject zero or negative maxSubsteps.
- Reject non-integer maxSubsteps.
- Reject invalid stepOnce() durations.
- Verify that valid configuration remains unchanged after a failed
  update.
- Verify that normal fixed-step simulation continues to work.
- Verify that interpolation values remain finite.

### Acceptance Criteria

- Invalid physics configuration is rejected deterministically.
- Public physics APIs follow a consistent validation contract.
- Invalid values cannot silently corrupt the accumulator.
- Existing physics and vehicle tests pass.
- New validation and regression tests pass.

## 6. Recommended Implementation Order

### Phase 1: Entity Identity Correctness

Issues:
- CR-001

Tasks:

- [x] Inspect entityId.ts, pool.ts, and world.ts.
- [x] Document the entity ID bit layout.
- [x] Document the free-list handle bit layout.
- [x] Implement consistent generation encoding and validation.
- [x] Add generation wraparound tests.
- [x] Run ECS tests.
- [x] Run the complete CPU test suite (3 unrelated failures, see the
      CR-001 resolution).
- [x] Verify that no public handle contracts were unintentionally
      changed.

Completion requirement:

The ECS must reject stale entity IDs after repeated slot reuse.

### Phase 2: Object Pool Integrity

Issues:
- CR-002

Tasks:

- [x] Identify all ObjectPool consumers (none internal; public API only).
- [x] Document object ownership and release semantics.
- [x] Implement leased-object tracking.
- [x] Reject duplicate releases.
- [x] Reject foreign-object releases.
- [x] Verify accounting and reset behavior.
- [x] Add pool regression tests.
- [x] Run relevant rendering, physics, and resource tests (full suite).
- [x] Benchmark the pool if profiling indicates material overhead (not
      needed: no internal consumer or hot path).

Completion requirement:

A pool cannot return the same retained object to multiple callers
simultaneously because of duplicate release operations.

### Phase 3: Physics Input Validation

Issues:
- CR-003

Tasks:

- [ ] Define valid fixedDt and maxSubsteps ranges.
- [ ] Add constructor validation.
- [ ] Add applyOptions() validation.
- [ ] Add stepOnce() duration validation.
- [ ] Ensure invalid updates preserve previous valid state.
- [ ] Add invalid-input regression tests.
- [ ] Run physics tests.
- [ ] Run vehicle physics tests.
- [ ] Run deterministic replay tests.

Completion requirement:

Invalid timestep configuration is rejected before it can corrupt
simulation calculations.

### Phase 4: Integration and Verification

Tasks:

- [ ] Run TypeScript checks.
- [ ] Run the complete unit-test suite.
- [ ] Run architecture checks.
- [ ] Run WGSL validation.
- [ ] Run API contract checks.
- [ ] Run deterministic replay verification.
- [ ] Run benchmark regression checks.
- [ ] Run the real-WebGPU browser gate.
- [ ] Review all changed files.
- [ ] Verify that each issue has a regression test.
- [ ] Record the commit containing the fixes.
- [ ] Update this document with final verification results.

Completion requirement:

All three issues are fixed, regression tests pass, and the relevant
integration checks succeed.

## 7. Additional Audit Areas

The following areas were identified as requiring further review.
They are not confirmed defects and must not be represented as such
until their implementations have been inspected and evidence has
been collected.

### GPU Resource Lifecycle

Potential review targets:

- Buffer and texture destruction.
- Resource ownership and disposal.
- Device-loss handling.
- Bind group and pipeline cache invalidation.
- Resource recreation after device loss.
- Resource accounting and memory pressure.
- Cleanup during renderer shutdown.

### Renderer and Render Graph

Potential review targets:

- Render-pass dependencies.
- Resource aliasing and lifetime tracking.
- CPU/GPU culling consistency.
- Draw-command bounds.
- Instance buffer sizing.
- Shadow rendering and visibility transitions.
- Unnecessary allocations in the frame loop.

### Terrain and Streaming

Potential review targets:

- Chunk creation and destruction.
- Stale worker results.
- Cancellation and replacement requests.
- Chunk cache eviction.
- Memory-budget enforcement.
- LOD transitions and terrain seams.
- Streaming behavior during rapid camera movement.

### Task Scheduler

Potential review targets:

- Cancellation races.
- Worker failure recovery.
- Timeout handling.
- Queue starvation.
- Task ownership and cleanup.
- Scheduler shutdown.
- Outstanding task accounting.

### Physics and Collision

Potential review targets:

- Continuous collision detection.
- Broadphase correctness.
- Contact generation.
- Numerical stability.
- Fixed-step accumulator behavior.
- Body removal during simulation.
- Collision edge cases at extreme scales.

### Population Rendering

Potential review targets:

- Instance buffer bounds.
- Population generation determinism.
- Visibility and frustum culling.
- Shadow culling.
- Chunk-boundary behavior.
- Resource reuse.
- CPU/GPU population consistency.

### Scene Serialization

Potential review targets:

- Malformed input handling.
- Missing component references.
- Schema migrations.
- Entity identity restoration.
- Resource reference resolution.
- Partial-load cleanup.
- Invalid numeric values.

## 8. CI Verification Notes

The reviewed GitHub Actions run reported successful CPU gates,
including the full unit-test suite.

The real-WebGPU browser gate was still running when inspected.
It was configured as advisory with continue-on-error enabled.

Consequently, the successful CPU gate must not be interpreted as
proof that real-WebGPU rendering is correct.

CI run:
https://github.com/iant89/Forge-Engine/actions/runs/40058400028

## 9. Review Integrity Requirements

Every future issue added to this document must include:

- A unique issue identifier.
- A severity classification.
- The affected subsystem.
- Exact source file paths.
- A concrete description of the defect.
- The conditions required to reproduce it.
- Its expected impact.
- A recommended fix.
- A regression test.
- Explicit acceptance criteria.

Do not classify an architectural preference as a confirmed defect.

Do not claim that a test fails unless the failure has been observed.

Do not mark an issue fixed merely because code has been changed.
Require regression-test evidence and relevant integration checks.

If further inspection disproves a finding, document the evidence and
mark the issue as withdrawn rather than silently deleting its history.

## 10. Current Status

Confirmed source-level findings: 3
High-priority findings: 1
Medium-priority findings: 2
Low-priority findings: 0

Fixes implemented: 2 (CR-001, CR-002)
Regression tests added: 3 (CR-001: 1, CR-002: 2)
Issues verified as fixed: 2 (CR-001, CR-002: CPU gates; browser gate
pending)
Additional defects found while fixing: 1 (liveEntityIds, folded into
CR-001)

Overall status: INITIAL REVIEW COMPLETE; FULL AUDIT IN PROGRESS

This document records the findings established during the initial
source-level review. It does not certify the entire repository as
free of additional defects.
