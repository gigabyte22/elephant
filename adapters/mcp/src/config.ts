// Env + CLI configuration for the elephant MCP server.
//
// Scope model: the MCP host is one "agent" talking to elephant. agentId
// identifies the host (e.g. 'claude-code'), sessionId defaults to a
// per-process id so observations group naturally, and projectId/userId are
// optional cross-cutting axes. Every axis gets a recall mode (boost by
// default) matching elephant's /recall contract.

import { randomUUID } from 'node:crypto';
import type { ScopeMode } from '@elephant/client';

export interface McpScopeConfig {
  agentId: string;
  sessionId: string;
  projectId?: string;
  userId?: string;
  agentScope: ScopeMode;
  sessionScope: ScopeMode;
  projectScope: ScopeMode;
  userScope: ScopeMode;
}

export interface McpConfig {
  url: string;
  token: string;
  scope: McpScopeConfig;
  transport: 'stdio' | 'http';
  port: number;
}

const SCOPE_MODES: ScopeMode[] = ['boost', 'filter', 'none', 'strict'];

function scopeMode(name: string, fallback: ScopeMode): ScopeMode {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!SCOPE_MODES.includes(raw as ScopeMode)) {
    throw new Error(`${name} must be one of ${SCOPE_MODES.join('|')}, got "${raw}"`);
  }
  return raw as ScopeMode;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): McpConfig {
  const token = process.env.MEMORY_SERVICE_TOKEN;
  if (!token || token.length < 8) {
    throw new Error('MEMORY_SERVICE_TOKEN is required (min 8 chars)');
  }

  let transport: 'stdio' | 'http' = 'stdio';
  let port = 18791;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--transport') {
      const value = argv[++i];
      if (value !== 'stdio' && value !== 'http') {
        throw new Error(`--transport must be stdio or http, got "${value}"`);
      }
      transport = value;
    } else if (argv[i] === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0)
        throw new Error('--port must be a positive integer');
    }
  }

  return {
    url: process.env.MEMORY_SERVICE_URL ?? 'http://127.0.0.1:18790',
    token,
    scope: {
      agentId: process.env.ELEPHANT_AGENT_ID ?? 'mcp',
      sessionId: process.env.ELEPHANT_SESSION_ID ?? `mcp:${randomUUID()}`,
      projectId: process.env.ELEPHANT_PROJECT_ID || undefined,
      userId: process.env.ELEPHANT_USER_ID || undefined,
      agentScope: scopeMode('ELEPHANT_AGENT_SCOPE', 'boost'),
      sessionScope: scopeMode('ELEPHANT_SESSION_SCOPE', 'boost'),
      projectScope: scopeMode('ELEPHANT_PROJECT_SCOPE', 'none'),
      userScope: scopeMode('ELEPHANT_USER_SCOPE', 'none'),
    },
    transport,
    port,
  };
}
