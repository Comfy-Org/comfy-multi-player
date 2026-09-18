# ADR-006: Publish to npm; consumers pin exact published versions

**Status:** Accepted
**Date:** 2026-08-22
**Invariant:** KA-1, FC-3 (both hosts run the *same* applier bytes)
**Supersedes:** ADR-004

## Context

ADR-004 chose immutable git-SHA dependencies while the package contract was
stabilizing and no registry release existed. The package is now published to
npm as `@comfyorg/comfy-multi-player@0.1.0`, so consumers no longer need a git
checkout or an install-time `prepare` build.

At this decision's 2026-08-22 acceptance, `0.1.0` was the published release.
The repository manifest is currently version `0.2.1` with the
`GPL-3.0-only` license; this current-state note does not announce or perform a
new npm release.

All three consumers use the registry release: ComfyUI frontend, the cloud
`services/agent/dochost` sidecar on `main`, and the `examples/dochost` example
merged in PR #27. Git-SHA pinning has therefore been retired in practice.

## Decision

Publish `@comfyorg/comfy-multi-player` to the npm registry and have every
consumer pin an exact published version. At acceptance, the shared published
version was `0.1.0`; the repository manifest is currently `0.2.1`.

Version updates remain explicit, reviewable changes in each consumer. The
frontend, cloud doc-host, and examples MUST use the same exact package version
where they rely on identical applier behavior (ADR-001).

## Consequences

- Package updates flow through normal npm semantic-version pins and lockfile
  updates rather than git-SHA dependency changes.
- Exact pins preserve the lockstep behavior required by KA-1 / FC-3; consumers
  do not use version ranges for the shared applier.
- Publishing a new version is an explicit maintainer action with its own
  cadence, separate from merging repository changes.
- The repository manifest and `LICENSE` now identify the package as
  `GPL-3.0-only`; the earlier pending `0.1.1` license-metadata plan is historical
  and no longer current.
- Consumers install the prebuilt registry artifact and no longer need to allow
  this package's git-dependency `prepare` script.

## Alternatives considered

- **Keep pinning git SHAs:** rejected because the published package removes the
  consumer build and git-auth requirements while exact versions retain
  deliberate lockstep upgrades.
- **Use semver ranges:** rejected because independent resolution could put the
  browser and host on different applier versions and violate FC-3.
- **Vendor a prebuilt copy into each consumer:** rejected because it creates a
  second source of truth that can drift from the published package.
