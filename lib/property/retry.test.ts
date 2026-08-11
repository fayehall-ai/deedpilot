/**
 * Backoff assertions.
 * Run: npx tsx lib/property/retry.test.ts
 *
 * `fetch` is stubbed and `sleep` is injected, so this runs instantly and never
 * touches a provider. The distinction being pinned is the one that truncated a
 * run: a throttle is transient and a rejected key is not.
 */
import { fetchWithBackoff, retryAfterMs } from "./retry";
import { ProviderUnavailableError } from "./types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const realFetch = globalThis.fetch;

/** Replies with the given statuses in order, repeating the last one. */
function stub(statuses: number[], headers: Record<string, string> = {}) {
  let i = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return new Response("{}", { status, headers });
  }) as unknown as typeof fetch;
  return { calls };
}

async function main() {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };

  // --- the bug this exists for -------------------------------------------------

  // A throttle that clears is not an outage. One 429, then success.
  {
    const { calls } = stub([429, 200]);
    const res = await fetchWithBackoff("u", {}, { provider: "attom", sleep, baseDelayMs: 10 });
    assert(res.status === 200, `retried past the throttle, got ${res.status}`);
    assert(calls.length === 2, `two calls, got ${calls.length}`);
  }

  // A rejected key is terminal on the first response — no retries, no waiting.
  {
    waits.length = 0;
    const { calls } = stub([401]);
    const res = await fetchWithBackoff("u", {}, { provider: "attom", sleep, baseDelayMs: 10 });
    assert(res.status === 401, "401 is returned, not retried");
    assert(calls.length === 1, `a dead key is asked once, got ${calls.length}`);
    assert(waits.length === 0, "and nothing waits on it");
  }

  // ATTOM answers "no match" with a 400. That must reach the caller untouched.
  {
    const { calls } = stub([400]);
    const res = await fetchWithBackoff("u", {}, { provider: "attom", sleep, baseDelayMs: 10 });
    assert(res.status === 400 && calls.length === 1, "400 passes straight through");
  }

  // --- giving up --------------------------------------------------------------

  // Sustained throttling eventually is an outage, and says so.
  {
    stub([429]);
    let threw: unknown = null;
    try {
      await fetchWithBackoff("u", {}, { provider: "attom", sleep, attempts: 3, baseDelayMs: 10 });
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof ProviderUnavailableError, "sustained 429 becomes unavailable");
    assert(/still throttled after 3 attempts/.test(String(threw)), `message says why: ${threw}`);
  }

  // 5xx retries too, and reports the status it gave up on.
  {
    stub([503]);
    let msg = "";
    try {
      await fetchWithBackoff("u", {}, { provider: "attom", sleep, attempts: 2, baseDelayMs: 10 });
    } catch (e) {
      msg = String(e);
    }
    assert(/HTTP 503/.test(msg), `5xx is reported: ${msg}`);
  }

  // --- backoff shape ----------------------------------------------------------

  // Doubles: 10, 20, 40.
  {
    waits.length = 0;
    stub([429]);
    try {
      await fetchWithBackoff("u", {}, { provider: "attom", sleep, attempts: 4, baseDelayMs: 10 });
    } catch {
      /* expected */
    }
    assert(waits.join(",") === "10,20,40", `exponential, got ${waits.join(",")}`);
  }

  // The server's own number wins over our guess.
  {
    waits.length = 0;
    stub([429, 200], { "retry-after": "2" });
    await fetchWithBackoff("u", {}, { provider: "attom", sleep, baseDelayMs: 10 });
    assert(waits[0] === 2000, `Retry-After honoured, got ${waits[0]}`);
  }

  // But it cannot park the run indefinitely.
  {
    waits.length = 0;
    stub([429, 200], { "retry-after": "86400" });
    await fetchWithBackoff("u", {}, { provider: "attom", sleep, baseDelayMs: 10, maxDelayMs: 5000 });
    assert(waits[0] === 5000, `capped, got ${waits[0]}`);
  }

  // --- Retry-After parsing ----------------------------------------------------

  assert(retryAfterMs("3") === 3000, "seconds");
  assert(retryAfterMs("0") === 0, "zero seconds is a value, not an absence");
  assert(retryAfterMs(null) === null, "absent header");
  assert(retryAfterMs("later") === null, "unparseable header is ignored, not treated as 0");
  {
    const now = Date.parse("2026-08-11T00:00:00Z");
    const ms = retryAfterMs("Tue, 11 Aug 2026 00:00:30 GMT", now);
    assert(ms === 30_000, `HTTP-date form, got ${ms}`);
    // A date already in the past means "go now", never a negative wait.
    assert(retryAfterMs("Tue, 11 Aug 2026 00:00:00 GMT", now + 60_000) === 0, "past date clamps to 0");
  }

  globalThis.fetch = realFetch;
  console.log("retry backoff: all assertions passed");
}

main();
