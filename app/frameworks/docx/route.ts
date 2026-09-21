/**
 * One county's framework as a Word document, generated on request.
 *
 *   /frameworks/docx?fips=12031                  the county's next sale in the window
 *   /frameworks/docx?fips=12031&date=2026-10-14  a named sale
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAdmin } from "@/lib/admin/auth";
import { frameworkDocx } from "@/lib/framework/docx";
import { frameworkSales } from "@/lib/framework/select";

export async function GET(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.redirect(new URL("/admin", req.url));
  const fips = req.nextUrl.searchParams.get("fips") ?? "";
  const date = req.nextUrl.searchParams.get("date") ?? undefined;
  if (!/^\d{5}$/.test(fips)) return NextResponse.json({ error: "fips must be five digits" }, { status: 400 });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });

  const [sale] = await frameworkSales({ fips, date });
  if (!sale) return NextResponse.json({ error: "no sale in the framework window for that county" }, { status: 404 });
  const bytes = await frameworkDocx(sale.framework);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="${sale.fileBase}.docx"`,
      "cache-control": "private, no-store",
    },
  });
}
