/**
 * Operator corrections to where a county publishes, applied to the crawl.
 *
 * ## The bug this closes
 *
 * `source_overrides` had a form in the console, a save action, an audit entry
 * and a listing — and **no adapter read it**. Correcting a moved county URL
 * saved successfully, appeared in the table, and changed nothing about what got
 * fetched. Exactly the shape of the auction-override problem: an edit that looks
 * like it worked and does not.
 *
 * ## Why this sits in the runner rather than in each adapter
 *
 * `runAdapter` calls `discoverCounties()` and gets `CountyBinding[]`. That is
 * the one choke point every adapter passes through, so overriding here covers
 * all twelve at once and covers the next one for free. Editing each adapter
 * would leave the feature silently missing wherever somebody forgot.
 *
 * ## Why a URL override is not universal, and says so
 *
 * `CountyBinding.config` is deliberately adapter-specific: `generic-county`
 * carries `{ url }`, `clark-nv` carries `{ sourceUrl }`, but `tx-lgbs` carries
 * `{ lgbsCounty, state }` and `mi-taxsaleinfo` carries `{ catalogId }` — they
 * resolve their source from a law firm's multi-county page or a platform
 * catalog id, and there is no per-county URL to replace.
 *
 * So a URL override applies where the binding actually holds one, and is
 * **reported as inapplicable** everywhere else rather than quietly dropped.
 * Silently ignoring it would rebuild the same bug one level down.
 *
 * Disabling a county, by contrast, is meaningful for every adapter: it removes
 * the binding, whatever shape its config takes.
 */

import { and, eq } from "drizzle-orm";

/** Config keys that hold a single fetchable source URL, in precedence order. */
const URL_KEYS = ["url", "sourceUrl", "listUrl"] as const;

export interface OverrideRow {
  adapter: string;
  countyFips: string;
  url: string | null;
  enabled: boolean;
  note: string | null;
}

export interface AppliedOverrides<B> {
  bindings: B[];
  /** Counties removed because an operator switched them off. */
  disabled: string[];
  /** Counties whose source URL was replaced. */
  rewritten: string[];
  /**
   * Overrides that could not be applied, with the reason.
   *
   * Surfaced rather than swallowed: an operator who set a URL on an adapter
   * that has no per-county URL needs to know their edit is inert, and the
   * console is the only place they would find out.
   */
  inapplicable: { countyFips: string; reason: string }[];
}

async function conn() {
  const [{ db }, { sourceOverrides }] = await Promise.all([
    import("../db"),
    import("../db/schema"),
  ]);
  return { db, sourceOverrides };
}

/** Every override for one adapter, keyed by county FIPS. */
export async function loadOverridesFor(adapter: string): Promise<Map<string, OverrideRow>> {
  try {
    const { db, sourceOverrides } = await conn();
    const rows = await db
      .select({
        adapter: sourceOverrides.adapter,
        countyFips: sourceOverrides.countyFips,
        url: sourceOverrides.url,
        enabled: sourceOverrides.enabled,
        note: sourceOverrides.note,
      })
      .from(sourceOverrides)
      .where(eq(sourceOverrides.adapter, adapter));
    return new Map(rows.map((r) => [r.countyFips, r]));
  } catch {
    /*
     * An unreachable overrides table must not stop a crawl. The corrections are
     * an overlay on a registry that is already correct for almost every county;
     * losing them degrades to the published source rather than to nothing.
     */
    return new Map();
  }
}

/** Which config key, if any, this binding uses to hold its source URL. */
export function urlKeyOf(config: Record<string, unknown>): string | null {
  for (const key of URL_KEYS) {
    if (typeof config[key] === "string" && (config[key] as string).length > 0) return key;
  }
  return null;
}

/**
 * Apply an adapter's overrides to the bindings it discovered.
 *
 * Pure given the override map, so the precedence rules are testable without a
 * database — which matters, because getting this wrong sends a crawler at the
 * wrong county's sale list.
 */
export function applyOverrides<B extends { countyFips: string; config: Record<string, unknown> }>(
  bindings: readonly B[],
  overrides: Map<string, OverrideRow>,
): AppliedOverrides<B> {
  const out: B[] = [];
  const disabled: string[] = [];
  const rewritten: string[] = [];
  const inapplicable: { countyFips: string; reason: string }[] = [];

  for (const binding of bindings) {
    const o = overrides.get(binding.countyFips);
    if (!o) {
      out.push(binding);
      continue;
    }

    if (!o.enabled) {
      disabled.push(binding.countyFips);
      continue;
    }

    if (!o.url) {
      // Enabled with no URL means "keep the registry's source" — the schema
      // says so, and it is how an operator re-enables a county they had off.
      out.push(binding);
      continue;
    }

    const key = urlKeyOf(binding.config);
    if (!key) {
      inapplicable.push({
        countyFips: binding.countyFips,
        reason:
          "this adapter resolves its source from a multi-county page or platform id, " +
          "so there is no per-county URL to replace — the override is stored but inert",
      });
      out.push(binding);
      continue;
    }

    rewritten.push(binding.countyFips);
    out.push({ ...binding, config: { ...binding.config, [key]: o.url } });
  }

  return { bindings: out, disabled, rewritten, inapplicable };
}
