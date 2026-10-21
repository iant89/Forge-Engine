# Forge Engine 1.0 versioning and release policy

This is the consumer contract for `@forge/engine`. It applies to the package root and to every
export approved by the root-only API audit. The policy is intentionally boring: a game should be
able to upgrade the engine without guessing whether a patch release changed a declaration, a shader
binding, or a save format.

## Semantic versioning

Forge follows [Semantic Versioning 2.0.0](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **Major**: an incompatible change to an approved public type, value, runtime behavior, serialized
  format, shader/resource contract, or supported browser/runtime requirement. Removing an export,
  changing a required parameter, changing a return invariant, and changing deterministic simulation
  results in a supported scenario are major changes.
- **Minor**: a backwards-compatible public addition, an optional parameter/member, a new supported
  extension registration, or a new opt-in capability. Existing callers must keep compiling and
  preserve their documented behavior.
- **Patch**: a backwards-compatible bug fix, documentation correction, test/tooling change, or
  performance improvement that does not intentionally change an observable contract.

The version number is not a promise that every GPU driver produces identical pixels. It is a promise
about the documented API and the supported deterministic contracts. A driver workaround may ship in a
patch when it preserves the public result and is covered by the browser verification gate.

### 0.x to 1.0

Before 1.0, the package was `0.1.x`. The completed Phase 27.1 audit approved the existing root
surface, but it did not make 0.x compatibility a promise. The 1.0 release is the first version at
which the public approval ledger, declaration contract, examples, migration guide, deprecation
window, and extension API are all release gates. See [MIGRATION-1.0.md](MIGRATION-1.0.md).

The nine WASM-physics state/memory seam exports remain explicitly experimental. They are excluded from
normal 1.0 compatibility guarantees until their status changes in the API audit and release notes.

## One source of version truth

The following values must be identical for a release:

1. the repository `package.json` version;
2. `engine/package.json` version;
3. the `VERSION` value exported from `@forge/engine`;
4. the `packageVersion` in `engine/api-surface.json`;
5. the version recorded in `package-lock.json` for the root and `@forge/engine` workspace.

`npm run api:check` rejects package/export/snapshot disagreement. The release checklist also checks
that the package tarball contains the same declaration and runtime version.

## Public surface and compatibility review

Only the package root, `@forge/engine`, is supported. Deep source paths are implementation details.
Every public candidate must have an approval row with the exact direct declaration and transitive
contract fingerprints. A public API change requires, in order:

1. update or add consumer-facing documentation and a runnable example when appropriate;
2. add or update behavioral/type tests;
3. review the semver classification and deprecation impact;
4. update `engine/api-surface.json` deliberately with `npm run api:update`;
5. update the approval ledger and review record;
6. run `npm run api:check`, the typecheck, the full test catalog, and the release gates.

A regenerated snapshot is evidence of a change, not approval of a change.

## Release process

A release is cut only from a clean branch after the following checklist is green:

- `npm run typecheck`;
- `npm run test` and `npm run test:check`;
- `npm run api:check`, `npm run lint:arch`, and `npm run docs:check`;
- `npm run check:wgsl` and the applicable browser/demo build gates;
- package version consistency and a dry-run package inspection;
- the migration, reference, examples, deprecation, and extension documents are linked from the
  package README or repository API guide;
- release notes name user-visible changes, migration actions, experimental changes, and known
  limitations.

The release commit changes all version-of-truth locations together. A release tag is `vX.Y.Z`, and
an npm dist-tag is selected explicitly (`latest` for a stable 1.x release, `next` for a prerelease).
A failed release is not repaired by republishing the same version: increment the appropriate version,
record the reason, and repeat the gates.

## Supported upgrade path

Within a major line, consumers should be able to upgrade one minor at a time, but skipping minors is
supported when the migration notes for every skipped minor are read. A major release ships a migration
guide before the tag and keeps the previous major's final documentation available. The extension API
has its own `apiVersion`; an extension may reject a host with an incompatible extension API before it
registers anything.

## What this policy does not promise

It does not promise support for deep imports, undocumented internals, experimental exports, arbitrary
browser implementations without WebGPU, or assets whose format is not listed as supported. It also
does not turn implementation details into public API merely because TypeScript can infer them.
