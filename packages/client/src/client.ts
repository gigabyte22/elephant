import { randomUUID } from 'node:crypto';
// HTTP client for the elephant memory service.
// Reference: src/http/routes/* and src/models/wire.ts in the service source.
// One method per route. Bearer auth, JSON envelope `{ ok, data, error }`,
// retries on 5xx, AbortSignal-aware so prompt-build callers can pass a tight
// per-call timeout without changing the class default (30s).

import type {
  RecallQuery,
  RecallResult,
  ScopeMode,
  WireArchivedRevision,
  WireAuditEvent,
  WireFact,
  WireHealth,
  WireIntention,
  WireKnowledgeAttachment,
  WireKnowledgeDocument,
  WireObservation,
  WirePreference,
  WireProcedure,
  WireResearch,
  WireScope,
  WireWorkingStateEntry,
  WithScore,
} from './wire-types.ts';

export class ElephantError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ElephantError';
  }
}

export interface ElephantConfig {
  url: string;
  token: string;
  /**
   * Applied to writes that accept a projectId and did not supply one.
   * Previously declared and never read, so callers who set it silently got
   * unscoped writes.
   */
  defaultProjectId?: string;
  /** Per-request timeout (ms). Default 30s. Override per-call via opts.signal. */
  timeoutMs?: number;
  /** Retry budget for 5xx + network errors. Default 3. */
  retries?: number;
}

export interface RequestOpts {
  /** External AbortSignal — wins over the default timeout if it fires first. */
  signal?: AbortSignal;
  /** Override timeout for this call only. */
  timeoutMs?: number;
  /** Override retries for this call only. */
  retries?: number;
}

export class ElephantClient {
  constructor(private readonly cfg: ElephantConfig) {}

  // ─ Health ──
  health(opts?: RequestOpts): Promise<WireHealth> {
    return this.request('GET', '/health', undefined, opts);
  }

  // ─ Episodes ──
  ingestEpisode(
    input: {
      id?: string;
      agentId: string;
      sessionId: string;
      rawTranscript: string;
      summary?: string;
      timestamp?: Date;
      projectId?: string;
      userId?: string;
      origin?: 'user' | 'cron' | 'event' | 'system' | 'ingest';
      /**
       * Declared human speakers for multi-party transcripts (turns labeled
       * `USER(<label>):`). Omit for 1:1 conversations — the service then
       * attributes facts to the episode's userId exactly as before.
       */
      participants?: Array<{ label: string; userId?: string }>;
      isolated?: boolean;
      /**
       * Free-form provenance (room id, turn id, upstream session id, ...).
       * Max 16 entries, keys 1..64 chars, values <=512 chars. Stored and
       * nothing more — never indexed, searched, recalled or scored. Only send
       * it when `health().episodeMetadata` is true; older servers reject an
       * unknown field.
       */
      metadata?: Record<string, string>;
    },
    opts?: RequestOpts,
  ): Promise<{ episodeId: string }> {
    return this.request('POST', '/episodes', this.withWriteDefaults(input), opts);
  }

  // ─ Facts ──
  saveFact(
    input: {
      id?: string;
      content: string;
      category?: string;
      confidence?: number;
      importance?: number;
      validFrom?: Date;
      entityNames?: string[];
      sourceEpisodeId?: string;
      projectId?: string;
      userId?: string;
      agentId?: string;
      sessionId?: string;
      actor?: string;
    },
    opts?: RequestOpts,
  ): Promise<WireFact> {
    return this.request('POST', '/facts', this.withWriteDefaults(input), opts);
  }
  saveFacts(
    facts: Array<Parameters<ElephantClient['saveFact']>[0]>,
    opts?: RequestOpts,
  ): Promise<WireFact[]> {
    return this.request(
      'POST',
      '/facts/batch',
      { facts: facts.map((f) => this.withWriteDefaults(f)) },
      opts,
    );
  }
  /**
   * `projectId`/`userId` scope the read: a cross-scope id 404s rather than 403s.
   * Unlike the write methods, scope is NOT filled in from `defaultProjectId` —
   * declaring none is what the service reads as "unrestricted", so defaulting it
   * would silently narrow every existing caller. Pass it to get the guard.
   */
  getFact(id: string, query: WireScope = {}, opts?: RequestOpts): Promise<WireFact> {
    return this.request('GET', scoped(`/facts/${seg(id)}`, query), undefined, opts);
  }
  /** The scope guards both facts — supersede writes to the new one too. */
  supersedeFact(
    oldId: string,
    newFactId: string,
    reason: string,
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<{ ok: true }> {
    return this.request(
      'POST',
      scoped(`/facts/${seg(oldId)}/supersede`, query),
      { newFactId, reason },
      opts,
    );
  }
  deleteFact(id: string, query: WireScope = {}, opts?: RequestOpts): Promise<{ deleted: true }> {
    return this.request('DELETE', scoped(`/facts/${seg(id)}`, query), undefined, opts);
  }

  // ─ Recall + Timeline ──
  recall(q: RecallQuery, opts?: RequestOpts): Promise<RecallResult> {
    return this.request('GET', `/recall?${qs(q)}`, undefined, opts);
  }
  timeline(
    at: Date,
    query?: { entityId?: string; preferenceKey?: string; limit?: number },
    opts?: RequestOpts,
  ): Promise<{ at: string; facts: WireFact[]; preference?: WirePreference | null }> {
    return this.request('GET', `/timeline?${qs({ at, ...query })}`, undefined, opts);
  }

  // ─ Entities ──
  getEntity(
    id: string,
    includeSuperseded = false,
    opts?: RequestOpts,
  ): Promise<{ entity: { id: string; name: string; type: string }; facts: WireFact[] }> {
    return this.request(
      'GET',
      `/entities/${seg(id)}?${qs({ includeSuperseded })}`,
      undefined,
      opts,
    );
  }
  searchEntities(
    name: string,
    limit = 10,
    opts?: RequestOpts,
  ): Promise<{ entities: Array<{ id: string; name: string; type: string }> }> {
    return this.request('GET', `/entities?${qs({ name, limit })}`, undefined, opts);
  }

  // ─ Preferences ──
  listPreferences(opts?: RequestOpts): Promise<{ preferences: WirePreference[] }> {
    return this.request('GET', '/preferences', undefined, opts);
  }
  getPreference(key: string, opts?: RequestOpts): Promise<WirePreference> {
    return this.request('GET', `/preferences/${encodeURIComponent(key)}`, undefined, opts);
  }
  putPreference(
    key: string,
    value: string,
    extras?: { confidence?: number; actor?: string },
    opts?: RequestOpts,
  ): Promise<WirePreference> {
    return this.request(
      'PUT',
      `/preferences/${encodeURIComponent(key)}`,
      { value, ...extras },
      opts,
    );
  }

  // ─ Observations ──
  writeObservation(
    input: { id?: string; agentId: string; sessionId: string; content: string },
    opts?: RequestOpts,
  ): Promise<WireObservation> {
    return this.request('POST', '/observations', this.withWriteDefaults(input), opts);
  }
  listObservations(
    sessionId: string,
    limit = 100,
    opts?: RequestOpts,
  ): Promise<{ observations: WireObservation[] }> {
    return this.request('GET', `/observations?${qs({ sessionId, limit })}`, undefined, opts);
  }

  // ─ Intentions (prospective memory) ──
  createIntention(
    input: {
      id?: string;
      content: string;
      dueAt?: string | null;
      triggerHint?: string | null;
      recurring?: boolean;
      schedule?: string | null;
      importance?: number;
      scope?: { projectId?: string; userId?: string; agentId?: string; sessionId?: string };
      sourceEpisodeId?: string;
      sourceFactId?: string;
      actor?: string;
    },
    opts?: RequestOpts,
  ): Promise<WireIntention> {
    return this.request('POST', '/intentions', input, opts);
  }
  /** Scoped like `getFact`: a cross-scope id 404s, and declaring none is unrestricted. */
  getIntention(id: string, query: WireScope = {}, opts?: RequestOpts): Promise<WireIntention> {
    return this.request('GET', scoped(`/intentions/${seg(id)}`, query), undefined, opts);
  }
  /** `projectScope: 'shared'` lists ONLY the null-scoped items — what a shared
   *  space contains. Omitting the ids instead infers `none`, which ignores the
   *  axis and spans every scope. */
  listIntentions(
    query?: {
      projectId?: string;
      userId?: string;
      agentId?: string;
      sessionId?: string;
      projectScope?: ScopeMode;
      userScope?: ScopeMode;
      agentScope?: ScopeMode;
      sessionScope?: ScopeMode;
      status?: 'pending' | 'completed' | 'cancelled' | 'expired';
      limit?: number;
    },
    opts?: RequestOpts,
  ): Promise<WireIntention[]> {
    return this.request('GET', `/intentions?${qs(query ?? {})}`, undefined, opts);
  }
  listDueIntentions(
    query?: {
      projectId?: string;
      userId?: string;
      agentId?: string;
      sessionId?: string;
      projectScope?: ScopeMode;
      userScope?: ScopeMode;
      agentScope?: ScopeMode;
      sessionScope?: ScopeMode;
      before?: string;
      status?: 'pending' | 'completed' | 'cancelled' | 'expired';
      limit?: number;
    },
    opts?: RequestOpts,
  ): Promise<WireIntention[]> {
    return this.request('GET', `/intentions/due?${qs(query ?? {})}`, undefined, opts);
  }
  completeIntention(
    id: string,
    input: { actor?: string; reason?: string } = {},
    opts?: RequestOpts,
  ): Promise<WireIntention> {
    return this.request('POST', `/intentions/${seg(id)}/complete`, input, opts);
  }
  cancelIntention(
    id: string,
    input: { actor?: string; reason?: string } = {},
    opts?: RequestOpts,
  ): Promise<WireIntention> {
    return this.request('POST', `/intentions/${seg(id)}/cancel`, input, opts);
  }
  markIntentionFired(
    id: string,
    input: { actor?: string; reason?: string } = {},
    opts?: RequestOpts,
  ): Promise<WireIntention> {
    return this.request('POST', `/intentions/${seg(id)}/fired`, input, opts);
  }

  // ─ Dream ──
  triggerDream(opts?: RequestOpts): Promise<{ jobId: string }> {
    return this.request('POST', '/dream', {}, opts);
  }
  dreamStatus(
    jobId: string,
    opts?: RequestOpts,
  ): Promise<{
    id: string;
    startedAt: string;
    completedAt?: string;
    status: 'running' | 'completed' | 'failed';
    episodesProcessed: number;
    factsCreated: number;
    factsSuperseded: number;
    factsPruned: number;
    insightsPromoted: number;
    error?: string;
  }> {
    return this.request('GET', `/dream/${seg(jobId)}`, undefined, opts);
  }

  // ─ Knowledge ──
  ingestKnowledge(
    input: {
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
    },
    opts?: RequestOpts,
  ): Promise<WireKnowledgeDocument> {
    return this.request('POST', '/knowledge/documents', input, opts);
  }
  updateKnowledge(
    id: string,
    input: {
      title?: string;
      content?: string;
      summary?: string;
      tags?: string[];
      expiresAt?: Date | null;
      reason?: string;
      actor?: string;
    },
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<WireKnowledgeDocument> {
    return this.request('PUT', scoped(`/knowledge/documents/${seg(id)}`, query), input, opts);
  }
  /**
   * `projectId`/`userId` scope the read: a cross-scope id 404s rather than 403s.
   * Unlike the write methods, scope is NOT filled in from `defaultProjectId` —
   * declaring none is what the service reads as "unrestricted", so defaulting it
   * would silently narrow every existing caller. Pass it to get the guard.
   */
  getKnowledge(
    id: string,
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<WireKnowledgeDocument> {
    return this.request('GET', scoped(`/knowledge/documents/${seg(id)}`, query), undefined, opts);
  }
  /** `projectScope: 'shared'` lists ONLY the null-scoped documents — what a
   *  shared space contains. Omitting the ids instead infers `none`, which
   *  ignores the axis and spans every scope. */
  listKnowledge(
    query?: {
      projectId?: string;
      userId?: string;
      projectScope?: ScopeMode;
      userScope?: ScopeMode;
      limit?: number;
    },
    opts?: RequestOpts,
  ): Promise<WireKnowledgeDocument[]> {
    return this.request('GET', `/knowledge/documents?${qs(query ?? {})}`, undefined, opts);
  }
  deleteKnowledge(
    id: string,
    purge = false,
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<{ deleted: true; chunksDeleted: number }> {
    return this.request(
      'DELETE',
      `/knowledge/documents/${seg(id)}?${qs({ ...query, purge })}`,
      undefined,
      opts,
    );
  }

  // ─ Knowledge attachments ──
  uploadAttachment(
    documentId: string,
    input: {
      filename: string;
      mimeType: string;
      dataBase64: string;
      actor?: string;
    },
    opts?: RequestOpts,
  ): Promise<WireKnowledgeAttachment> {
    return this.request('POST', `/knowledge/documents/${seg(documentId)}/attachments`, input, opts);
  }
  deleteAttachment(
    documentId: string,
    attachmentId: string,
    opts?: RequestOpts,
  ): Promise<{ deleted: true }> {
    return this.request(
      'DELETE',
      `/knowledge/documents/${seg(documentId)}/attachments/${seg(attachmentId)}`,
      undefined,
      opts,
    );
  }
  /** Raw blob fetch (binary, not the JSON envelope). Returns the underlying
   *  Response so callers can stream it through their own transport. */
  async fetchAttachmentBlob(blobId: string, opts?: RequestOpts): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts?.timeoutMs ?? this.cfg.timeoutMs ?? 30_000);
    opts?.signal?.addEventListener('abort', () => ctl.abort(opts.signal?.reason), { once: true });
    try {
      const res = await fetch(`${this.cfg.url}/knowledge/attachments/${seg(blobId)}`, {
        signal: ctl.signal,
        headers: { authorization: `Bearer ${this.cfg.token}` },
      });
      if (!res.ok) throw new ElephantError(res.status, `GET blob ${blobId} -> ${res.status}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─ Procedures ──
  createProcedure(
    input: {
      id?: string;
      name: string;
      content: string;
      whenToUse: string;
      scope?: { projectId?: string; userId?: string };
      expiresAt?: Date | null;
      actor?: string;
    },
    opts?: RequestOpts,
  ): Promise<WireProcedure> {
    return this.request('POST', '/procedures', input, opts);
  }
  /** Scoped like `getKnowledge`: a cross-scope id 404s, and declaring none is unrestricted. */
  getProcedure(id: string, query: WireScope = {}, opts?: RequestOpts): Promise<WireProcedure> {
    return this.request('GET', scoped(`/procedures/${seg(id)}`, query), undefined, opts);
  }
  getProcedureByName(
    name: string,
    scope?: { projectId?: string; userId?: string },
    opts?: RequestOpts,
  ): Promise<WireProcedure[]> {
    return this.request('GET', `/procedures?${qs({ name, ...scope })}`, undefined, opts);
  }
  updateProcedure(
    id: string,
    patch: Partial<{
      content: string;
      whenToUse: string;
      successRate: number;
      invocationCount: number;
      lastSuccessAt: Date | null;
      expiresAt: Date | null;
      reason: string;
      actor: string;
    }>,
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<WireProcedure> {
    return this.request('PUT', scoped(`/procedures/${seg(id)}`, query), patch, opts);
  }
  /** `projectScope: 'shared'` lists ONLY the null-scoped items — what a shared
   *  space contains. Omitting the ids instead infers `none`, which ignores the
   *  axis and spans every scope. */
  listProcedures(
    query?: {
      projectId?: string;
      userId?: string;
      projectScope?: ScopeMode;
      userScope?: ScopeMode;
      limit?: number;
    },
    opts?: RequestOpts,
  ): Promise<WireProcedure[]> {
    return this.request('GET', `/procedures?${qs(query ?? {})}`, undefined, opts);
  }
  deleteProcedure(
    id: string,
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<{ deleted: true }> {
    return this.request('DELETE', scoped(`/procedures/${seg(id)}`, query), undefined, opts);
  }

  // ─ Research ──
  createResearch(
    input: {
      id?: string;
      title: string;
      source: string;
      sourceUri?: string;
      content: string;
      summary?: string;
      tags?: string[];
      /** Opaque caller provenance; write-once, never indexed or searched. */
      metadata?: Record<string, string>;
      projectId: string;
      userId?: string;
      expiresAt?: Date | null;
      actor?: string;
    },
    opts?: RequestOpts,
  ): Promise<WireResearch> {
    return this.request('POST', '/research', input, opts);
  }
  /** `projectId`/`userId` scope the read: a cross-scope id 404s rather than 403s. */
  getResearch(id: string, query: WireScope = {}, opts?: RequestOpts): Promise<WireResearch> {
    return this.request('GET', `/research/${seg(id)}?${qs(query)}`, undefined, opts);
  }
  updateResearch(
    id: string,
    patch: {
      title?: string;
      content?: string;
      summary?: string;
      tags?: string[];
      sourceUri?: string;
      expiresAt?: Date | null;
      reason?: string;
      actor?: string;
    },
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<WireResearch> {
    return this.request('PUT', `/research/${seg(id)}?${qs(query)}`, patch, opts);
  }
  /** Live research in the same project whose stored summary embedding scores at
   *  least `minScore` (default 0.85) against this item's, excluding the item
   *  itself, best first. `projectId`/`userId` scope the read like `getResearch`. */
  similarResearch(
    id: string,
    opts: WireScope & { limit?: number; minScore?: number } = {},
    reqOpts?: RequestOpts,
  ): Promise<Array<WithScore<WireResearch>>> {
    return this.request('GET', scoped(`/research/${seg(id)}/similar`, opts), undefined, reqOpts);
  }
  /** `projectId` is required by the service UNLESS an explicit `projectScope` is
   *  sent. Note `projectScope: 'shared'` is empty by construction here: research
   *  always carries a projectId, so no null-scoped row exists. The `userId` axis
   *  IS nullable, so `userScope: 'shared'` is the meaningful shared listing. */
  listResearch(
    query: {
      projectId?: string;
      userId?: string;
      projectScope?: ScopeMode;
      userScope?: ScopeMode;
      limit?: number;
    },
    opts?: RequestOpts,
  ): Promise<WireResearch[]> {
    return this.request('GET', `/research?${qs(query)}`, undefined, opts);
  }
  deleteResearch(
    id: string,
    query: WireScope = {},
    opts?: RequestOpts,
  ): Promise<{ deleted: true }> {
    return this.request('DELETE', scoped(`/research/${seg(id)}`, query), undefined, opts);
  }

  // ─ Working state ──
  setState(
    input: {
      scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string };
      key: string;
      value: unknown;
      ttlSec?: number;
    },
    opts?: RequestOpts,
  ): Promise<{ ok: true }> {
    return this.request('POST', '/state', input, opts);
  }
  getState(
    key: string,
    scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string },
    opts?: RequestOpts,
  ): Promise<WireWorkingStateEntry> {
    return this.request('GET', `/state/${encodeURIComponent(key)}?${qs(scope)}`, undefined, opts);
  }
  deleteState(
    key: string,
    scope: { agentId: string; sessionId?: string; userId?: string; projectId?: string },
    opts?: RequestOpts,
  ): Promise<{ deleted: true }> {
    return this.request(
      'DELETE',
      `/state/${encodeURIComponent(key)}?${qs(scope)}`,
      undefined,
      opts,
    );
  }
  listState(
    scope: {
      agentId: string;
      sessionId?: string;
      userId?: string;
      projectId?: string;
      prefix?: string;
    },
    opts?: RequestOpts,
  ): Promise<WireWorkingStateEntry[]> {
    return this.request('GET', `/state?${qs(scope)}`, undefined, opts);
  }

  // ─ Audit ──
  audit(
    targetId: string,
    limit = 100,
    opts?: RequestOpts,
  ): Promise<{
    revisions: WireArchivedRevision[];
    events: WireAuditEvent[];
  }> {
    return this.request('GET', `/audit/${seg(targetId)}?${qs({ limit })}`, undefined, opts);
  }
  auditList(
    query?: { actor?: string; from?: Date; to?: Date; limit?: number },
    opts?: RequestOpts,
  ): Promise<WireAuditEvent[]> {
    return this.request('GET', `/audit?${qs(query ?? {})}`, undefined, opts);
  }

  // ─ HTTP plumbing ──

  /**
   * Stamp a client-generated id on writes that did not supply one, and apply
   * defaultProjectId.
   *
   * The id matters because request() retries on network errors and timeouts.
   * EXPECTED.md promises "all writes idempotent via client-supplied id" — that
   * holds server-side, but neither the MCP nor the OpenClaw tool layer supplied
   * an id, so a timed-out-but-succeeded POST duplicated on retry. Exactly the
   * scenario the guarantee exists to cover.
   */
  private withWriteDefaults<T extends { id?: string; projectId?: string }>(input: T): T {
    const out: T = { ...input };
    if (out.id === undefined) out.id = randomUUID();
    if (out.projectId === undefined && this.cfg.defaultProjectId !== undefined) {
      out.projectId = this.cfg.defaultProjectId;
    }
    return out;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOpts,
  ): Promise<T> {
    const retries = opts?.retries ?? this.cfg.retries ?? 3;
    const timeoutMs = opts?.timeoutMs ?? this.cfg.timeoutMs ?? 30_000;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Check BEFORE attaching the listener. addEventListener never fires for
      // an already-aborted signal, so a caller that cancelled (or timed out)
      // between attempts had its AbortController left un-aborted and the
      // request re-issued for every remaining retry — a prompt-build path that
      // gave up kept hammering the service.
      if (opts?.signal?.aborted) {
        throw opts.signal.reason instanceof Error
          ? opts.signal.reason
          : new Error('request aborted');
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      // Forward an external abort so the caller can cancel.
      const onExternalAbort = () => ctl.abort(opts?.signal?.reason);
      opts?.signal?.addEventListener('abort', onExternalAbort, { once: true });
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
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: T;
          error?: string;
        } | null;
        if (!res.ok || !json?.ok) {
          const message = json?.error ?? `${method} ${path} -> ${res.status}`;
          if (res.status >= 500 && attempt < retries) {
            lastErr = new ElephantError(res.status, message, json);
            continue;
          }
          throw new ElephantError(res.status, message, json);
        }
        return json.data as T;
      } catch (err) {
        lastErr = err;
        const isElephantErr = err instanceof ElephantError;
        const retryable = !isElephantErr || (err as ElephantError).status >= 500;
        if (attempt < retries && retryable) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onExternalAbort);
      }
    }
    // Unreachable: loop either returns or throws.
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/** Encode a caller-supplied id as a single path segment — an id containing
 *  `/` or `..` must not be able to reroute the request to another endpoint. */
function seg(id: string): string {
  return encodeURIComponent(id);
}

/** URLSearchParams string from a plain object. Skips undefined/null; Dates → ISO; arrays → comma-joined. */
function qs(obj: Record<string, unknown> | object): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) params.set(k, v.join(','));
    else if (v instanceof Date) params.set(k, v.toISOString());
    else params.set(k, String(v));
  }
  return params.toString();
}

/** Append a query string only when there is one, so a scope-less call keeps its bare path. */
function scoped(path: string, query: WireScope): string {
  const q = qs(query);
  return q ? `${path}?${q}` : path;
}
