// Drives register() with a fake OpenClaw api object: records tool/CLI/hook
// registrations, then invokes the handlers against a stubbed fetch to assert
// elephant payloads, prependContext shape, and episode capture.

import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import plugin from '../index.ts';

interface RegisteredTool {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the host's untyped surface
  execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ text: string }> }>;
}

function makeFakeApi(config: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the host's untyped surface
  const hooks = new Map<string, (event: any) => Promise<any>>();
  let cliRegistered = false;
  return {
    api: {
      pluginConfig: config,
      // biome-ignore lint/suspicious/noExplicitAny: host-supplied shape
      registerTool(tool: any, _opts?: unknown) {
        tools.set(tool.name, tool);
      },
      // biome-ignore lint/suspicious/noExplicitAny: host-supplied shape
      on(event: string, handler: (event: any) => Promise<any>) {
        hooks.set(event, handler);
      },
      registerCli(_setup: unknown, _opts?: unknown) {
        cliRegistered = true;
      },
    },
    tools,
    hooks,
    isCliRegistered: () => cliRegistered,
  };
}

const CONFIG = {
  url: 'http://elephant.test',
  token: 'tok-12345678',
  agentId: 'openclaw',
  userId: 'gg',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registration', () => {
  test('manifest identity and memory kind', () => {
    expect(plugin.id).toBe('memory-elephant');
    expect(plugin.kind).toBe('memory');
  });

  test('registers the eight tools, both hooks, and the CLI', () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    expect(Array.from(fake.tools.keys()).sort()).toEqual([
      'memory_entity',
      'memory_forget',
      'memory_observe',
      'memory_preference_get',
      'memory_preference_set',
      'memory_recall',
      'memory_save',
      'memory_timeline',
    ]);
    expect(Array.from(fake.hooks.keys()).sort()).toEqual(['agent_end', 'before_agent_start']);
    expect(fake.isCliRegistered()).toBe(true);
  });

  test('hooks are not registered when disabled in config', () => {
    const fake = makeFakeApi({
      ...CONFIG,
      autoRecall: { enabled: false },
      autoCapture: { enabled: false },
    });
    plugin.register(fake.api);
    expect(fake.hooks.size).toBe(0);
  });

  test('missing token fails fast', () => {
    const fake = makeFakeApi({ url: 'http://elephant.test' });
    expect(() => plugin.register(fake.api)).toThrow(/token/);
  });
});

describe('tools', () => {
  test('memory_save posts scope and actor', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { id: 'f1' } }));
    const result = await fake.tools.get('memory_save')!.execute('t1', {
      fact: 'user prefers espresso',
      category: 'preference',
    });
    expect(result.content[0]!.text).toContain('Saved fact f1');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body).toEqual({
      content: 'user prefers espresso',
      category: 'preference',
      agentId: 'openclaw',
      userId: 'gg',
      actor: 'openclaw',
    });
  });

  test('memory_forget rejects non-UUID factId without a request', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    const result = await fake.tools.get('memory_forget')!.execute('t1', { factId: '../dream' });
    expect(result.content[0]!.text).toBe('factId must be a UUID.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('memory_forget fuzzy path hard-filters to own agent scope', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { facts: [] } }));
    await fake.tools.get('memory_forget')!.execute('t1', { query: 'old belief' });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/recall');
    expect(url.searchParams.get('agentScope')).toBe('filter');
  });
});

describe('before_agent_start (auto-recall)', () => {
  test('prepends rendered memory when there are matches', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
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
        },
      }),
    );
    const out = await fake.hooks.get('before_agent_start')!({
      prompt: 'what coffee do I like?',
      sessionId: 'telegram:42',
    });
    expect(out.prependContext).toContain('<relevant-memories source="elephant">');
    expect(out.prependContext).toContain('espresso wins');
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('sessionId')).toBe('telegram:42');
  });

  test('returns nothing on empty recall and swallows errors', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { facts: [] } }));
    const empty = await fake.hooks.get('before_agent_start')!({ prompt: 'x' });
    expect(empty).toBeUndefined();

    fetchMock.mockRejectedValue(new Error('connection refused'));
    const failed = await fake.hooks.get('before_agent_start')!({ prompt: 'x' });
    expect(failed).toBeUndefined();
  });
});

describe('agent_end (auto-capture)', () => {
  test('flushes the turn transcript as an episode', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { episodeId: 'e1' } }));
    await fake.hooks.get('agent_end')!({
      agentId: 'openclaw',
      sessionId: 'telegram:42',
      messages: [
        { role: 'user', content: 'remember that I switched the deploy day to thursday' },
        { role: 'assistant', content: 'Noted — deploys now happen on Thursday.' },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://elephant.test/episodes');
    const body = JSON.parse(init?.body as string);
    expect(body.agentId).toBe('openclaw');
    expect(body.sessionId).toBe('telegram:42');
    expect(body.rawTranscript).toContain('USER: remember that I switched');
    expect(body.rawTranscript).toContain('ASSISTANT: Noted');
    expect(body.userId).toBe('gg');
  });

  test('skips trivial turns and injected memory blocks', async () => {
    const fake = makeFakeApi(CONFIG);
    plugin.register(fake.api);
    await fake.hooks.get('agent_end')!({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: '<relevant-memories source="elephant">…</relevant-memories>' },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
