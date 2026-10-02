---
title: "Elephant: how recall works"
tags: [elephant, memory, recall, retrieval]
---

`GET /recall?q=<text>` is the hot path: it turns a natural-language query into a ranked, scoped set of facts
(plus preferences, insights and, on request, other categories). It makes **no LLM call** unless you opt into
reranking or the PageRank recognition filter; the only model call by default is embedding the query.

## The pipeline, at behaviour level

Recall runs about 28 small stages strictly in order:

1. **Prepare**: embed `q` once.
2. **Sources**: query each index separately. Facts by vector and by full text; episode chunks by vector and full
   text; preferences, insights by vector; observations (opt-in, needs `sessionId`); knowledge chunks, procedures,
   research and research chunks, intentions (each opt-in). Vector searches over-fetch (`limit` x
   `RETRIEVAL_OVERFETCH_MULTIPLIER`, default 3) and, because a Neo4j vector query returns the global top-K before
   any scope/time filter runs, widen K adaptively (up to `RETRIEVAL_ANN_MAX_K` 2000, growth x4, 3 attempts) when
   too few rows survive. A historical `asOf` over-fetches another x4. A source that still cannot fill the limit is
   marked "starved" in the trace and logged as a warning.
3. **Chunk -> fact projection**: facts derived from matching episode chunks join the candidate set.
4. **Personalized PageRank** (opt-in, HippoRAG style): seeds from top facts and query-linked entities and walks
   the entity graph (`:HAS_FACT`, `:RELATES`, `:SYNONYM`). Needs the GDS projection the dream cycle refreshes
   when `RETRIEVAL_ENABLE_PPR=true`; otherwise a no-op.
5. **RRF fusion**: each source contributes `1/(k + rank)` with `k = RETRIEVAL_RRF_K` (60). Ranks, not raw
   scores, are fused, because cosine and BM25 scores are not comparable.
6. **Expansions**: entity siblings (other facts of the same entities, budget `RETRIEVAL_SIBLING_BUDGET` 20,
   damped x0.5) and neighbouring chunks (`chunkNeighborRadius`, 1-3).
7. **Post-filter**: scope modes, `kinds`, valid-time (`asOf`, `from`/`to`), `minImportance`, `minConfidence`,
   superseded/redacted facts.
8. **Blended scoring** for facts:
   `0.5 x normalized RRF + 0.2 x importance + 0.1 x confidence + 0.1 x recency + 0.1 x reference count`
   (weights `RETRIEVAL_WEIGHT_*`, must sum to 1.0; recency half-life `RETRIEVAL_RECENCY_HALF_LIFE_DAYS` 30, on
   transaction/access time). Then scope boosts multiply (project x1.2, user x1.1, own agent x1.15, same session
   x1.05). Facts reached only by chunk projection are damped x0.8.
9. **LLM rerank** (opt-in): a listwise rerank of the top `RETRIEVAL_RERANK_TOP_K` (20), keeping
   `RETRIEVAL_RERANK_KEEP_K` (10). Skipped if the LLM adapter has no rerank method.
10. **Top-K**, **hydrate entities**, and **reference tick**: every returned fact gets `referenceCount + 1` and a
    fresh `lastReferencedAt`, which is what keeps recalled memories from being pruned.

Every optional step (PPR, GDS, rerank) turns into a no-op on failure instead of failing the request.

## Query parameters

| Param | Default | Meaning |
|---|---|---|
| `q` | required | query text |
| `limit` | 20 (max 100) | facts returned |
| `projectId`, `userId`, `agentId`, `sessionId` | none | scope values; mode `boost` when given |
| `projectScope`, `userScope`, `agentScope`, `sessionScope` | inferred | `boost`/`filter`/`strict`/`shared`/`none` (see *Elephant: memory scopes*) |
| `includePreferences`, `includeInsights` | on | set `false` to omit |
| `includeChunks` | off | return raw episode chunks as context |
| `includeKnowledge`, `includeProcedures`, `includeResearch`, `includeIntentions` | off | opt into those categories (costs extra vector queries) |
| `includeObservations` | off | session working memory; **400** without `sessionId` |
| `kinds` | all | comma list of `episode,chunk,fact,preference,insight,observation,knowledge_document,knowledge_chunk,procedure,research,research_chunk,intention`; a post-filter only, it does not switch on an opt-in category |
| `asOf` | now | valid-time instant for facts and preferences |
| `from`, `to` | - | fact valid interval must overlap this range |
| `includeSuperseded` | false | also return closed facts |
| `minImportance`, `minConfidence` | - | 0-1 floors |
| `entityId` | - | restrict to one entity's subgraph |
| `rerank`, `ppr` | env | per-request override of `RETRIEVAL_ENABLE_RERANK` / `RETRIEVAL_ENABLE_PPR` |
| `chunkNeighborRadius` | 1 | 1-3 |
| `debug` | false | adds `trace`: per-stage timings, fusion detail, source diagnostics |

Booleans accept `true/1/yes/on`; anything else is false.

## The response

`{ok:true, data:{facts:[...], entities?, chunks?, preferences?, insights?, knowledgeChunks?, procedures?,
research?, researchChunks?, intentions?, observations?, trace?}}`. Each fact carries `content`, `importance`,
`confidence`, `validFrom`/`validTo`/`recordedAt`, entity ids, scope, `refCount`, origin agent/session, `score`
and, when there was a vector hit, `vectorScore`, plus `expansionReason` (for example `fact_vector`,
`entity_sibling`, `chunk_derived`, `entity_ppr`, `rerank`). Knowledge chunks carry `derivation`: `verbatim`
(the source's own words) or `model` (OCR, transcription or an image description written by a model).

**Rank on `score`, threshold on `vectorScore`.** `score` is normalized within one result set: the top hit of a
poor query scores about the same as the top hit of a great one, so it cannot tell you "nothing relevant was
found". `vectorScore` is the raw similarity and is comparable across queries; its useful cut-off depends on the
embedding model. It is absent (not 0) for full-text-only hits and expansions.

## Examples

```bash
TOKEN=$(sed -n 's/^MEMORY_SERVICE_TOKEN=//p' /home/cerebro/stack/elephant/.env)
E=http://127.0.0.1:18790
# Facts about a topic for one user, shared items included
curl -s -H "Authorization: Bearer $TOKEN" "$E/recall?q=travel+plans&userId=alice&userScope=filter&limit=10" | jq '.data.facts[] | {content, score, vectorScore}'
# Include knowledge documents and procedures, with a timing trace
curl -s -H "Authorization: Bearer $TOKEN" "$E/recall?q=how+to+back+up&includeKnowledge=1&includeProcedures=1&debug=1" | jq '.data.trace'
# What was believed on a past date
curl -s -H "Authorization: Bearer $TOKEN" "$E/recall?q=employer&asOf=2026-03-01T00:00:00Z" | jq
```

## Related read routes

- `GET /timeline?at=<iso>[&entityId=&preferenceKey=&limit=]`: exhaustive valid-time snapshot, no ranking.
- `GET /entities?name=<text>`: fuzzy entity lookup; `GET /entities/:id`: one entity and its facts.
- `GET /facts/:id`: one fact in the same shape recall returns.
