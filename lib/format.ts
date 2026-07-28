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

const SALE_TYPE_VAR: Record<string, string> = {
  "Tax Lien": "var(--type-lien)",
  "Tax Deed": "var(--type-deed)",
  "Redeemable Deed": "var(--type-redeemable)",
  Hybrid: "var(--type-hybrid)",
};

export function saleTypeColor(type: string): string {
  return SALE_TYPE_VAR[type] ?? "var(--muted)";
}
