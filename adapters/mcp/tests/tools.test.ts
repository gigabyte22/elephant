// Drives the real McpServer through an in-memory transport pair with fetch
// stubbed, so every tool's wire behavior (schema, elephant payload, rendered
// text) is covered without a running elephant.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { McpConfig } from '../src/config.ts';
import { buildServer } from '../src/server.ts';

const config: McpConfig = {
  url: 'http://elephant.test',
  token: 'tok-12345678',
  scope: {
    agentId: 'claude-code',
    sessionId: 's-test',
    projectId: undefined,
    userId: undefined,
    agentScope: 'boost',
    sessionScope: 'boost',
    projectScope: 'none',
    userScope: 'none',
  },
  transport: 'stdio',
  port: 18791,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let client: Client;
let fetchMock: MockInstance<typeof fetch>;

beforeEach(async () => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
  const { server } = buildServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-host', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join('\n');
}

describe('tool registration', () => {
  test('exposes the full elephant tool surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'memory_audit',
      'memory_entity',
      'memory_forget',
      'memory_intention_cancel',
      'memory_intention_complete',
      'memory_intention_create',
      'memory_intention_due',
      'memory_intention_fired',
      'memory_intention_list',
      'memory_knowledge_delete',
      'memory_knowledge_get',
      'memory_knowledge_list',
      'memory_knowledge_save',
      'memory_knowledge_update',
      'memory_observe',
      'memory_preference_get',
      'memory_preference_set',
      'memory_procedure_delete',
      'memory_procedure_get',
      'memory_procedure_list',
      'memory_procedure_save',
      'memory_procedure_update',
      'memory_recall',
      'memory_research_delete',
      'memory_research_get',
      'memory_research_list',
      'memory_research_save',
      'memory_research_update',
      'memory_save',
      'memory_state_delete',
      'memory_state_get',
      'memory_state_list',
      'memory_state_set',
      'memory_timeline',
    ]);
    const recall = tools.find((t) => t.name === 'memory_recall');
    expect(recall?.annotations?.readOnlyHint).toBe(true);
  });

  // /dream stays off the tool surface on purpose — consolidation is cron-driven.
  test('does not expose a dream tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name.includes('dream'))).toBe(false);
  });
});

describe('memory_save', () => {
  test('posts to /facts with origin scope and actor', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { id: 'f1' } }));
    const result = await client.callTool({
      name: 'memory_save',
      arguments: { fact: 'user prefers espresso', category: 'preference', entities: ['espresso'] },
    });
    expect(textOf(result)).toContain('Saved fact f1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://elephant.test/facts');
    expect(JSON.parse(init?.body as string)).toEqual({
      content: 'user prefers espresso',
      category: 'preference',
      entityNames: ['espresso'],
      agentId: 'claude-code',
      sessionId: 's-test',
      actor: 'claude-code',
    });
  });
});

describe('memory_recall', () => {
  test('queries /recall with scope axes and renders sections', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          facts: [
            {
              id: 'f1',
              content: 'espresso wins',
              confidence: 0.9,
              importance: 0.7,
              validFrom: '2026-01-01T00:00:00Z',
              validTo: null,
              recordedAt: '2026-01-01T00:00:00Z',
              entities: [],
              score: 0.91,
            },
          ],
          preferences: [
            {
              key: 'coffee',
              value: 'espresso',
              confidence: 0.95,
              validFrom: '2026-01-01T00:00:00Z',
              validTo: null,
              score: 0.8,
            },
          ],
        },
      }),
    );
    const result = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'coffee', limit: 5 },
    });
    const text = textOf(result);
    expect(text).toContain('Preferences:\n- coffee: espresso');
    expect(text).toContain('[f1]');
    expect(text).toContain('espresso wins');

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/recall');
    expect(url.searchParams.get('q')).toBe('coffee');
    expect(url.searchParams.get('agentId')).toBe('claude-code');
    expect(url.searchParams.get('agentScope')).toBe('boost');
    expect(url.searchParams.get('limit')).toBe('5');
    // No projectId configured → the axis is forced to none.
    expect(url.searchParams.get('projectScope')).toBe('none');
  });

  test('opts into every v1.2 category', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { facts: [] } }));
    await client.callTool({ name: 'memory_recall', arguments: { query: 'anything' } });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    for (const flag of [
      'includePreferences',
      'includeInsights',
      'includeProcedures',
      'includeKnowledge',
      'includeResearch',
      'includeIntentions',
    ]) {
      expect(url.searchParams.get(flag)).toBe('true');
    }
  });

  test('renders knowledge, research and intention sections', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          facts: [],
          knowledgeChunks: [
            {
              id: 'kc1',
              documentId: 'kd1',
              position: 0,
              text: 'chunk text',
              createdAt: '2026-01-01T00:00:00Z',
              score: 0.5,
            },
          ],
          research: [
            {
              id: 'r1',
              title: 'Vector indexes',
              summary: 'how they work',
              tags: [],
              source: 'web',
              projectId: 'p1',
              expiresAt: null,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
              score: 0.6,
            },
          ],
          researchChunks: [
            {
              id: 'rc1',
              researchId: 'r1',
              position: 0,
              text: 'excerpt text',
              createdAt: '2026-01-01T00:00:00Z',
              score: 0.4,
            },
          ],
          intentions: [
            {
              id: 'i1',
              content: 'ship the adapter',
              status: 'pending',
              dueAt: '2026-08-01T09:00:00Z',
              triggerHint: null,
              recurring: false,
              schedule: null,
              fireCount: 0,
              lastFiredAt: null,
              validFrom: '2026-01-01T00:00:00Z',
              validTo: null,
              createdAt: '2026-01-01T00:00:00Z',
              completedAt: null,
              importance: 0.6,
              score: 0.7,
            },
          ],
        },
      }),
    );
    const text = textOf(
      await client.callTool({ name: 'memory_recall', arguments: { query: 'anything' } }),
    );
    expect(text).toContain('Knowledge:\n- [kd1] chunk text');
    expect(text).toContain('Research:\n- [r1] Vector indexes: how they work');
    expect(text).toContain('Research excerpts:\n- [r1] excerpt text');
    expect(text).toContain('Intentions:\n- [i1] (pending, due 2026-08-01 09:00) ship the adapter');
  });
});

describe('research', () => {
  test('save refuses without a configured project id, no request made', async () => {
    const result = await client.callTool({
      name: 'memory_research_save',
      arguments: { title: 't', source: 'web', content: 'c' },
    });
    expect(textOf(result)).toContain('no project id is configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('list refuses without a configured project id', async () => {
    const result = await client.callTool({ name: 'memory_research_list', arguments: {} });
    expect(textOf(result)).toContain('no project id is configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('working state', () => {
  test('set posts the agent scope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { ok: true } }));
    await client.callTool({
      name: 'memory_state_set',
      arguments: { key: 'branch', value: 'feat/mcp', ttlSec: 60 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://elephant.test/state');
    expect(JSON.parse(init?.body as string)).toEqual({
      scope: { agentId: 'claude-code', sessionId: 's-test' },
      key: 'branch',
      value: 'feat/mcp',
      ttlSec: 60,
    });
  });

  test('get returns a friendly message on 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'not found' }, 404));
    const result = await client.callTool({
      name: 'memory_state_get',
      arguments: { key: 'missing' },
    });
    expect(textOf(result)).toBe('State "missing" is not set.');
  });
});

describe('procedures', () => {
  const PROC_ID = '9a1c1c1e-0f2b-4a3d-8c5e-1b2a3c4d5e6f';
  const proc = {
    id: PROC_ID,
    name: 'deploy',
    version: 2,
    content: 'step one',
    whenToUse: 'shipping',
    successRate: 0.75,
    invocationCount: 4,
    lastSuccessAt: null,
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  test('get by id takes precedence over name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: proc }));
    const result = await client.callTool({
      name: 'memory_procedure_get',
      arguments: { id: PROC_ID, name: 'ignored' },
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://elephant.test/procedures/${PROC_ID}`);
    expect(textOf(result)).toContain('deploy (v2)');
  });

  test('get by name falls back to the list route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: [proc] }));
    await client.callTool({ name: 'memory_procedure_get', arguments: { name: 'deploy' } });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/procedures');
    expect(url.searchParams.get('name')).toBe('deploy');
  });
});

describe('memory_audit', () => {
  test('renders events and revisions', async () => {
    const TARGET = '11111111-2222-4333-8444-555555555555';
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          events: [
            {
              id: 'a1',
              kind: 'update',
              targetId: TARGET,
              targetKind: 'fact',
              payload: {},
              at: '2026-02-01T00:00:00Z',
              actor: 'claude-code',
            },
          ],
          revisions: [
            {
              id: 'v1',
              originalId: TARGET,
              originalKind: 'fact',
              snapshot: {},
              archivedAt: '2026-02-01T00:00:00Z',
              reason: 'corrected',
            },
          ],
        },
      }),
    );
    const text = textOf(
      await client.callTool({ name: 'memory_audit', arguments: { targetId: TARGET } }),
    );
    expect(text).toContain('update (fact) by claude-code');
    expect(text).toContain('corrected');
  });
});

describe('memory_forget', () => {
  const FACT_ID = '3f0e8f6a-58a2-4bfb-9d6e-0f6f4a1c2b3d';

  test('factId path deletes directly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { deleted: true } }));
    const result = await client.callTool({
      name: 'memory_forget',
      arguments: { factId: FACT_ID },
    });
    expect(textOf(result)).toContain(`Soft-deleted fact ${FACT_ID}`);
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://elephant.test/facts/${FACT_ID}`);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
  });

  test('non-UUID factId is rejected by the schema, no request made', async () => {
    const result = await client.callTool({
      name: 'memory_forget',
      arguments: { factId: '../dream' },
    });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fuzzy query with multiple matches returns candidates, deletes nothing', async () => {
    const fact = (id: string) => ({
      id,
      content: `candidate ${id}`,
      confidence: 0.8,
      importance: 0.5,
      validFrom: '2026-01-01T00:00:00Z',
      validTo: null,
      recordedAt: '2026-01-01T00:00:00Z',
      entities: [],
      score: 0.5,
    });
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, data: { facts: [fact('a'), fact('b')] } }),
    );
    const result = await client.callTool({
      name: 'memory_forget',
      arguments: { query: 'candidate' },
    });
    expect(textOf(result)).toContain('Multiple matches');
    // Only the recall call happened — no DELETE.
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'DELETE')).toBe(true);
  });

  test('fuzzy query with exactly one match deletes it', async () => {
    const only = {
      id: 'solo',
      content: 'the one',
      confidence: 0.8,
      importance: 0.5,
      validFrom: '2026-01-01T00:00:00Z',
      validTo: null,
      recordedAt: '2026-01-01T00:00:00Z',
      entities: [],
      score: 0.9,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { facts: [only] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { deleted: true } }));
    const result = await client.callTool({
      name: 'memory_forget',
      arguments: { query: 'the one' },
    });
    expect(textOf(result)).toContain('Soft-deleted the single match');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://elephant.test/facts/solo');
  });
});

describe('memory_timeline', () => {
  test('resolves entity name then queries /timeline', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, data: { entities: [{ id: 'e1', name: 'Neo4j', type: 'Tool' }] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, data: { at: '2026-03-01T00:00:00.000Z', facts: [] } }),
      );
    const result = await client.callTool({
      name: 'memory_timeline',
      arguments: { at: '2026-03-01T00:00:00Z', entity: 'Neo4j' },
    });
    expect(textOf(result)).toContain('Beliefs valid at 2026-03-01');
    const timelineUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(timelineUrl.pathname).toBe('/timeline');
    expect(timelineUrl.searchParams.get('entityId')).toBe('e1');
  });
});

describe('preferences', () => {
  test('get returns friendly message on 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'not found' }, 404));
    const result = await client.callTool({
      name: 'memory_preference_get',
      arguments: { key: 'unset-key' },
    });
    expect(textOf(result)).toBe('Preference "unset-key" is not set.');
  });

  test('set PUTs value with actor', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          key: 'coffee',
          value: 'espresso',
          confidence: 0.95,
          validFrom: '2026-07-15T00:00:00Z',
          validTo: null,
        },
      }),
    );
    await client.callTool({
      name: 'memory_preference_set',
      arguments: { key: 'coffee', value: 'espresso' },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://elephant.test/preferences/coffee');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ value: 'espresso', actor: 'claude-code' });
  });
});

describe('memory_observe', () => {
  test('writes a session-scoped observation', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          id: 'o1',
          agentId: 'claude-code',
          sessionId: 's-test',
          content: 'x',
          recordedAt: '2026-07-15T00:00:00Z',
          expiresAt: '2026-07-22T00:00:00Z',
        },
      }),
    );
    const result = await client.callTool({
      name: 'memory_observe',
      arguments: { note: 'user is mid-refactor of the auth module' },
    });
    expect(textOf(result)).toContain('expires 2026-07-22');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body).toEqual({
      agentId: 'claude-code',
      sessionId: 's-test',
      content: 'user is mid-refactor of the auth module',
    });
  });
});
