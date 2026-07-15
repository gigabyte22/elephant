// Round-trips a real MCP client over the streamable HTTP transport against
// serveHttp on an ephemeral port. listTools needs no elephant, so fetch stays
// unstubbed (the MCP client itself uses fetch).

import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { McpConfig } from '../src/config.ts';
import { serveHttp } from '../src/http.ts';

const config: McpConfig = {
  url: 'http://elephant.test',
  token: 'tok-12345678',
  scope: {
    agentId: 'http-host',
    sessionId: 's-http',
    projectId: undefined,
    userId: undefined,
    agentScope: 'boost',
    sessionScope: 'boost',
    projectScope: 'none',
    userScope: 'none',
  },
  transport: 'http',
  port: 0, // ephemeral
};

let httpServer: Awaited<ReturnType<typeof serveHttp>>;
let client: Client;

beforeAll(async () => {
  httpServer = await serveHttp(config);
  const { port } = httpServer.address() as AddressInfo;
  client = new Client({ name: 'http-test-host', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  httpServer?.close();
});

test('initializes and lists the eight tools over streamable HTTP', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    'memory_entity',
    'memory_forget',
    'memory_observe',
    'memory_preference_get',
    'memory_preference_set',
    'memory_recall',
    'memory_save',
    'memory_timeline',
  ]);
});
