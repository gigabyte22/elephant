
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

---

## Addendum: okfVersion 2 (2026-08-13)

An audit of the live vault found the projection correct against its contract
but poor as an artifact. Three measurements drove this pass:

- **59% of vault bytes were frontmatter, 30% was the `summary` key alone.**
  Below `SUMMARY_THRESHOLD_TOKENS` the ingest path stores content verbatim as
  its own summary, and the frontmatter carried the whole thing next to a body
  that repeated it. 522 of 567 files were exact or prefix duplicates.
- **398 of 567 live files (70%) had no graph node.** The sync only ever walked
  graph→disk, so nothing could remove a file whose node was gone.
- **Every filename was a bare UUID, with zero wikilinks and zero index files**
  across 679 documents — the vault was greppable but not browsable.

Shipped:

1. `summary` leaves the frontmatter whenever the body already opens with it;
   otherwise it is clipped to 1000 chars. The cap was chosen from the data —
   only three files in the whole vault had a genuinely distilled summary over
   1 KB, and a tighter cap would have destroyed them to save ~4 KB.
2. Filenames became `{slug}--{id}.md`. The id suffix is not decoration: twenty
   title/directory pairs collide in the live vault.
3. The sync reconciles disk→graph as well, with a parse gate, an mtime gate
   and an empty-graph guard (see SPEC.md). `--dry-run`, `--purge`,
   `--no-reap`, `--no-index` and `--force-reap` on `pnpm okf:sync`.
4. Generated `_index.md` per project bucket, wikilinked and deterministic.
5. `okfVersion` joined the sync hash-gate, which is what migrated the existing
   vault in a single sweep.

Also fixed, and the actual source of the 398 orphans:
`tests/integration/setup.ts` redirected `NEO4J_*` at a throwaway container but
never `OKF_DIR` or `KNOWLEDGE_BLOB_DIR`, both of which default to *relative*
paths. 34 of 35 integration specs were building a real filesystem writer
pointed at the working tree, invisibly, because both directories are
gitignored. The testcontainer isolated the database and nothing isolated the
disk — the filesystem analogue of the incident `tests/integration/guard.ts`
documents.

Still not built: projecting `:Procedure` (a near drop-in — it already carries
`content`, `projectId`, `updatedAt` and `expiresAt`, though its updates rotate
the node id, which a per-id file layout would have to follow) and `:Entity`
hub notes (no scope, no `content`, no `updatedAt` to hash-gate on, so they
need a derived-aggregate projection rather than a per-node one).
