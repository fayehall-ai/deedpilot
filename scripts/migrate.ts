/**
 * Apply every migration in `drizzle/`, in order.
 *
 *   npm run db:migrate
 *
 * Each file is written to be re-runnable (`IF NOT EXISTS` throughout), so this
 * simply runs all of them every time rather than keeping a ledger — the same
 * way they were applied by hand before this existed. A file that is not safe to
 * re-run does not belong in that folder.
 */
import "../lib/env";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    await client.unsafe(readFileSync(path.join("drizzle", f), "utf8"));
    console.log(`applied ${f}`);
  }
  await client.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
