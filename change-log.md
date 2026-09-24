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
  }
]
```
