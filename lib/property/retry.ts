/**
 * Transient-failure retry for property provider calls.
 *
 * A 429 means slow down; it does not mean stop. The ATTOM provider raised
 * `ProviderUnavailableError` on the first one, which marks the provider dead
 * for the rest of the batch — so a throttle that a two-second pause would have
 * cleared could silently truncate a run and leave the remainder looking like an
 * outage. That is the same conflation the rest of this module exists to stop,
 * one level down: "cannot answer right now" is not "cannot answer".
 *
 * 401 and 403 are still terminal on the first response. A key that is rejected
 * will be rejected again in four seconds, and retrying it just spends wall
 * clock to reach the same conclusion.
 */
import { ProviderUnavailableError } from "./types";

/** Retryable: throttling, and the 5xx family that means "try again". */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

export interface BackoffOptions {
  /** Provider name, for the error raised when retries run out. */
  provider: string;
  /** Total attempts including the first. */
  attempts?: number;
  /** First backoff step; doubles each attempt. */
  baseDelayMs?: number;
  /** Ceiling on any single wait, so a bad `Retry-After` cannot park a run. */
  maxDelayMs?: number;
  /** Injected in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; status: number; waitMs: number }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long the server asked us to wait, in ms, or null.
 *
 * `Retry-After` is either a number of seconds or an HTTP date. Both are
 * honoured, and both are clamped by the caller — a server that says "come back
 * in a day" should not hold a batch open for a day.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

/**
 * Fetch, retrying transient statuses with exponential backoff.
 *
 * Returns the last response when it is not transient — including 4xx, which the
 * caller still has to interpret, because ATTOM answers "no match" with a 400.
 * Throws `ProviderUnavailableError` only once the retries are spent, which is
 * the point at which the provider really has stopped being usable.
 */
export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  opts: BackoffOptions,
): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;

  let last: Response | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, init);
    if (!TRANSIENT.has(res.status)) return res;
    last = res;

    if (attempt === attempts) break;

    const asked = retryAfterMs(res.headers.get("retry-after"));
    const backoff = base * 2 ** (attempt - 1);
    const waitMs = Math.min(max, asked ?? backoff);
    opts.onRetry?.({ attempt, status: res.status, waitMs });
    await sleep(waitMs);
  }

  throw new ProviderUnavailableError(
    opts.provider,
    last?.status ?? 0,
    last?.status === 429
      ? `rate limited, still throttled after ${attempts} attempts`
      : `unavailable (HTTP ${last?.status}) after ${attempts} attempts`,
  );
}
