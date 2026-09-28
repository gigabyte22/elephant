# @gigabyte22/elephant-client

Typed HTTP client for the elephant memory service. One method per route,
Bearer auth, `{ ok, data } / { ok, error }` envelope unwrapping, retries with
exponential backoff on 5xx and network errors, AbortSignal-aware timeouts.

```bash
npm install @gigabyte22/elephant-client
```

The published package is compiled ESM with type declarations (Node ≥ 22, no
runtime dependencies). Inside this repo the workspace resolves the package to
its TypeScript source, so the adapters in `adapters/` and the integration tests
use it without a build step.

```ts
import { ElephantClient } from '@gigabyte22/elephant-client';

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

Wire notes for bi-temporal fields: facts always expose `validFrom` / `validTo`
(event time) and `recordedAt` (transaction time). Preferences may include
optional `recordedAt` on newer servers — treat it as additive. `saveFact`
`validFrom` is optional; when omitted with `sourceEpisodeId`, the server uses
the episode timestamp.

## Releasing

The version in `package.json` is the release. Bump it, merge, then push a tag
named `client-v<version>` (for example `client-v0.2.0`). The `publish-client`
workflow checks that the tag matches the version, runs typecheck, tests and
build, and publishes to npm with `pnpm publish`, which swaps in the `dist`
entry points from `publishConfig`. `pnpm --filter @gigabyte22/elephant-client
pack` builds the same tarball locally.
