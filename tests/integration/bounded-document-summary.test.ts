// Knowledge and research documents longer than the LLM context are summarized
// in pieces. They used to go up as one prompt, so every create or update of a
// long note failed with the LLM's "context exceeded" (HTTP 500).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { write as txWrite } from '../../src/config/neo4j.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';
import { approxTokens } from '../../src/utils/tokens.ts';
import { assertDestructiveAllowed } from './guard.ts';

const TOKEN = process.env.__TEST_TOKEN ?? 'test-token';
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);
const json = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;
const PROJECT = 'bounded-summary-proj';

// maxContextTokens 1000 → summarizer input budget 600 tokens.
const MAX_CONTEXT = 1_000;
const BUDGET = Math.floor(MAX_CONTEXT * 0.6);
const LONG = 'A paragraph of operator documentation for the stack. '.repeat(400);

const calls: string[] = [];
let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;

beforeAll(async () => {
  container = await bootstrap({
    llm: createFakeLLMAdapter({
      maxContextTokens: MAX_CONTEXT,
      summarize: (input) => {
        if (approxTokens(input.text) > BUDGET) throw new Error('context exceeded');
        calls.push(input.text);
        return `summary of ${approxTokens(input.text)} tokens`;
      },
    }),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
  });
  app = await buildHttpServer(container);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await shutdown();
});

beforeEach(async () => {
  assertDestructiveAllowed();
  await txWrite(async (tx) => {
    await tx.run('MATCH (n) DETACH DELETE n');
  });
  calls.length = 0;
});

describe('documents longer than the LLM context', () => {
  test('knowledge create and update summarize in pieces that fit', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/knowledge/documents',
      headers: json,
      payload: { title: 'Long note', source: 'wiki', content: LONG },
    });
    expect(created.statusCode).toBe(200);
    expect(calls.length).toBeGreaterThan(1);

    calls.length = 0;
    const id = created.json().data.id as string;
    const updated = await app.inject({
      method: 'PUT',
      url: `/knowledge/documents/${id}`,
      headers: json,
      payload: { content: `${LONG} One more paragraph.` },
    });
    expect(updated.statusCode).toBe(200);
    expect(calls.length).toBeGreaterThan(1);
    expect(updated.json().data.summary).toMatch(/^summary of/);
  });

  test('research create summarizes in pieces that fit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/research',
      headers: json,
      payload: { title: 'Long research', source: 'manual', content: LONG, projectId: PROJECT },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.length).toBeGreaterThan(1);
  });
});
