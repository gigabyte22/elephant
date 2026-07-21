# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Elephant is a Neo4j-backed long-term memory service for agent orchestrators. Neo4j is the *only* datastore — its native vector, full-text, and temporal support replace a separate vector DB, SQL layer, and queue. Orchestrators POST raw conversation **episodes**; a scheduled "dream" cycle extracts **facts**/**preferences**, links them to **entities**, promotes **insights**, and prunes along a decay curve. `GET /recall` fuses vector + full-text (+ optional PageRank) results.

## Commands

```bash
pnpm install
docker compose up -d neo4j      # Neo4j 5.26 + APOC + GDS plugins
pnpm migrate                    # idempotent schema (constraints + vector/fulltext indexes)
pnpm --filter @elephant/web build   # dashboard must be built before it will serve
pnpm serve                      # or `pnpm dev` for watch mode

pnpm test                       # unit only, no Docker
pnpm test:integration           # Neo4j testcontainer, needs Docker
pnpm typecheck                  # tsc --noEmit
pnpm lint / pnpm lint:fix       # biome
pnpm dream                      # run one dream cycle now
pnpm okf:sync                   # backfill/repair the markdown vault
```

Single test: `pnpm vitest run tests/unit/decay.test.ts -t "name"`. For integration you **must** keep the config: `pnpm vitest run --config vitest.integration.config.ts tests/integration/dashboard.test.ts`.

**Never run integration specs with a bare `vitest run` or `bun test`.** They `DETACH DELETE` everything, and without `vitest.integration.config.ts` the connection points at whatever `.env` says — i.e. the live database. This wiped the production graph once (2026-06-09, no backup); `tests/integration/guard.ts` exists so it can't recur.

Dashboard dev: `pnpm --filter @elephant/web dev` (Vite on :5173, proxies `/dashboard/api` → :18790). Python adapter tests: `cd adapters/hermes && uv run --with pytest pytest -q`.

## Layout

pnpm workspace: root (the service) + `web` (React dashboard) + `packages/client` + `adapters/mcp` + `adapters/openclaw`. `adapters/hermes` is Python and deliberately *not* a workspace member.

Node ≥22, ESM, `tsx` at runtime — **no build step for the backend**. Imports carry explicit `.ts` extensions (`allowImportingTsExtensions`). Biome, not ESLint/Prettier: single quotes, semicolons, 100 cols, 2-space indent.

## Architecture

**Composition root.** `src/index.ts` builds the whole dependency graph from env: `bootstrap()` → `verifyConnectivity()` + `buildContainer()`. Services are closure factories (`createXService(deps)` returning an object literal, `export type XService = ReturnType<typeof createXService>`) — almost no classes. `ContainerOverrides` (llm, embedder, retrievalPipeline, workingStateAdapter, vault) is the test seam, paired with `src/adapters/fakes.ts`. Boot asserts `embedder.dim === env.EMBED_DIM`, because `EMBED_DIM` is baked into vector-index DDL at migrate time.

**HTTP** (`src/http/`). Fastify + `fastify-type-provider-zod`. Routes are plain `registerXRoutes(app, container)` functions — no plugin encapsulation. `src/http/types.ts` exports `App` (a `FastifyInstance` pinned to `ZodTypeProvider`), which is what makes `req.query`/`req.body` inferred from each route's Zod schemas. Registration order matters: all API routes register before the dashboard static handler so the SPA fallback can't shadow them.

Every response is `{ ok: true, data } | { ok: false, error }` per EXPECTED.md. Handlers return the success shape literally; errors throw `HttpError` via `notFound`/`badRequest`/`conflict`/`payloadTooLarge` and `errorHandler` maps them. Schemas live in `src/http/wire-schemas*.ts`; domain→wire mappers in `src/models/wire.ts` strip embeddings and ISO-ify dates.

Auth is one global `preHandler` (`src/http/auth.ts`) comparing a bearer token, exempting `/health` and any `/dashboard*` path that isn't `/dashboard/api/*` — so the SPA shell loads before the user pastes a token, but data doesn't.

**Neo4j access** (`src/repositories/`). Repositories never own sessions. `src/config/neo4j.ts` holds the singleton driver and exports exactly two entry points, `read(work)` and `write(work)`, which run managed transactions. Every repository method is a static object method taking `tx: ManagedTransaction` first: `await read((tx) => FactRepository.get(tx, id))`. That's what lets a service compose several repo calls into one atomic transaction and lets `AuditService.revise({tx, ...})` join the caller's.

Dates pass as ISO strings wrapped by `datetime($x)` in the Cypher (`src/utils/neo4j-conv.ts`). `chunk-repository-factory.ts` generates the Knowledge/Research chunk repos from one config — they keep separate labels and indexes because Neo4j vector queries can't pre-filter, so a shared index would shrink effective top-K.

**Retrieval** (`src/services/retrieval/`). A `RetrievalStage` is `{ name, run(ctx, state) }`; `composePipeline` runs ~28 of them strictly sequentially, timing each (parallelism belongs *inside* a stage). Order in `pipeline.ts`: prepare query → source stages (one per index; the v1.2 knowledge/procedure/research sources early-return unless the caller opted in) → chunk→fact projection → PPR → **RRF fusion** (`1/(k+rank)`, k=60 — dense cosine and BM25 scores aren't comparable, ranks are) → expansions → post-filter → blended scoring → optional LLM rerank → topK → hydrate → refcount tick.

That last stage closes a loop with pruning: recall bumps `referenceCount`, and `src/utils/decay.ts` keeps frequently-recalled facts alive (Ebbinghaus retention, strength scaled by refCount and importance). Every optional path — PPR, GDS projection, rerank — degrades to a no-op on failure rather than erroring the request.

**Dreaming** (`src/services/DreamingService.ts`, the densest file). Guarded by an `AsyncMutex` (concurrent trigger → 409). Uses a persistent cursor, not "last run time", so a deadline-boxed run resumes mid-backlog; the cursor advances past *failed* episodes so a poisoned one can't pin it. Per episode: extract → embed → dedup by cosine → persist → supersede-detect. Then, only if the deadline held: entity resolution, consolidation, insight promotion, prune. Sub-passes are individually try/caught — facts are already committed, so a late failure must not fail the cycle.

**Adapters** (`src/adapters/`). Selection is a plain env switch in `factory.ts` — no registry. Interfaces per subdir in `types.ts`, implementations are `createXAdapter(config)` closures. Optional interface methods are load-bearing: `LlmRerankStage` checks `typeof llm.rerank === 'function'` and no-ops, so a local llama.cpp backend degrades gracefully. `vault` returns `undefined` unless `OKF_ENABLED` (nullable dependency, not a null object). Extraction is MIME-routed rather than a single choice.

**Config** (`src/config/env.ts`). One Zod schema, ~90 vars, memoized `loadEnv()`. Use `boolEnv()`, never `z.coerce.boolean()` — `Boolean("false") === true` would make every opt-out flag impossible to disable. The same footgun is handled again by `queryBool` for query params. A `.superRefine` does cross-field validation (provider↔key pairing; retrieval weights must sum to 1.0 ±0.01).

**Jobs** (`src/jobs/`). Three croner schedulers, all `startXScheduler(container) => { stop, pattern }` with `protect: true`. `scripts/serve.ts` starts them and drains them on SIGTERM. The OKF sweep is staggered 30 min off the dream cron because both hit the same driver pool.

## Conventions

- **IDs**: `newId()` = UUIDv7 everywhere. Time-ordered and sortable, so creation order is reconstructable without a separate timestamp index.
- **Nothing is hard-deleted.** Deletion sets `validTo = now`. Mutating writes to Fact/Preference/Procedure/KnowledgeDocument/Research route through `AuditService`, which snapshots an `:ArchivedRevision` and appends an `:AuditEvent` inside the caller's transaction.
- **Scope** has four axes (`projectId`, `userId`, `agentId`, `sessionId`) and four modes (`boost` default when a value is given, `filter`, `strict`, `none`), applied at three layers: write (`memoryItemSetClause`), query (`scopeFilterClause` splices Cypher predicates), and scoring (`scopeBoostMultiplier` + `PostFilterStage.axisAllows`). The subtle part is in `axisAllows`: `filter` excludes only cross-scope items since a null scope means shared/global, while `strict` also excludes nulls.
- **Two error regimes.** Request path: throw typed `HttpError`, let the handler build the envelope. Background/best-effort paths: catch, log, continue.
- **Layering**: `src/` never imports from `scripts/`. That's why `vault/sync.ts` lives in `src/adapters/` despite a CLI being its main caller.
- **Migrations aren't versioned.** `src/migrate.ts` is a flat list of `IF NOT EXISTS` statements applied in order, imported by both the CLI and the integration setup so tests run real schema. Backfills that can't be idempotent are separate one-shot `scripts/backfill-*.ts` with documented ordering (e.g. `backfill-entity-norm.ts` must run *before* `migrate` on DBs predating the `entity_name_norm` constraint).
- **`packages/client` duplicates wire types on purpose** — consumers never import service source; pin compatibility at startup via `GET /health`. `adapters/openclaw` can't carry a `workspace:` dep (it installs standalone), so `pnpm sync:vendored-client` copies the client into `adapters/openclaw/vendor/`; a test fails on drift.
- Commits are conventional (`feat(scope): …`) on `type/slug` branches merged via PR.

## Docs

- `EXPECTED.md` — the API contract (routes, envelope, idempotency-by-client-id). Consult when touching an endpoint; integration specs assert against it.
- `SPEC.md` — data model: the `:MemoryItem` hybrid label scheme, node categories, scope axes, audit design, OKF vault contract. Consult when changing schema or Cypher.
- `INTEGRATION.md` — guide for wiring an orchestrator against the service. Consult when writing a consumer or adapter.
- `docs/okf-evaluation.md` — as-built addendum for OKF, including work explicitly *not* built.

"OKF vault" is a one-way markdown projection of research + knowledge documents. **The node content is the source of truth; the vault is derived.** Soft-deletes move files to `_trash/`. The writer uses temp-sibling + atomic rename because `protect` gives no cross-process lock against a manual `pnpm okf:sync`.
