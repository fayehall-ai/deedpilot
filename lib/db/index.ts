import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and point it at a Postgres instance.",
  );
}

/**
 * Reuse the client across hot reloads in dev, otherwise every save opens a new
 * pool and Postgres runs out of connections within a few minutes.
 */
const globalForDb = globalThis as unknown as { conn?: postgres.Sql };

const conn =
  globalForDb.conn ??
  postgres(connectionString, {
    // Serverless functions are short-lived; a big pool per instance is wasted
    // connections against the database's global cap.
    max: process.env.NODE_ENV === "production" ? 1 : 5,
    prepare: false, // required when running through a transaction pooler

    /*
     * Nothing here may wait forever.
     *
     * A crawl worker was found holding a job lease for twenty minutes at zero
     * CPU with exactly one socket open — to Postgres, not to the county it was
     * supposed to be fetching. It had issued a query that never came back, and
     * because there was no deadline anywhere in this file it would have sat
     * there until someone noticed. The queue's own lease expired ten minutes
     * in and the worker never learned that, so the job was neither progressing
     * nor available for anything else to pick up.
     *
     * `connect_timeout` is the half that can be fixed here: a connection that
     * will not establish in thirty seconds is not going to.
     *
     * A statement timeout is the half that cannot, and the reason is worth
     * recording so nobody adds it again believing it works. Neon's pooler
     * refuses it as a startup parameter outright — `?options=-c
     * statement_timeout=120000` comes back "unsupported startup parameter in
     * options: statement_timeout. Please use unpooled" — and passing it
     * through postgres.js's `connection` option is silently ignored, pooled
     * or direct: `show statement_timeout` still reports `0`. Verified five
     * ways. `SET statement_timeout` on an open connection does work, but a
     * transaction pooler is free to hand the next query a different backend,
     * which is exactly why Neon points at the unpooled endpoint.
     *
     * So a query here can still hang, and today the only thing that recovers
     * it is the queue's own lease expiry. See `lib/admin/queue.ts`.
     */
    connect_timeout: 30,
  });

if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
export { schema };
export * from "./schema";
