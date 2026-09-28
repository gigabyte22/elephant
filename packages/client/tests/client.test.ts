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
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok-12345678');
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

  test('preference reads and writes carry the declared scope', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ ok: true, data: { preferences: [] } }));
    const client = new ElephantClient(cfg);
    const scope = { projectId: 'p1', userId: 'u1' };
    await client.listPreferences(scope);
    await client.getPreference('a/b', scope);
    await client.putPreference('a/b', 'v', { confidence: 0.5, ...scope });
    const calls = fetchMock.mock.calls;
    expect(calls[0]![0]).toBe('http://elephant.test/preferences?projectId=p1&userId=u1');
    expect(calls[1]![0]).toBe('http://elephant.test/preferences/a%2Fb?projectId=p1&userId=u1');
    // PUT takes its scope in the body, as the route declares it.
    expect(calls[2]![0]).toBe('http://elephant.test/preferences/a%2Fb');
    expect(JSON.parse(calls[2]![1]?.body as string)).toEqual({
      value: 'v',
      confidence: 0.5,
      projectId: 'p1',
      userId: 'u1',
    });
  });

  test('preference calls without a scope address the unscoped row', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ ok: true, data: { preferences: [] } }));
    // defaultProjectId must not leak into preferences: that would silently move
    // existing callers off the unscoped row.
    const client = new ElephantClient({ ...cfg, defaultProjectId: 'dflt' });
    await client.listPreferences();
    await client.getPreference('k');
    await client.putPreference('k', 'v');
    const calls = fetchMock.mock.calls;
    expect(calls[0]![0]).toBe('http://elephant.test/preferences');
    expect(calls[1]![0]).toBe('http://elephant.test/preferences/k');
    expect(JSON.parse(calls[2]![1]?.body as string)).toEqual({ value: 'v' });
  });

  test('attachment upload and delete carry the scope guard query', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ ok: true, data: { deleted: true } }));
    const client = new ElephantClient(cfg);
    const input = { filename: 'a.png', mimeType: 'image/png', dataBase64: 'AA==' };
    await client.uploadAttachment('d1', input, { projectId: 'p1', userId: 'u1' });
    await client.deleteAttachment('d1', 'a1', { userId: 'u1' });
    await client.uploadAttachment('d1', input);
    const calls = fetchMock.mock.calls;
    expect(calls[0]![0]).toBe(
      'http://elephant.test/knowledge/documents/d1/attachments?projectId=p1&userId=u1',
    );
    expect(calls[0]![1]?.method).toBe('POST');
    expect(JSON.parse(calls[0]![1]?.body as string)).toEqual(input);
    expect(calls[1]![0]).toBe(
      'http://elephant.test/knowledge/documents/d1/attachments/a1?userId=u1',
    );
    expect(calls[1]![1]?.method).toBe('DELETE');
    expect(calls[2]![0]).toBe('http://elephant.test/knowledge/documents/d1/attachments');
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
    // withWriteDefaults injects a client-side idempotency id on every write.
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      content: 'x',
      agentId: 'alpha',
      sessionId: 's1',
      actor: 'alpha',
    });
  });
});

describe('fact scope query', () => {
  test('scope is forwarded, and a scope-less call keeps its bare URL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ ok: true, data: { deleted: true } }));
    const client = new ElephantClient(cfg);

    await client.getFact('f1', { projectId: 'p1', userId: 'u1' });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://elephant.test/facts/f1?projectId=p1&userId=u1',
    );

    await client.supersedeFact('old', 'new', 'moved', { projectId: 'p1' });
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'http://elephant.test/facts/old/supersede?projectId=p1',
    );

    // No scope declared: no trailing '?', which is the URL every existing caller sends.
    await client.deleteFact('f2');
    expect(fetchMock.mock.calls[2]![0]).toBe('http://elephant.test/facts/f2');
  });
});

describe('research similar', () => {
  test('forwards scope, limit and minScore; a bare call keeps its bare URL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ ok: true, data: [] }));
    const client = new ElephantClient(cfg);

    await client.similarResearch('r1', { projectId: 'p1', limit: 5, minScore: 0.9 });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://elephant.test/research/r1/similar?projectId=p1&limit=5&minScore=0.9',
    );

    await client.similarResearch('r2');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://elephant.test/research/r2/similar');
  });
});

describe('path-segment encoding', () => {
  test('ids are encoded so they cannot traverse to another endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ ok: true, data: { deleted: true } }));
    const client = new ElephantClient(cfg);
    await client.deleteFact('../dream');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://elephant.test/facts/..%2Fdream');
    await client.getEntity('a/b?x=1');
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'http://elephant.test/entities/a%2Fb%3Fx%3D1?includeSuperseded=false',
    );
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
