import "server-only";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

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

export interface StructuredRequest<T extends z.ZodType> {
  system: string;
  prompt: string;
  schema: T;
  /** Schema name sent to the provider; must be a bare identifier. */
  schemaName: string;
  maxTokens?: number;
}

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

  configured: () => Boolean(process.env.XAI_API_KEY),

  async run<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const client = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    });

    const completion = await client.chat.completions.parse({
      model: GROK_MODEL,
      max_completion_tokens: req.maxTokens ?? 16000,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      response_format: zodResponseFormat(req.schema, req.schemaName),
    });

    const choice = completion.choices[0];
    if (choice?.message?.refusal) {
      throw new ProviderRefusedError(`grok declined: ${choice.message.refusal}`);
    }
    const parsed = choice?.message?.parsed;
    if (!parsed) {
      throw new Error("grok returned no parsed output matching the schema");
    }
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

  configured: () => Boolean(process.env.ANTHROPIC_API_KEY),

  async run<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const client = new Anthropic();

    const response = await client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      output_config: {
        effort: "high",
        format: zodOutputFormat(req.schema),
      },
      messages: [{ role: "user", content: req.prompt }],
    });

    // Safety classifiers can decline; check before reading content.
    if (response.stop_reason === "refusal") {
      throw new ProviderRefusedError(
        `claude declined (${response.stop_details?.category ?? "unspecified"})`,
      );
    }
    if (!response.parsed_output) {
      throw new Error("claude returned no parsed output matching the schema");
    }
    return response.parsed_output as z.infer<T>;
  },
};

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/** Primary first, fallback second. Order is the product decision. */
const CHAIN: Provider[] = [grokProvider, claudeProvider];

export function configuredProviders(): string[] {
  return CHAIN.filter((p) => p.configured()).map((p) => p.name);
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
  const usable = CHAIN.filter((p) => p.configured());

  if (usable.length === 0) {
    throw new NoProviderAvailableError(
      "No LLM provider configured. Set XAI_API_KEY (primary) or ANTHROPIC_API_KEY (fallback).",
    );
  }

  const failures: string[] = [];

  for (const [i, provider] of usable.entries()) {
    try {
      const data = await provider.run(req);
      return { data, model: provider.model, usedFallback: i > 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${provider.name}: ${msg}`);
      console.warn(`[ai] ${provider.name} failed, trying next provider — ${msg}`);
    }
  }

  throw new NoProviderAvailableError(
    `All configured providers failed. ${failures.join(" | ")}`,
  );
}
