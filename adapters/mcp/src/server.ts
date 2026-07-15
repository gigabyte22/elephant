import { ElephantClient } from '@elephant/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConfig } from './config.ts';
import { registerTools } from './tools.ts';

export function buildServer(config: McpConfig): { server: McpServer; client: ElephantClient } {
  const client = new ElephantClient({ url: config.url, token: config.token });
  const server = new McpServer({ name: 'elephant', version: '0.1.0' });
  registerTools(server, client, config.scope);
  return { server, client };
}

/** Non-fatal startup probe — elephant may come up after the MCP host does. */
export async function probeHealth(client: ElephantClient, url: string): Promise<void> {
  try {
    const health = await client.health({ timeoutMs: 3_000, retries: 0 });
    if (!health.neo4j) {
      console.error(`[elephant-mcp] ${url} reachable but Neo4j is down — tools will error`);
    }
  } catch (err) {
    console.error(
      `[elephant-mcp] elephant not reachable at ${url} (${(err as Error).message}) — continuing, tools will retry`,
    );
  }
}
