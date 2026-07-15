# @elephant/client

Typed HTTP client for the elephant memory service. One method per route,
Bearer auth, `{ ok, data } / { ok, error }` envelope unwrapping, retries with
exponential backoff on 5xx and network errors, AbortSignal-aware timeouts.

This is a **private, source-only workspace package** — it exports raw
TypeScript (`src/index.ts`) and is consumed by the adapter packages in
`adapters/` either directly (tsx) or bundled at build time. It is not
published to npm.

```ts
import { ElephantClient } from '@elephant/client';

const elephant = new ElephantClient({
  url: process.env.MEMORY_SERVICE_URL ?? 'http://127.0.0.1:18790',
  token: process.env.MEMORY_SERVICE_TOKEN!,
});

const health = await elephant.health();
const fact = await elephant.saveFact({
  content: 'the deploy dashboard lives behind the vpn',
  agentId: 'assistant',
  actor: 'assistant',
});
const { facts } = await elephant.recall({ q: 'deploy dashboard', agentId: 'assistant' });
```

## Compatibility

The wire types in `src/wire-types.ts` mirror the service's
`src/models/wire.ts` by deliberate duplication — the repo convention is that
consumers do **not** import service source. Pin compatibility at startup via
`GET /health` (embedder dim, schema vector dim) and keep this package in sync
when the service's wire shapes change. `adapters/openclaw/vendor/` carries a
generated copy; regenerate it with `pnpm sync:vendored-client` after editing
anything under `src/`.
