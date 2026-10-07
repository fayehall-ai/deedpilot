/**
 * Display formatting.
 *
 * The recurring rule: a missing value renders as an em dash, never as $0.
 * "We don't know the opening bid" and "the opening bid is zero" lead to
 * completely different decisions at an auction.
 */

export function money(
  value: number | string | null | undefined,
  opts: { decimals?: boolean; compact?: boolean } = {},
): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";

  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.decimals ? 2 : 0,
    maximumFractionDigits: opts.decimals ? 2 : 0,
    notation: opts.compact ? "compact" : "standard",
  });
}

export function percent(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(decimals)}%`;
}

export function num(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/** Format a YYYY-MM-DD date without letting the local timezone shift the day. */
export function saleDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * A sale's dates: "Oct 7, 2026" for one day, "Oct 30 – Nov 2, 2026" for a span.
 * The year is written once when both ends share it.
 */
export function saleDateRange(start: string | null | undefined, end?: string | null): string {
  if (!start) return "—";
  if (!end || end <= start) return saleDate(start);
  const md = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
  };
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${md(start)} – ${md(end)}, ${end.slice(0, 4)}`
    : `${saleDate(start)} – ${saleDate(end)}`;
}

/** Whole days from one ISO date to another, counting both ends: Oct 30 → Nov 2 is 4. */
export function daysSpanned(start: string, end?: string | null): number {
  if (!end || end <= start) return 1;
  const ms = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10)) -
    Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  return Math.round(ms / 86_400_000) + 1;
}

/** "in 6 days" / "today" / "3 days ago", relative to now in whole days. */
export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const target = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((target - today) / 86_400_000);

  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/**
 * Auction platforms as their operators brand them.
 *
 * Worth spelling out rather than title-casing the enum: a bidder who already
 * holds a GovEase deposit or a Zeus login is filtering for exactly that word,
 * and "Taxsaleinfo" is not what it says on the site they log into.
 */
const PLATFORM_LABELS: Record<string, string> = {
  realtaxdeed: "RealAuction",
  realforeclose: "RealForeclose",
  govease: "GovEase",
  bid4assets: "Bid4Assets",
  zeus: "Zeus Auction",
  lienhub: "LienHub",
  grantstreet: "Grant Street",
  taxsaleinfo: "Tax Sale Info",
  mvba: "MVBA",
  lgbs: "Linebarger (LGBS)",
  county_site: "County site",
  in_person: "In person",
};

/**
 * How long ago something happened, at timestamp granularity.
 *
 * `relativeDays` answers "which day", which is the right answer for a sale
 * date and the wrong one for a pipeline run: a crawl that finished two hours
 * ago and one that finished twenty-two both read as "today", and the whole
 * reason to show a run time is to tell those apart.
 */
export function relativeTime(at: Date | string | null | undefined): string {
  if (!at) return "";
  const then = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function platformLabel(platform: string | null | undefined): string {
  if (!platform) return "—";
  return PLATFORM_LABELS[platform] ?? platform;
}

const SALE_TYPE_VAR: Record<string, string> = {
  "Tax Lien": "var(--type-lien)",
  "Tax Deed": "var(--type-deed)",
  "Redeemable Deed": "var(--type-redeemable)",
  Hybrid: "var(--type-hybrid)",
};

export function saleTypeColor(type: string): string {
  return SALE_TYPE_VAR[type] ?? "var(--muted)";
}

/**
 * How many parcels to show for a sale, and whether that number is ours.
 *
 * Two different facts share one slot in the UI. `lotCount` is parcels this
 * database holds — crawled, priceable, clickable. `announcedParcelCount` is
 * what a county said it is offering in a sale nothing has crawled yet, which is
 * a claim about the world rather than a count of rows.
 *
 * Collapsing them would be wrong in both directions: showing an imported sale
 * as "0 parcels" hides a genuine 16,062-parcel auction, and showing it as a
 * plain "16,062" promises a parcel list that does not exist behind the link.
 * So the count comes back with the flag, and every caller is obliged to say
 * which kind it is rather than being able to forget.
 */
export function parcelsShown(a: {
  lotCount: number;
  announcedParcelCount?: number | null;
}): { count: number; announced: boolean } {
  if (a.lotCount > 0) return { count: a.lotCount, announced: false };
  return { count: a.announcedParcelCount ?? 0, announced: true };
}
