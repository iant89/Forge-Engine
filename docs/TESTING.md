# Test suites and affected runs

The Node test suite uses the repository-local [`selrun`](../packages/selrun/) workspace package. Each unit/integration suite is a `tests/<area>/*.test.ts` file with a leading `@suite` header and an exported `suite` manifest. `tests/full.test.ts` is the ordered source of truth for the complete run; selrun launches each linked suite in its own process, sequentially in that declared order.

## Commands

```sh
npm test                                      # run all linked suites (2 isolated processes at a time)
npm run test:serial                           # run the ordered list sequentially
npx selrun run --all --jobs 4                  # increase bounded concurrency (max 16)
npx selrun run --all --jobs 1                  # force sequential isolated execution
npm run test:affected                         # select from the working-tree change set (fail-safe)
npm run test:affected:print                   # print the working-tree selection, without running it
npm run test:affected -- --explain            # print with transitive, subsystem, and smoke-floor evidence
npm run test:affected -- --base origin/main  # compare origin/main...HEAD only
npm run test:check                            # validate suite headers/manifests, coverage, links, and count
npm run test:audit                            # compare current selected scope; no accuracy claim without outcomes
npm run test:audit -- --mutations FILE        # run true mutation audits against baseline + full suite
npm run typecheck                             # strict engine, examples, and tests typecheck
```

Without `--base`, `affected` includes staged and unstaged changes, deletions, renames, and untracked files. A base comparison is exactly `REF...HEAD`; it deliberately ignores staged, unstaged, and untracked working-tree changes. Renames include both the old and new paths.

Run one suite directly while iterating:

```sh
npx tsx --tsconfig tests/tsconfig.json tests/rendering/frame.test.ts
```

## Suite manifests and coverage

Every suite declares its metadata twice: a leading JSDoc header for reviewers and an exported `suite` object for the catalog. The `@suite`, `@group`, `@desc`, and every individual `@covers` claim must match the export. Coverage is intentionally many-to-many: several suites may cover one source file, and one suite may cover several files. No source file is assigned a single owner, and every listed coverage claim is validated and used independently during selection.

- Suite files live directly under an area directory that exists in this repository. Do not invent area names.
- Use exact repository paths for `@covers`; a glob is available for genuinely broad contracts such as the architecture boundary scan.
- Imports from `@forge/engine` do not expand coverage to every re-exported file. Add the public barrel itself and each implementation file whose behavior the assertions pin.
- A changed suite is selected directly. A changed test-only helper selects suites that statically import it (including through other test helpers). Dynamic imports are not treated as static dependencies.
- Production source changes select suites through explicit `@covers` claims **and** complementary impact evidence (see below).
- Browser and end-to-end smokes remain separate under `npm run check:browser*`; they are not placed in `tests/*.test.ts`.

`npm run test:check` verifies that every discovered suite has one matching header and exported manifest, a unique name, a repository-backed area and at least one valid coverage claim. All current `@covers` claims are counted and validated independently. It also checks that each suite appears exactly once in the literal order in `tests/full.test.ts` and that its `report(n)` equals the number of links. The list's order is intentional and is consumed as written; the controls suites stay last so DOM-oriented tests do not affect earlier suites.

## Fail-safe affected selection (P2)

The selector is designed to **fail safe**: a conservative selector that runs a few extra suites is preferable to a fast selector that misses a regression. The key metric is not how many tests are skipped, but how often the selector misses a test that would have caught a regression (false negatives). False negatives are measured separately from false positives.

### Complementary impact evidence

Selection combines four sources of evidence:

1. **Direct coverage** — `suite.covers` claims that match a changed path (exact or glob).
2. **Transitive dependencies** — the production import graph is built for all `engine/src/**` files. If a suite covers a file whose transitive import closure contains a changed file, it is selected. For example, changing `engine/src/math/transform.ts` selects suites covering `engine/src/animation/mechanical.ts`, `engine/src/scene/world.ts`, and other downstream consumers. Foundation files (transform, vec, mat, double3, coordinateSpace, etc.) are treated as high fan-in and trigger cross-subsystem selection; leaf files only trigger same-subsystem selection to avoid over-selection.
3. **Subsystem mapping** — every file belongs to a subsystem (`engine/src/math/**` → `math`, `engine/src/rendering/**` → `rendering`, etc.). Suites covering the same subsystem as a changed file are selected as complementary evidence. The map lives in `packages/selrun/src/subsystems.mjs` and is intentionally hand-reviewed; a stale map silently under-tests.
4. **Test-only import closure** — changes to `tests/**` helpers select suites that statically import them.

Browser coverage is complementary: if a changed file impacts rendering, scene, or environment subsystems, the CLI warns to run `npm run check:browser` in addition to the Node suite.

### Mandatory smoke floor

Regardless of the selected impact scope, a **smoke floor** always runs:

- `tests/engine/architecture.test.ts` (import boundaries)
- `tests/math/math.test.ts` (foundational math)
- `tests/tools/selrun.test.ts` (selector itself)
- `tests/scene/ecs.test.ts` (core ECS)
- `tests/rendering/pipeline.test.ts` (rendering pipeline)

Even when the affected set is empty (e.g., docs-only changes), the smoke floor runs. It is intentionally small and fast, but broad enough to catch catastrophic regressions.

### Fallback to broader testing

Whenever the change set, dependency graph, or coverage metadata cannot be resolved confidently, the selector **falls back to the full suite** rather than risk under-testing:

- Config changes (`package.json`, `tsconfig*.json`, `.github/**`, `scripts/**`, `vite.config.*`) → full suite.
- Deleted production files with no rename counterpart → full suite (broken import graph).
- Unowned files (no subsystem and no covering suite) → full suite.
- Large change sets (>20 files) → full suite (likely refactor).
- Catalog/coverage metadata errors with a complete ordered link manifest, Git or graph resolution errors → full suite; if the ordered full-suite manifest itself is unreadable, the command aborts with an error instead of guessing.

Renames are handled by retaining both old and new paths; a rename within the same subsystem (e.g., `engine/src/math/old-vec.ts` → `engine/src/math/vec.ts`) is treated as a move, not a deletion.

### Accuracy tracking

`npm run test:audit` compares the legacy direct-only selection with the fail-safe selection for the current change set. It reports conservative expansion only; it does not claim that added suites would catch real regressions.

For outcome-backed accuracy, run mutation audits:

```sh
npm run test:audit -- --mutations packages/selrun/mutations.example.json --jobs 4 --max-mutants 20
```

A mutation entry can use literal, exact-match source replacements or opt into token-aware operator generation. `packages/selrun/mutations.example.json` shows both. Supported operators are `comparison-boundary` (`<`/`<=`, `>`/`>=`), `comparison-swap` (reverse relational/equality comparisons), `boolean` (`true`/`false`, `&&`/`||`), and `arithmetic` (`+`/`-`, `*`/`/`, `%`/`*`). The TypeScript scanner ignores comments and string contents. Operator generation is deterministic and capped at 20 generated mutants by default; override with `--max-mutants`. Optional `startLine`/`endLine` bounds focus generation to a source region. Literal patches are not counted against this cap.

The literal form is an exact-match source replacement:

```json
[
  {
    "name": "clamp lower-bound regression",
    "file": "engine/src/math/scalar.ts",
    "replace": [
      {
        "search": "return value < min ? min : value > max ? max : value;",
        "replacement": "return value < min ? max : value > max ? max : value;"
      }
    ]
  }
]
```

For each mutation, Selrun copies the working tree into a disposable temporary workspace, runs the full suite unmutated to record baseline failures, applies the mutation only to the copy, then runs the full suite again. Newly failing suites are the observed regression detectors; Selrun compares them with the suites the selector would choose for the mutated path. The audit reports caught suites, false-negative suites, and extra selected suites. Pre-existing baseline failures are excluded. A mutant that causes no new full-suite failure is marked **SURVIVED** and is not counted as evidence about selector recall. Exact patches must match exactly once by default. Temporary copies are removed when the audit finishes.

This audit is intentionally opt-in and potentially expensive: it executes the complete suite once for baseline and once per mutant. Suites run with bounded parallelism (default two; set `--jobs N`, maximum 16), and each suite process has a 120-second timeout by default (`--timeout-ms N`). The command exits nonzero if any detectable mutant has a selector miss or if a mutant survives the full suite; inconclusive timeouts/process errors abort rather than being counted as mutation results. Do not use it as the fast per-edit check. For light-weight selector plumbing scenarios, use `auditScenarios()` in `packages/selrun/src/impact.mjs`:

```ts
auditScenarios(catalog.suites, [
  { name: "transform regression", changedFiles: ["engine/src/math/transform.ts"], expectedFailingSuites: ["tests/scene/ecs.test.ts", "tests/rendering/frame.test.ts"] }
])
```

A caught regression means all expected failing suites were selected; a missed scenario is a false negative. Track selection accuracy against the full suite, including deliberately injected regressions, and measure false negatives separately from false positives.

### Testing the selector

The selector itself is tested with:

- Renamed files (both old and new paths retained)
- Deleted files (fallback to full)
- Changed exports and re-exports (via `export * from` and `export {x} from`)
- Shared utilities (high fan-in foundation files vs leaf files)
- Configuration changes (fallback)

See `tests/tools/selrun.test.ts` (direct coverage, import closure, git boundaries) and `tests/tools/selrunImpact.test.ts` (transitive, subsystem, smoke floor, fallback, accuracy).
