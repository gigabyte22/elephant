// Streamable HTTP transport (stateless mode): one transport + McpServer pair
// per request, no session ids. Suitable for remote hosts; stdio remains the
// default for local use.

import { type IncomingMessage, type Server, createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpConfig } from './config.ts';
import { buildServer } from './server.ts';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function serveHttp(config: McpConfig): Promise<Server> {
  const httpServer = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const { server } = buildServer(config);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readJsonBody(req));
    } catch (err) {
      console.error('[elephant-mcp] request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: null,
          }),
        );
      }
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(config.port, '127.0.0.1', resolve));
  return httpServer;
}
