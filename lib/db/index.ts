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
  });

if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
export { schema };
export * from "./schema";
