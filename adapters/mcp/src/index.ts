// Entry point. Stdio transport (Claude Code / Desktop).
// All logging goes to stderr — stdout belongs to the stdio transport.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { buildServer, probeHealth } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, client } = buildServer(config);
  await probeHealth(client, config.url);

  await server.connect(new StdioServerTransport());
  console.error(`[elephant-mcp] stdio transport connected (elephant at ${config.url})`);
}

main().catch((err) => {
  console.error('[elephant-mcp] fatal:', err);
  process.exit(1);
});
