# Integration Guide — Adopting Elephant from an Agent Orchestration Layer

This guide shows how to wire the elephant memory service into a TypeScript agent orchestrator — any system that runs agents in a loop, builds prompts, and exposes tool-calling. The file paths and agent names below (`src/memory/...`, `assistant`, `scheduler-agent`, …) are placeholders; substitute your own.

The goal is total replacement of the orchestrator's bespoke memory primitives. Where a typical orchestrator has a `MemoryStore` (markdown + keyword recall), a `SessionMemory` (in-memory token-budgeted history), and static per-agent persona files, this document shows what each becomes once elephant is the source of truth.

---

## 1. What elephant gives you that bare prompts and markdown do not

A typical agent loop today stuffs a static markdown blob into every system prompt and calls it "memory". That gets you keyword recall at best, no temporal model, no consolidation, no cross-agent sharing, no audit trail. Elephant replaces that with:

- **Semantic recall over a hybrid GraphRAG index** — vector + full-text fusion across facts, episode chunks, preferences, insights, knowledge documents, procedures, and research, with reciprocal-rank fusion and optional LLM rerank.
- **Bi-temporal facts** — every fact has `validFrom` / `validTo` and `recordedAt`. You can ask "what did the agent believe on date X?" via [`GET /timeline`](src/http/routes/timeline.ts), and supersede outdated beliefs with full audit history.
- **Dreaming consolidation** — a scheduled cycle (default 03:00 UTC) extracts facts from raw episodes, dedupes them semantically, promotes high-importance facts into insights, and prunes stale low-importance ones.
- **Scoped knowledge** — every memory item carries optional `agentId`, `sessionId`, `projectId`, `userId`. Queries can `boost` the agent's own memories while still recalling cross-agent knowledge, or hard-`filter` to hermetic scope.
- **Procedures with success metrics** — versioned, reusable instructions with `whenToUse`, `successRate`, and `invocationCount`. Maps cleanly onto an orchestrator's skill / playbook system.
- **Audit log + archived revisions** — every write is auditable; updates archive the prior snapshot. Answers "why does the agent think this?" and "who told it that?".
- **Pluggable working state** — non-memory KV (Neo4j or Redis backend) for live orchestration state with TTLs.

```
┌───────────────────────────┐         HTTP / Bearer-auth        ┌───────────────────────────┐
│  your orchestrator        │  ────────────────────────────►   │  elephant (memory svc)    │
│                           │                                   │                           │
│  ┌────────────────────┐   │   POST /episodes                  │  ingestion pipeline       │
│  │ Agent loop         │   │   POST /facts                     │     ↓                     │
│  │  ↳ prompt build    │   │   POST /observations              │  Neo4j graph              │
│  │  ↳ tool dispatch   │   │   GET  /recall                    │   - Episodes / Chunks     │
│  │  ↳ session memory  │   │   PUT  /preferences/:key          │   - Facts (bi-temporal)   │
│  └────────────────────┘   │   POST /procedures                │   - Entities / Insights   │
│                           │   POST /state                     │   - Knowledge / Procs     │
│  ┌────────────────────┐   │   GET  /audit/:id                 │  Working state (Neo4j or  │
│  │ ElephantClient     │   │   ...                             │   Redis) + Audit log      │
│  └────────────────────┘   │                                   │                           │
└───────────────────────────┘                                   └───────────────────────────┘
```

The HTTP API is the only public surface. There is no SDK, no shared library, no in-process embedding. That is intentional — elephant is a service, and a service is the only thing that can be consolidated by a background dreamer without coordinating with every consumer.

---

## 2. The mental model

Map the orchestrator's existing concerns to elephant primitives once. Everything else follows.

| Orchestrator concern                | Elephant primitive                                         | Why this and not something else                                                                          |
| ----------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Conversation transcript             | `Episode` (auto-chunked, summarized, embedded)             | Long-form raw kept whole; chunking + embedding handled server-side; feeds dreaming                       |
| Stable beliefs about the world      | `Fact` (bi-temporal, supersedable)                         | Beliefs change; supersede preserves history; bi-temporal answers "what did we know on date X"            |
| Discovered entities                 | `Entity` (auto-upserted via `entityNames` on facts)        | Hub for graph expansion in retrieval                                                                     |
| User preferences                    | `Preference` (versioned key/value, auto-supersede on PUT)  | First-class KV with versioning; dedicated wire shape                                                     |
| Mid-conversation observations       | `Observation` (TTL'd, default 7 days)                      | Short-lived working memory scoped to a session; surfaces in next turn's recall                           |
| Live orchestration state            | `WorkingStateEntry` (TTL KV; Neo4j or Redis)               | Not a memory item — no embedding, no consolidation. For "current task id", "summary cache", etc.         |
| Reusable instructions / playbooks   | `Procedure` (versioned, with `whenToUse` + success stats)  | Maps 1:1 to orchestrator skills; `whenToUse` is embedded so retrieval can suggest unknown procedures     |
| External reference docs             | `KnowledgeDocument` (+ auto-`KnowledgeChunk`)              | Books, manuals, scoped by project/user, durable                                                          |
| Web research artifacts              | `Research` (`projectId` mandatory, expirable)              | Time-bound, project-scoped; segregated from durable knowledge                                            |
| Promoted patterns from many facts   | `Insight` (output of dreaming)                             | Don't write directly; produced by consolidation                                                          |
| Change history / provenance         | `AuditEvent` + `ArchivedRevision`                          | Every write produces an event; updates archive a snapshot                                                |

### Scope axes

Every memory item except `WorkingStateEntry` carries up to four optional scope fields: `agentId`, `sessionId`, `projectId`, `userId`. Every recall query carries a corresponding mode per axis: `boost`, `filter`, or `none`.

- `boost` — items in the scope rank higher; items outside still match.
- `filter` — hard filter; items outside the scope are excluded.
- `none` — the axis is ignored.

Defaults (see [src/http/routes/recall.ts](src/http/routes/recall.ts)):

| Axis        | Default  |
| ----------- | -------- |
| `agentId`   | `boost`  |
| `sessionId` | `boost`  |
| `projectId` | `none`   |
| `userId`    | `none`   |

Map your orchestrator's identifiers to scope:

- `agentId` → the agent's name in your registry (`assistant`, `research-agent`, `scheduler-agent`, …).
- `sessionId` → derived from channel + identity (e.g. `telegram:${chatId}`, `web:${connectionId}`).
- `projectId` → a configured default project id for general traffic; the project ID when running inside a project-scoped channel.
- `userId` → channel identity when known (chat username, authenticated web user). Enables "follows-the-user-across-channels" recall.

---

## 3. Wiring elephant into your orchestrator — file by file

Six changes. Each section names an example file, states the change, and gives the working code. Adapt paths and types to your codebase.

### 3.1 Add the client wrapper

**New file: `src/memory/elephant-client.ts`**

A thin wrapper over the HTTP API. One method per route, returning the wire types lifted from [`src/models/wire.ts`](src/models/wire.ts). Bearer auth, retries on 5xx, typed errors.

```ts
// src/memory/elephant-client.ts

// ── Wire types (mirror elephant's src/models/wire.ts) ──────────────────────

export interface WireScope {
  projectId?: string;
  userId?: string;
}

export interface WireFact extends WireScope {
  id: string;
  content: string;
  category?: string;
  confidence: number;
  importance: number;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  entities: string[];
  supersedes?: string;
  sourceEpisodeId?: string;
  refCount?: number;
  originAgentId?: string | null;
  originSessionId?: string | null;
}

export type WireFactWithScore = WireFact & { score: number; expansionReason?: string };

export interface WirePreference extends WireScope {
  key: string;
  value: string;
  confidence: number;
  validFrom: string;
  validTo: string | null;
}

export interface WireObservation extends WireScope {
  id: string;
  agentId: string;
  sessionId: string;
  content: string;
  recordedAt: string;
  expiresAt: string;
}

export interface WireInsight extends WireScope {
  id: string;
  content: string;
  promotedFromFactIds: string[];
  createdAt: string;
}

export interface WireProcedure extends WireScope {
  id: string;
  name: string;
  version: number;
  content: string;
  whenToUse: string;
  successRate: number;
  invocationCount: number;
  lastSuccessAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireKnowledgeDocument extends WireScope {
  id: string;
  title: string;
  source: string;
  sourceUri?: string;
  contentHash?: string;
  summary: string;
  tags: string[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireResearch extends WireKnowledgeDocument {
  projectId: string;
}

export interface WireWorkingStateEntry {
  scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string };
  key: string;
  value: unknown;
  expiresAt: string | null;
  updatedAt: string;
}

export interface WireAuditEvent {
  id: string;
  kind: 'create' | 'update' | 'supersede' | 'soft_delete' | 'prune' | 'promote' | 'archive';
  targetId: string;
  targetKind: string;
  payload: unknown;
  at: string;
  actor?: string;
}

// ── Recall request shape ──────────────────────────────────────────────────

export type ScopeMode = 'boost' | 'filter' | 'none' | 'strict';

export interface RecallQuery {
  q: string;
  agentId?: string;
  sessionId?: string;
  projectId?: string;
  userId?: string;
  agentScope?: ScopeMode;
  sessionScope?: ScopeMode;
  projectScope?: ScopeMode;
  userScope?: ScopeMode;
  kinds?: Array<
    | 'episode' | 'chunk' | 'fact' | 'preference' | 'insight'
    | 'observation' | 'knowledge_document' | 'knowledge_chunk'
    | 'procedure' | 'research' | 'research_chunk' | 'intention'
  >;
  from?: Date;
  to?: Date;
  minImportance?: number;
  minConfidence?: number;
  limit?: number;
  includeSuperseded?: boolean;
  entityId?: string;
  includeChunks?: boolean;
  includePreferences?: boolean;
  includeInsights?: boolean;
  includeKnowledge?: boolean;
  includeProcedures?: boolean;
  includeResearch?: boolean;
  includeIntentions?: boolean;
  rerank?: boolean;
  ppr?: boolean;          // personalized PageRank; no-ops without a GDS projection
  debug?: boolean;
  chunkNeighborRadius?: 1 | 2 | 3;
}

export interface RecallResult {
  facts: WireFactWithScore[];
  entities?: Array<{ id: string; name: string; type: string }>;
  chunks?: Array<{ id: string; episodeId: string; position: number; text: string; createdAt: string; score: number }>;
  preferences?: Array<WirePreference & { score: number }>;
  insights?: Array<WireInsight & { score: number }>;
  knowledgeChunks?: Array<{ id: string; documentId: string; position: number; text: string; createdAt: string; score: number }>;
  procedures?: Array<WireProcedure & { score: number }>;
  research?: Array<WireResearch & { score: number }>;
  researchChunks?: Array<{ id: string; researchId: string; position: number; text: string; createdAt: string; score: number }>;
  intentions?: Array<WireIntention & { score: number }>;
  trace?: { stageTimingsMs: Record<string, number>; rerankUsed: boolean; candidatesSeen: Record<string, number> };
}

// ── Errors ─────────────────────────────────────────────────────────────────

export class ElephantError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

export interface ElephantConfig {
  url: string;
  token: string;
  defaultProjectId?: string;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Retry budget for 5xx + network errors. Default 3. */
  retries?: number;
}

export class ElephantClient {
  constructor(private readonly cfg: ElephantConfig) {}

  // ─ Health ──
  health(): Promise<{ neo4j: boolean; llm: { name: string; maxContextTokens: number }; embedder: { name: string; dim: number; maxInputTokens: number }; dream: { lastRun: string | null; lastRunDurationMs: number | null; running: boolean; runningJobId: string | null; backlogEstimate: number | null } }> {
    return this.get('/health');
  }

  // ─ Episodes ──
  ingestEpisode(input: {
    id?: string;
    agentId: string;
    sessionId: string;
    rawTranscript: string;
    summary?: string;
    timestamp?: Date;
  }): Promise<{ episodeId: string }> {
    return this.post('/episodes', input);
  }

  // ─ Facts ──
  saveFact(input: {
    id?: string;
    content: string;
    category?: string;
    confidence?: number;
    importance?: number;
    validFrom?: Date;
    entityNames?: string[];
    sourceEpisodeId?: string;
  }): Promise<WireFact> {
    return this.post('/facts', input);
  }
  saveFacts(facts: Array<Parameters<ElephantClient['saveFact']>[0]>): Promise<WireFact[]> {
    return this.post('/facts/batch', { facts });
  }
  supersedeFact(oldId: string, newFactId: string, reason: string): Promise<{ ok: true }> {
    return this.post(`/facts/${oldId}/supersede`, { newFactId, reason });
  }
  deleteFact(id: string): Promise<{ deleted: true }> {
    return this.delete(`/facts/${id}`);
  }

  // ─ Recall + Timeline ──
  recall(q: RecallQuery): Promise<RecallResult> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined) continue;
      if (v instanceof Date) params.set(k, v.toISOString());
      // Arrays (e.g. `kinds`) stringify to comma-separated lists, which is the wire format.
      else params.set(k, String(v));
    }
    return this.get(`/recall?${params.toString()}`);
  }
  timeline(at: Date, opts?: { entityId?: string; preferenceKey?: string; limit?: number }): Promise<{ at: string; facts: WireFact[]; preference?: WirePreference | null }> {
    const params = new URLSearchParams({ at: at.toISOString() });
    if (opts?.entityId) params.set('entityId', opts.entityId);
    if (opts?.preferenceKey) params.set('preferenceKey', opts.preferenceKey);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.get(`/timeline?${params.toString()}`);
  }

  // ─ Entities ──
  getEntity(id: string, includeSuperseded = false): Promise<{ entity: { id: string; name: string; type: string }; facts: WireFact[] }> {
    return this.get(`/entities/${id}?includeSuperseded=${includeSuperseded}`);
  }
  searchEntities(name: string, limit = 10): Promise<{ entities: Array<{ id: string; name: string; type: string }> }> {
    return this.get(`/entities?name=${encodeURIComponent(name)}&limit=${limit}`);
  }

  // ─ Preferences ──
  listPreferences(): Promise<{ preferences: WirePreference[] }> { return this.get('/preferences'); }
  getPreference(key: string): Promise<WirePreference> { return this.get(`/preferences/${encodeURIComponent(key)}`); }
  putPreference(key: string, value: string, confidence?: number): Promise<WirePreference> {
    return this.request('PUT', `/preferences/${encodeURIComponent(key)}`, { value, confidence });
  }

  // ─ Observations ──
  writeObservation(input: { id?: string; agentId: string; sessionId: string; content: string }): Promise<WireObservation> {
    return this.post('/observations', input);
  }
  listObservations(sessionId: string, limit = 100): Promise<{ observations: WireObservation[] }> {
    return this.get(`/observations?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`);
  }

  // ─ Dream ──
  triggerDream(): Promise<{ jobId: string }> { return this.post('/dream', {}); }
  dreamStatus(jobId: string) { return this.get(`/dream/${jobId}`); }

  // ─ Knowledge ──
  ingestKnowledge(input: {
    id?: string;
    title: string;
    source: string;
    sourceUri?: string;
    content: string;
    summary?: string;
    tags?: string[];
    expiresAt?: Date | null;
    scope?: { projectId?: string; userId?: string };
    actor?: string;
  }): Promise<WireKnowledgeDocument> { return this.post('/knowledge/documents', input); }
  getKnowledge(id: string): Promise<WireKnowledgeDocument> { return this.get(`/knowledge/documents/${id}`); }
  listKnowledge(opts?: { projectId?: string; userId?: string; limit?: number }): Promise<WireKnowledgeDocument[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts ?? {})) if (v !== undefined) params.set(k, String(v));
    return this.get(`/knowledge/documents?${params.toString()}`);
  }
  deleteKnowledge(id: string, purge = false): Promise<{ deleted: true; chunksDeleted: number }> {
    return this.delete(`/knowledge/documents/${id}?purge=${purge}`);
  }

  // ─ Procedures ──
  createProcedure(input: {
    id?: string;
    name: string;
    content: string;
    whenToUse: string;
    scope?: { projectId?: string; userId?: string };
    expiresAt?: Date | null;
    actor?: string;
  }): Promise<WireProcedure> { return this.post('/procedures', input); }
  getProcedure(id: string): Promise<WireProcedure> { return this.get(`/procedures/${id}`); }
  getProcedureByName(name: string, scope?: { projectId?: string; userId?: string }): Promise<WireProcedure[]> {
    const params = new URLSearchParams({ name });
    if (scope?.projectId) params.set('projectId', scope.projectId);
    if (scope?.userId) params.set('userId', scope.userId);
    return this.get(`/procedures?${params.toString()}`);
  }
  updateProcedure(id: string, patch: Partial<{
    content: string;
    whenToUse: string;
    successRate: number;
    invocationCount: number;
    lastSuccessAt: Date | null;
    expiresAt: Date | null;
    reason: string;
    actor: string;
  }>): Promise<WireProcedure> { return this.request('PUT', `/procedures/${id}`, patch); }
  listProcedures(opts?: { projectId?: string; userId?: string; limit?: number }): Promise<WireProcedure[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts ?? {})) if (v !== undefined) params.set(k, String(v));
    return this.get(`/procedures?${params.toString()}`);
  }
  deleteProcedure(id: string): Promise<{ deleted: true }> { return this.delete(`/procedures/${id}`); }

  // ─ Research ──
  createResearch(input: {
    id?: string;
    title: string;
    source: string;
    sourceUri?: string;
    content: string;
    summary?: string;
    tags?: string[];
    projectId: string;
    userId?: string;
    expiresAt?: Date | null;
    actor?: string;
  }): Promise<WireResearch> { return this.post('/research', input); }
  // `projectId` scopes the read — a cross-project id 404s rather than 403s.
  getResearch(id: string, projectId?: string): Promise<WireResearch> {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.get(`/research/${id}${q}`);
  }
  updateResearch(id: string, patch: Partial<{
    title: string;
    content: string;
    summary: string;
    tags: string[];
    sourceUri: string;
    expiresAt: Date | null;
    reason: string;
    actor: string;
  }>): Promise<WireResearch> { return this.request('PUT', `/research/${id}`, patch); }
  listResearch(opts: { projectId: string; userId?: string; limit?: number }): Promise<WireResearch[]> {
    const params = new URLSearchParams({ projectId: opts.projectId });
    if (opts.userId) params.set('userId', opts.userId);
    if (opts.limit) params.set('limit', String(opts.limit));
    return this.get(`/research?${params.toString()}`);
  }
  deleteResearch(id: string): Promise<{ deleted: true }> { return this.delete(`/research/${id}`); }

  // ─ Working state ──
  setState(input: {
    scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string };
    key: string;
    value: unknown;
    ttlSec?: number;
  }): Promise<{ ok: true }> { return this.post('/state', input); }
  getState(key: string, scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string }): Promise<WireWorkingStateEntry> {
    const params = new URLSearchParams({ agentId: scope.agentId });
    if (scope.sessionId) params.set('sessionId', scope.sessionId);
    if (scope.userId) params.set('userId', scope.userId);
    if (scope.projectId) params.set('projectId', scope.projectId);
    return this.get(`/state/${encodeURIComponent(key)}?${params.toString()}`);
  }
  deleteState(key: string, scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string }): Promise<{ deleted: true }> {
    const params = new URLSearchParams({ agentId: scope.agentId });
    if (scope.sessionId) params.set('sessionId', scope.sessionId);
    if (scope.userId) params.set('userId', scope.userId);
    if (scope.projectId) params.set('projectId', scope.projectId);
    return this.delete(`/state/${encodeURIComponent(key)}?${params.toString()}`);
  }
  listState(scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string; prefix?: string }): Promise<WireWorkingStateEntry[]> {
    const params = new URLSearchParams({ agentId: scope.agentId });
    if (scope.sessionId) params.set('sessionId', scope.sessionId);
    if (scope.userId) params.set('userId', scope.userId);
    if (scope.projectId) params.set('projectId', scope.projectId);
    if (scope.prefix) params.set('prefix', scope.prefix);
    return this.get(`/state?${params.toString()}`);
  }

  // ─ Audit ──
  audit(targetId: string, limit = 100) { return this.get(`/audit/${targetId}?limit=${limit}`); }
  auditList(opts?: { actor?: string; from?: Date; to?: Date; limit?: number }): Promise<WireAuditEvent[]> {
    const params = new URLSearchParams();
    if (opts?.actor) params.set('actor', opts.actor);
    if (opts?.from) params.set('from', opts.from.toISOString());
    if (opts?.to) params.set('to', opts.to.toISOString());
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.get(`/audit?${params.toString()}`);
  }

  // ─ HTTP plumbing ──
  private get<T>(path: string) { return this.request<T>('GET', path); }
  private post<T>(path: string, body: unknown) { return this.request<T>('POST', path, body); }
  private delete<T>(path: string) { return this.request<T>('DELETE', path); }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const retries = this.cfg.retries ?? 3;
    const timeoutMs = this.cfg.timeoutMs ?? 30_000;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.cfg.url}${path}`, {
          method,
          signal: ctl.signal,
          headers: {
            authorization: `Bearer ${this.cfg.token}`,
            ...(body !== undefined && { 'content-type': 'application/json' }),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
        if (!res.ok || !json?.ok) {
          const message = json?.error ?? `${method} ${path} -> ${res.status}`;
          if (res.status >= 500 && attempt < retries) { lastErr = new ElephantError(res.status, message, json); continue; }
          throw new ElephantError(res.status, message, json);
        }
        return json.data as T;
      } catch (err) {
        lastErr = err;
        if (attempt < retries && (err instanceof ElephantError === false || (err as ElephantError).status >= 500)) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(t);
      }
    }
    throw lastErr;
  }
}
```

Every response follows the envelope `{ ok: true, data: ... }` on success and `{ ok: false, error: "..." }` on failure — the plumbing above unwraps it once so callers only ever see `data`.

### 3.2 Configuration

**Edit your orchestrator's `.env.example`** (add):

```bash
ELEPHANT_URL=http://127.0.0.1:18790
ELEPHANT_SERVICE_TOKEN=change-me-min-8-chars
ELEPHANT_DEFAULT_PROJECT_ID=my-project
```

**Edit your config loader** (e.g. `config/default.ts`) — extend `AppConfig`:

```ts
export interface AppConfig {
  // ... existing fields ...
  elephant: {
    url: string;
    token: string;
    defaultProjectId: string;
  };
}

// in loadConfig():
elephant: {
  url: process.env.ELEPHANT_URL ?? 'http://127.0.0.1:18790',
  token: required('ELEPHANT_SERVICE_TOKEN'),
  defaultProjectId: process.env.ELEPHANT_DEFAULT_PROJECT_ID ?? 'my-project',
},
```

**Run elephant alongside your orchestrator** (compose snippet for reference):

```yaml
# docker-compose.yml fragment
services:
  neo4j:
    image: neo4j:5
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}
      NEO4J_PLUGINS: '["apoc"]'
    ports: ["7687:7687", "7474:7474"]
    volumes: ["neo4j-data:/data"]
  elephant:
    build: ../elephant
    depends_on: [neo4j]
    environment:
      MEMORY_SERVICE_TOKEN: ${ELEPHANT_SERVICE_TOKEN}
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_PASSWORD: ${NEO4J_PASSWORD}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}    # for embeddings
    ports: ["18790:18790"]
volumes: { neo4j-data: {} }
```

### 3.3 Inject the client into `ToolContext`

**Edit your shared types** (e.g. `src/shared/types.ts`) — add to `ToolContext`:

```ts
import type { ElephantClient } from '../memory/elephant-client.js';

export interface ToolContext {
  // ... existing ...
  elephant?: ElephantClient;
}
```

**Edit your entry point** (e.g. `src/index.ts`) — instantiate at boot, fail fast on health check, hand off to the orchestrator:

```ts
import { ElephantClient } from './memory/elephant-client.js';

const elephant = new ElephantClient({
  url: config.elephant.url,
  token: config.elephant.token,
  defaultProjectId: config.elephant.defaultProjectId,
});
const health = await elephant.health();
logger.info({ elephant: health }, 'elephant connected');

orchestrator.setElephant(elephant);
```

**Edit your orchestrator class** (e.g. `src/agents/orchestrator.ts`) — propagate to every agent:

```ts
private elephant?: ElephantClient;

setElephant(client: ElephantClient): void {
  this.elephant = client;
  for (const agent of this.registry.all()) agent.setElephant(client);
}
```

**Edit your agent class** (e.g. `src/agents/agent.ts`) — store the reference and pass it through every tool call:

```ts
private elephant?: ElephantClient;

setElephant(client: ElephantClient): void { this.elephant = client; }

// In the spot where ToolContext is constructed for tool execution:
const ctx: ToolContext = {
  session,
  config: this.config,
  agentName: this.name,
  // ... existing ...
  elephant: this.elephant,
};
```

### 3.4 Replace `MemoryStore`

**Deprecate your bespoke memory store** (e.g. `src/memory/memory-store.ts`). Keep the interface so call sites stay quiet.

**New file: `src/memory/elephant-memory-store.ts`**

```ts
import type { ElephantClient } from './elephant-client.js';

export interface MemoryStore {
  recall(query: string): Promise<string[]>;
  save(fact: string, category?: string): Promise<void>;
  forget(query: string): Promise<number>;
  /** @deprecated Use targeted recall during prompt build. See INTEGRATION.md §4.1. */
  getAll(): Promise<string>;
}

export class ElephantMemoryStore implements MemoryStore {
  constructor(
    private readonly elephant: ElephantClient,
    private readonly scope: { agentId: string; projectId?: string; actor: string },
  ) {}

  async save(fact: string, category?: string): Promise<void> {
    await this.elephant.saveFact({
      content: fact,
      category,
      // origin attribution flows via sourceEpisodeId — set by the per-turn ingest path,
      // not here. A bare fact with no source is acceptable for explicit memory_save.
    });
  }

  async recall(query: string): Promise<string[]> {
    const r = await this.elephant.recall({
      q: query,
      agentId: this.scope.agentId,
      projectId: this.scope.projectId,
      agentScope: 'boost',
      kinds: ['fact', 'insight', 'preference'],
      includeInsights: true,
      includePreferences: true,
      limit: 10,
    });
    const items: string[] = [];
    for (const f of r.facts) items.push(f.content);
    for (const i of r.insights ?? []) items.push(`[insight] ${i.content}`);
    for (const p of r.preferences ?? []) items.push(`[pref ${p.key}] ${p.value}`);
    return items;
  }

  async forget(query: string): Promise<number> {
    const r = await this.elephant.recall({
      q: query, agentId: this.scope.agentId, agentScope: 'boost',
      kinds: ['fact'], limit: 20, minConfidence: 0.6,
    });
    let n = 0;
    for (const f of r.facts) {
      await this.elephant.deleteFact(f.id);
      n++;
    }
    return n;
  }

  /** @deprecated kept only for migration; do not call from prompt build. */
  async getAll(): Promise<string> {
    const r = await this.elephant.recall({
      q: '*', agentId: this.scope.agentId, agentScope: 'boost',
      kinds: ['fact'], limit: 50, minImportance: 0.7,
    });
    let out = '';
    for (const f of r.facts) out += (out ? '\n' : '') + `- ${f.content}`;
    return out;
  }
}
```

### 3.5 Replace `SessionMemory`

**Deprecate your in-memory session history** (e.g. `src/memory/session-memory.ts`). Keep its public interface (`addUser`, `addAssistant`, `addToolCall`, `addToolResult`, `getMessages`, `clear`) so the agent loop doesn't change shape.

The new implementation **mirrors** locally for prompt assembly (token-budget trimming stays a prompt concern), but **also** writes each turn to elephant as an `Observation` and flushes the full transcript as an `Episode` at session close.

```ts
// src/memory/elephant-session-memory.ts
import type { Message } from '../shared/types.js';
import type { ElephantClient } from './elephant-client.js';

interface Opts {
  elephant: ElephantClient;
  agentId: string;
  sessionId: string;
  tokenBudget?: number;
  countTokens: (text: string) => number;  // wire to your tokenizer of choice
}

export class ElephantSessionMemory {
  private readonly messages: Message[] = [];
  private readonly elephant: ElephantClient;
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly tokenBudget: number;
  private readonly countTokens: (text: string) => number;

  constructor(opts: Opts) {
    this.elephant = opts.elephant;
    this.agentId = opts.agentId;
    this.sessionId = opts.sessionId;
    this.tokenBudget = opts.tokenBudget ?? 8192;
    this.countTokens = opts.countTokens;
  }

  addMessage(m: Message): void {
    this.messages.push(m);
    this.trimToBudget();
    // Fire-and-forget observation write. Failures are logged but do not block the agent.
    this.observe(m).catch((e) => console.error('elephant.writeObservation failed', e));
  }

  getMessages(): Message[] { return [...this.messages]; }
  clear(): void { this.messages.length = 0; }

  /** Call on session close (channel disconnect, idle timeout, explicit checkpoint). */
  async flushEpisode(): Promise<{ episodeId: string } | null> {
    if (this.messages.length === 0) return null;
    let transcript = '';
    for (const m of this.messages) {
      transcript += (transcript ? '\n\n' : '') + `${m.role.toUpperCase()}: ${m.content}`;
    }
    return this.elephant.ingestEpisode({
      agentId: this.agentId,
      sessionId: this.sessionId,
      rawTranscript: transcript,
    });
  }

  private async observe(m: Message): Promise<void> {
    if (!m.content || m.content.trim().length === 0) return;
    const prefix = m.role === 'tool' ? '[tool result] ' : `[${m.role}] `;
    await this.elephant.writeObservation({
      agentId: this.agentId,
      sessionId: this.sessionId,
      content: prefix + m.content,
    });
  }

  private trimToBudget(): void {
    let total = 0;
    const kept: Message[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const t = this.countTokens(this.messages[i].content);
      if (total + t > this.tokenBudget) break;
      total += t;
      kept.unshift(this.messages[i]);
    }
    this.messages.splice(0, this.messages.length, ...kept);
  }
}
```

Wire flush from your orchestrator's session lifecycle on session close (channel disconnect, idle reaper, or explicit `checkpoint` tool).

### 3.6 Persona files — keep local, optionally publish

If each agent has a slow-changing personality/capability file (e.g. `config/agents/<name>/PERSONA.md`), that is version-controlled config and should stay a markdown file. Optionally publish it as a `Procedure` so other agents can recall it semantically:

```ts
// during agent boot
await elephant.createProcedure({
  name: `persona:${agent.name}`,
  content: agent.persona,
  whenToUse: `Personality, capabilities, and tone of agent "${agent.name}"`,
}).catch(async (err) => {
  // Idempotent on name within scope. If it exists, fetch + update.
  const [existing] = await elephant.getProcedureByName(`persona:${agent.name}`);
  if (existing) await elephant.updateProcedure(existing.id, { content: agent.persona, whenToUse: `Personality...` });
});
```

This is optional. Skip it if cross-agent personality discovery isn't useful in your setup.

---

## 4. Per-operation playbook

For each thing the orchestrator does today, here is what it does after elephant is wired in. The pattern is consistent: **before** describes typical pre-elephant code; **after** describes the new code; **snippet** is copy-pasteable.

### 4.1 Building the system prompt (every turn)

**Before** (e.g. `src/agents/prompt-builder.ts`): `buildSystemPrompt(persona, memory, user, subagents)` concatenates a **static** memory dump from `MemoryStore.getAll()`. This burns prompt cache (the dump rarely changes per query) and ignores semantic relevance.

**After**: at prompt-build time, run a **query-conditioned recall pass** against elephant and inject the result.

```ts
// src/agents/prompt-builder.ts (extend)
import type { ElephantClient, RecallResult } from '../memory/elephant-client.js';

export async function buildRelevantMemorySection(
  elephant: ElephantClient,
  query: string,
  scope: { agentId: string; sessionId: string; projectId: string; userId?: string },
): Promise<string> {
  const r = await elephant.recall({
    q: query,
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    projectId: scope.projectId,
    userId: scope.userId,
    agentScope: 'boost',
    sessionScope: 'boost',
    projectScope: 'boost',
    userScope: scope.userId ? 'boost' : 'none',
    kinds: ['fact', 'insight', 'preference', 'procedure'],
    includeInsights: true,
    includePreferences: true,
    includeProcedures: true,
    limit: 12,
  });

  return renderRecall(r);
}

function renderRecall(r: RecallResult): string {
  let out = '';
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    out += (out ? '\n\n' : '') + `### ${title}`;
    for (const item of items) out += `\n- ${item}`;
  };
  section('User preferences', (r.preferences ?? []).map((p) => `${p.key}: ${p.value}`));
  section('Relevant facts', r.facts.map((f) => `${f.content}${f.category ? ` *(${f.category})*` : ''}`));
  section('Promoted insights', (r.insights ?? []).map((i) => i.content));
  section('Suggested procedures', (r.procedures ?? []).map(
    (p) => `**${p.name}** (v${p.version}, success ${(p.successRate * 100).toFixed(0)}%) — ${p.whenToUse}`,
  ));
  return out ? `## Relevant memory\n\n${out}` : '';
}
```

Hook it into your agent's message handler:

```ts
// inside the loop, before calling provider.chat for the first time this turn:
const relevant = this.elephant
  ? await buildRelevantMemorySection(this.elephant, latestUserText, {
      agentId: this.name,
      sessionId: session.id,
      projectId: this.config.elephant.defaultProjectId,
      userId: session.channelUserId || undefined,
    })
  : '';

const sysPrompt = buildSystemPrompt(this.persona, relevant, userContext, this.subagentSummaries);
```

The static `MemoryStore.getAll()` call disappears from the prompt path. Recall is now per-query, ranked, and scope-aware.

### 4.2 Saving a fact (`memory_save` tool)

**Before**: many orchestrators ship a `memory_save` tool that appends to a markdown file — or is a stub that echoes the fact back without persisting.

**After**: persist via `POST /facts`, with light entity extraction from the LLM's tool args.

```ts
// src/tools/builtins/memory-save.ts
import type { Tool, ToolContext, ToolResult } from '../../shared/types.js';

const memorySave: Tool = {
  name: 'memory_save',
  description: 'Save a durable fact to long-term memory.',
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact to remember (one sentence is best).' },
      category: { type: 'string', description: 'Optional category, e.g. "work", "preference".' },
      entities: { type: 'array', items: { type: 'string' }, description: 'Names of entities the fact is about.' },
      importance: { type: 'number', description: '0–1; default 0.6.', minimum: 0, maximum: 1 },
      confidence: { type: 'number', description: '0–1; default 0.9.', minimum: 0, maximum: 1 },
    },
    required: ['fact'],
  },
  isReadOnly: false,
  alwaysLoad: true,
  searchHint: 'remember store persist long-term memory fact',
  async *execute(params: unknown, ctx: ToolContext): AsyncIterable<ToolResult> {
    const { fact, category, entities, importance, confidence } = params as {
      fact: string; category?: string; entities?: string[]; importance?: number; confidence?: number;
    };
    if (!ctx.elephant) {
      yield { type: 'error', content: 'memory backend unavailable' };
      return;
    }
    const saved = await ctx.elephant.saveFact({
      content: fact,
      category,
      entityNames: entities,
      importance,
      confidence,
    });
    yield {
      type: 'data',
      content: `Saved fact ${saved.id}${category ? ` [${category}]` : ''}`,
      data: { id: saved.id, validFrom: saved.validFrom },
    };
  },
};

export default memorySave;
```

> **Note.** `POST /facts` accepts optional `agentId`/`sessionId` (origin scope) and `actor` (audit attribution) alongside `projectId`/`userId`. When `sourceEpisodeId` is present, episode-derived origin still wins at recall; for free-form `memory_save` calls (no associated episode), pass `agentId`/`sessionId`/`actor` directly so the fact participates in agent/session scoping and the audit log shows who wrote it.

### 4.3 Recall (`memory_recall` tool)

```ts
// src/tools/builtins/memory-recall.ts
import type { Tool, ToolContext, ToolResult } from '../../shared/types.js';

const memoryRecall: Tool = {
  name: 'memory_recall',
  description: 'Recall facts, preferences, insights, and procedures relevant to a query.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query.' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['fact', 'preference', 'insight', 'procedure', 'knowledge_chunk', 'research'] },
        description: 'Optional: restrict result kinds. Default: fact + preference + insight.',
      },
      limit: { type: 'number', description: 'Max items per kind. Default 8.', minimum: 1, maximum: 50 },
    },
    required: ['query'],
  },
  isReadOnly: true,
  alwaysLoad: true,
  searchHint: 'recall remember retrieve search semantic memory',
  async *execute(params: unknown, ctx: ToolContext): AsyncIterable<ToolResult> {
    const { query, kinds, limit } = params as { query: string; kinds?: string[]; limit?: number };
    if (!ctx.elephant) { yield { type: 'error', content: 'memory backend unavailable' }; return; }
    const r = await ctx.elephant.recall({
      q: query,
      agentId: ctx.agentName,
      sessionId: ctx.session.id,
      projectId: ctx.config.elephant.defaultProjectId,
      agentScope: 'boost',
      kinds: (kinds ?? ['fact', 'preference', 'insight']) as any,
      includePreferences: true,
      includeInsights: true,
      includeProcedures: kinds?.includes('procedure'),
      includeKnowledge: kinds?.includes('knowledge_chunk'),
      includeResearch: kinds?.includes('research'),
      limit: limit ?? 8,
    });
    yield {
      type: 'data',
      content: renderForLlm(r),
      data: r,
    };
  },
};

function renderForLlm(r: { facts: any[]; preferences?: any[]; insights?: any[]; procedures?: any[] }): string {
  let out = '';
  const add = (line: string) => { out += (out ? '\n' : '') + line; };
  if (r.preferences?.length) {
    add('Preferences:');
    for (const p of r.preferences) add(`  - ${p.key}: ${p.value}`);
  }
  if (r.facts.length) {
    add('Facts:');
    for (const f of r.facts) add(`  - (${f.score.toFixed(2)}) ${f.content}`);
  }
  if (r.insights?.length) {
    add('Insights:');
    for (const i of r.insights) add(`  - ${i.content}`);
  }
  if (r.procedures?.length) {
    add('Procedures:');
    for (const p of r.procedures) add(`  - ${p.name}: ${p.whenToUse}`);
  }
  return out || 'No matches.';
}

export default memoryRecall;
```

### 4.4 Forget (`memory_forget` tool)

A two-step: recall, present matches to the LLM, soft-delete the chosen IDs. Keeping it in two LLM turns avoids destructive false positives.

```ts
// src/tools/builtins/memory-forget.ts
const memoryForget: Tool = {
  name: 'memory_forget',
  description: 'Soft-delete a specific fact by id. Use memory_recall first to find the id.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Fact UUID returned from memory_recall.' },
    },
    required: ['id'],
  },
  isReadOnly: false,
  searchHint: 'forget delete remove unsave',
  async *execute(params, ctx) {
    const { id } = params as { id: string };
    if (!ctx.elephant) { yield { type: 'error', content: 'memory backend unavailable' }; return; }
    await ctx.elephant.deleteFact(id);
    yield { type: 'text', content: `Soft-deleted fact ${id}. Audit history preserved.` };
  },
};
```

The fact stays in the graph with `validTo = now` and the audit log records a `soft_delete` event — recoverable and accountable.

### 4.5 Per-turn observations (every message)

§3.5's `ElephantSessionMemory.addMessage` already writes a `POST /observations` per turn. These are short-lived (TTL 7 days by default, configurable via `MEMORY_OBSERVATION_TTL_DAYS` in elephant) and feed §4.1's recall pass for the **next** turn — solving the "agent forgets what it just said three turns ago" problem without inflating the prompt with full history.

No extra code in tools or the agent loop.

### 4.6 Per-session episode flush

When a session closes, idles, or a turn count is hit, flush the full transcript as an `Episode`. Elephant chunks, summarizes (via its own LLM adapter), embeds, and stores. The next dreaming cycle extracts facts from it.

```ts
// src/agents/orchestrator.ts (idle reaper / disconnect handler)
const idleMs = 10 * 60 * 1000;
setInterval(async () => {
  for (const session of this.sessions.values()) {
    if (Date.now() - session.lastActiveAt.getTime() < idleMs) continue;
    const memory = this.sessionMemoryFor(session);
    const episode = await memory.flushEpisode();
    if (episode) {
      logger.info({ sessionId: session.id, episodeId: episode.episodeId }, 'session flushed to elephant');
      memory.clear();
    }
    this.sessions.delete(session.id);
  }
}, 60_000);
```

**Why both observations and episodes?**

- Observations are short-lived, fine-grained (one per message), already embedded for recall, and cheap to write. They surface in the *next* turn.
- Episodes are coarse, long-form, the input to dreaming. They become the basis for *consolidated* facts and insights *days later*.

### 4.7 Preferences

Add two tools and inject the active set into every prompt.

```ts
// src/tools/builtins/pref-set.ts
const prefSet: Tool = {
  name: 'pref_set',
  description: 'Set a user preference (key/value). Auto-supersedes the prior value.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['key', 'value'],
  },
  async *execute(params, ctx) {
    const { key, value, confidence } = params as { key: string; value: string; confidence?: number };
    if (!ctx.elephant) { yield { type: 'error', content: 'memory backend unavailable' }; return; }
    const pref = await ctx.elephant.putPreference(key, value, confidence);
    yield { type: 'text', content: `Set ${key} = "${value}" (validFrom ${pref.validFrom})` };
  },
};
```

Active preferences come back via §4.1's recall (already includes preferences as a kind). For a deterministic `## User preferences` section regardless of relevance, list directly:

```ts
// in prompt-builder, when assembling the prompt
const prefs = await elephant.listPreferences();
let prefSection = '';
if (prefs.preferences.length) {
  prefSection = '## User preferences';
  for (const p of prefs.preferences) prefSection += `\n- ${p.key}: ${p.value}`;
}
```

### 4.8 Skills → Procedures (1-to-1 mapping)

If your orchestrator has a skill system (e.g. `config/skills/<name>/SKILL.md` with frontmatter for `whenToUse`, `allowedTools`, `successCriteria`), it lines up directly with elephant's `Procedure`:

| Skill field            | Procedure field             |
| ---------------------- | --------------------------- |
| `name`                 | `name`                      |
| `prompt` (substituted) | `content`                   |
| `whenToUse`            | `whenToUse` (embedded)      |
| `successCriteria`      | (encoded in `content`)      |
| `version` (frontmatter)| `version` (auto, server)    |

Sync on boot:

```ts
// src/index.ts (after orchestrator + elephant wired)
for (const skill of skillStore.list()) {
  const existing = await elephant.getProcedureByName(skill.name);
  if (existing.length === 0) {
    await elephant.createProcedure({
      name: skill.name,
      content: skill.prompt,
      whenToUse: skill.whenToUse ?? skill.description,
      actor: 'orchestrator:boot',
    });
  } else if (existing[0].content !== skill.prompt || existing[0].whenToUse !== (skill.whenToUse ?? skill.description)) {
    await elephant.updateProcedure(existing[0].id, {
      content: skill.prompt,
      whenToUse: skill.whenToUse ?? skill.description,
      reason: 'skill file changed',
      actor: 'orchestrator:boot',
    });
  }
}
```

After a skill execution completes, write success metrics back:

```ts
// in skill_invoke result handler
await elephant.updateProcedure(procedureId, {
  invocationCount: prev.invocationCount + 1,
  successRate: ((prev.successRate * prev.invocationCount) + (success ? 1 : 0)) / (prev.invocationCount + 1),
  lastSuccessAt: success ? new Date() : prev.lastSuccessAt,
  actor: ctx.agentName,
});
```

The payoff: **skill discovery via recall**. §4.1's prompt-build pass returns relevant procedures by `whenToUse` semantic match — agents discover skills they didn't know to ask for. Without elephant, skills are listed in the prompt by name; with elephant, they surface conditioned on the user's actual query.

### 4.9 Knowledge documents

Two new tools: ingest and the recall opt-in. Use case: an agent reads a manual via `web_fetch`, decides it's worth keeping permanently.

```ts
// src/tools/builtins/knowledge-ingest.ts
const knowledgeIngest: Tool = {
  name: 'knowledge_ingest',
  description: 'Save reference material (manual, doc, book) to durable knowledge.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      source: { type: 'string', description: 'e.g. "url", "book:NAME", "manual"' },
      sourceUri: { type: 'string' },
      content: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'source', 'content'],
  },
  isReadOnly: false,
  async *execute(params, ctx) {
    const p = params as { title: string; source: string; sourceUri?: string; content: string; tags?: string[] };
    if (!ctx.elephant) { yield { type: 'error', content: 'memory backend unavailable' }; return; }
    const doc = await ctx.elephant.ingestKnowledge({
      ...p,
      scope: { projectId: ctx.config.elephant.defaultProjectId },
      actor: ctx.agentName,
    });
    yield { type: 'text', content: `Knowledge saved as ${doc.id}: ${doc.title}` };
  },
};
```

To pull knowledge into recall, tag the relevant agent profiles as knowledge-using and pass `includeKnowledge: true` in §4.1's recall call for those agents.

### 4.10 Research artifacts

Web research goes to `Research`, not `Knowledge`. Differences:

- `projectId` is **mandatory** on research.
- Research carries `expiresAt` semantics — it's expected to age out.
- Knowledge is durable (think "the product's reference manual"), research is ephemeral (think "today's weather report").

Wrap notable `web_fetch` / `web_search` results:

```ts
await elephant.createResearch({
  title: result.title,
  source: 'web_search',
  sourceUri: result.url,
  content: result.snippet,
  tags: result.tags,
  projectId: ctx.config.elephant.defaultProjectId,
  expiresAt: new Date(Date.now() + 30 * 86400_000),  // 30 days
  actor: ctx.agentName,
});
```

### 4.11 Working state — live orchestration KV

Most orchestrators have no clean place for "the current task id this session is working on" — it gets passed through tool args or stored on `session.metadata`. Working state replaces that with a TTL-aware KV scoped by agent/session/user/project.

Use cases:

- In-flight project task id while the agent is mid-multi-step task.
- A cached conversation summary so you don't re-summarize on every turn.
- Per-session checkpoint state for graceful resume after a restart.
- Cron schedule cursors.

```ts
// src/agents/orchestrator.ts — checkpoint helper
async checkpoint(session: Session, payload: Record<string, unknown>): Promise<void> {
  if (!this.elephant) return;
  await this.elephant.setState({
    scope: { agentId: 'assistant', sessionId: session.id, projectId: this.config.elephant.defaultProjectId },
    key: 'session_checkpoint',
    value: payload,
    ttlSec: 7 * 86400,
  });
}

async resumeIfCheckpointed(session: Session): Promise<Record<string, unknown> | null> {
  if (!this.elephant) return null;
  try {
    const entry = await this.elephant.getState('session_checkpoint', {
      agentId: 'assistant', sessionId: session.id, projectId: this.config.elephant.defaultProjectId,
    });
    return entry.value as Record<string, unknown>;
  } catch (err) {
    if ((err as ElephantError)?.status === 404) return null;
    throw err;
  }
}
```

Drive `checkpoint()` every N turns and on graceful shutdown. Drive `resumeIfCheckpointed()` on session reconnect.

### 4.12 Audit — "why does the agent think X?"

Surface elephant's audit log when the user asks how a memory got there.

```ts
// src/tools/builtins/audit-show.ts
const auditShow: Tool = {
  name: 'audit_show',
  description: 'Show the audit history for a memory item by its id.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Memory item UUID.' } },
    required: ['id'],
  },
  isReadOnly: true,
  async *execute(params, ctx) {
    const { id } = params as { id: string };
    if (!ctx.elephant) { yield { type: 'error', content: 'memory backend unavailable' }; return; }
    const { revisions, events } = await ctx.elephant.audit(id);
    let out = `Events for ${id}:`;
    for (const e of events) out += `\n  - ${e.at} [${e.kind}] ${e.actor ?? '(system)'}`;
    if (revisions.length) {
      out += `\nArchived revisions: ${revisions.length}`;
      for (const r of revisions) out += `\n  - ${r.archivedAt}: ${r.reason}`;
    }
    yield { type: 'text', content: out };
  },
};
```

**Pass `actor` on every elephant write** so audit is meaningful. The patterns above already do this (`actor: ctx.agentName`). `POST /facts` and `PUT /preferences/:key` both accept an optional `actor` on the body; omit it and audit falls back to the service's internal actor names.

### 4.13 Dreaming — surface health, optionally trigger

Dreaming runs internally on elephant's cron (`MEMORY_DREAM_CRON`, default `0 3 * * *`). Your orchestrator doesn't need to trigger it. But it should:

1. **Surface health** in your orchestrator's status panel:

```ts
// src/gateway/api-handlers/handle-health.ts (extend)
const elephantHealth = await elephant.health();
return {
  // ... existing orchestrator health ...
  elephant: {
    neo4j: elephantHealth.neo4j,
    embedder: elephantHealth.embedder.name,
    dream: elephantHealth.dream,
  },
};
```

2. **Expose a manual trigger** as an admin-only tool for testing:

```ts
const dreamTrigger: Tool = {
  name: 'admin_dream_trigger',
  description: '(admin) Manually trigger a memory consolidation cycle.',
  parameters: { type: 'object', properties: {}, required: [] },
  shouldDefer: true,  // not active by default
  async *execute(_, ctx) {
    if (!ctx.elephant) { yield { type: 'error', content: 'memory backend unavailable' }; return; }
    const { jobId } = await ctx.elephant.triggerDream();
    yield { type: 'text', content: `Dream triggered, job ${jobId}. Poll status with admin_dream_status.` };
  },
};
```

### 4.14 Multi-agent scoping

Pass the actual agent name on every elephant call. A parent agent (`assistant`) and its subagents (`research-agent`, `scheduler-agent`) should all use their distinct names as `agentId`.

Default behavior (`agentScope: 'boost'`) means each agent's own memories rank higher, but the parent can still recall what `research-agent` knows, and `research-agent` can recall what `assistant` learned. This is usually what you want.

For a hermetic agent (rare — say, a scratch sub-agent for an isolated task), pass `agentScope: 'filter'`:

```ts
// inside an isolated sub-agent's recall call
await ctx.elephant.recall({
  q: query,
  agentId: 'sandbox-worker-A',
  agentScope: 'filter',  // see ONLY this agent's memories
  // ...
});
```

All agents share the same `projectId`, so project-scoped knowledge / research / procedures are cross-agent by default.

### 4.15 Channels (chat, web, project)

Identifiers map naturally:

- `sessionId` → `${session.channelId}:${session.channelUserId}` for stable identity, or `${session.id}` for ephemeral. Pick one and stick to it; it's the unit of `sessionScope`.
- `agentId` → the active agent's name, regardless of channel.
- `userId` → `session.channelUserId` when the channel surfaces a stable user identity.
- `projectId` → the configured default project id for general traffic, or the project id for project-scoped channels.

Rule of thumb: **the same person on a chat channel and on the web app shares preferences and facts** if their `userId` is the same. If your channels don't reconcile identity, that's a separate problem — elephant just consumes whatever you give it.

---

## 5. Migrating existing markdown memory

One-shot script to backfill existing markdown memory files (e.g. a global `memory/MEMORY.md` and per-agent `memory/agents/*/MEMORY.md`) into elephant.

```ts
// scripts/migrate-memory-to-elephant.ts
import { readFileSync } from 'node:fs';
import { glob } from 'glob';
import { v5 as uuidv5 } from 'uuid';
import { ElephantClient } from '../src/memory/elephant-client.js';
import { loadConfig } from '../config/default.js';

const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';  // any stable namespace

async function main(): Promise<void> {
  const cfg = loadConfig();
  const elephant = new ElephantClient({ url: cfg.elephant.url, token: cfg.elephant.token });
  const files = await glob('memory/{MEMORY.md,agents/*/MEMORY.md}');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const agentMatch = file.match(/agents\/([^/]+)\/MEMORY\.md/);
    const agentId = agentMatch?.[1] ?? 'assistant';
    const facts = parseMarkdownFacts(text, agentId);
    if (facts.length === 0) continue;
    for (let i = 0; i < facts.length; i += 500) {
      await elephant.saveFacts(facts.slice(i, i + 500));
    }
    console.log(`migrated ${facts.length} facts from ${file}`);
  }
}

function parseMarkdownFacts(text: string, agentId: string): Array<{ id: string; content: string; category?: string; importance: number; confidence: number }> {
  const lines = text.split('\n');
  const out: Array<{ id: string; content: string; category?: string; importance: number; confidence: number }> = [];
  let category: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('## ')) { category = line.slice(3).trim(); continue; }
    if (!line.startsWith('- ')) continue;
    const content = line.slice(2).trim();
    if (content.length === 0) continue;
    out.push({
      id: uuidv5(`${agentId}|${category ?? ''}|${content}`, NS),
      content,
      category,
      importance: 0.6,
      confidence: 0.85,
    });
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Idempotent thanks to UUIDv5 — reruns don't duplicate. After verification, archive the markdown files (`mv memory/MEMORY.md memory/legacy/`).

---

## 6. Configuration reference

New env vars added to your orchestrator:

| Variable                       | Required | Default                  | Notes                                    |
| ------------------------------ | -------- | ------------------------ | ---------------------------------------- |
| `ELEPHANT_URL`                 | no       | `http://127.0.0.1:18790` | Where elephant listens                   |
| `ELEPHANT_SERVICE_TOKEN`       | yes      | —                        | ≥ 8 chars; matches elephant's token      |
| `ELEPHANT_DEFAULT_PROJECT_ID`  | no       | `my-project`             | Default `projectId` scope on all writes  |

Elephant's own env vars live in [src/config/env.ts](src/config/env.ts) — don't duplicate them in your orchestrator. Run elephant standalone (or via the docker-compose snippet in §3.2) and let it own its own configuration surface.

---

## 7. Verification

End-to-end smoke test once the integration is wired.

1. **Bring up elephant**:
   ```bash
   cd elephant
   MEMORY_SERVICE_TOKEN=devtoken NEO4J_PASSWORD=… ANTHROPIC_API_KEY=sk-… OPENAI_API_KEY=sk-… pnpm serve
   curl -H 'authorization: Bearer devtoken' http://127.0.0.1:18790/health
   # → { ok: true, data: { neo4j: true, llm: {...}, embedder: {...}, dream: {...} } }
   ```

2. **Bring up your orchestrator** with `ELEPHANT_URL=http://127.0.0.1:18790 ELEPHANT_SERVICE_TOKEN=devtoken …`. Check your orchestrator's health endpoint includes `elephant.neo4j: true`.

3. **Send a test message** (e.g. via the web channel: "Remember that I prefer espresso over drip coffee."). Expect:
   - One `POST /observations` per turn — verify with
     `curl -H 'authorization: Bearer devtoken' "http://127.0.0.1:18790/observations?sessionId=<sid>"`.
   - One `POST /facts` (from the `memory_save` tool call) — capture the returned id.
   - Next-turn recall used in prompt build — pass `debug: true` in the recall call temporarily and inspect `trace.stageTimingsMs` in your orchestrator's logs.

4. **Run the migration script in dry-run mode** against a sample `memory/MEMORY.md` (add a `--dry-run` flag if you want; the script as written commits immediately).

5. **Trigger dreaming**:
   ```bash
   curl -X POST -H 'authorization: Bearer devtoken' http://127.0.0.1:18790/dream
   # → { ok: true, data: { jobId: "..." } }
   curl -H 'authorization: Bearer devtoken' http://127.0.0.1:18790/dream/<jobId>
   # poll until status: "completed"; expect factsCreated > 0 if any episodes have been flushed
   ```

6. **Audit a fact**:
   ```bash
   curl -H 'authorization: Bearer devtoken' http://127.0.0.1:18790/audit/<factId>
   # → { ok: true, data: { revisions: [...], events: [{ kind: "create", actor: "assistant", ... }] } }
   ```

If any of the above fails, check the elephant `/health` endpoint first — `dream.backlogEstimate`, `embedder.dim`, and `neo4j: true` are the usual culprits.

---

## 8. Open questions and follow-ups

- ~~**Actor on direct fact writes.**~~ Done — `POST /facts` and `PUT /preferences/:key` accept an optional `actor` on the body ([src/http/routes/facts.ts](src/http/routes/facts.ts), [src/http/routes/preferences.ts](src/http/routes/preferences.ts)).
- ~~**Scope on direct fact writes.**~~ Done — `POST /facts` accepts `projectId`/`userId`/`agentId`/`sessionId` on the body; direct-written facts participate in agent/session boost/filter at recall via a fact-level origin fallback ([src/services/retrieval/stages/AgentOriginAnnotationStage.ts](src/services/retrieval/stages/AgentOriginAnnotationStage.ts)).
- **Tool discovery via recall.** §4.8 makes procedures discoverable. The same pattern can extend to your tool registry — embed each tool's `searchHint` and surface the top 3 in the prompt. Out of scope for this integration but a natural next step.
- **Per-channel session retention.** `MEMORY_OBSERVATION_TTL_DAYS` (default 7) is per-deployment. If you want longer retention for paid users, run a separate elephant deployment or add a per-write TTL parameter (route change).
