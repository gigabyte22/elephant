
---

## As-built addendum (2026-07-20)

Shipped as four milestones (see SPEC.md "OKF vault" section for the contract):

1. Research retains full `content` on-node and returns it via the API (the
   "first fix" above).
2. `PUT /research/:id` with `:ArchivedRevision` snapshots via `revise()`;
   no `:SUPERSEDES` clone; `projectId`/`userId` immutable.
3. Research bodies chunk into `:ResearchChunk` nodes (separate label +
   vector/fulltext indexes; parent-liveness guard) fused into recall as
   `researchChunks[]`. Implemented via shared chunk-repository and
   chunk-source-stage factories instantiated for both Knowledge and Research.
4. OKF vault: one-way projection — content **on-node is the source of
   truth**, the vault is a derived markdown layer (option A/B hybrid).
   Log-and-continue after commit; `_trash/` tombstones; `pnpm okf:sync`
   backfill/repair/expiry-tombstoner.

Deliberately not built (future work): round-trip vault import (Phase 3),
procedures-as-runbooks in the vault, raw-markdown HTTP responses (would
break the `{ok,data}` envelope — the vault IS the markdown surface).
