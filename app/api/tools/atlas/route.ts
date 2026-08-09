/**
 * Trusted tool: lookup_atlas
 *
 * GET /api/tools/atlas?fips=06037
 * GET /api/tools/atlas?state=CA&county=los-angeles
 *
 * Returns the resolved county rule with inheritance flags, asOf, and sources.
 * The agent MUST cite asOf and sources when using this output.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveBySlug, resolveCountyRule } from "@/lib/atlas";


export async function GET(req: NextRequest) {
  const fips = req.nextUrl.searchParams.get("fips");
  const state = req.nextUrl.searchParams.get("state");
  const county = req.nextUrl.searchParams.get("county");

  let rule = null;
  if (fips) {
    rule = resolveCountyRule(fips.trim());
  } else if (state && county) {
    rule = resolveBySlug(state.trim(), county.trim());
  } else {
    return NextResponse.json(
      {
        error: "Provide fips=SSCCC or state=CA&county=los-angeles",
        tool: "lookup_atlas",
      },
      { status: 400 },
    );
  }

  if (!rule) {
    return NextResponse.json(
      { error: "County not found", tool: "lookup_atlas", fips, state, county },
      { status: 404 },
    );
  }

  return NextResponse.json({
    tool: "lookup_atlas",
    trusted: true,
    mustCite: ["asOf", "sources", "inherited", "isStateDefault"],
    asOf: rule.asOf ?? null,
    sources: rule.sources ?? [],
    result: rule,
    provenance: {
      isStateDefault: rule.isStateDefault,
      inherited: rule.inherited,
      fips: rule.county.fips,
      state: rule.county.state,
      county: rule.county.name,
    },
  });
}
