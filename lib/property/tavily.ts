/**
 * Retrieval for property lookup: search once, then extract.
 *
 * ## Why this exists
 *
 * `runSearched` hands the whole job to the model, which browses on its own. For
 * one address that measured at **114.6 seconds, 15 searches and 49 citations** —
 * the model kept looking because nothing told it when to stop.
 *
 * A single Tavily call for the same address took **4.8 seconds** and returned the
 * market value in its own summary line. Both arrived at $1,283,202,000, so the
 * slower path bought nothing here except confidence that it had looked
 * everywhere.
 *
 * This splits the two halves the rest of the project already separates: search
 * retrieves, the model extracts. Retrieval is a search-engine problem and
 * `runStructured` — with no browsing — is fast because it only has to read.
 *
 * ## What it does not change
 *
 * The schema, the refusal behaviour and the ban on writing `assessedValue` all
 * live in `websearch.ts` and are untouched. This module only supplies text for
 * that contract to read, so a faster retrieval path cannot loosen the guard that
 * keeps a searched estimate out of the assessed-value field.
 *
 * ## When to prefer the browsing path
 *
 * Tavily returns snippets from pages it has already indexed. For a question that
 * needs a form filled in or a county portal walked — the harder half of parcel
 * lookup — the browsing model is still the better tool. This is the fast path
 * for the common case, not a replacement for the general one.
 */

const TAVILY_URL = "https://api.tavily.com/search";

export interface RetrievedSource {
  url: string;
  title: string | null;
  content: string;
}

export interface Retrieval {
  /** Tavily's own one-line summary. Useful, and never used as the figure. */
  answer: string | null;
  sources: RetrievedSource[];
  ms: number;
}

export function tavilyConfigured(): boolean {
  return !!(process.env.TAVILY_API_KEY ?? "").trim();
}

/**
 * One search, returning the pages rather than an answer.
 *
 * `include_answer` is requested because it is free with the call and gives the
 * extraction step a hint to check, but it is passed through as `answer` and
 * never promoted to a figure on its own — a one-line summary with no URL is
 * exactly the unsourced number this project refuses everywhere else.
 */
export async function retrieveForAddress(
  address: string,
  extra: { parcelNumber?: string | null; county?: string | null } = {},
): Promise<Retrieval> {
  const key = (process.env.TAVILY_API_KEY ?? "").trim();
  if (!key) throw new Error("TAVILY_API_KEY is not set");

  const query = [
    address,
    extra.parcelNumber ? `parcel ${extra.parcelNumber}` : null,
    extra.county ? `${extra.county} County assessor` : null,
    "property assessed value market value owner",
  ]
    .filter(Boolean)
    .join(" ");

  const started = Date.now();
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "advanced",
      max_results: 6,
      include_answer: true,
      include_raw_content: true,
    }),
    // Retrieval must not become the slow half it was added to remove.
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    answer?: string;
    results?: { url: string; title?: string; content?: string; raw_content?: string }[];
  };

  return {
    answer: data.answer ?? null,
    sources: (data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? null,
      /*
       * Snippet first, raw page text only to top it up.
       *
       * Retrieval is 4.8s of the call; extraction over the returned text is the
       * rest. Eight sources at 12,000 characters each put ~96K characters in
       * front of the model and cost ~20s to read. Tavily's `content` is already
       * the relevant extract, so leading with it and capping the raw top-up
       * keeps what decides the answer and drops the boilerplate around it.
       */
      content: [r.content ?? "", (r.raw_content ?? "").slice(0, 4_000)]
        .filter(Boolean)
        .join("\n")
        .slice(0, 5_000),
    })),
    ms: Date.now() - started,
  };
}

/** The retrieved pages as one prompt block, each labelled with its URL. */
export function asContext(r: Retrieval): string {
  const parts = r.sources.map(
    (s, i) => `--- SOURCE ${i + 1}: ${s.url}\n${s.title ? `TITLE: ${s.title}\n` : ""}${s.content}`,
  );
  if (r.answer) {
    parts.unshift(
      `--- SEARCH ENGINE SUMMARY (a hint to verify against the sources below, NOT a citable figure)\n${r.answer}`,
    );
  }
  return parts.join("\n\n");
}
