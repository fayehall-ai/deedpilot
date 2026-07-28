/**
 * Environment loading for standalone scripts (seed, ingest, stripe setup).
 *
 * Next.js loads `.env.local` automatically; plain `tsx` scripts do not, and
 * `dotenv/config` only reads `.env`. Import this first in any script that
 * touches the database or an external API.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" }); // fallback; does not override what .env.local set

/** Read a required variable, failing loudly at startup rather than at use. */
export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — add it to .env.local (see .env.example)`);
  return v;
}
