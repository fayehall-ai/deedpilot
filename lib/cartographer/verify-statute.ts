/**
 * Read the cited statute and check it says what the proposal claims.
 *
 * ## Why this exists
 *
 * The Arkansas draft carried `redemption: null` on sound reasoning over
 * secondary sources, and sat that way for a week because the review note said a
 * person had to open two links. That was the wrong instruction. Fetching a page
 * and locating a subsection is retrieval, not judgement, and asking a human to
 * be a browser is the slowest possible way to answer a question with a
 * published answer.
 *
 * The gate the Cartographer actually needs is that **nobody writes
 * `STATUTE_PARAMS` unreviewed**. It was never that a human should do the
 * reading. This pass does the reading; the human still accepts the number.
 *
 * ## Why it quotes rather than concludes
 *
 * The output a reviewer wants is not "verified ✓" — that is just a second
 * opinion with no evidence attached. It is the operative sentence, verbatim,
 * with the URL, so the check is Ctrl-F against a page rather than trusting a
 * model twice. A claim the text does not support comes back `contradicted` with
 * the language that contradicts it.
 *
 * Verbatim matters especially here. Arkansas turned on the difference between a
 * right to redeem BEFORE the sale and a bar on contesting AFTER it — one word
 * apart in summary, opposite in economic sign.
 */

import { z } from "zod";
import * as cheerio from "cheerio";
import { politeFetch, PolicyBlockedError } from "../ingest/fetch";
import { runSearched, runStructured } from "../ai/providers";

const VerdictSchema = z.object({
  verdict: z
    .enum(["supported", "contradicted", "silent", "unreadable"])
    .describe(
      "'supported' only when the text states the claim; 'contradicted' when it states " +
        "otherwise; 'silent' when the section simply does not address it; 'unreadable' " +
        "when the page did not contain statute text",
    ),
  quote: z
    .string()
    .describe(
      "The operative sentence, VERBATIM from the page, that decides it. Empty if silent " +
        "or unreadable. Never paraphrase — a reviewer must be able to find this string.",
    ),
  section: z.string().describe("The section or subsection the quote sits in, e.g. '§ 26-37-202(e)'"),
  reasoning: z.string().describe("One or two sentences on why the quote decides the claim"),
  alsoNoted: z
    .array(z.string())
    .describe(
      "Anything else in the text that changes the economics and the claim did not mention — " +
        "amending acts, effective dates, exceptions, disability tolling",
    ),
});

export type StatuteVerdict = z.infer<typeof VerdictSchema>;

export interface VerificationResult extends StatuteVerdict {
  url: string;
  claim: string;
  /** Characters of statute text actually read, so an empty page is visible. */
  charsRead: number;
  /** How the text was obtained — a fetched citation, or a search that found it. */
  via: "fetch" | "search";
  /** Where a search actually read the text, when the cited URL was unusable. */
  foundAt?: string[];
  error?: string;
}

/**
 * Fall back to searching for the section when its citation cannot be fetched.
 *
 * Legal publishers are a hostile fetch target — findlaw and justia both returned
 * zero characters for § 26-37-203, and casetext 203, all JS shells or paywalls.
 * A citation nobody can open is a real finding about the proposal, but it is a
 * poor reason to abandon a question the text answers plainly somewhere else.
 *
 * The searched leg is second, never first: a fetched citation is deterministic
 * and reproducible, and a search is neither. Reaching for search first would
 * trade a checkable answer for a convenient one.
 */
async function verifyBySearch(url: string, claim: string): Promise<VerificationResult> {
  const base = { url, claim, charsRead: 0, via: "search" as const };
  try {
    const result = await runSearched({
      system: SYSTEM,
      prompt:
        `CLAIM TO CHECK:\n${claim}\n\n` +
        `The citation ${url} could not be fetched — it is a paywall or a JS shell. Find the ` +
        `same statute section on a publisher that serves readable text, read the operative ` +
        `language, and decide whether it supports, contradicts or is silent on the claim. ` +
        `Quote verbatim from the text you actually read, and report where you read it.`,
      schema: VerdictSchema,
      schemaName: "statute_verdict",
      operation: "cartographer",
      maxTokens: 8000,
    });
    return {
      ...base,
      ...result.data,
      foundAt: result.citations.map((c) => c.url).slice(0, 4),
    };
  } catch (e) {
    return {
      ...base,
      verdict: "unreadable",
      quote: "",
      section: "",
      reasoning: `citation unfetchable and search failed: ${e instanceof Error ? e.message : String(e)}`,
      alsoNoted: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

const SYSTEM = `You read statute text and report what it says, nothing more.

You quote verbatim. A reviewer will search the page for your quote, so a
paraphrase is a failed answer even when its meaning is right.

You do not resolve ambiguity in the claim's favour. If the section does not
address the claim, that is 'silent' and is a useful answer. If it says the
opposite, that is 'contradicted' and is the most useful answer of all.

Report anything in the text that changes the economics and the claim omitted:
an amending act, an effective date, an exception, a tolling provision.`;

/** Strip a legal-publisher page down to readable text. */
function extractText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, noscript, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

/**
 * Check one claim against one cited page.
 *
 * Never throws. A blocked or dead citation is a finding — it means the proposal
 * rests on a source a reviewer cannot open either.
 */
export async function verifyClaim(url: string, claim: string): Promise<VerificationResult> {
  const base = { url, claim, charsRead: 0, via: "fetch" as const };
  let text: string;

  try {
    const res = await politeFetch(url);
    text = extractText(res.body);
  } catch (e) {
    /*
     * A policy block is not a publisher problem and search must not route
     * around it — the access decision is deliberate and applies to this project
     * whatever the transport.
     */
    if (e instanceof PolicyBlockedError) {
      return {
        ...base,
        verdict: "unreadable",
        quote: "",
        section: "",
        reasoning: `access policy blocks ${new URL(url).hostname}; cite a publisher this project may fetch`,
        alsoNoted: [],
        error: e.message,
      };
    }
    return verifyBySearch(url, claim);
  }

  // A JS shell or paywall reads as a successful fetch of nothing.
  if (text.length < 400) return verifyBySearch(url, claim);

  const { data } = await runStructured({
    system: SYSTEM,
    prompt:
      `CLAIM TO CHECK:\n${claim}\n\n` +
      `Decide whether the statute text below supports it, contradicts it, or is silent. ` +
      `Quote the operative sentence verbatim.\n\nSOURCE: ${url}\n\n---\n${text.slice(0, 120_000)}`,
    schema: VerdictSchema,
    schemaName: "statute_verdict",
    operation: "cartographer",
    maxTokens: 4000,
  });

  return { ...base, ...data, charsRead: text.length };
}

/** Check several claims, each against its own citation. */
export async function verifyClaims(
  claims: readonly { url: string; claim: string }[],
): Promise<VerificationResult[]> {
  const out: VerificationResult[] = [];
  // Sequential: `politeFetch` enforces per-host delays and legal publishers are
  // frequently the same host.
  for (const c of claims) out.push(await verifyClaim(c.url, c.claim));
  return out;
}
