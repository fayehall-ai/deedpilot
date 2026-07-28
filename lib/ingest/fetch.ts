/**
 * The only way ingestion code is allowed to touch the network.
 *
 * Enforces, in order: explicit source policy -> live robots.txt -> per-host
 * rate limit -> bounded retry. A source marked `requires_agreement` throws
 * `PolicyBlockedError`, which the runner records as a blocked county rather
 * than a crash — coverage stays honest instead of silently going dark.
 */

import { policyFor, checkRobots, isGovernmentSource } from "./policy";

/** Identifies the crawler and gives site owners a way to reach us. */
export const USER_AGENT =
  "DeedPilotBot/0.1 (+https://deedpilot.app/bot; tax sale public-record aggregation)";

export class PolicyBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly decision: string,
    readonly reason: string,
  ) {
    super(`Blocked by source policy (${decision}) for ${host}: ${reason}`);
    this.name = "PolicyBlockedError";
  }
}

/** Default politeness when a source states nothing: slower for non-gov hosts. */
const DEFAULT_DELAY_GOV_MS = 1000;
const DEFAULT_DELAY_MS = 3000;

const lastRequestAt = new Map<string, number>();
const hostQueues = new Map<string, Promise<unknown>>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialize per host so concurrent adapters can't collectively hammer one
 * origin — the rate limit is a property of the host, not of the caller.
 */
function withHostLock<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostQueues.get(host) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  hostQueues.set(
    host,
    next.catch(() => {}),
  );
  return next;
}

export interface PoliteFetchOptions {
  /** Skip the delay for the first request to a host (default false). */
  headers?: Record<string, string>;
  /** Total attempts including the first (default 3). */
  attempts?: number;
  timeoutMs?: number;
  /**
   * Set only where a signed data agreement exists. Bypasses robots.txt but
   * never bypasses rate limiting.
   */
  underAgreement?: boolean;
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  contentType: string;
}

export async function politeFetch(
  url: string,
  opts: PoliteFetchOptions = {},
): Promise<FetchResult> {
  const { attempts = 3, timeoutMs = 30_000, headers = {}, underAgreement = false } = opts;
  const host = new URL(url).hostname;

  const policy = policyFor(host);
  if (policy && policy.decision !== "allow" && !underAgreement) {
    throw new PolicyBlockedError(host, policy.decision, policy.reason);
  }

  let crawlDelayMs = 0;
  if (!underAgreement) {
    const robots = await checkRobots(url, USER_AGENT);
    if (!robots.allowed) {
      throw new PolicyBlockedError(
        host,
        "robots_disallow",
        `robots.txt disallows ${new URL(url).pathname} for ${USER_AGENT}`,
      );
    }
    crawlDelayMs = robots.crawlDelayMs ?? 0;
  }

  const delay = Math.max(
    policy?.minDelayMs ?? 0,
    crawlDelayMs,
    isGovernmentSource(host) ? DEFAULT_DELAY_GOV_MS : DEFAULT_DELAY_MS,
  );

  return withHostLock(host, async () => {
    const since = Date.now() - (lastRequestAt.get(host) ?? 0);
    if (since < delay) await sleep(delay - since);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            ...headers,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
        lastRequestAt.set(host, Date.now());

        // Back off hard on explicit rate limiting, honouring Retry-After.
        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get("retry-after"));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay * attempt * 2;
          if (attempt < attempts) {
            await sleep(Math.min(wait, 60_000));
            continue;
          }
        }

        return {
          url: res.url || url,
          status: res.status,
          body: await res.text(),
          contentType: res.headers.get("content-type") ?? "",
        };
      } catch (e) {
        lastErr = e;
        lastRequestAt.set(host, Date.now());
        if (attempt < attempts) await sleep(delay * attempt);
      }
    }
    throw new Error(`fetch failed after ${attempts} attempts: ${url} — ${String(lastErr)}`);
  });
}

/** Convenience for JSON endpoints; throws on non-2xx or unparseable body. */
export async function fetchJson<T = unknown>(
  url: string,
  opts: PoliteFetchOptions = {},
): Promise<T> {
  const res = await politeFetch(url, {
    ...opts,
    headers: { accept: "application/json", ...opts.headers },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${res.body.slice(0, 200)}`);
  }
}
