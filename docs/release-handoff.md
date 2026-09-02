# Cross-repository release handoff

Changes to `@comfyorg/comfy-multi-player` flow to cloud before frontend exposure:

```text
cmp merge + immutable release
  -> cloud pin + tests + dark deploy + runtime proof
  -> frontend pin + tests + flag-off deploy
  -> flags on + authenticated browser canvas/reconnect proof
  -> stable promotion of the exact tested combination
```

The package release is the producer gate. Run the repository's full package gates, publish an
immutable npm version when consumers use npm, and prove a clean install resolves it. Never hand off
a moving branch or an unpublished version. An explicitly approved Git dependency must use a full
commit SHA.

Both consumers must resolve the same accepted package version. Cloud compatibility comes first so
the frontend never emits or requires a contract the deployed doc-host cannot handle. Deployment is
not proven by a green build: the handoff needs the running cloud revision, resolved package version,
doc-host health, readable schema, catalog pin, and request/frame behavior.

After the frontend consumer deploys with exposure off, QA records exact frontend/cloud revisions,
package version, and flag values. Acceptance requires an authenticated browser flow that causes a
visible canvas edit and survives reconnect. Expand the `agent-in-app-experience` cohort only after
that receipt. `AGENT_CRDT_MODE` plus `workflows.crdt_enabled` selects the storage path; it is not the
product flag.

Documentation-only changes may proceed in parallel. Runtime PR sets must link their producer and
consumer PRs and identify the release coordinator, cloud deploy verifier, frontend deploy verifier,
and QA receipt owner.

## Glossary

- **Dark deploy:** compatible code deployed while user exposure is disabled.
- **Integrated receipt:** exact revisions, package version, flags, and browser-visible proof.
- **Producer gate:** the merged and installable package release consumers are allowed to pin.
