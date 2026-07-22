// Boot a REAL elephant server against a throwaway Neo4j testcontainer, so a
// non-vitest client (the Python hermes adapter) can be driven over a real
// socket.
//
// The TS side already has `tests/integration/client-live.test.ts`, which proves
// the pattern inside vitest. hermes is Python: it cannot share that process, so
// the server has to be a standalone process it can talk to. This script is that
// process.
//
// SAFETY: this NEVER touches the developer's live Neo4j. Exactly like
// tests/integration/setup.ts, it starts its own container and overwrites
// NEO4J_* in this process's env BEFORE any elephant module is imported —
// `dotenv/config` (pulled in by src/config/env.ts) does not override variables
// that already exist, so the values set here win over .env. Every elephant
// import below is therefore lazy/dynamic; a top-level static import would read
// .env first and could point at the live database.
//
// Usage:
//   tsx scripts/live-server.ts                      # stay up, print JSON handle
//   tsx scripts/live-server.ts -- pytest -q         # run a command, then tear down
//
// In "stay up" mode a single JSON line is written to stdout:
//   {"url":"http://127.0.0.1:53412","token":"...","embedDim":256}
// In "command" mode the same line is printed, the command inherits stdio plus
// ELEPHANT_LIVE_URL / ELEPHANT_SERVICE_TOKEN, and this process exits with the
// command's exit code.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const NEO4J_IMAGE = process.env.NEO4J_IMAGE_TAG ?? 'neo4j:5.26-community';
const PASSWORD = 'test-password-1234';
const TOKEN = 'live-harness-token';
const EMBED_DIM = '256';

// Everything after a literal `--` is the command to run against the server.
const dashIndex = process.argv.indexOf('--');
const command = dashIndex === -1 ? [] : process.argv.slice(dashIndex + 1);

let container: StartedTestContainer | undefined;
let app: { close: () => Promise<void> } | undefined;
let blobDir: string | undefined;
let cleaningUp = false;

function log(message: string): void {
  process.stderr.write(`[live-server] ${message}\n`);
}

async function cleanup(): Promise<void> {
  if (cleaningUp) return;
  cleaningUp = true;
  log('tearing down');
  await app?.close().catch(() => undefined);
  try {
    const { closeDriver } = await import('../src/config/neo4j.ts');
    await closeDriver().catch(() => undefined);
  } catch {
    // never bootstrapped
  }
  await container?.stop().catch(() => undefined);
  if (blobDir) rmSync(blobDir, { recursive: true, force: true });
}

async function main(): Promise<number> {
  log(`starting ${NEO4J_IMAGE} …`);
  container = await new GenericContainer(NEO4J_IMAGE)
    .withExposedPorts(7474, 7687)
    .withEnvironment({
      NEO4J_AUTH: `neo4j/${PASSWORD}`,
      NEO4J_server_memory_pagecache_size: '256M',
      NEO4J_server_memory_heap_max__size: '512M',
    })
    .withWaitStrategy(Wait.forLogMessage(/Started\./i))
    .withStartupTimeout(180_000)
    .start();

  blobDir = mkdtempSync(join(tmpdir(), 'elephant-live-blobs-'));

  // Point this process at the throwaway container. Must happen before the first
  // elephant import — see the header note about dotenv precedence.
  process.env.NEO4J_URI = `bolt://${container.getHost()}:${container.getMappedPort(7687)}`;
  process.env.NEO4J_USER = 'neo4j';
  process.env.NEO4J_PASSWORD = PASSWORD;
  process.env.NEO4J_DATABASE = 'neo4j';
  process.env.MEMORY_SERVICE_TOKEN = TOKEN;
  process.env.MEMORY_LLM_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'fake-not-used'; // the fake adapter is injected below
  process.env.MEMORY_EMBED_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'fake-not-used';
  process.env.EMBED_DIM = EMBED_DIM;
  process.env.KNOWLEDGE_BLOB_DIR = blobDir;
  process.env.OKF_ENABLED = 'false'; // no markdown vault projection in the harness
  process.env.WORKING_STATE_BACKEND = 'neo4j';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  log(`neo4j at ${process.env.NEO4J_URI}, migrating schema …`);
  const { migrate } = await import('../src/migrate.ts');
  await migrate({ log: () => undefined });

  const { createFakeEmbeddingAdapter, createFakeLLMAdapter } = await import(
    '../src/adapters/fakes.ts'
  );
  const { buildHttpServer } = await import('../src/http/server.ts');
  const { bootstrap } = await import('../src/index.ts');

  const containerDeps = await bootstrap({
    llm: createFakeLLMAdapter({}),
    embedder: createFakeEmbeddingAdapter({ dim: Number(EMBED_DIM) }),
  });
  const server = await buildHttpServer(containerDeps);
  app = server;

  // Port 0 => the OS picks a free port, so concurrent runs can't collide and we
  // can never accidentally bind the developer's real 18790.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected a TCP address');
  const url = `http://127.0.0.1:${addr.port}`;

  process.stdout.write(`${JSON.stringify({ url, token: TOKEN, embedDim: Number(EMBED_DIM) })}\n`);
  log(`listening on ${url}`);

  if (command.length === 0) {
    log('no command given — staying up, Ctrl-C to stop');
    await new Promise<void>(() => {
      /* run until signalled */
    });
    return 0;
  }

  const [bin, ...args] = command;
  log(`running: ${command.join(' ')}`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(bin as string, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ELEPHANT_LIVE_URL: url,
        ELEPHANT_URL: url,
        ELEPHANT_SERVICE_TOKEN: TOKEN,
        ELEPHANT_LIVE_EMBED_DIM: EMBED_DIM,
      },
    });
    child.on('error', (err) => {
      log(`failed to spawn: ${err.message}`);
      resolve(127);
    });
    // A signalled child (e.g. SIGKILL) reports code null — treat as failure so
    // the runner can never exit 0 on a crashed test process.
    child.on('close', (childCode) => resolve(childCode ?? 1));
  });
  return code;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130));
  });
}

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (err) => {
    log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
    await cleanup();
    process.exit(1);
  });
