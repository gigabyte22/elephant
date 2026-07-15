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
  test('exposes the eight elephant tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'memory_entity',
      'memory_forget',
      'memory_observe',
      'memory_preference_get',
      'memory_preference_set',
      'memory_recall',
      'memory_save',
      'memory_timeline',
    ]);
    const recall = tools.find((t) => t.name === 'memory_recall');
    expect(recall?.annotations?.readOnlyHint).toBe(true);
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
});

describe('memory_forget', () => {
  test('factId path deletes directly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { deleted: true } }));
    const result = await client.callTool({ name: 'memory_forget', arguments: { factId: 'f9' } });
    expect(textOf(result)).toContain('Soft-deleted fact f9');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://elephant.test/facts/f9');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
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
