# Security Policy

## Supported versions

Elephant is pre-1.0 and ships from `main`. Only the latest commit on `main`
receives security fixes; there are no backports to older tags.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/gigabyte22/elephant/security/advisories/new)
— the "Report a vulnerability" button on the repository's Security tab. That
opens a discussion visible only to you and the maintainers.

Please include:

- what an attacker can do (read other tenants' memories, bypass auth, execute
  code, …), not just the faulty line;
- the smallest reproduction you have — a `curl` against a local instance is
  ideal;
- the commit SHA you tested, and any non-default configuration required
  (`SCOPE_*`, `AUTH_TOKEN`, adapter selection).

You should get an acknowledgement within 7 days and a fix or a decision within
30. This is a solo-maintained project, so please allow for that pace before
disclosing publicly.

## Scope

In scope — anything that lets a caller read or write memory it should not:

- authentication bypass on the HTTP API (`src/http/auth.ts`), including the
  `/health` and `/dashboard*` exemptions;
- scope-isolation failures, where a `projectId` / `userId` / `agentId` /
  `sessionId` filter leaks items across tenants;
- Cypher injection through query parameters, scope values, or extracted
  entities;
- secrets (API keys, bearer tokens, embeddings of sensitive text) reaching
  logs, the dashboard, the OKF vault, or an API response;
- remote code execution via ingestion, extraction, or the dream cycle.

Out of scope:

- running Elephant with `AUTH_TOKEN` unset or Neo4j exposed to the internet —
  the service expects to sit on a trusted network behind a token;
- denial of service from unbounded ingestion, embedding, or LLM cost. Report
  these as ordinary issues;
- vulnerabilities in Neo4j, the LLM providers, or other dependencies — report
  those upstream. If a dependency's flaw is reachable through Elephant in a way
  their advisory doesn't cover, we do want to hear about it.

## Operating Elephant safely

Elephant stores raw conversation content and its embeddings. Treat the Neo4j
database, the `KNOWLEDGE_BLOB_DIR` blob store, and the OKF vault as holding the
same sensitivity as the conversations you feed it:

- always set `AUTH_TOKEN`; every route except `/health` and the dashboard shell
  requires it;
- never expose the Neo4j bolt port publicly, and change the default password;
- keep provider API keys in the environment, not in committed `.env` files —
  `.env` is gitignored, `.env.example` is the template to copy;
- back up the graph before running any `scripts/backfill-*.ts` or
  `pnpm rebuild:facts`; they are not reversible.
