# Selective testing — subsystems and affected suites

`npm test` runs every vitest suite. That is correct for a merge to `main`, but during the edit loop it
re-runs ~500 tests to prove that a shader tweak did not break the vehicle solver. This document
describes the machinery that lets you run **only the suites a change can reach**, and how to keep it
honest.

- **Map:** [`tools/test-subsystems.mjs`](../tools/test-subsystems.mjs) — the single source of truth.
- **Runner:** [`tools/affected-tests.mjs`](../tools/affected-tests.mjs) — reads git, selects, runs.
- **Guard:** [`tests/subsystems.test.ts`](../tests/subsystems.test.ts) + `npm run check:testmap`.

## Commands

```sh
npm run test:affected          # run only the suites your working-tree diff can reach + smoke floor
npm run test:affected:print    # print that selection (subsystems, suites, reason) without running
npm run test:all               # force the full suite through the selector
npm run check:testmap          # assert the map has not drifted (fast; also a CI gate)
npm test                       # the full suite, unconditionally
```

The runner also takes flags directly:

```sh
node tools/affected-tests.mjs --base origin/main      # diff against a specific ref
node tools/affected-tests.mjs --all                   # opt-in full run
node tools/affected-tests.mjs --print                 # dry-run: show the plan
node tools/affected-tests.mjs -- --reporter=dot       # forward args after -- to vitest
node tools/test-subsystems.mjs --explain engine/src/rendering/renderer.ts   # what would this select?
node tools/test-subsystems.mjs --list                 # print the whole map
```

## The model

Testing is split into **subsystems**. Each one declares:

- `src`   — the `engine/src` (or `examples/`, `tools/`, `docs/`) paths it owns;
- `tests` — the suites that exercise it;
- `deps`  — the subsystems it is *built upon*, taken from the real relative imports in `engine/src`.

A change to subsystem **X** selects **X and every subsystem that transitively depends on X** — the
suites the change can reach — and nothing else. On top of that, a fixed **smoke floor** always runs.

| Subsystem | Owns (source) | Depends on |
| --- | --- | --- |
| `math` *(foundation)* | `engine/src/math` | — |
| `core` *(foundation)* | `engine/src/core`, `engine/src/debug` | math |
| `gpu` | `engine/src/gpu` | core, math |
| `resources` | `engine/src/resources` | core, gpu, math |
| `scene` | `engine/src/scene` | core, math |
| `environment` | `engine/src/environment` | math, scene |
| `particles` | `engine/src/particles` | gpu, math, rendering, scene |
| `rendering` | `engine/src/rendering` | core, environment, gpu, math, particles, resources, scene |
| `physics` | `engine/src/physics` | core, math, scene, vehicles |
| `vehicles` | `engine/src/vehicles` | math, physics, scene |
| `terrain` | `engine/src/terrain` | core, gpu, math, rendering, scene |
| `examples` | `examples/src` | the engine broadly (integration; the suites are cheap) |
| `docs` | `capabilities.ts`, `ROADMAP.md`, `docs/`, `AGENTS.md` | — |
| `gpuenv` | `tools/gpu-env.mjs`, `scripts/setup-deps.sh` | — |

Some `deps` form cycles (rendering ↔ particles, physics ↔ vehicles); those are real edges in the code
and the closure handles them.

### The smoke floor (always runs)

`math`, `ecs`, `renderGraph`, `frame`, the `architecture` import-boundary guard, and `subsystems`
(this map's own drift test). Cheap fundamentals that catch broad breakage on every selection.

### When selection expands to the full suite

Selection never trades safety for speed silently. It falls back to the **full** suite — printing a
one-line reason — when:

- a **foundation** subsystem changes (`core`, `math`): everything rests on them;
- a **full-run trigger** is touched: the build/test config (`package.json`, `vitest.config.ts`,
  the `tsconfig`s), the public barrel `engine/src/index.ts`, the strict mock device
  `engine/src/testing/`, shared test helpers `tests/support/`, the selection tooling itself, or the CI
  workflow;
- a changed file is **owned by no subsystem** (unknown ⇒ safe).

## Why a hand-written map instead of an import graph

Every suite imports the public barrel `@forge/engine` (AGENTS.md §3: "Public API only from the
demo/tests"). A static import graph therefore cannot tell the rendering suites apart from the physics
suites — they all import the same file. Ownership is declared explicitly instead, in the repository's
registry style (cf. `engine/src/core/capabilities.ts`, `tools/lint-arch.mjs`), and guarded so it can
not silently rot.

## Keeping the map honest

`tests/subsystems.test.ts` (in the smoke floor) and `npm run check:testmap` both fail when the map
drifts: a new suite left unclaimed, a suite claimed by two subsystems, a source path or `deps` id that
no longer resolves, or an `engine/src` directory owned by nobody. **When you add a suite or move a
subsystem's files, update `tools/test-subsystems.mjs`** — CI will not go green otherwise.

## CI

Pull requests run `test:affected` against the PR base commit; pushes to `main` run the full suite as
the safety net. Force a full run on a PR with the `full-test-run` label, a `[full-ci]` token in the
head commit message, or a manual `workflow_dispatch` with `full: true`. See `.github/workflows/ci.yml`.
