# Change Log — Forge Engine activity history

Machine-readable history of engine changes. A future interactive history page will render the
JSON array below; agents maintain it by hand until then.

## Maintenance rules (agents: follow these)

- Append a `change` entry for every file you create, modify, or delete: one entry per file, with
  the `model` that made the edit (`modelVersion` when known, else `null`), the `file` path, and a
  brief `what` + `why`.
- Before each PR merge, append a `pr-merge` entry summarising **all** changes in that PR.
- Entries are chronological (oldest first). `id` is zero-padded sequential — use last id + 1.
- `model` is the agent identity as known to the session. Arena sessions use `"Arena Agent Mode"`
  unless the specific underlying model is known, in which case record it (and its version).
- After editing, validate the block still parses: `node -e '...'`
  (extract the ```json fence and `JSON.parse` it — see `tools/` if a checker exists by then).

## Entry schemas

`change`: `id, date (UTC ISO), type, pr (number|null), branch, model, modelVersion, file, what, why`
`pr-merge`: `id, date (UTC ISO), type, pr, branch, base, title, model, modelVersion, summary, files[]`
(`note` is optional on any entry.)

## Entries

```json
[
  {
    "id": "0001",
    "date": "2026-09-24T13:43:33Z",
    "type": "pr-merge",
    "pr": 33,
    "branch": "arena/01a0d372-forge-engine",
    "base": "main",
    "title": "Fix the sky painting over the whole scene on WebKit (load scene depth explicitly)",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "summary": "Initial engine import to main (215 files, squash-merged) plus visibility fixes: WebKit sky no longer paints over the scene, and the rover + terrain render correctly in the Mars showcase.",
    "files": [],
    "note": "Backfilled after the fact: PR #33 was squash-merged without branch history, so per-file entries cannot be reconstructed."
  },
  {
    "id": "0002",
    "date": "2026-09-24T13:58:40Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "scripts/convert-perseverance.mjs",
    "what": "Rebase per-wheel indices by the cluster base when emitting wheel slices; throw on cross-wheel triangles; rank k-means seeds front-to-rear explicitly.",
    "why": "The converter pushed global indices into 0-based per-wheel slices, so only wheel_FL (base 0) rendered and the other five wheels were invisible with no error."
  },
  {
    "id": "0003",
    "date": "2026-09-24T13:58:40Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/assets/Perseverance.glb",
    "what": "Repaired 15 wheel meshes in place by subtracting each mesh's index minimum (verified contiguous ranges; body meshes already correct).",
    "why": "The checked-in GLB carried the converter's broken indices; the Draco source was unavailable, so an exact in-place repair beat reconversion."
  },
  {
    "id": "0004",
    "date": "2026-09-24T13:58:40Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/assets/glb.ts",
    "what": "loadGlb now console.warns when a primitive's max index exceeds its vertex count.",
    "why": "Out-of-bounds index buffers fail silently on the GPU; future corrupt geometry should be loud at load time."
  },
  {
    "id": "0005",
    "date": "2026-09-24T13:58:40Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/roverGlb.test.ts",
    "what": "New regression test: six wheel roots + hub positions and in-range indices on every mesh of the checked-in GLB.",
    "why": "Pin the repaired asset so a future reconversion or bad edit fails in CI instead of shipping invisible wheels again."
  },
  {
    "id": "0006",
    "date": "2026-09-24T13:58:40Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "mnemosyne.md",
    "what": "Created the cross-session memory file with repo facts and dated notes (first entry: the invisible-wheels bug).",
    "why": "Future sessions need durable notes on real bugs and hard-won repo knowledge, not just code comments."
  },
  {
    "id": "0007",
    "date": "2026-09-24T14:06:45Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "change-log.md",
    "what": "Created this JSON-backed activity log with maintenance rules, schemas, a backfilled PR #33 entry, and PR #34 entries.",
    "why": "Requested as the data source for a future interactive engine-history page; one entry per change plus a summary per PR merge."
  },
  {
    "id": "0008",
    "date": "2026-09-24T14:06:45Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "AGENTS.md",
    "what": "Added §7 directing agents to use mnemosyne.md for free-form session notes and change-log.md for per-change + per-PR entries.",
    "why": "The notes/log convention only works if every session knows about it before starting work."
  },
  {
    "id": "0009",
    "date": "2026-09-24T14:06:45Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "mnemosyne.md",
    "what": "Appended the change-log.md convention note (entry format, pr-merge rule, model-field convention).",
    "why": "The log convention is itself session knowledge worth preserving alongside the AGENTS.md pointer."
  },
  {
    "id": "0010",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "scripts/convert-perseverance.mjs",
    "what": "Extract the Remote Sensing Mast subtree (head up-walked to its scene root plus descendants) as hinge-relative mast_* parts; pad the JSON chunk with spaces per the glTF spec.",
    "why": "The mast was baked into the per-material body merge so it could not move; the demo needs a rigid hinge-relative assembly to raise/lower, and NUL JSON padding makes JSON.parse throw."
  },
  {
    "id": "0011",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/assets/Perseverance.glb",
    "what": "Regenerated from the NASA Draco source with the mast split out (55 hinge-relative parts), rebased wheel indices, and valid chunk padding.",
    "why": "The checked-in asset predates the mast split; regenerating from source also folds the earlier in-place wheel repair into a clean convert."
  },
  {
    "id": "0012",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/assets/glb.ts",
    "what": "Parse the `mast` root into LoadedGlb.mast (hinge pivot + parts), alongside the wheel groups.",
    "why": "The scene needs the hinge position and the hinge-relative parts to build the deployment pivot."
  },
  {
    "id": "0013",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/scenes/marsShowcaseScene.ts",
    "what": "Mast pivot entity under the chassis, underdamped deployment spring (M key / MAST button / setMast), HUD + marsState mast status.",
    "why": "Requested feature: smooth realistic mast fold/unfold; the spring gives a ~3 s raise with a small latch overshoot and mid-swing reversals."
  },
  {
    "id": "0014",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/controls/vehicleTouch.ts",
    "what": "MAST pad support: onMastToggle tap callback plus setMast(active) button lighting; unbound on the playground.",
    "why": "The on-screen C/MAST button needs the same tap plumbing as gas/brake without disturbing the shared drive pad."
  },
  {
    "id": "0015",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/index.html",
    "what": "C/MAST pad button in the vehicle cluster, shown only under body.scene-mars, with an active (commanded) style.",
    "why": "Requested controller button matching the Gas/Brake pads; Mars-only so it never leaks onto the playground."
  },
  {
    "id": "0016",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/main.ts",
    "what": "Toggle body.scene-mars for the showcase and expose __forge.setMast(deployed) for gates.",
    "why": "CSS needs a Mars marker for the MAST button, and the browser gate needs a programmatic mast hook."
  },
  {
    "id": "0017",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "engine/src/math/mat.ts",
    "what": "Fixed Quat.fromUnitVectorY to actually rotate +Y onto dir (x/z terms were negated, yielding the inverse).",
    "why": "Found while deriving the mast deploy quaternion; the helper had no callers but would have bitten the first user."
  },
  {
    "id": "0018",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/math.test.ts",
    "what": "Pin fromUnitVectorY: +Y lands on dir for axis and diagonal inputs, antipodal input flips cleanly.",
    "why": "Lock the corrected quaternion helper against regressions."
  },
  {
    "id": "0019",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/roverGlb.test.ts",
    "what": "Assert the mast root, hinge pivot, part count, and hinge-relative z extents of the checked-in GLB.",
    "why": "A remodelled source or converter regression must fail in CI before it ships a detached or mis-hinged mast."
  },
  {
    "id": "0020",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/vehicleTouch.test.ts",
    "what": "MAST toggle tests: tap fires the callback, nothing binds without it, setMast lights/clears the button.",
    "why": "Cover the new pad control the same way the gas/brake holds are covered."
  },
  {
    "id": "0021",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "docs/screenshots/mars-showcase-mast-deployed.png",
    "what": "Headless capture of the raised mast (HUD mast UP) for the screenshots gallery.",
    "why": "Documents the finished feature the way the loading/bounds captures document theirs."
  },
  {
    "id": "0022",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "docs/screenshots/README.md",
    "what": "Table row describing the deployed-mast capture.",
    "why": "Keep the gallery index complete."
  },
  {
    "id": "0023",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "change-log.md",
    "what": "Mast-feature entries plus this self-entry; PR #34 merge summary rewritten to cover the full branch.",
    "why": "The log must stay complete as the branch grows; the merge summary tracks the PR, not the first commit."
  },
  {
    "id": "0024",
    "date": "2026-09-24T14:41:01Z",
    "type": "change",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "mnemosyne.md",
    "what": "Session notes: stowed-mast discovery, hinge/head data, fromUnitVectorY + JSON-padding bugs, no-parallel-edits lesson.",
    "why": "Durable record of what this session learned so the next one starts warm."
  },
  {
    "id": "0025",
    "date": "2026-09-24T14:41:01Z",
    "type": "pr-merge",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "base": "main",
    "title": "Mars rover: wheel fix, deployable camera mast, activity log",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "summary": "Mars showcase: all six wheels render (converter index rebase, GLB repaired then cleanly regenerated); deployable Remote Sensing Mast via MAST button / M key with a spring-driven raise and latch overshoot (mast split from the body at convert time, hinge pivot, HUD + gate status); JSON change-log.md plus mnemosyne.md session notes and the AGENTS.md convention; drive-by fixes for Quat.fromUnitVectorY and GLB JSON padding; GLB, touch, and math regression tests.",
    "files": [
      "scripts/convert-perseverance.mjs",
      "examples/assets/Perseverance.glb",
      "examples/src/assets/glb.ts",
      "tests/roverGlb.test.ts",
      "mnemosyne.md",
      "change-log.md",
      "AGENTS.md",
      "examples/src/scenes/marsShowcaseScene.ts",
      "examples/src/controls/vehicleTouch.ts",
      "examples/index.html",
      "examples/src/main.ts",
      "engine/src/math/mat.ts",
      "tests/math.test.ts",
      "tests/vehicleTouch.test.ts",
      "docs/screenshots/mars-showcase-mast-deployed.png",
      "docs/screenshots/README.md"
    ]
  },
  {
    "id": "0026",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "README.md",
    "what": "Mars showcase controls paragraph now covers M (camera mast) and R (robotic arm) plus the TFGH/IJKL jog keys and the thumbsticks.",
    "why": "The README described driving only; the mast shipped undocumented and the arm must not."
  },
  {
    "id": "0027",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "docs/VERIFICATION.md",
    "what": "The check:browser row now records the robotic-arm gate: R starts the unfold (elbow leaves its stowed angle), stow returns every joint to zero with the sticks hidden.",
    "why": "The gate gained an arm section; the honesty table must say what it proves."
  },
  {
    "id": "0028",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "docs/screenshots/README.md",
    "what": "Gallery row for the deployed-arm capture.",
    "why": "Keep the screenshot index complete."
  },
  {
    "id": "0029",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "docs/screenshots/mars-showcase-arm-unfolded.png",
    "what": "Headless capture (real WebGPU) of the unfolded arm in the ready pose with both jog thumbsticks on screen and the HUD reporting arm READY.",
    "why": "Documents the finished feature the way the mast capture documents its."
  },
  {
    "id": "0030",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/assets/Perseverance.glb",
    "what": "Regenerated: the five-joint arm is now a nested arm > arm_shoulder > arm_elbow > arm_wrist > arm_turret chain with pivot-relative parts; mast_upper/mast_head joints moved into extras. Binary payload unchanged (every body vertex within 1.4e-8 m of the previous asset).",
    "why": "The scene needs joint pivots and per-link geometry to articulate the arm; the mast fix makes the asset spec-correct."
  },
  {
    "id": "0031",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/index.html",
    "what": "D·ARM pad button (Mars-only, id-keyed lit rule), the #arm-touch overlay with two labelled thumbsticks (above the drive controls on touch layouts, bottom corners on desktop, beside the pad on short landscape), and a max-width fix so the longer Mars hint stays on one line.",
    "why": "The arm needs its toggle and, when unfolded, its two sticks above the rover controls."
  },
  {
    "id": "0032",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/assets/glb.ts",
    "what": "LoadedGlb.arm: the loader walks the nested joint chain (strictly-nested validation, unit-normalised extras.axis) and returns per-joint offsets and pivot-relative parts; mast joints now read extras.joint with a translation fallback; fixes the pre-existing TS never-narrowing that failed main's typecheck.",
    "why": "The scene needs the chain; the loader must also keep working with the old flat-mast asset."
  },
  {
    "id": "0033",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/controls/vehicleTouch.ts",
    "what": "ARM pad button wired like MAST (onArmToggle, setArm, dispose), tap-toggle generalised, suppressTouchChrome exported for armTouch.",
    "why": "The pad gains the arm toggle; the arm sticks reuse its iOS-chrome suppression."
  },
  {
    "id": "0034",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/controls/armTouch.ts",
    "what": "New: two pointer-capture thumbsticks (swing/shoulder, turret/elbow) with the drive stick's dead zone and knob behaviour, visible only while #arm-touch.shown; hiding releases held sticks; window-level end fallback.",
    "why": "The requested second pair of controls for the unfolded arm."
  },
  {
    "id": "0035",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/main.ts",
    "what": "__forge.setArm for automation, mirroring setMast.",
    "why": "The gate and any harness must be able to command the arm headlessly."
  },
  {
    "id": "0036",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/scenes/marsShowcaseScene.ts",
    "what": "Nested arm pivot entities under the chassis posed from RoverArmController each frame; R key + ARM pad toggle; TFGH/IJKL keyboard jog added to stick axes; arm HUD line; marsState arm fields; setArm handle; hint text.",
    "why": "Wires the controller and the sticks into the scene."
  },
  {
    "id": "0037",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "examples/src/scenes/roverArm.ts",
    "what": "New: pure arm controller — keyframed unfold/stow choreography (lift, swing, long-path elbow, turret aim), smoothed jog rates, joint limits, wrist auto-level, ground guard, acceleration-limited progress with jog offsets that fade on stow.",
    "why": "All arm behaviour in one testable module; the choreography and limits were voxel-swept against the model."
  },
  {
    "id": "0038",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "mnemosyne.md",
    "what": "Session notes: joint pivots = node origins, stowed-shoulder lab collision, long-path elbow, verified jog box, TS never-narrowing and CSS specificity traps, SwiftShader capture recipe.",
    "why": "Durable record so the next session starts warm."
  },
  {
    "id": "0039",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "scripts/convert-perseverance.mjs",
    "what": "Arm chain split (asserted by name/parentage/axis) into the nested pivot-relative hierarchy with extras {joint, axis}; report gains the joint table; mast sub-group joints moved to extras.",
    "why": "Source of the new GLB structure."
  },
  {
    "id": "0040",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/roverGlb.test.ts",
    "what": "Arm-chain structure test: joint roles/axes in controller order, parent-relative offsets matching roverArm's hardcoded geometry, pivot-relative extents per link, composed turret pivot; mast extras-not-translation check.",
    "why": "A reconversion that moves a pivot or flattens the chain must fail here, not mis-aim the arm."
  },
  {
    "id": "0041",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/roverArm.test.ts",
    "what": "New: 14 tests over the choreography (ready pose, timing, no snaps, lift-before-swing, eased reversal), jogging (gating, rates, coast, auto-level, limits, ground guard, jog reset), and the geometry helpers.",
    "why": "Pins the controller behaviour the scene shows."
  },
  {
    "id": "0042",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/armTouch.test.ts",
    "what": "New: 9 tests over stick mapping (up/right positive), dead zone, per-pointer tracking, window fallback, hide-releases, iOS suppression, dispose, null root.",
    "why": "The thumbstick module's contract."
  },
  {
    "id": "0043",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tests/vehicleTouch.test.ts",
    "what": "ARM toggle tests mirroring the MAST ones (tap firing, iOS suppression, setArm/dispose) with #veh-arm in the stub DOM.",
    "why": "Covers the pad-button addition and the tap-toggle refactor."
  },
  {
    "id": "0044",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "tools/browser-check.mjs",
    "what": "Gate arm section: R must start the unfold (elbow joint moves) within 60 s, setArm(false) must stow to all-zero joints with sticks hidden, zero new GPU errors.",
    "why": "Proves the feature end-to-end on real WebGPU within SwiftShader's frame rate."
  },
  {
    "id": "0045",
    "date": "2026-09-24T18:42:23Z",
    "type": "change",
    "pr": 36,
    "branch": "arena/01a0d44b-forge-engine",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "file": "change-log.md",
    "what": "Arm-feature entries plus this self-entry for PR #36.",
    "why": "The log must stay complete as the branch grows."
  }
]
```
