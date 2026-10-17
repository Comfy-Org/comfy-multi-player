# ADR compliance

Treat accepted records in `docs/adr/` as architectural constraints. Treat
proposed records as review guidance. Read the decision and consequences for
every record relevant to the changed surface, and report only contradictions
introduced by the diff. Cite the full semantic identifier in every finding.

An architecture change needs an ADR when it establishes a durable boundary,
changes an invariant, chooses among viable system designs, or creates a
compatibility or migration policy. Implementation detail, transient test
evidence, and routine maintenance do not need ADRs. A deliberate deviation from
the package invariants still belongs in `docs/decisions/EXCEPTIONS.md`.

<!-- coderabbit-instructions: {src/**,docs/adr/**} -->
```text
Treat accepted ADRs in docs/adr/ as constraints and proposed ADRs as directional guidance. For source changes, read the decisions relevant to the affected op, state, replication, API, ordering, validation, or distribution surface. Flag only contradictions introduced by this diff, cite the full ADR identifier, and distinguish a conflict with an accepted record from disagreement with a proposal. If the diff establishes a durable architecture boundary, changes an invariant, chooses among viable system designs, or creates compatibility or migration policy without recording the tradeoff in docs/adr/, ask for an ADR. Do not demand an ADR for implementation detail, transient evidence, tests, or routine maintenance. For ADR files, verify that context, decision, alternatives, consequences, compatibility impact, and supersession links are concrete and mutually consistent.
```
<!-- /coderabbit-instructions -->
