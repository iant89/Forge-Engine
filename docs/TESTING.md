# Test suites and affected runs

The Node test suite uses the repository-local [`selrun`](../packages/selrun/) workspace package. Each unit/integration suite is a `tests/<area>/*.test.ts` file with a leading `@suite` header and an exported `suite` manifest. `tests/full.test.ts` is the ordered source of truth for the complete run; selrun launches each linked suite in its own process, sequentially in that declared order.

## Commands

```sh
npm test                                      # run all linked suites
npm run test:serial                           # run the ordered list sequentially
npm run test:affected                         # select from the working-tree change set
npm run test:affected:print                   # print the working-tree selection, without running it
npm run test:affected -- --base origin/main   # compare origin/main...HEAD only
npm run test:check                            # validate suite headers/manifests, coverage, links, and count
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
- Production source changes select suites only through explicit `@covers` claims. Production import closure is never used to infer suite ownership.
- Browser and end-to-end smokes remain separate under `npm run check:browser*`; they are not placed in `tests/*.test.ts`.

`npm run test:check` verifies that every discovered suite has one matching header and exported manifest, a unique name, a repository-backed area and at least one valid coverage claim. All 653 current `@covers` claims are counted and validated independently. It also checks that each suite appears exactly once in the literal order in `tests/full.test.ts` and that its `report(n)` equals the number of links. The list's order is intentional and is consumed as written; the controls suites stay last so DOM-oriented tests do not affect earlier suites.
