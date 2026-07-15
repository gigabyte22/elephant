import { afterEach, describe, expect, test, vi } from 'vitest';
import { ElephantClient, ElephantError } from '../src/client.ts';

const cfg = { url: 'http://elephant.test', token: 'tok-12345678' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('envelope handling', () => {
  test('unwraps { ok: true, data } to the payload', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true, data: { id: 'f1', content: 'x' } }));
    const client = new ElephantClient(cfg);
    const fact = await client.saveFact({ content: 'x' });
    expect(fact).toEqual({ id: 'f1', content: 'x' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://elephant.test/facts');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-12345678');
  });

  test('4xx throws ElephantError with status and body, no retry', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: false, error: 'bad input' }, 400));
    const client = new ElephantClient(cfg);
    const err = await client.saveFact({ content: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(ElephantError);
    expect((err as ElephantError).status).toBe(400);
    expect((err as ElephantError).message).toBe('bad input');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('5xx retries then succeeds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { deleted: true } }));
    const client = new ElephantClient({ ...cfg, retries: 2 });
    const out = await client.deleteFact('abc');
    expect(out).toEqual({ deleted: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('5xx exhausts retries and throws the last error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: false, error: 'down' }, 503));
    const client = new ElephantClient({ ...cfg, retries: 1 });
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(ElephantError);
    expect((err as ElephantError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe('query-string building', () => {
  test('recall serializes scope axes, kinds array, and Date bounds', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true, data: { facts: [] } }));
    const client = new ElephantClient(cfg);
    await client.recall({
      q: 'dark mode',
      agentId: 'alpha',
      agentScope: 'boost',
      kinds: ['fact', 'preference'],
      from: new Date('2026-01-01T00:00:00.000Z'),
      limit: 5,
      includePreferences: true,
    });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/recall');
    expect(url.searchParams.get('q')).toBe('dark mode');
    expect(url.searchParams.get('agentId')).toBe('alpha');
    expect(url.searchParams.get('agentScope')).toBe('boost');
    expect(url.searchParams.get('kinds')).toBe('fact,preference');
    expect(url.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('includePreferences')).toBe('true');
    // undefined axes are omitted entirely
    expect(url.searchParams.has('sessionId')).toBe(false);
  });

  test('preference key is URI-encoded and actor rides the body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true, data: { key: 'a/b', value: 'v' } }));
    const client = new ElephantClient(cfg);
    await client.putPreference('a/b', 'v', { confidence: 0.8, actor: 'assistant' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://elephant.test/preferences/a%2Fb');
    expect(JSON.parse(init?.body as string)).toEqual({
      value: 'v',
      confidence: 0.8,
      actor: 'assistant',
    });
  });

  test('saveFact forwards origin scope and actor', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true, data: { id: 'f1' } }));
    const client = new ElephantClient(cfg);
    await client.saveFact({
      content: 'x',
      agentId: 'alpha',
      sessionId: 's1',
      actor: 'alpha',
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body).toEqual({ content: 'x', agentId: 'alpha', sessionId: 's1', actor: 'alpha' });
  });
});

describe('non-JSON failure', () => {
  test('HTML error page still yields ElephantError with the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>bad gateway</html>', { status: 502 }),
    );
    const client = new ElephantClient({ ...cfg, retries: 0 });
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(ElephantError);
    expect((err as ElephantError).status).toBe(502);
    expect((err as ElephantError).message).toBe('GET /health -> 502');
  });
});
