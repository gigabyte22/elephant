// GENERATED — do not edit. Source: packages/client/src.
// Regenerate with: pnpm sync:vendored-client
// HTTP client for the elephant memory service.
// Reference: src/http/routes/* and src/models/wire.ts in the service source.
// One method per route. Bearer auth, JSON envelope `{ ok, data, error }`,
// retries on 5xx, AbortSignal-aware so prompt-build callers can pass a tight
// per-call timeout without changing the class default (30s).

import type {
  RecallQuery,
  RecallResult,
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
  WireWorkingStateEntry,
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
      isolated?: boolean;
    },
    opts?: RequestOpts,
  ): Promise<{ episodeId: string }> {
    return this.request('POST', '/episodes', input, opts);
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
    return this.request('POST', '/facts', input, opts);
  }
  saveFacts(
    facts: Array<Parameters<ElephantClient['saveFact']>[0]>,
    opts?: RequestOpts,
  ): Promise<WireFact[]> {
    return this.request('POST', '/facts/batch', { facts }, opts);
  }
  supersedeFact(
    oldId: string,
    newFactId: string,
    reason: string,
    opts?: RequestOpts,
  ): Promise<{ ok: true }> {
    return this.request('POST', `/facts/${seg(oldId)}/supersede`, { newFactId, reason }, opts);
  }
  deleteFact(id: string, opts?: RequestOpts): Promise<{ deleted: true }> {
    return this.request('DELETE', `/facts/${seg(id)}`, undefined, opts);
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
    return this.request('POST', '/observations', input, opts);
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
  getIntention(id: string, opts?: RequestOpts): Promise<WireIntention> {
    return this.request('GET', `/intentions/${seg(id)}`, undefined, opts);
  }
  listIntentions(
    query?: {
      projectId?: string;
      userId?: string;
      agentId?: string;
      sessionId?: string;
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
    opts?: RequestOpts,
  ): Promise<WireKnowledgeDocument> {
    return this.request('PUT', `/knowledge/documents/${seg(id)}`, input, opts);
  }
  getKnowledge(id: string, opts?: RequestOpts): Promise<WireKnowledgeDocument> {
    return this.request('GET', `/knowledge/documents/${seg(id)}`, undefined, opts);
  }
  listKnowledge(
    query?: { projectId?: string; userId?: string; limit?: number },
    opts?: RequestOpts,
  ): Promise<WireKnowledgeDocument[]> {
    return this.request('GET', `/knowledge/documents?${qs(query ?? {})}`, undefined, opts);
  }
  deleteKnowledge(
    id: string,
    purge = false,
    opts?: RequestOpts,
  ): Promise<{ deleted: true; chunksDeleted: number }> {
    return this.request(
      'DELETE',
      `/knowledge/documents/${seg(id)}?${qs({ purge })}`,
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
  getProcedure(id: string, opts?: RequestOpts): Promise<WireProcedure> {
    return this.request('GET', `/procedures/${seg(id)}`, undefined, opts);
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
    opts?: RequestOpts,
  ): Promise<WireProcedure> {
    return this.request('PUT', `/procedures/${seg(id)}`, patch, opts);
  }
  listProcedures(
    query?: { projectId?: string; userId?: string; limit?: number },
    opts?: RequestOpts,
  ): Promise<WireProcedure[]> {
    return this.request('GET', `/procedures?${qs(query ?? {})}`, undefined, opts);
  }
  deleteProcedure(id: string, opts?: RequestOpts): Promise<{ deleted: true }> {
    return this.request('DELETE', `/procedures/${seg(id)}`, undefined, opts);
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
      projectId: string;
      userId?: string;
      expiresAt?: Date | null;
      actor?: string;
    },
    opts?: RequestOpts,
  ): Promise<WireResearch> {
    return this.request('POST', '/research', input, opts);
  }
  /** `projectId` scopes the read: a cross-project id 404s rather than 403s. */
  getResearch(
    id: string,
    query: { projectId?: string } = {},
    opts?: RequestOpts,
  ): Promise<WireResearch> {
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
    query: { projectId?: string } = {},
    opts?: RequestOpts,
  ): Promise<WireResearch> {
    return this.request('PUT', `/research/${seg(id)}?${qs(query)}`, patch, opts);
  }
  listResearch(
    query: { projectId: string; userId?: string; limit?: number },
    opts?: RequestOpts,
  ): Promise<WireResearch[]> {
    return this.request('GET', `/research?${qs(query)}`, undefined, opts);
  }
  deleteResearch(id: string, opts?: RequestOpts): Promise<{ deleted: true }> {
    return this.request('DELETE', `/research/${seg(id)}`, undefined, opts);
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
