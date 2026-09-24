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
    "date": "2026-09-24T14:06:45Z",
    "type": "pr-merge",
    "pr": 34,
    "branch": "arena/01a0d3b2-forge-engine",
    "base": "main",
    "title": "Fix invisible rover wheels (only wheel_FL rendered)",
    "model": "Arena Agent Mode",
    "modelVersion": null,
    "summary": "All six rover wheels render: fixed the converter's non-rebased wheel indices, repaired the checked-in GLB in place, added a loader warning plus a GLB regression test; also added mnemosyne.md session notes, this change-log.md, and the AGENTS.md convention section.",
    "files": [
      "scripts/convert-perseverance.mjs",
      "examples/assets/Perseverance.glb",
      "examples/src/assets/glb.ts",
      "tests/roverGlb.test.ts",
      "mnemosyne.md",
      "change-log.md",
      "AGENTS.md"
    ]
  }
]
```
