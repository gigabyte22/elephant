// Vitest globalSetup: spin up a single Neo4j container, run the schema migrate,
// expose connection details via env. Container is shared across all integration
// specs (vitest.config.ts pins singleFork) and torn down at end-of-run.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const NEO4J_IMAGE = process.env.NEO4J_IMAGE_TAG ?? 'neo4j:5.26-community';
const PASSWORD = 'test-password-1234';
const TOKEN = 'test-token';
const EMBED_DIM = '256';

let container: StartedTestContainer | undefined;
let scratchDirs: string[] = [];

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
  // Without this, the fake API keys above make the extraction factory build a
  // *real* vision/transcription client, and any image or audio attachment in a
  // test would attempt a live provider call. Disabled means those attachments
  // deterministically report 'skipped'.
  process.env.KNOWLEDGE_VISION_PROVIDER = 'none';
  process.env.KNOWLEDGE_TRANSCRIBE_PROVIDER = 'none';

  // Redirect every path the service writes to. Both of these default to
  // *relative* paths ('./.okf-vault', './.knowledge-blobs') resolved against
  // cwd, and `src/config/env.ts` imports 'dotenv/config' at module load — so
  // without this, the repo's own .env (OKF_ENABLED=true) makes 34 of the 35
  // integration specs build a real filesystem writer pointed at the working
  // tree. That is not hypothetical: it left 398 orphaned .md files and 50
  // stray blobs in the repo, invisible because both directories are
  // gitignored.
  //
  // This is the filesystem analogue of ./guard.ts — the testcontainer already
  // isolates the database, and nothing isolated the disk.
  const okfDir = await mkdtemp(join(tmpdir(), 'elephant-okf-'));
  const blobDir = await mkdtemp(join(tmpdir(), 'elephant-blobs-'));
  scratchDirs = [okfDir, blobDir];
  process.env.OKF_DIR = okfDir;
  process.env.KNOWLEDGE_BLOB_DIR = blobDir;

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
  for (const dir of scratchDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
