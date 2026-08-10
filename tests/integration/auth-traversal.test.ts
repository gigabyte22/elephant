// Path-traversal probes against the auth exemption and the static handler.
//
// `bearerAuth` exempts any URL whose *raw string* starts with `/dashboard` and
// does not start with `/dashboard/api/`, so the browser can load the SPA shell
// before the user pastes a token. That exemption is a prefix test on
// `req.url`, which means anything that looks like `/dashboard...` skips auth
// and only then gets routed. Two things must hold for that to be safe:
//
//   1. A traversal-shaped URL must never reach an authenticated API route.
//      `/dashboard/../facts` skips auth by string; if routing later resolves
//      it to `/facts`, memory content is readable with no token.
//   2. @fastify/static must never serve a file outside web/dist. The repo root
//      holds `.env` (NEO4J_PASSWORD, provider API keys) two levels up from
//      the static root, and the whole /dashboard prefix is unauthenticated.
//
// These are regression tests, not a vulnerability report: they should pass
// today and fail loudly if the exemption, the static config, or the
// @fastify/static version regresses.

import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeEmbeddingAdapter, createFakeLLMAdapter } from '../../src/adapters/fakes.ts';
import { buildHttpServer } from '../../src/http/server.ts';
import { bootstrap, type Container, shutdown } from '../../src/index.ts';

// No TOKEN here on purpose — every probe in this file is unauthenticated.
const EMBED_DIM = Number(process.env.__TEST_EMBED_DIM ?? 256);

let container: Container;
let app: Awaited<ReturnType<typeof buildHttpServer>>;
let port: number;

beforeAll(async () => {
  container = await bootstrap({
    llm: createFakeLLMAdapter(),
    embedder: createFakeEmbeddingAdapter({ dim: EMBED_DIM }),
  });
  app = await buildHttpServer(container);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
});

// `app.inject` runs through light-my-request, which collapses `../` segments
// before Fastify sees the URL — so an injected `/dashboard/../x` arrives as
// `/x` and never exercises the exemption at all. A raw socket is the only way
// to put literal dot segments in the request line and reach `req.url` intact.
function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.setTimeout(10_000, () => socket.destroy(new Error(`timeout on ${path}`)));
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = Number(raw.slice(9, 12));
      resolve({ status, body: raw });
    });
  });
}

afterAll(async () => {
  await app?.close();
  await shutdown();
});

// Every encoding an attacker gets for free: raw dots, percent-encoded dots,
// percent-encoded separators, doubled encoding, backslashes, and the `..;`
// parameter trick that some routers strip before matching.
const escapes = [
  '..',
  '..%2f',
  '%2e%2e/',
  '%2e%2e%2f',
  '%252e%252e%252f',
  '..%5c',
  '..%252f',
  '..;',
  '.%2e/',
];

describe('auth exemption cannot be escaped into an API route', () => {
  // Baseline: the exemption itself works as documented, so a failure below is
  // about traversal and not about auth being off entirely.
  test('an API route rejects a missing token', async () => {
    const res = await app.inject({ method: 'GET', url: '/facts?limit=1' });
    expect(res.statusCode).toBe(401);
  });

  test('/dashboard/api/* is not exempted', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/api/overview' });
    expect(res.statusCode).toBe(401);
  });

  test('the SPA shell itself stays reachable without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/' });
    expect(res.statusCode).toBe(200);
  });

  for (const esc of escapes) {
    for (const target of ['facts', 'recall?q=x', 'dashboard/api/overview']) {
      const url = `/dashboard/${esc}/${target}`;

      test(`no unauthenticated data from ${url}`, async () => {
        const res = await app.inject({ method: 'GET', url });

        // An HTML response is the SPA fallback — benign, that shell is public.
        // The failure we care about is a JSON envelope carrying data, which
        // would mean the request reached a real handler without a token.
        // 401 (auth), 403 (static rejects the escape), and 404 (no such route)
        // are all correct rejections — the assertion is that nothing 2xx comes
        // back from a handler that should have demanded a token.
        const contentType = String(res.headers['content-type'] ?? '');
        if (contentType.includes('application/json')) {
          expect(
            res.statusCode,
            `traversal reached a JSON handler without being rejected: ${url}`,
          ).toBeGreaterThanOrEqual(400);
        }
        expect(
          res.body.includes('"ok":true'),
          `traversal returned a success envelope from ${url}`,
        ).toBe(false);
      });
    }
  }
});

describe('static handler cannot serve files outside web/dist', () => {
  // Repo-root files that the static root must never reach. `.env` is the one
  // that matters: it holds NEO4J_PASSWORD and provider keys.
  const secrets = [
    { path: '.env', marker: 'NEO4J_PASSWORD' },
    { path: '.env.example', marker: 'NEO4J_PASSWORD' },
    { path: 'package.json', marker: '"name": "elephant"' },
    { path: 'CLAUDE.md', marker: 'Neo4j-backed long-term memory' },
  ];

  for (const esc of escapes) {
    for (const { path, marker } of secrets) {
      // web/dist is two levels below the repo root, so two hops escape it.
      const url = `/dashboard/${esc}/${esc}/${path}`;

      test(`does not disclose ${path} via ${esc}`, async () => {
        const res = await app.inject({ method: 'GET', url });
        expect(
          res.body.includes(marker),
          `served ${path} contents from ${url} (status ${res.statusCode})`,
        ).toBe(false);
      });
    }
  }

  test('does not disclose the service source tree', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/../../src/http/auth.ts',
    });
    expect(res.body.includes('bearerAuth')).toBe(false);
  });
});

// The decisive cases: literal dot segments, delivered over a socket so nothing
// normalizes them on the way in. `req.url` keeps its `/dashboard` prefix here,
// so auth is genuinely skipped and only @fastify/static stands between the
// request and the repo root.
describe('literal dot segments over a raw socket', () => {
  const probes = [
    { path: '/dashboard/../../.env', marker: 'NEO4J_PASSWORD' },
    { path: '/dashboard/../../package.json', marker: '"name": "elephant"' },
    { path: '/dashboard/../../src/http/auth.ts', marker: 'bearerAuth' },
    { path: '/dashboard/./../../.env', marker: 'NEO4J_PASSWORD' },
    { path: '/dashboard//../../.env', marker: 'NEO4J_PASSWORD' },
    { path: '/dashboard/..//..//.env', marker: 'NEO4J_PASSWORD' },
  ];

  for (const { path, marker } of probes) {
    test(`rejects ${path}`, async () => {
      const res = await rawGet(path);
      expect(res.body.includes(marker), `disclosed ${marker} via ${path}`).toBe(false);
      expect(res.status, `${path} returned 200`).not.toBe(200);
    });
  }

  // Same escape aimed at an authenticated API route rather than a file.
  test('cannot reach /facts unauthenticated', async () => {
    const res = await rawGet('/dashboard/../facts?limit=1');
    expect(res.body.includes('"ok":true'), 'reached /facts without a token').toBe(false);
  });
});
