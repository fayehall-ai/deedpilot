/**
 * Fill the AVM gap across the whole book.
 *
 *   npm run sweep:avm                          # everything with an APN
 *   npm run sweep:avm -- --state MI --limit 500
 *   npm run sweep:avm -- --concurrency 8
 *
 * Why this exists rather than another `enrich:lots` flag:
 *
 *   1. `enrichLotsMissingAssessed` re-runs its own SELECT for every chunk, and
 *      the selector is "has no market value". A parcel that genuinely has no
 *      match never acquires one, so it is picked again by the next chunk, and
 *      the next — a loop that bills for the same misses forever. This walks a
 *      snapshot of ids taken once, so every lot is attempted at most once.
 *
 *   2. The full provider chain tries `cadastre` first, and on the lots left in
 *      this gap that leg is slow enough to dominate: a 500-lot run managed 22
 *      lots in nine minutes, about 24s each, which puts the remaining ~16.7k at
 *      over a hundred hours. Cadastre has already swept this book (16,001 rows)
 *      and the parcels still missing a market value are the ones it could not
 *      answer, so asking it again is the expensive way to learn nothing. This
 *      sweep asks RealEstateAPI only.
 *
 *   3. Sequential lookups waste the latency. These are ~300ms HTTP round trips
 *      with no local work, so a small worker pool is the difference between
 *      hours and minutes.
 *
 * Progress is appended synchronously to a log file as well as stdout, because
 * node block-buffers stdout to a pipe and a backgrounded sweep would otherwise
 * be invisible until it exited.
 */
import "../lib/env";
import { appendFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { applyRecordToLot } from "../lib/property/enrich";
import { realestateapiProvider } from "../lib/property/providers/realestateapi";
import { ProviderUnavailableError } from "../lib/property/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const STATE = arg("state")?.toUpperCase();
const LIMIT = arg("limit") ? Number(arg("limit")) : undefined;
const CONCURRENCY = Math.max(1, Number(arg("concurrency") ?? 5));
const LOG_PATH = arg("log") ?? "avm-sweep.log";

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  // Synchronous, so a backgrounded run is readable while it is still running.
  try {
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    /* logging must never take the sweep down */
  }
  console.log(line);
}

interface Target {
  id: string;
  state: string;
  fips: string;
  countyName: string;
  parcelNumber: string | null;
  addressLine: string | null;
  city: string | null;
  zip: string | null;
}

async function main() {
  log(
    `sweep start — provider=realestateapi concurrency=${CONCURRENCY}` +
      `${STATE ? ` state=${STATE}` : ""}${LIMIT ? ` limit=${LIMIT}` : ""}`,
  );

  /*
   * One snapshot, highest opening bid first. Bid order is a value proxy
   * (r = 0.852 against assessed value on Arkansas), so if the run is stopped
   * early the parcels that matter are already done.
   */
  const rows: any = await db.execute(sql`
    select l.id, c.state, c.fips, c.name as county_name,
           l.parcel_number, l.address_line, l.city, l.zip
    from lots l
      join counties c on c.fips = l.county_fips
    where l.status is distinct from 'sold'
      and l.parcel_number is not null and l.parcel_number <> ''
      ${STATE ? sql`and c.state = ${STATE}` : sql``}
      and not exists (
        select 1 from lot_valuations v
        where v.lot_id = l.id and v.market_value is not null
      )
    order by l.opening_bid desc nulls last, l.id
    ${LIMIT ? sql`limit ${LIMIT}` : sql``}`);

  const targets: Target[] = (rows.rows ?? rows).map((r: any) => ({
    id: r.id,
    state: r.state,
    fips: r.fips,
    countyName: r.county_name,
    parcelNumber: r.parcel_number,
    addressLine: r.address_line,
    city: r.city,
    zip: r.zip,
  }));

  log(`targets: ${targets.length}`);
  if (targets.length === 0) {
    log("nothing to do");
    process.exit(0);
  }

  const started = Date.now();
  let cursor = 0;
  let hit = 0;
  let miss = 0;
  let failed = 0;
  let echoed = 0;
  let aborted: string | null = null;

  /*
   * Shared across workers. A dead key is dead for every worker at once, and the
   * whole point of `ProviderUnavailableError` is that grinding on turns an
   * outage into thousands of recorded misses.
   */
  const unavailable = new Set<string>();

  async function worker(): Promise<void> {
    while (!aborted) {
      const i = cursor++;
      if (i >= targets.length) return;
      const t = targets[i];

      try {
        const rec = await realestateapiProvider.lookup({
          state: t.state,
          fips: t.fips,
          countyName: t.countyName,
          parcelNumber: t.parcelNumber,
          addressLine: t.addressLine,
          city: t.city,
          zip: t.zip,
        });

        if (!rec) {
          miss++;
        } else {
          await applyRecordToLot(t.id, rec);
          hit++;
          if (rec.marketValue !== undefined && rec.marketValue === rec.assessedValue) echoed++;
        }
      } catch (e) {
        if (e instanceof ProviderUnavailableError) {
          unavailable.add("realestateapi");
          aborted = e.message;
          log(`ABORT — provider unusable: ${e.message}`);
          return;
        }
        failed++;
        log(`error ${t.id} (${t.state}/${t.countyName} ${t.parcelNumber}): ${
          e instanceof Error ? e.message : e
        }`);
      }

      const done = hit + miss + failed;
      if (done % 100 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        const rate = done / elapsed;
        const eta = (targets.length - done) / rate;
        log(
          `${done}/${targets.length} — hit ${hit} (echo ${echoed}) miss ${miss} err ${failed} — ` +
            `${rate.toFixed(1)}/s, eta ${(eta / 60).toFixed(0)}m`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = (Date.now() - started) / 1000;
  log(
    `sweep done in ${(elapsed / 60).toFixed(1)}m — attempted ${hit + miss + failed}/${
      targets.length
    }, hit ${hit}, of which echoed-assessment ${echoed}, miss ${miss}, errors ${failed}` +
      (aborted ? ` — ABORTED: ${aborted}` : ""),
  );
  process.exit(aborted ? 1 : 0);
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
