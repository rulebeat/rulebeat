const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [2_000, 8_000]; // delay before attempt 2, then before attempt 3

/**
 * True per-request timeout budget (spec 007) — safe wherever a fresh call and a fresh options
 * object are made per request: a single HTTP request, or a hand-rolled loop that reconstructs its
 * call each iteration (e.g. ResourceGraphClient.queryBatch()'s do/while).
 */
export const AZURE_CALL_TIMEOUT_MS = 30_000;

/**
 * Operation-wide timeout budget (spec 007) for an entire SDK-driven paginated enumeration. The
 * installed SDK pagers (`ResourceManagementClient.providers.list()`,
 * `SubscriptionClient.subscriptions.list()`) reuse the same options object, including whatever
 * `abortSignal` was passed at `.list()` call time, across every internal page fetch — so a signal
 * passed once here bounds the *whole* `for await` enumeration, not each page. Sized larger than
 * AZURE_CALL_TIMEOUT_MS for exactly that reason. Do not use this for a single-shot call.
 */
export const AZURE_LIST_TIMEOUT_MS = 60_000;

export interface FetchRetryOptions {
  /** Per-attempt request timeout, in ms. Defaults to AZURE_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Total attempts, including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Backoff delay (ms) before each retry, indexed by attempt number - 1. The last entry repeats
   *  for any attempt beyond its length. Overridden per-attempt by a response's Retry-After header
   *  when present. */
  backoffMs?: number[];
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function backoffFor(attempt: number, schedule: number[]): number {
  return schedule[attempt - 1] ?? schedule[schedule.length - 1] ?? 0;
}

/** Reads Retry-After (seconds or an HTTP-date) off a response, falling back to the default backoff
 *  schedule when the header is absent or unparseable. Never returns a negative delay. */
function retryDelayMs(res: Response, fallbackMs: number): number {
  const header = res.headers.get('retry-after');
  if (!header) return fallbackMs;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return fallbackMs;
}

function isTransient(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * A `fetch` with a per-attempt request timeout and retry/backoff for transient failures — 429, 408,
 * 5xx, or a thrown network/timeout error. A `Retry-After` response header (seconds or HTTP-date)
 * overrides the default backoff schedule when present. A non-transient response (any other status)
 * is returned as-is on the first attempt — this helper never inspects the response body or throws
 * on a non-ok status; callers keep their own existing error-message formatting.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? AZURE_CALL_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || !isTransient(res.status) || attempt === maxAttempts) return res;

      await sleep(retryDelayMs(res, backoffFor(attempt, backoffMs)));
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(backoffFor(attempt, backoffMs));
    }
  }

  // Unreachable: the loop above always returns or throws on the last attempt.
  throw new Error('fetchWithRetry: exhausted attempts without a result');
}
