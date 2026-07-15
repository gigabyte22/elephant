// Vitest globalSetup: spin up a single Neo4j container, run the schema migrate,
// expose connection details via env. Container is shared across all integration
// specs (vitest.config.ts pins singleFork) and torn down at end-of-run.

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const NEO4J_IMAGE = process.env.NEO4J_IMAGE_TAG ?? 'neo4j:5.26-community';
const PASSWORD = 'test-password-1234';
const TOKEN = 'test-token';
const EMBED_DIM = '256';

let container: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  container = await new GenericContainer(NEO4J_IMAGE)
    .withExposedPorts(7474, 7687)
    .withEnvironment({
      NEO4J_AUTH: `neo4j/${PASSWORD}`,
      NEO4J_server_memory_pagecache_size: '256M',
      NEO4J_server_memory_heap_max__size: '512M',
    })
    .withWaitStrategy(Wait.forLogMessage(/Started\./i))
    .withStartupTimeout(120_000)
    .start();

  process.env.NEO4J_URI = `bolt://${container.getHost()}:${container.getMappedPort(7687)}`;
  process.env.NEO4J_USER = 'neo4j';
  process.env.NEO4J_PASSWORD = PASSWORD;
  process.env.NEO4J_DATABASE = 'neo4j';
  process.env.MEMORY_SERVICE_TOKEN = TOKEN;
  process.env.MEMORY_LLM_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'fake-not-used'; // tests inject the fake adapter
  process.env.MEMORY_EMBED_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'fake-not-used';
  process.env.EMBED_DIM = EMBED_DIM;

  // Apply schema. Imported lazily so env vars are set before module-level reads.
  const { migrate } = await import('../../src/migrate.ts');
  await migrate({ log: () => undefined });

  // Make the shared values available to integration specs.
  process.env.__TEST_TOKEN = TOKEN;
  process.env.__TEST_EMBED_DIM = EMBED_DIM;
  // Opt-in flag the destructive-wipe guard (tests/integration/guard.ts) checks.
  // Only ever set here, after NEO4J_* has been redirected at the throwaway
  // testcontainer above — so a wipe can only fire against the isolated DB, never
  // the live one a bare `bun test` / `vitest run` would still be pointed at.
  process.env.ELEPHANT_ALLOW_DESTRUCTIVE_TESTS = '1';
}

export async function teardown(): Promise<void> {
  const { closeDriver } = await import('../../src/config/neo4j.ts');
  await closeDriver().catch(() => undefined);
  await container?.stop();
}
