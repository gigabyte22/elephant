// Entry point. Stdio transport by default (Claude Code / Desktop);
// `--transport http --port N` serves streamable HTTP on 127.0.0.1 instead.
// All logging goes to stderr — stdout belongs to the stdio transport.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { serveHttp } from './http.ts';
import { buildServer, probeHealth } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, client } = buildServer(config);
  await probeHealth(client, config.url);

  if (config.transport === 'http') {
    await serveHttp(config);
    console.error(
      `[elephant-mcp] streamable HTTP on http://127.0.0.1:${config.port}/mcp (elephant at ${config.url})`,
    );
    return;
  }

  await server.connect(new StdioServerTransport());
  console.error(`[elephant-mcp] stdio transport connected (elephant at ${config.url})`);
}

main().catch((err) => {
  console.error('[elephant-mcp] fatal:', err);
  process.exit(1);
});
