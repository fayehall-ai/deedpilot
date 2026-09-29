/**
 * Sunday CAPE run, step two: read the sale lists the Auction Scout workbook
 * queued. The dispatcher in drain-only mode — county crawls only, no planning,
 * research or site intel. Its own path because a cron entry is a path, and the
 * documentation promises nothing about query strings on one.
 */
import { NextRequest } from "next/server";
import { GET as dispatch } from "../dispatch/route";

export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  url.searchParams.set("drain", "1");
  return dispatch(new NextRequest(url, { headers: req.headers }));
}
