// Client retry safety. No server — global fetch is stubbed so each test can
// assert exactly what went over the wire, and how many times.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ElephantClient } from '../../packages/client/src/client.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function okResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function client(overrides: Record<string, unknown> = {}) {
  return new ElephantClient({
    url: 'http://memory.test',
    token: 't',
    timeoutMs: 50,
    ...overrides,
  });
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('writes carry a client-generated id so retries are idempotent', () => {
  // The server promises idempotency by client-supplied id, but neither the MCP
  // nor the OpenClaw tool layer supplied one — so a timed-out-but-succeeded
  // POST duplicated on retry, which is exactly what the promise exists to stop.
  test('a retried saveFact sends the SAME id on every attempt', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('network error');
      return okResponse({ id: 'server-id' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await client().saveFact({ content: 'the deploy runbook moved' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = bodyOf(fetchMock.mock.calls[0] as unknown[]);
    const second = bodyOf(fetchMock.mock.calls[1] as unknown[]);
    expect(first.id).toBeTruthy();
    expect(second.id).toBe(first.id);
  });

  test('an explicit id is never overwritten', async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: 'x' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await client().saveFact({ id: 'caller-chosen', content: 'x' });

    expect(bodyOf(fetchMock.mock.calls[0] as unknown[]).id).toBe('caller-chosen');
  });

  test.each([
    [
      'ingestEpisode',
      (c: ElephantClient) => c.ingestEpisode({ agentId: 'a', sessionId: 's', rawTranscript: 't' }),
    ],
    [
      'writeObservation',
      (c: ElephantClient) => c.writeObservation({ agentId: 'a', sessionId: 's', content: 'c' }),
    ],
  ])('%s stamps an id too', async (_name, call) => {
    const fetchMock = vi.fn(async () => okResponse({ episodeId: 'e', id: 'o' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await call(client());

    expect(bodyOf(fetchMock.mock.calls[0] as unknown[]).id).toBeTruthy();
  });

  test('batch entries are each stamped', async () => {
    const fetchMock = vi.fn(async () => okResponse([]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await client().saveFacts([{ content: 'a' }, { content: 'b' }]);

    const facts = bodyOf(fetchMock.mock.calls[0] as unknown[]).facts as Array<{ id?: string }>;
    expect(facts.map((f) => f.id).every(Boolean)).toBe(true);
    expect(facts[0]!.id).not.toBe(facts[1]!.id);
  });
});

describe('defaultProjectId is actually applied', () => {
  // It was declared on the config and never read, so callers who set it
  // silently got unscoped writes.
  test('fills in a missing projectId', async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: 'x' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await client({ defaultProjectId: 'acme' }).saveFact({ content: 'x' });

    expect(bodyOf(fetchMock.mock.calls[0] as unknown[]).projectId).toBe('acme');
  });

  test('does not override an explicit projectId', async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: 'x' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await client({ defaultProjectId: 'acme' }).saveFact({ content: 'x', projectId: 'zenith' });

    expect(bodyOf(fetchMock.mock.calls[0] as unknown[]).projectId).toBe('zenith');
  });
});

describe('cancellation is honoured', () => {
  // addEventListener never fires for an ALREADY-aborted signal, so the fresh
  // AbortController stayed un-aborted and the call was re-issued for every
  // remaining retry.
  test('an already-aborted signal performs zero fetches', async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: 'x' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ctl = new AbortController();
    ctl.abort(new Error('caller gave up'));

    await expect(client().saveFact({ content: 'x' }, { signal: ctl.signal })).rejects.toThrow(
      'caller gave up',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a signal aborted between attempts stops the retry loop', async () => {
    const ctl = new AbortController();
    const fetchMock = vi.fn(async () => {
      // Fail the first attempt, and cancel while the backoff is pending.
      ctl.abort(new Error('caller gave up'));
      throw new TypeError('network error');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      client({ retries: 3 }).saveFact({ content: 'x' }, { signal: ctl.signal }),
    ).rejects.toThrow();
    // One real attempt; the remaining retries are abandoned rather than
    // hammering a service the caller has stopped waiting on.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
