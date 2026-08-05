/**
 * One-shot ingest for list sources discovered by the coverage hunt
 * (clerk PDFs / XLSX that the generic adapter does not yet route to).
 *
 *   npm run ingest:found
 */
import "../lib/env";
import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { auctions, lots } from "../lib/db/schema";
import { pdfToText, parseStructuredPdfText } from "../lib/ingest/parse";
import { extractLots } from "../lib/ingest/extract";
import { politeFetchBinary } from "../lib/ingest/fetch";
import { judgeLots } from "../lib/ingest/judge";
import type { DiscoveredLot } from "../lib/ingest/types";

async function upsertAuction(a: {
  countyFips: string;
  platform: "county_site";
  saleType: "Tax Deed" | "Redeemable Deed" | "Tax Lien";
  externalId: string;
  saleDate: string;
  title: string;
  sourceUrl: string;
}): Promise<string> {
  const [row] = await db
    .insert(auctions)
    .values({
      countyFips: a.countyFips,
      platform: a.platform,
      saleType: a.saleType,
      externalId: a.externalId,
      title: a.title,
      saleDate: a.saleDate,
      status: "scheduled",
      sourceUrl: a.sourceUrl,
      raw: { via: "ingest-found-lists" },
    })
    .onConflictDoUpdate({
      target: [auctions.countyFips, auctions.platform, auctions.externalId],
      set: {
        saleDate: sql`excluded.sale_date`,
        title: sql`excluded.title`,
        sourceUrl: sql`excluded.source_url`,
        lastSeenAt: sql`now()`,
      },
    })
    .returning({ id: auctions.id });
  return row.id;
}

async function upsertLots(auctionId: string, countyFips: string, discovered: DiscoveredLot[]) {
  if (!discovered.length) return 0;
  const values = discovered.map((l) => ({
    auctionId,
    countyFips,
    dedupeKey: (l.parcelNumber?.trim() || l.externalId?.trim() || l.lotNumber?.trim() || crypto.randomUUID())!,
    externalId: l.externalId ?? l.lotNumber ?? null,
    lotNumber: l.lotNumber ?? null,
    parcelNumber: l.parcelNumber ?? null,
    addressLine: l.addressLine ?? null,
    city: l.city ?? null,
    openingBid: l.openingBid !== undefined ? String(l.openingBid) : null,
    assessedValue: l.assessedValue !== undefined ? String(l.assessedValue) : null,
    taxesOwed: l.taxesOwed !== undefined ? String(l.taxesOwed) : null,
    ownerName: l.ownerName ?? null,
    status: "pending" as const,
    sourceUrl: l.sourceUrl ?? null,
    raw: l.raw ?? null,
  }));

  let written = 0;
  for (let i = 0; i < values.length; i += 500) {
    const batch = values.slice(i, i + 500);
    await db
      .insert(lots)
      .values(batch)
      .onConflictDoUpdate({
        target: [lots.auctionId, lots.dedupeKey],
        set: {
          openingBid: sql`excluded.opening_bid`,
          assessedValue: sql`excluded.assessed_value`,
          taxesOwed: sql`excluded.taxes_owed`,
          addressLine: sql`excluded.address_line`,
          ownerName: sql`excluded.owner_name`,
          lastSeenAt: sql`now()`,
        },
      });
    written += batch.length;
  }
  await db.update(auctions).set({ lotCount: written }).where(eq(auctions.id, auctionId));
  return written;
}

async function ingestPdfList(opts: {
  countyFips: string;
  saleType: "Tax Deed" | "Redeemable Deed" | "Tax Lien";
  saleDate: string;
  title: string;
  externalId: string;
  url: string;
  countyName: string;
  state: string;
}) {
  console.log(`\n--- ${opts.title} ---`);
  const text = await pdfToText(opts.url);
  let discovered =
    parseStructuredPdfText(text, opts.url) ??
    (
      await extractLots(text, {
        countyName: opts.countyName,
        state: opts.state,
        sourceUrl: opts.url,
      })
    ).lots;

  const judged = judgeLots(discovered);
  console.log(
    `raw=${discovered.length} accepted=${judged.accepted.length} rejected=${judged.rejected.length}`,
  );
  if (!judged.accepted.length) {
    console.log("skip persist (0 accepted)");
    return 0;
  }
  const id = await upsertAuction({
    countyFips: opts.countyFips,
    platform: "county_site",
    saleType: opts.saleType,
    externalId: opts.externalId,
    saleDate: opts.saleDate,
    title: opts.title,
    sourceUrl: opts.url,
  });
  const n = await upsertLots(id, opts.countyFips, judged.accepted);
  console.log(`wrote ${n} lots`);
  return n;
}

async function ingestRichlandXlsx() {
  const url =
    "https://www.richlandcountysc.gov/files/assets/county/v/6/treasurer/documents/updated-flc-properties-listing-6-29-2026.xlsx";
  console.log("\n--- Richland SC FLC XLSX ---");
  const bin = await politeFetchBinary(url);
  const path = "/tmp/richland-flc.xlsx";
  writeFileSync(path, Buffer.from(bin.bytes));
  // Use python for reliable xlsx parse (no extra node dep).
  const out = execSync(`python3 scripts/_parse_xlsx_rows.py ${JSON.stringify(path)}`, {
    encoding: "utf8",
  });
  const rows = JSON.parse(out) as string[][];
  // header at rows[1]: TAX MAP#, OWNER NAME, LOCATION, OPENING BID
  const discovered: DiscoveredLot[] = [];
  for (const r of rows.slice(2)) {
    if (r.length < 4 || !r[0] || r[0].startsWith("FLC")) continue;
    const bid = Number(String(r[3]).replace(/[,$]/g, ""));
    if (!Number.isFinite(bid) || bid <= 0) continue;
    discovered.push({
      parcelNumber: r[0].replace(/-$/, ""),
      ownerName: r[1] || undefined,
      addressLine: r[2] || undefined,
      openingBid: bid,
      sourceUrl: url,
      raw: { source: "richland-flc-xlsx", row: r },
    });
  }
  const judged = judgeLots(discovered);
  console.log(`raw=${discovered.length} accepted=${judged.accepted.length}`);
  if (!judged.accepted.length) return 0;
  const id = await upsertAuction({
    countyFips: "45079",
    platform: "county_site",
    saleType: "Tax Deed",
    externalId: "45079|flc-2026-06-29",
    saleDate: "2026-09-01", // forfeited land inventory — date not fixed; use horizon
    title: "Richland County SC forfeited land commission inventory",
    sourceUrl: url,
  });
  return upsertLots(id, "45079", judged.accepted);
}

async function main() {
  let total = 0;

  total += await ingestPdfList({
    countyFips: "12009",
    saleType: "Tax Deed",
    saleDate: "2026-08-20",
    title: "Brevard County FL tax deed sale 2026-08-20",
    externalId: "12009|2026-08-20",
    url: "https://www.brevardclerk.us/?a=Files.Serve&File_id=225351C0-DD3B-4D97-829D-4258E682AC7E",
    countyName: "Brevard",
    state: "FL",
  });

  total += await ingestPdfList({
    countyFips: "12009",
    saleType: "Tax Deed",
    saleDate: "2026-09-17",
    title: "Brevard County FL tax deed sale 2026-09-17",
    externalId: "12009|2026-09-17",
    url: "https://www.brevardclerk.us/?a=Files.Serve&File_id=4E8081FE-455F-4DC0-A879-0039939F9F15",
    countyName: "Brevard",
    state: "FL",
  });

  total += await ingestRichlandXlsx();

  console.log(`\nTotal lots written this run: ${total}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
