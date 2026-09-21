/**
 * The Statutory Ground page, generated live: every county's tax-sale law with
 * its upcoming sales from the calendar. See `lib/statutory/page.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAdmin } from "@/lib/admin/auth";
import { statutoryPage } from "@/lib/statutory/page";

export async function GET(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.redirect(new URL("/admin", req.url));
  const { html } = await statutoryPage();
  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}
