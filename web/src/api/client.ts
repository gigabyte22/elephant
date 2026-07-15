import { clearToken, getToken } from '../lib/auth.ts';

// Thin fetch wrapper around the dashboard introspection API. Centralizes:
//   - bearer auth from localStorage
//   - the {ok, data}|{ok, error} envelope (unwrap on success, throw on failure)
//   - 401 handling (clears the token so the AuthGate re-prompts)
//
// All callers receive `data` directly. Errors are AuthError, ApiError, or
// NetworkError so React Query can switch on them.

const BASE = '/dashboard/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class AuthError extends ApiError {
  constructor(message = 'unauthorized') {
    super(401, message);
    this.name = 'AuthError';
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'network error');
    this.name = 'NetworkError';
  }
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

interface RequestOpts {
  search?: Record<string, unknown> | object;
  signal?: AbortSignal;
}

export async function apiGet<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const token = getToken();
  if (!token) throw new AuthError('missing token');

  const url = buildUrl(path, opts.search);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
  } catch (err) {
    throw new NetworkError(err);
  }

  if (res.status === 401) {
    clearToken();
    throw new AuthError();
  }

  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError(res.status, `non-JSON response (status ${res.status})`);
  }

  if (!body.ok) {
    throw new ApiError(res.status, body.error);
  }
  return body.data;
}

function buildUrl(path: string, search?: object): string {
  const url = `${BASE}${path}`;
  if (!search) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}
