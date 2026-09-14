// Deliberately not marked `server-only`: the ingestion CLI runs this under
// plain tsx, outside any React server context, to extract parcels from county
// PDFs. `server-only` throws there. The modules that must stay server-bound
// (lib/ai/brief.ts, lib/queries.ts) carry the guard themselves.
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { recordUsage, type Operation } from "./usage";

/**
 * LLM provider chain for DeedPilot.
 *
 * Grok (xAI) is the primary provider; Claude is the failover leg only. Both
 * are driven through the same schema-validated interface so the calling code
 * never branches on which one answered — only the recorded `model` string
 * differs, which is what lands in `deal_analyses.model`.
 *
 * xAI's API is OpenAI-compatible, so the `openai` client works against
 * https://api.x.ai/v1 with JSON-schema structured outputs.
 */

export class NoProviderAvailableError extends Error {}
export class ProviderRefusedError extends Error {}

/**
 * A rendered page image, for documents that carry no text layer.
 *
 * Roughly one county sale list in thirteen is a scan — Fulton County GA
 * publishes its levy sale as 8 pages of images with 128 characters of
 * extractable text, all of it page markers. The words are on the page; they
 * are simply not characters. Reading them needs the model's eyes.
 */
export interface ImageInput {
  /** `image/png` or `image/jpeg`. */
  mediaType: "image/png" | "image/jpeg";
  /** Raw base64, no data: prefix — each provider wraps it its own way. */
  base64: string;
}

export interface StructuredRequest<T extends z.ZodType> {
  /**
   * What this call is for, recorded against its cost.
   *
   * "Why did last week cost more" is answered by purpose, never by call site,
   * so this is passed rather than inferred from a stack. Defaults per entry
   * point when a caller does not say.
   */
  operation?: Operation;
  /** County this call is about, when it is about one. */
  countyFips?: string;
  system: string;
  prompt: string;
  schema: T;
  /** Schema name sent to the provider; must be a bare identifier. */
  schemaName: string;
  maxTokens?: number;
  /**
   * Page images to read alongside the prompt. Send few and large rather than
   * many and small: a dense parcel table needs the resolution, and every
   * provider caps total request size.
   */
  images?: ImageInput[];
  /**
   * How long one provider may take before the chain gives up on it.
   *
   * Nothing here may wait forever, for the same reason nothing in
   * `lib/db/index.ts` may: a call with no deadline does not fail, it parks. A
   * batch run found it — 476 scripts, one call each, and a single request that
   * never returns holds the whole run at package 3 with an idle event loop and
   * no way to tell that from a slow model. The chain already knows what to do
   * with a provider that fails; it just needed a reason to decide one had.
   *
   * Generous on purpose. A long structured generation legitimately runs into
   * minutes, so this is a hang detector, not a latency budget — it should never
   * fire on a call that was going to succeed.
   */
  timeoutMs?: number;
  /**
   * How many times ONE provider is re-asked on a transient failure.
   *
   * Defaults to `TRANSIENT_ATTEMPTS`. A caller under a wall-clock ceiling needs
   * to be able to lower it, because the retries multiply through the whole
   * chain: two providers at three attempts each, at a 150-second deadline, is
   * fifteen minutes for a single call — and a CAPE package is two calls. That
   * arithmetic produced `Vercel Runtime Timeout Error: Task timed out after 800
   * seconds` on a function whose claim window was sixty.
   *
   * Setting it to 1 does not remove the safety net, it moves it: the provider
   * chain still falls through to Claude, and the job queue still retries the
   * whole job up to `MAX_ATTEMPTS` times with a fresh lease.
   */
  attempts?: number;
}

/** See `StructuredRequest.timeoutMs`. Four minutes; scripts land inside two. */
const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * How many times one provider is re-asked before the chain moves on.
 *
 * Only for failures that say nothing about whether the request was reasonable.
 * A 400 will be a 400 every time; a timeout will not. Measured on a batch run:
 * grok answered in about ninety seconds most of the time and occasionally not
 * at all, and with no retry half of the fresh packages failed — while the
 * Claude leg, which was supposed to catch them, was returning 400 on every call
 * because the key is not workspace-scoped.
 */
const TRANSIENT_ATTEMPTS = 3;

/**
 * Whether a failure is worth asking the same provider again.
 *
 * Deliberately an allow-list of the transient shapes. Anything unrecognised is
 * treated as permanent and falls through to the next provider immediately,
 * because re-sending a request that was refused on its merits spends money and
 * time to be told the same thing — and, for a refusal, is how a system ends up
 * badgering a safety classifier.
 */
function isTransient(e: unknown): boolean {
  if (e instanceof ProviderRefusedError) return false;
  const status = (e as { status?: number } | null)?.status;
  if (typeof status === "number") return status === 408 || status === 409 || status === 429 || status >= 500;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /timed out|timeout|etimedout|econnreset|socket hang up|network|fetch failed|aborted/.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ProviderResult<T> {
  data: T;
  /** Which model actually produced this, for auditing and cost attribution. */
  model: string;
  /** True when the primary failed and the fallback answered. */
  usedFallback: boolean;
}

interface Provider {
  name: string;
  model: string;
  configured(): boolean;
  run<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>>;
}

// ---------------------------------------------------------------------------
// Grok (primary)
// ---------------------------------------------------------------------------

/**
 * grok-4.5 — 500k context, supports `response_format: json_schema` with a
 * match guarantee. Pinned rather than floating so a model swap is a deliberate
 * commit, not a silent behaviour change on someone's auction morning.
 */
const GROK_MODEL = process.env.XAI_MODEL ?? "grok-4.5";

const grokProvider: Provider = {
  name: "grok",
  model: GROK_MODEL,

  configured: () => (process.env.XAI_API_KEY ?? "").trim().length > 0,

  async run<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const client = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    });

    const completion = await client.chat.completions.parse(
      {
      model: GROK_MODEL,
      max_completion_tokens: req.maxTokens ?? 16000,
      messages: [
        { role: "system", content: req.system },
        {
          role: "user",
          // Images first, then the instruction: both providers attend better
          // to a question asked after the evidence than before it.
          content: req.images?.length
            ? [
                ...req.images.map((img) => ({
                  type: "image_url" as const,
                  image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: "high" as const },
                })),
                { type: "text" as const, text: req.prompt },
              ]
            : req.prompt,
        },
      ],
      response_format: zodResponseFormat(req.schema, req.schemaName),
      },
      /*
       * `maxRetries: 0` because `runStructured` owns the retry, not the SDK.
       *
       * The SDK's retries are invisible from outside and multiply the deadline
       * silently — two of them at four minutes is twelve before the caller
       * hears anything, and no log line says why. The loop in `runStructured`
       * does the same job where it can be read, counted and backed off.
       */
      { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: 0 },
    );

    const choice = completion.choices[0];
    if (choice?.message?.refusal) {
      throw new ProviderRefusedError(`grok declined: ${choice.message.refusal}`);
    }
    const parsed = choice?.message?.parsed;
    if (!parsed) {
      throw new Error("grok returned no parsed output matching the schema");
    }
    await recordUsage({
      provider: "xai",
      model: GROK_MODEL,
      operation: req.operation ?? "pdf-extract",
      inputTokens: completion.usage?.prompt_tokens ?? null,
      outputTokens: completion.usage?.completion_tokens ?? null,
      countyFips: req.countyFips ?? null,
      note: req.schemaName,
    });
    return parsed as z.infer<T>;
  },
};

// ---------------------------------------------------------------------------
// Claude (fallback)
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = "claude-opus-5";

const claudeProvider: Provider = {
  name: "claude",
  model: CLAUDE_MODEL,

  // An empty string is not a key. ANTHROPIC_API_KEY was set to "" in .env.local,
  // which `Boolean()` reports as unconfigured only by luck of it being falsy —
  // but a whitespace-only value would have passed and failed at the API instead,
  // reporting "all providers failed" for what is really "no key set".
  configured: () => (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0,

  async run<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const client = new Anthropic();
    const maxTokens = req.maxTokens ?? 16000;

    // Anthropic requires streaming for operations that may exceed ~10 minutes.
    // Large PDF extractions (high max_tokens + high effort + big prompts) hit
    // that gate on non-streaming `messages.parse`, so we always stream and
    // take finalMessage() — same structured parse when output_config.format
    // is set.
    const stream = client.messages.stream(
      {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: req.system,
      output_config: {
        // Medium is enough for transcription; "high" balloons latency and
        // was forcing the long-request path on booklets.
        effort: maxTokens >= 16000 ? "medium" : "high",
        format: zodOutputFormat(req.schema),
      },
      messages: [
        {
          role: "user",
          content: req.images?.length
            ? [
                ...req.images.map((img) => ({
                  type: "image" as const,
                  source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
                })),
                { type: "text" as const, text: req.prompt },
              ]
            : req.prompt,
        },
      ],
      },
      /* See the note on the Grok leg — `runStructured` owns the retry. */
      { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: 0 },
    );

    const response = await stream.finalMessage();

    // Safety classifiers can decline; check before reading content.
    if (response.stop_reason === "refusal") {
      throw new ProviderRefusedError(
        `claude declined (${(response as { stop_details?: { category?: string } }).stop_details?.category ?? "unspecified"})`,
      );
    }
    const parsed = (response as { parsed_output?: z.infer<T> }).parsed_output;
    if (!parsed) {
      throw new Error("claude returned no parsed output matching the schema");
    }
    const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    await recordUsage({
      provider: "anthropic",
      model: CLAUDE_MODEL,
      operation: req.operation ?? "pdf-extract",
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      countyFips: req.countyFips ?? null,
      note: req.schemaName,
    });
    return parsed;
  },
};

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/**
 * Primary first, fallback second. Order is the product decision.
 *
 * Grok stays primary. `DEEDPILOT_DISABLE_GROK=1` drops it from the chain without
 * a code change, which is worth having: when the xAI account hit its spending
 * limit it returned 403 on every call and took reflection, the decide node and
 * the Cartographer down together, and an env flag beats an emergency deploy.
 *
 * Read at call time (not module load) so `dotenv` / `.env.local` loaded by
 * scripts after import still takes effect.
 */
function providerChain(): Provider[] {
  const disableGrok = /^(1|true|yes)$/i.test(process.env.DEEDPILOT_DISABLE_GROK ?? "");
  return disableGrok ? [claudeProvider] : [grokProvider, claudeProvider];
}

export function configuredProviders(): string[] {
  return providerChain().filter((p) => p.configured()).map((p) => p.name);
}

/**
 * Run a schema-constrained request against the provider chain.
 *
 * A provider that isn't configured is skipped silently — that is a deployment
 * state, not an error. A provider that is configured but *fails* is logged and
 * the chain continues, so a bad xAI key or an outage degrades to Claude rather
 * than taking the feature down.
 *
 * Throws `NoProviderAvailableError` only when every leg is unusable; callers
 * render the deterministic analysis without a narrative in that case.
 */
export async function runStructured<T extends z.ZodType>(
  req: StructuredRequest<T>,
): Promise<ProviderResult<z.infer<T>>> {
  const usable = providerChain().filter((p) => p.configured());

  if (usable.length === 0) {
    throw new NoProviderAvailableError(
      "No LLM provider configured. Set XAI_API_KEY (primary) or ANTHROPIC_API_KEY (fallback).",
    );
  }

  const failures: string[] = [];

  const maxAttempts = Math.max(1, req.attempts ?? TRANSIENT_ATTEMPTS);

  for (const [i, provider] of usable.entries()) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await provider.run(req);
        return { data, model: provider.model, usedFallback: i > 0 };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = isTransient(e) && attempt < maxAttempts;
        if (retryable) {
          /* Backoff, jittered, so a batch that all timed out does not all
             return at the same instant and time out together again. */
          const wait = Math.round(2000 * 2 ** (attempt - 1) * (0.5 + Math.random()));
          console.warn(`[ai] ${provider.name} attempt ${attempt} — ${msg}; retrying in ${wait}ms`);
          await sleep(wait);
          continue;
        }
        failures.push(`${provider.name}: ${msg}`);
        console.warn(`[ai] ${provider.name} failed, trying next provider — ${msg}`);
        break;
      }
    }
  }

  throw new NoProviderAvailableError(
    `All configured providers failed. ${failures.join(" | ")}`,
  );
}

// ---------------------------------------------------------------------------
// Searched requests — the model reads the live web, not its memory
// ---------------------------------------------------------------------------

/**
 * Which model does the browsing.
 *
 * Pinned separately from `XAI_MODEL` because the two jobs have different
 * requirements and, as of this writing, different capabilities: probed against
 * the live API, grok-4.5 ran six searches and returned an empty `annotations`
 * array, while grok-4.6 returned thirty real county URLs for the same
 * question. A report whose rows cannot be traced to a source is the thing this
 * whole path exists to avoid, so the searching leg pins the model that cites.
 */
const GROK_SEARCH_MODEL = process.env.XAI_SEARCH_MODEL ?? "grok-4.6";

/** A page the model actually fetched, as reported by the provider. */
export interface Citation {
  url: string;
  title: string | null;
}

export interface SearchedRequest<T extends z.ZodType> extends StructuredRequest<T> {
  /**
   * Hosts the search must not read. Max five, and mutually exclusive with an
   * allow-list at the provider — so this is the lever for "do not source from
   * X", not for "only source from Y".
   */
  excludedDomains?: string[];
}

export interface SearchedResult<T> extends ProviderResult<T> {
  citations: Citation[];
  /** How many searches the provider actually ran. Zero means it did not look. */
  searchCount: number;
}

export class SearchUnavailableError extends Error {}

/**
 * Run a schema-constrained request with live web access.
 *
 * Deliberately NOT part of `runStructured`'s provider chain, and this is the
 * important decision in the file.
 *
 * `runStructured` degrades to Claude when Grok fails, which is right for a
 * narrative over figures that were already computed — the worst case is a
 * differently-worded explanation of the same numbers. Here the worst case is
 * categorically different. A searched request asks for facts the model does not
 * have: which county is selling, on what date, at what URL. Falling back to a
 * leg that cannot browse would not degrade the answer, it would invent one —
 * a confident, well-formatted list of auctions that do not exist, on dates
 * nobody can attend. Someone would drive to a courthouse on the strength of it.
 *
 * So there is no fallback. If the searching provider is unavailable this
 * throws, and the caller reports that no report could be produced. A missing
 * report is recoverable; a fabricated one is not.
 *
 * Uses the Responses API rather than chat completions: the older
 * `live_search` tool now answers HTTP 410 Gone, directing callers to the agent
 * tools API. Raw fetch rather than the SDK because the wire shape here —
 * `tools[].filters`, and citations arriving as message annotations — was
 * established by probing the live endpoint, and is what this parses.
 */
export async function runSearched<T extends z.ZodType>(
  req: SearchedRequest<T>,
): Promise<SearchedResult<z.infer<T>>> {
  const key = (process.env.XAI_API_KEY ?? "").trim();
  if (!key) {
    throw new SearchUnavailableError(
      "Live web search needs XAI_API_KEY. There is no fallback for searched requests on purpose — " +
        "a provider that cannot browse would invent the answer rather than look it up.",
    );
  }

  const base = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";

  /*
   * A dispatcher that will wait.
   *
   * Node's default `headersTimeout` is five minutes, and this request sends no
   * headers until the model has finished searching and writing — an Arkansas
   * run enumerating a statewide catalog died at 303,534ms with a bare "fetch
   * failed", which reads as an API outage and is nothing of the kind. The work
   * was still going. Raised well past what a full state takes so the ceiling
   * is the model's, not the socket's.
   */
  const { Agent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });
  // Reuse the OpenAI helper purely as the zod → JSON Schema converter, so the
  // schema this sends is the same one `runStructured` would have sent.
  const jsonSchema = zodResponseFormat(req.schema, req.schemaName).json_schema.schema;

  const tool: Record<string, unknown> = { type: "web_search" };
  if (req.excludedDomains?.length) {
    // Five is the provider's ceiling; more is rejected outright rather than
    // truncated, so it is truncated here where the reason can be seen.
    tool.filters = { excluded_domains: req.excludedDomains.slice(0, 5) };
  }

  // undici's own fetch, not the global one: a dispatcher built by the userland
  // undici package is rejected by Node's internal copy, which surfaces as a
  // bare "fetch failed" two seconds in. Same package for both, or neither.
  const res = await undiciFetch(`${base}/responses`, {
    method: "POST",
    dispatcher,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: GROK_SEARCH_MODEL,
      max_output_tokens: req.maxTokens ?? 32000,
      instructions: req.system,
      input: [{ role: "user", content: req.prompt }],
      tools: [tool],
      text: { format: { type: "json_schema", name: req.schemaName, strict: true, schema: jsonSchema } },
    }),
  });

  if (!res.ok) {
    throw new SearchUnavailableError(`xAI responses HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as ResponsesBody;
  if (body.error) throw new SearchUnavailableError(`xAI responses: ${JSON.stringify(body.error).slice(0, 300)}`);

  // The final message carries the JSON; earlier ones are the model narrating
  // its way through the searches.
  const messages = (body.output ?? []).filter((o) => o.type === "message");
  const last = messages[messages.length - 1];
  const text = (last?.content ?? []).map((c) => c.text ?? "").join("").trim();
  if (!text) {
    throw new SearchUnavailableError(
      `xAI returned no final message (status ${body.status ?? "unknown"}) — ` +
        `likely truncated at max_output_tokens after ${body.usage?.server_side_tool_usage_details?.web_search_calls ?? 0} searches.`,
    );
  }

  const data = req.schema.parse(JSON.parse(text)) as z.infer<T>;

  // Citations are annotations on the message, deduped by URL — the same source
  // is commonly cited by several sentences.
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const c of last?.content ?? []) {
    for (const a of c.annotations ?? []) {
      if (a.type !== "url_citation" || !a.url || seen.has(a.url)) continue;
      seen.add(a.url);
      citations.push({ url: a.url, title: a.title ?? null });
    }
  }

  const searchCount = body.usage?.server_side_tool_usage_details?.web_search_calls ?? 0;
  await recordUsage({
    provider: "xai",
    model: GROK_SEARCH_MODEL,
    operation: req.operation ?? "scout-research",
    inputTokens: body.usage?.input_tokens ?? null,
    outputTokens: body.usage?.output_tokens ?? null,
    searchCalls: searchCount,
    countyFips: req.countyFips ?? null,
    note: req.schemaName,
  });

  return {
    data,
    model: GROK_SEARCH_MODEL,
    usedFallback: false,
    citations,
    searchCount,
  };
}

/** The slice of the Responses API body this reads. Probed, not guessed. */
interface ResponsesBody {
  status?: string;
  error?: unknown;
  output?: {
    type: string;
    content?: {
      text?: string;
      annotations?: { type?: string; url?: string; title?: string | null }[];
    }[];
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    server_side_tool_usage_details?: { web_search_calls?: number };
  };
}
