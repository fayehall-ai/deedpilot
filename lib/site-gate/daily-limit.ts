/**
 * Daily limits on the paid features, for visitors on the public domain.
 *
 * deedpilot.app is open without the site password, so anyone — and any bot —
 * can reach the three things that spend money per use. Each is capped twice per
 * UTC day: per visitor, so one person or scraper cannot use it all, and in
 * total, because bots rotate addresses and only a total bounds the bill.
 *
 * Visitors are keyed on a SHA-256 of their IP; the IP itself is never stored.
 * Requests through the password-protected host are never counted.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { isPublicHost } from "./public-host";

export type LimitedFeature = "lookup" | "streetview" | "brief";

/** Per visitor and site-wide, per UTC day. A quarter of the first limits (2026-10-01), rounded. */
export const DAILY_LIMITS: Record<LimitedFeature, { perVisitor: number; total: number; label: string }> = {
  /* A new address is one billed RealEstateAPI record. */
  lookup: { perVisitor: 3, total: 75, label: "address lookups" },
  /* One billed Google image; the browser keeps it a day, so revisits are free. */
  streetview: { perVisitor: 15, total: 750, label: "street photos" },
  /* One model call per brief written; a brief already written is free. */
  brief: { perVisitor: 1, total: 38, label: "AI briefs" },
};

export type LimitCheck = { ok: true } | { ok: false; message: string };

/** The visitor's IP as Vercel reports it. */
function clientIp(headers: Headers): string {
  return (
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

async function bump(key: string): Promise<number> {
  const [row] = (await db.execute(sql`
    insert into daily_limits (key, day, count) values (${key}, (now() at time zone 'utc')::date, 1)
    on conflict (key, day) do update set count = daily_limits.count + 1
    returning count`)) as unknown as { count: number }[];
  return Number(row?.count ?? 0);
}

/**
 * Count one use of `feature` and say whether it is allowed. Call it only where
 * money is about to be spent — after a cache has missed — so free answers do
 * not use up the allowance.
 */
export async function spendDailyAllowance(feature: LimitedFeature, headers: Headers): Promise<LimitCheck> {
  if (!isPublicHost(headers.get("host"))) return { ok: true };
  const limit = DAILY_LIMITS[feature];
  const visitor = createHash("sha256").update(clientIp(headers)).digest("hex").slice(0, 32);
  const [mine, all] = await Promise.all([bump(`${feature}:v:${visitor}`), bump(`${feature}:all`)]);
  if (mine > limit.perVisitor) {
    return { ok: false, message: `You have reached today's limit of ${limit.perVisitor} ${limit.label}. It resets at midnight UTC.` };
  }
  if (all > limit.total) {
    return { ok: false, message: `The site has reached today's limit for ${limit.label}. It resets at midnight UTC.` };
  }
  return { ok: true };
}
