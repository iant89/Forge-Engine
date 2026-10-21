# Forge Engine deprecation and removal policy

Deprecation is a migration tool, not a warning-shaped breaking change. A consumer must have a clear
replacement, enough time to move, and a release in which the old contract still works.

## What can be deprecated

An approved package-root export, a public member, an option, a serialized field, an extension
registration, or a documented runtime behavior can be deprecated. Internal symbols do not need a
public deprecation window because they were never supported. Experimental symbols may change under
the experimental policy, but their release notes still name migration actions when practical.

Every deprecation must include:

- the version in which it became deprecated (`@deprecated since X.Y` or the equivalent release-note
  entry);
- the replacement or a statement that there is no replacement;
- the reason and any behavior difference that matters to callers;
- a migration example in the relevant guide/reference page;
- a test that keeps the old path working for the declared window.

The API audit rejects an empty `@deprecated` explanation. Reviewers also reject a deprecation that
cannot be found in the migration/reference documentation.

## Minimum window

A stable API is retained for **at least two minor releases and six months**, whichever is longer,
after the first stable release that marks it deprecated. The clock starts at the published release,
not at the merge date. A patch release may fix a deprecated API, but may not remove it or silently
change its required arguments.

A removal can happen only in the next major release after that minimum window. The release notes and
migration guide must name the removal, and the API approval ledger must record the reviewed removal.
If the window was not met, the old path remains or the major release is delayed.

A security, legal, or unrecoverable platform issue may require an emergency exception. Such an
exception needs an explicit release-note explanation, a replacement or mitigation, and maintainer
review; it is not a general shortcut around semver.

## Runtime and type behavior

During the window:

- the old type/value is still exported from `@forge/engine`;
- the old runtime operation keeps its documented behavior unless a bug fix is required;
- warnings are opt-in or diagnostic and must not spam a render/update loop;
- serialization readers accept old data while writers use the replacement format when safe;
- extension hosts keep resolving the old registration until the removal major.

The deprecation annotation, runtime warning, or release note never makes a deep import supported.

## Review and release bookkeeping

For each deprecation, reviewers update the root API snapshot/approval row, the documentation, the
migration guide, the changelog, and the test. The release checklist records the deprecation date,
the earliest eligible removal release, and the actual removal release. A deprecation is not complete
when a comment is added; it is complete when a consumer can follow the replacement without reading
engine internals.

Current 1.0 status: no approved top-level export is deprecated. This is intentional; the 0.x-to-1.0
migration is documented as a release migration rather than disguising 0.x compatibility gaps as
runtime deprecations.
