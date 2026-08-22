# Contributing to Elephant

Thanks for taking a look. Elephant is a Neo4j-backed long-term memory service
for agent orchestrators — one datastore, no separate vector DB or queue.

Bug reports and focused pull requests are both welcome. For anything large
(a new adapter, a change to the retrieval pipeline, a schema migration), please
open an issue first so we can agree on the shape before you write it.

## Getting set up

Node ≥ 22, [pnpm](https://pnpm.io), and Docker.

```bash
pnpm install
docker compose up -d neo4j          # Neo4j 5.26 with APOC + GDS
cp .env.example .env                # then fill in NEO4J_PASSWORD, AUTH_TOKEN, provider keys
pnpm migrate                        # idempotent — constraints + vector/full-text indexes
pnpm --filter @elephant/web build   # the dashboard is served from web/dist
pnpm serve                          # or `pnpm dev` to watch
```

There is **no build step for the backend** — it runs from TypeScript source via
`tsx`, which is why imports carry explicit `.ts` extensions.

For dashboard work, `pnpm --filter @elephant/web dev` runs Vite on `:5173` and
proxies `/dashboard/api` to the service on `:18790`.

## Tests

```bash
pnpm test              # unit only, no Docker needed
pnpm typecheck         # tsc --noEmit
pnpm lint              # biome; `pnpm lint:fix` to apply
pnpm test:integration  # spins up a Neo4j testcontainer — needs Docker
```

A single unit test: `pnpm vitest run tests/unit/decay.test.ts -t "name"`.

> [!WARNING]
> **Never run an integration spec with a bare `vitest run`.** They
> `DETACH DELETE` the whole graph, and without `vitest.integration.config.ts`
> the driver connects to whatever your `.env` points at — i.e. possibly your
> real database. Always pass the config:
>
> ```bash
> pnpm vitest run --config vitest.integration.config.ts tests/integration/dashboard.test.ts
> ```

Python adapter tests: `cd adapters/hermes && uv run --with pytest pytest -q`.
The live-server tests skip themselves unless an instance is reachable.

CI runs lint, typecheck, unit tests, the dashboard build, and the Python
adapter tests on every pull request. Integration tests are not in the PR gate —
run them locally when you touch repositories, Cypher, or the dream cycle.

## House style

- **Biome**, not ESLint/Prettier: single quotes, semicolons, 100 columns,
  2-space indent. `pnpm lint:fix` settles all of it.
- Services are closure factories — `createXService(deps)` returning an object
  literal, with `export type XService = ReturnType<typeof createXService>`.
  Very few classes.
- Repositories never own a session. Every method is a static taking
  `tx: ManagedTransaction` first, called through `read()` / `write()` from
  `src/config/neo4j.ts`, so a service can compose several calls into one
  transaction.
- Every HTTP response is `{ ok: true, data } | { ok: false, error }`. Handlers
  return the success shape literally and throw `HttpError` for failures; the
  error handler builds the envelope.
- Nothing is hard-deleted. Soft-delete and prune set `validTo`; mutating writes
  to `Fact` / `Preference` / `Procedure` / `KnowledgeDocument` / `Research` go
  through `AuditService` so a revision is archived in the same transaction.
- Boolean env vars use `boolEnv()`, never `z.coerce.boolean()` — `Boolean("false")`
  is `true`, which would make every opt-out flag impossible to turn off.
- `src/` never imports from `scripts/`.

`CLAUDE.md` in the repository root is the condensed tour of the architecture and
is worth reading before a non-trivial change. The deeper references are
`SPEC.md` (data model), `EXPECTED.md` (API contract), and `INTEGRATION.md`
(wiring an orchestrator).

## Pull requests

- Branch from `main` as `type/slug` — `fix/embed-oversized-bodies`,
  `feat/hermes-adapter-packaging`.
- Conventional commits: `feat(retrieval): …`, `fix(dream): …`,
  `docs(hermes): …`.
- `main` is protected: land everything through a pull request with CI green.
- Keep the PR to one concern. If you touch an endpoint, update `EXPECTED.md`;
  if you change the schema or Cypher, update `SPEC.md` and add the migration to
  `src/migrate.ts` (a flat list of `IF NOT EXISTS` statements — migrations are
  not versioned).
- New behaviour needs a test. Unit tests are cheap; use the testcontainer suite
  when the behaviour is really about Cypher.

## Dependency updates

pnpm quarantines packages published in the last 24 hours (`minimumReleaseAge`),
which is the cheap defence against a compromised release being pulled in before
anyone notices. Dependabot writes `pnpm-lock.yaml` with its own resolver, which
does not know about that policy and always takes absolute-latest — so most
Dependabot npm PRs land a lockfile that then fails `pnpm install
--frozen-lockfile` in CI, usually on a transitive dependency that has nothing
to do with the bump.

Rebasing does not converge: each rebase re-resolves to whatever is newest at
that moment. Repair the lockfile instead:

```bash
gh pr checkout <n>
pnpm clean --lockfile && pnpm install
git commit -am 'chore(deps): re-resolve the lockfile within the release-age policy'
git push
```

pnpm's resolver picks the newest version *older* than the cutoff, so this
produces an in-policy lockfile. The direct bumps in `package.json` are
untouched — only the lockfile differs. Note that pushing to a Dependabot branch
stops Dependabot from rebasing that PR, which is what you want here.

Don't reach for a per-package `minimumReleaseAgeExclude`: the offending package
is different every time, so the exclusion list grows without ever fixing the
cause.

## Upgrade notes

**Vision extraction got a new prompt and a quality guard.** A completed OCR
response must now contain the transcription plus a trailing `DESCRIPTION:` line;
output that doesn't conform (the way a small model silently gives up on a dense
screenshot) is no longer stored as `done` — it falls through to the optional
`KNOWLEDGE_VISION_FALLBACK_*` tier, and records `failed` with each tier's
outcome if every tier flunks. Junk readings stored as `done` *before* this
change are not repaired automatically: re-run
`scripts/backfill-attachment-extraction.ts --id=<attachmentId>` for the ones you
know about (`--id` bypasses the status filter).

**Attachment OCR/transcription became explicit opt-in.** `KNOWLEDGE_VISION_PROVIDER=auto`
and `KNOWLEDGE_TRANSCRIBE_PROVIDER=auto` used to enable themselves off any
available key, so a deployment that set `ANTHROPIC_API_KEY` for dreaming got
image OCR it never asked for. `auto` now requires the dedicated
`KNOWLEDGE_VISION_*` / `KNOWLEDGE_TRANSCRIBE_*` credentials.

A deployment that was relying on the old behaviour keeps it by naming the
provider it was implicitly using:

```bash
KNOWLEDGE_VISION_PROVIDER=anthropic      # or =openai, or set KNOWLEDGE_VISION_BASE_URL
```

Restart afterwards and check the two `[extraction]` lines the service logs at
boot; they say which provider and endpoint (if any) each capability resolved to.
Attachments uploaded while the capability was off are recorded `skipped` and are
repaired by `scripts/backfill-attachment-extraction.ts` once it is on.

## Security

Please don't file security problems as public issues — see
[SECURITY.md](SECURITY.md) for private reporting.
