---
title: "Elephant: changing the embedding model"
tags: [elephant, embeddings, procedure, reembed]
---

Every stored vector in Elephant (facts, episodes, chunks, documents, entities, ...) was produced by one embedding
model at one dimension. Vectors from two different models are not comparable even at the same dimension, and a
Neo4j vector index only accepts vectors of the size it was created with. So the embedding model is pinned:

- `EMBED_DIM` sizes every vector index when the migration first creates it.
- The migration records the model and dimension on `(:SystemState {key:'embedding'})`, as
  `<provider>:<model>` (for example `openai:text-embedding-3-large`, `ollama:nomic-embed-text`, `voyage:voyage-3`).
- At every start the service compares the configured embedder (`MEMORY_EMBED_PROVIDER` + model + `EMBED_DIM`)
  with that record and **refuses to start** on any difference.

`GET /health` shows both sides: `embedModel` (configured) vs `schemaEmbedModel` (stored), and `embedder.dim`
(configured `EMBED_DIM`) vs `schemaVectorDim` (read from the `fact_vectors` index).

## Symptom of an accidental change

After someone edits the embedder settings (directly or via `ELEPHANT_EMBED_*` / `ELEPHANT_OPENAI_EMBED_MODEL` /
`ELEPHANT_OLLAMA_EMBED_MODEL` in `stack.env` + `bin/stack configure`), `elephant.service` restarts every 5 s. The
journal shows the migration warning
`[migrate] WARNING: The configured embedder does not match the stored vectors: model ... (graph has ...)` followed
by `[serve] fatal: Error: The configured embedder does not match the stored vectors ...`. The fix is either to put
the previous settings back (then `bin/stack configure` if they came from `stack.env`, and restart), or to
re-embed deliberately with the procedure below.

A different failure: `EMBED_DIM` that does not match what the model actually returns. Elephant does not
measure the model; it trusts `EMBED_DIM` (and does not ask OpenAI for a reduced size), so the service starts, but
the vectors it writes do not fit the indexes: depending on the Neo4j version such writes fail or the nodes are
silently left out of vector search, and recall degrades to full-text only. `pnpm reembed --dry-run` detects it
with its probe (`... returned a N-dim vector but is configured for M; fix EMBED_DIM first`). Set `EMBED_DIM` to
the model's real output size, for example nomic-embed-text 768, mxbai-embed-large 1024,
text-embedding-3-small 1536, text-embedding-3-large 3072. Note that the built-in defaults
(`text-embedding-3-large` with `EMBED_DIM=1536`) do not agree with each other, so always set both.

## Procedure: switch to a new embedding model

Run as `cerebro`. The re-embed calls the new model once per stored text, so it takes a while on a big graph,
and recall is wrong while vectors are mixed.

1. Stop the service so nothing writes or recalls meanwhile:
   `cd /home/cerebro/cerebro-stack && bin/stack down elephant` (Neo4j stays up).
2. Back up the graph: `cd /home/cerebro/stack/elephant && python3 scripts/backup-neo4j.py`.
3. Configure the new embedder. In the stack, set `ELEPHANT_EMBED_PROVIDER`, the model variable
   (`ELEPHANT_OPENAI_EMBED_MODEL` or `ELEPHANT_OLLAMA_EMBED_MODEL`, plus base URL/key if needed) and
   `ELEPHANT_EMBED_DIM` in `stack.env`, then `bin/stack configure`. (Without the stack, edit
   `MEMORY_EMBED_PROVIDER`, `OPENAI_EMBED_MODEL`/`OLLAMA_EMBED_MODEL`, `EMBED_DIM` in `.env`.)
4. Preview: `cd /home/cerebro/stack/elephant && pnpm reembed --dry-run`. It prints the vectors per label, whether
   the vector indexes will be dropped and recreated (only when the dimension changes), and probes the new model
   once to confirm its dimension.
5. Run it: `pnpm reembed --yes` (optional `--batch=<n>`). Each label is re-derived from the same text its writer
   embedded (fact content, episode summary, chunk text, `key: value` for preferences, entity name, ...). Items
   with no source text have their vector removed. On a dimension change the vector indexes are dropped first
   and recreated at the new size afterwards. The stored model record is updated **last**. Success ends with
   `[reembed] done: N vector(s) re-embedded, M with no source text removed`.
6. Start it: `bin/stack up elephant`. Check `curl -s http://127.0.0.1:18790/health | jq .data` shows
   `schemaEmbedModel == embedModel` and `schemaVectorDim == embedder.dim`, then try a recall.

If the run is interrupted, the old model stays on record, the service keeps refusing to start, and you simply
run `pnpm reembed --yes` again from the start.

## Notes

- Changing the LLM (`MEMORY_LLM_PROVIDER`, extraction/dreaming models) needs no re-embed; only a restart.
- The embedder serves every write and every recall query (one embedding per query), so a slow or unreachable
  embedding endpoint makes writes and recall slow or failing, even though no LLM is involved.
- The embedder retries transient errors itself; a persistent failure surfaces as 500s on writes and recall.
