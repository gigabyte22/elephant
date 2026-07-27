// Retry/backoff for the raw-`fetch` embedding adapters.
//
// The Anthropic and OpenAI SDKs retry twice by default. Voyage and Ollama are
// hand-rolled `fetch` calls with none, so a single 429 or a momentary connection
// refusal threw straight out of embedBatch. In the dream cycle that failed the
// whole episode — which, before per-episode retry markers existed, meant the
// episode was skipped permanently. A five-minute provider blip during the 3am
// cron destroyed that window of memory.
//
// Retries only what is plausibly transient: network errors, 408/425/429, and
// 5xx. A 400 (oversized input, bad model name) is a caller error and fails fast.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface EmbedRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Issue `request()` with bounded exponential backoff. Resolves with the first
 * non-retryable response (including a non-ok one — the caller still owns error
 * message construction) and rejects with the last error if every attempt fails.
 */
export async function fetchWithRetry(
  label: string,
  request: () => Promise<Response>,
  opts: EmbedRetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
    try {
      const response = await request();
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) return response;
      if (attempt === attempts - 1) return response;
      // Honour Retry-After when the provider supplies one; it is better
      // information than our backoff curve.
      const wait = retryAfterMs(response);
      if (wait !== null) await new Promise((r) => setTimeout(r, wait));
      // eslint-disable-next-line no-console
      console.warn(`[${label}] ${response.status}, retrying (${attempt + 1}/${attempts - 1})`);
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1) throw err;
      // eslint-disable-next-line no-console
      console.warn(
        `[${label}] request failed, retrying (${attempt + 1}/${attempts - 1}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  throw lastError ?? new Error(`${label}: exhausted retries`);
}
