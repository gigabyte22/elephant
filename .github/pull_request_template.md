<!--
  Conventional commit title, please: feat(retrieval): …, fix(dream): …
  Link the issue this closes, if there is one.
-->

## What changed

## Why

## How it was tested

<!-- Which suites you ran. Integration tests are not in the PR gate — say so if
     you skipped them and the change touches Cypher, repositories, or dreaming. -->

- [ ] `pnpm test`
- [ ] `pnpm typecheck` / `pnpm lint`
- [ ] `pnpm test:integration` (needs Docker)

## Docs

- [ ] `EXPECTED.md` updated (endpoint behaviour changed)
- [ ] `SPEC.md` updated (schema, labels, or Cypher changed)
- [ ] Migration added to `src/migrate.ts`, or a `scripts/backfill-*.ts` with its
      ordering documented
- [ ] Not applicable
