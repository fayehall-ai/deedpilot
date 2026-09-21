/**
 * Every upcoming sale's county framework, in one page, generated live.
 *
 * The book `npm run framework -- --all --html` writes, served from the
 * database on each visit instead of published by hand — so it is never older
 * than the calendar. The same window and rules as the documents delivered to
 * Drive: see `lib/framework/select.ts`. Behind the console sign-in, like /cape.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAdmin } from "@/lib/admin/auth";
import { frameworkBook } from "@/lib/framework/html";
import { frameworkSales } from "@/lib/framework/select";

export async function GET(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.redirect(new URL("/admin", req.url));
  const sales = await frameworkSales();
  const html = frameworkBook(sales.map((s) => ({ fips: s.fips, framework: s.framework })));
  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}
