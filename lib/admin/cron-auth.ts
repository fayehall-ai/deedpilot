/**
 * Who may start a scheduled worker.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron request once
 * the secret is set, so that is the check. The routes used to accept the
 * `x-vercel-cron` header on its own as well — a header any client can send —
 * which let anyone who guessed a path start paid work. It is honoured now only
 * when no secret is configured, which is a local or preview deployment.
 *
 * The operator token is accepted too, so a person can trigger a pass by hand.
 */
import type { NextRequest } from "next/server";
import { tokenMatches } from "./token";

export function cronAuthorised(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (secret && bearer === secret) return true;
  if (!secret && req.headers.get("x-vercel-cron")) return true;
  return tokenMatches(bearer) || tokenMatches(req.nextUrl.searchParams.get("token"));
}
