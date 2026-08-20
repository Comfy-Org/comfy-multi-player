# Op identity and ordering review

Apply this profile to mint, retry, dedupe, stamps, ordering, and LWW conflict handling. It protects KA-2, KA-4, FC-2, FC-7, and FC-9.

- `op_id` is minted by the creator before dispatch and never regenerated on retry.
- The total ordering key is exactly `[base_version, actor, op_id]`; every replica must evaluate it offline.
- Its first two elements are read out of `op.stamp`, never re-derived from the envelope's `base_version`/`actor`. A test whose ops carry `stamp === [base_version, actor]` cannot distinguish the two readings and does not establish this — flag it. The vectors in `test/ka2-stamp-inside-op.test.ts` are the shape that does: the in-op stamp and the envelope name different winners.
- Resolve conflicts by that stamp, never client-id, arrival order, database read order, or a server sequence alone.
- Verify duplicate `op_id` handling is a true byte-identical no-op. Reuse with different canonical payload/stamp must fail without mutation.
- A server may advance scalar `base_version` for V1, but code and contracts must leave room for a logical clock rather than making the scalar the permanent sole authority.
