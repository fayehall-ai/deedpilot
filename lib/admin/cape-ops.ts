/**
 * CAPE, viewed as an operations queue rather than a scoreboard.
 *
 * `/cape` answers "is this package ready". This answers the operator's
 * question instead: across every upcoming sale, which stage is holding the
 * most packages back, and what specifically is missing at that stage.
 *
 * The distinction matters because the two views disagree about what is
 * interesting. A component sitting at 60% everywhere is a background condition;
 * a component at 100% on ninety packages and 0% on six is a fixable incident.
 * Ranking by how many packages an item blocks surfaces the second.
 */
import "server-only";
import { getCapeAuctions, getCapeParcelCoverage } from "../queries";
import { buildPackage, type ItemState, type CapePackage } from "../cape/components";
import { getCounty, resolveCountyRule } from "../atlas";
import { statuteFor } from "../deal/statute";
import { pickLink, type CountyDirectory, type OfficeKind } from "../directory/onlinesearches";
import directory from "../../data/county-directory.json";

export interface StageRollup {
  n: number;
  title: string;
  /** Mean component score across all upcoming packages. */
  mean: number;
  counts: Record<ItemState, number>;
  /** Packages where this component scores below 1. */
  packagesBlocked: number;
  /**
   * The individual checklist items holding this stage back, worst first.
   * `absent` is counted separately from `verify`: absent means the data does
   * not exist for us to get, verify means we hold something unconfirmed.
   */
  items: { label: string; absent: number; verify: number; have: number; sample: string | null }[];
}

export interface CapeOps {
  packages: number;
  releasable: number;
  meanScore: number;
  stages: StageRollup[];
  /** Blocking reasons across all packages, most frequent first. */
  blockers: { reason: string; packages: number }[];
  /** The worst-scoring upcoming packages, for a place to start. */
  worst: { auctionId: string; label: string; saleDate: string; score: number; blockedBy: string[] }[];
}

export async function getCapeOps(): Promise<CapeOps> {
  const [rows, coverage] = await Promise.all([getCapeAuctions(), getCapeParcelCoverage()]);
  const today = new Date().toISOString().slice(0, 10);
  const empty = {
    total: 0, withParcelNumber: 0, withAssessed: 0,
    withAddress: 0, withZoning: 0, withGeo: 0,
  };

  const dir = directory as Record<string, CountyDirectory>;
  const officesFor = (fips: string): Partial<Record<string, string>> => {
    const entry = dir[fips];
    if (!entry) return {};
    const out: Partial<Record<string, string>> = {};
    for (const kind of ["assessor", "collector", "recorder", "gis", "tax_portal"] as OfficeKind[]) {
      const hit = pickLink(entry, kind);
      if (hit) out[kind] = hit.url;
    }
    return out;
  };

  const packages: { pkg: CapePackage; label: string; saleDate: string }[] = rows.map((r) => ({
    label: `${r.countyName ?? r.countyFips}, ${r.state ?? "??"}`,
    saleDate: r.saleDate,
    pkg: buildPackage({
      auctionId: r.id,
      countyName: r.countyName,
      state: r.state,
      saleDate: r.saleDate,
      saleDateConfirmed: r.saleDateConfirmed,
      saleType: r.saleType,
      sourceUrl: r.sourceUrl,
      platform: r.platform,
      startTime: null,
      registrationDeadline: r.registrationDeadline,
      depositDeadline: r.depositDeadline,
      lotCount: r.lotCount,
      listingKind: r.listingKind,
      rule: resolveCountyRule(r.countyFips),
      statute: statuteFor(r.state) ?? null,
      offices: officesFor(r.countyFips),
      population: getCounty(r.countyFips)?.population ?? null,
      parcels: coverage[r.id] ?? empty,
      today,
    }),
  }));

  if (packages.length === 0) {
    return { packages: 0, releasable: 0, meanScore: 0, stages: [], blockers: [], worst: [] };
  }

  /*
   * Every package carries the same components in the same order, so index
   * alignment is safe — but read the title off each package rather than
   * assuming, so a component added mid-list cannot silently mislabel a column.
   */
  const stages: StageRollup[] = packages[0].pkg.components.map((proto, idx) => {
    const counts: Record<ItemState, number> = { have: 0, verify: 0, absent: 0 };
    const byItem = new Map<string, { absent: number; verify: number; have: number; sample: string | null }>();
    let sum = 0;
    let blocked = 0;

    for (const { pkg } of packages) {
      const c = pkg.components[idx];
      sum += c.score;
      if (c.score < 1) blocked++;
      for (const k of ["have", "verify", "absent"] as ItemState[]) counts[k] += c.counts[k];
      for (const item of c.items) {
        const cur = byItem.get(item.label) ?? { absent: 0, verify: 0, have: 0, sample: null };
        cur[item.state]++;
        // Keep the first explanation seen for a non-satisfied item; it is the
        // most useful thing on the row and is usually identical across counties.
        if (item.state !== "have" && !cur.sample && item.detail) cur.sample = item.detail;
        byItem.set(item.label, cur);
      }
    }

    return {
      n: proto.n,
      title: proto.title,
      mean: sum / packages.length,
      counts,
      packagesBlocked: blocked,
      items: [...byItem.entries()]
        .map(([label, v]) => ({ label, ...v }))
        .sort((a, b) => b.absent - a.absent || b.verify - a.verify || a.label.localeCompare(b.label)),
    };
  });

  const blockerCounts = new Map<string, number>();
  for (const { pkg } of packages) {
    for (const b of pkg.blockedBy) blockerCounts.set(b, (blockerCounts.get(b) ?? 0) + 1);
  }

  const worst = packages
    .slice()
    .sort((a, b) => a.pkg.score - b.pkg.score || a.saleDate.localeCompare(b.saleDate))
    .slice(0, 12)
    .map(({ pkg, label, saleDate }) => ({
      auctionId: pkg.auctionId,
      label,
      saleDate,
      score: pkg.score,
      blockedBy: pkg.blockedBy,
    }));

  return {
    packages: packages.length,
    releasable: packages.filter((p) => p.pkg.releasable).length,
    meanScore: packages.reduce((n, p) => n + p.pkg.score, 0) / packages.length,
    stages,
    blockers: [...blockerCounts.entries()]
      .map(([reason, n]) => ({ reason, packages: n }))
      .sort((a, b) => b.packages - a.packages),
    worst,
  };
}
