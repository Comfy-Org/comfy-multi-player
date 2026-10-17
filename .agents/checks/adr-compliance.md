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

The template sections are recommendations. Do not report a finding solely
because an ADR omits or renames Context, Decision, Alternatives considered, or
Consequences. Review whether the record preserves enough rationale and impact
to be useful for its specific decision.

<!-- coderabbit-instructions: {src/**,docs/adr/**} -->
```text
Treat accepted ADRs in docs/adr/ as constraints and proposed ADRs as directional guidance. For source changes, read the decisions relevant to the affected op, state, replication, API, ordering, validation, or distribution surface. Flag only contradictions introduced by this diff, cite the full ADR identifier, and distinguish a conflict with an accepted record from disagreement with a proposal. If the diff establishes a durable architecture boundary, changes an invariant, chooses among viable system designs, or creates compatibility or migration policy without recording the tradeoff in docs/adr/, ask for an ADR. Do not demand an ADR for implementation detail, transient evidence, tests, or routine maintenance. Context, Decision, Alternatives considered, and Consequences are recommended prompts, not required headings; do not fail an ADR solely because one is omitted or renamed. Review whether rationale, impact, compatibility, and supersession are concrete and mutually consistent for the decision at hand.
```
<!-- /coderabbit-instructions -->
