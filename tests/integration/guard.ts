// Safety guard for destructive integration-test helpers (clearDb / `MATCH (n)
// DETACH DELETE n`). These specs are written to run ONLY under
// `vitest.integration.config.ts`, whose globalSetup (tests/integration/setup.ts)
// spins up a throwaway Neo4j testcontainer, redirects NEO4J_* at it, and sets
// ELEPHANT_ALLOW_DESTRUCTIVE_TESTS=1. Run any other way — `bun test`, a bare
// `vitest run`, or importing a spec directly — and that opt-in is absent, so the
// connection still points at whatever .env says (the LIVE database). Calling the
// wipe in that state nukes production. This guard makes the wipe fail loudly
// instead of silently destroying data.
//
// History: on 2026-06-09 `bun test` in this repo ran these specs against the live
// neo4j and `MATCH (n) DETACH DELETE n` wiped the entire memory graph. There was
// no backup. This guard exists so that can never recur.

export function assertDestructiveAllowed(): void {
  if (process.env.ELEPHANT_ALLOW_DESTRUCTIVE_TESTS === '1') return;
  throw new Error(
    'Refusing to run a destructive test wipe: ELEPHANT_ALLOW_DESTRUCTIVE_TESTS is not set. ' +
      'These integration specs DETACH DELETE the whole database and are only safe under ' +
      '`pnpm test:integration` (vitest.integration.config.ts), whose globalSetup starts an ' +
      'isolated testcontainer and sets the opt-in. Never run them with `bun test` or a bare ' +
      '`vitest run` — that targets the live DB from .env.',
  );
}
