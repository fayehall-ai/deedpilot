import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { isAdmin } from "@/lib/admin/auth";
import { loadRegistry } from "@/lib/ingest/adapters/generic";
import { resolveFips } from "@/lib/atlas/resolve-fips";
import { getScoutReport } from "@/lib/admin/scout-jobs";
import { daysOut, priorityOf, statusOf, urgentRows, type ScoutRow } from "@/lib/ai/scout-report";

/**
 * The Auction Scout workbook.
 *
 * Built to the structure of the report that already goes out — five tabs in
 * this order, the sixteen Auction Scout columns in this order, and the palette
 * read out of that file's own styles. It is a rebuild rather than a
 * template-fill because the existing workbook is written with `x:`-prefixed
 * OOXML that exceljs cannot open at all: loading it and writing rows in was
 * tried first and fails before it reads a single sheet.
 *
 * The download re-reads the jobs rather than taking a payload from the browser,
 * so what lands in the file is what the console showed and nothing a client
 * could have edited on the way past. Gated on the admin cookie: the rows carry
 * unpublished research and the sources that produced it.
 *
 * No `runtime`/`dynamic` segment config — this Next rejects both when
 * `cacheComponents` is on, and neither is needed. Reading the admin cookie is
 * request data, which is what makes the route dynamic.
 */

/* The Tax Deed Collective palette, taken from the workbook's own styles.xml. */
const NAVY = "FF0B1220";
const INK = "FF111827";
const SLATE = "FF1F2937";
const BLUE = "FF1D4ED8";
const BLUE_TINT = "FFDBEAFE";
const PURPLE = "FF6D28D9";
const PURPLE_TINT = "FFEDE9FE";
const AMBER_TINT = "FFFDE68A";
const AMBER_INK = "FF92400E";
const RED_TINT = "FFFEE2E2";
const RED_INK = "FF991B1B";
const GREY = "FFE5E7EB";
const PAPER = "FFFFFFFF";

/**
 * A real date cell, so Sale Date sorts and filters rather than sitting there as
 * text — pinned to midday UTC.
 *
 * Midnight UTC is a day-boundary trap: opened west of Greenwich it renders as
 * the previous day, and a 2026-08-13 sale showed in the sheet as Aug 12 17:00.
 * A tax sale is attended on a date, so a workbook that moves it by one is worse
 * than one that never printed it. Noon has twelve hours of slack either side,
 * which covers every real timezone.
 */
function excelDate(iso: string | null): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return new Date(`${iso}T12:00:00Z`);
}

function headerRow(row: ExcelJS.Row, fill = NAVY) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: PAPER }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.alignment = { vertical: "middle" };
  });
  row.height = 20;
}

function tint(cell: ExcelJS.Cell, fill: string, font: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  cell.font = { bold: true, color: { argb: font } };
}

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const report = await getScoutReport();

  /*
   * Registry state, read once. `loadRegistry` is the same file the generic
   * adapter crawls from, so "in pipeline" here means exactly what the crawler
   * will act on rather than an optimistic restatement of the research.
   */
  const registry = loadRegistry();
  const pipelineStateFor = (r: ScoutRow): string => {
    const res = resolveFips(r.county, r.state);
    if (!res.ok) {
      return res.reason === "municipal_state"
        ? "Municipal — not a county sale"
        : res.reason === "ambiguous"
          ? "County name ambiguous — needs a person"
          : "County not matched";
    }
    const entry = registry?.counties[res.fips];
    if (!entry || entry.sources.length === 0) return "No source — not yet crawlable";
    const gov = entry.sources.some((x) => x.isGovernment && x.kind === "listing");
    return gov ? "Crawled from a government list" : "Source on file";
  };
  const window = report.window;
  const today = new Date();
  const rows = report.rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = "The Tax Deed Collective — Auction Scout";
  wb.created = today;

  // =========================================================================
  // 1. Summary
  // =========================================================================
  const summary = wb.addWorksheet("Summary", {
    properties: { tabColor: { argb: PURPLE } },
    views: [{ showGridLines: false }],
  });
  summary.columns = [{ width: 38 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 20 }, { width: 24 }, { width: 20 }];

  const brand = [
    ["THE TAX DEED COLLECTIVE", 16, PAPER, NAVY],
    ["Auction Scout", 13, PAPER, INK],
    ["Weekly Intelligence Report", 11, PAPER, SLATE],
  ] as const;
  for (const [text, size, colour, fill] of brand) {
    const r = summary.addRow([text]);
    for (let c = 1; c <= 8; c++) {
      r.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    }
    r.getCell(1).font = { bold: true, size, color: { argb: colour } };
    r.height = size + 12;
  }

  const byState = (st: string) => rows.filter((r) => r.state === st);
  const urgent = urgentRows(rows, today);

  const facts: [string, string | number][] = [
    ["Report Date", today.toISOString().slice(0, 10)],
    ["Sales Scheduled On Or After", window?.start ?? "—"],
    ["Scan Window End", window?.end ?? "No end date — all upcoming sales"],
    ["Total Auction / Watch Rows", rows.length],
    ["States Covered", report.totals.statesCovered],
    [`Urgent Deadlines (<=7 days)`, urgent.length],
    ["Manual Verification Items", report.totals.manualVerification],
    ["Counties Checked", report.totals.countiesChecked],
    ["Sources Read", report.citations.length],
    ["States Scanned", report.states.filter((s) => s.status === "done").length],
    ["States Never Scanned", report.totals.notRun],
    ["States Failed", report.totals.failed],
  ];
  for (const [label, value] of facts) {
    const r = summary.addRow([label, value]);
    r.getCell(1).font = { bold: true, color: { argb: INK } };
    r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } };
  }

  summary.addRow([]);
  const perState = summary.addRow([
    "State",
    "Rows",
    "Urgent",
    "Near-term",
    "Watchlist",
    "Manual Verification",
    "Verified / Public Source",
    "Scan Status",
  ]);
  headerRow(perState, BLUE);

  for (const s of report.states) {
    const mine = byState(s.state);
    const grade = (p: string) => mine.filter((r) => priorityOf(r, today) === p).length;
    summary.addRow([
      s.state,
      mine.length,
      grade("Urgent"),
      grade("Near-term"),
      grade("Watchlist"),
      mine.filter((r) => r.verification !== "confirmed").length + s.manualVerification.length,
      mine.filter((r) => r.officialSource).length,
      // A state nobody ran shows zeros for every count above. Without this
      // column those zeros read as "scanned, nothing found", which is the one
      // misreading a coverage table must not invite.
      s.status === "done" ? "Scanned" : s.status === "not run" ? "NOT SCANNED" : s.status,
    ]);
    if (s.status !== "done") {
      tint(summary.lastRow!.getCell(8), AMBER_TINT, AMBER_INK);
    }
  }

  summary.addRow([]);
  const notesHead = summary.addRow(["Notable Additions / Scan Notes"]);
  notesHead.getCell(1).font = { bold: true, size: 12, color: { argb: PAPER } };
  notesHead.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: SLATE } };

  for (const s of report.states) {
    if (s.summary) summary.addRow([`${s.state}: ${s.summary}`]);
    else if (s.status === "failed") summary.addRow([`${s.state}: FAILED — nothing searched (${s.error ?? "unknown"})`]);
  }
  if (report.totals.notRun > 0) {
    const r = summary.addRow([
      `${report.totals.notRun} state(s) were never scanned this cycle and contribute no rows: ` +
        report.states.filter((s) => s.status === "not run").map((s) => s.state).join(", "),
    ]);
    tint(r.getCell(1), AMBER_TINT, AMBER_INK);
  }
  summary.addRow([
    `${rows.filter((r) => r.officialSource).length} of ${rows.length} row(s) cite an official county or state page; ` +
      "the rest cite a platform or aggregator, marked in the Status column.",
  ]);

  // =========================================================================
  // 2. Auction Scout — the sixteen columns, in the report's own order
  // =========================================================================
  const sheet = wb.addWorksheet("Auction Scout", {
    properties: { tabColor: { argb: BLUE } },
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "State", key: "state", width: 8 },
    { header: "County", key: "county", width: 24 },
    { header: "Sale Type", key: "saleKind", width: 24 },
    { header: "Sale Date", key: "saleDate", width: 12 },
    { header: "Time", key: "time", width: 14 },
    { header: "Auction Format", key: "format", width: 20 },
    { header: "Platform", key: "platform", width: 22 },
    { header: "Platform Link", key: "platformLink", width: 40 },
    { header: "Registration / Deposit Deadline", key: "deadline", width: 30 },
    { header: "Deposit Rules", key: "deposit", width: 34 },
    { header: "County List / PDF Link", key: "countyList", width: 44 },
    { header: "Source Link", key: "source", width: 44 },
    { header: "Status", key: "status", width: 28 },
    { header: "Days Out", key: "daysOut", width: 10 },
    { header: "Priority", key: "priority", width: 12 },
    /*
     * Seventeenth column, and the one that stops this file being a second
     * source of truth. Every other column reports what research found; this one
     * reports what the pipeline did with it — whether the county now carries a
     * source the crawler reads. Without it a workbook can say "confirmed" for a
     * county the system will never fetch, and the spreadsheet and the app drift
     * apart within a week with no way to tell which one lied.
     */
    { header: "In Pipeline", key: "pipeline", width: 26 },
    { header: "Notes", key: "notes", width: 60 },
  ];
  headerRow(sheet.getRow(1));
  sheet.autoFilter = { from: "A1", to: "Q1" };

  const link = (cell: ExcelJS.Cell, url: string | null) => {
    if (!url) return;
    cell.value = { text: url, hyperlink: url };
    cell.font = { color: { argb: BLUE }, underline: true };
  };

  for (const r of rows as ScoutRow[]) {
    const priority = priorityOf(r, today);
    const deadline = [r.registrationDeadline, r.depositDeadline].filter(Boolean).join(" / ");
    const row = sheet.addRow({
      state: r.state,
      county: r.county,
      saleKind: r.saleKind,
      saleDate: excelDate(r.saleDate) ?? r.saleDate,
      time: r.saleTimeLocal ?? "",
      format: r.auctionFormat ?? "",
      platform: r.platform ?? "",
      platformLink: r.platformLink ?? "",
      deadline: deadline || "Not published",
      deposit: r.depositRules ?? "",
      // The report's own convention for a county that posts no list.
      countyList: r.countyListUrl ?? "Manual verification required",
      source: r.sourceUrl,
      status: statusOf(r),
      daysOut: daysOut(r, today),
      priority,
      pipeline: pipelineStateFor(r),
      notes: r.notes ?? "",
    });
    row.getCell("saleDate").numFmt = "yyyy-mm-dd";

    link(row.getCell("platformLink"), r.platformLink);
    link(row.getCell("countyList"), r.countyListUrl);
    link(row.getCell("source"), r.sourceUrl);

    if (priority === "Urgent") tint(row.getCell("priority"), RED_TINT, RED_INK);
    else if (priority === "Near-term") tint(row.getCell("priority"), AMBER_TINT, AMBER_INK);
    else tint(row.getCell("priority"), BLUE_TINT, BLUE);

    if (r.verification !== "confirmed") tint(row.getCell("status"), AMBER_TINT, AMBER_INK);
  }

  // =========================================================================
  // 3. County Scan Coverage — what was looked at, including the empty answers
  // =========================================================================
  const coverage = wb.addWorksheet("County Scan Coverage", { properties: { tabColor: { argb: PURPLE } } });
  coverage.columns = [
    { header: "State", key: "state", width: 8 },
    { header: "County", key: "county", width: 26 },
    { header: "Scan Source", key: "scanSource", width: 30 },
    { header: "Source / Verification Path", key: "path", width: 52 },
    { header: "Platform", key: "platform", width: 22 },
    { header: "Scan Result", key: "result", width: 46 },
  ];
  headerRow(coverage.getRow(1));

  for (const s of report.states) {
    for (const r of byState(s.state)) {
      coverage.addRow({
        state: r.state,
        county: r.county,
        scanSource: r.officialSource ? "County / municipal public page" : "Auction platform listing",
        path: r.sourceUrl,
        platform: r.platform ?? "",
        result: `Sale confirmed ${r.saleDate}`,
      });
    }
    for (const county of s.noSaleFound) {
      coverage.addRow({
        state: s.state,
        county,
        scanSource: "Official county / municipal page",
        path: "",
        platform: "",
        result: "Scanned; no upcoming sale posted",
      });
    }
    for (const county of s.manualVerification) {
      const row = coverage.addRow({
        state: s.state,
        county,
        scanSource: "Official county / municipal page",
        path: "",
        platform: "",
        result: "Manual verification required — no public list or date confirmed",
      });
      tint(row.getCell("result"), AMBER_TINT, AMBER_INK);
    }
    if (s.status !== "done") {
      const row = coverage.addRow({
        state: s.state,
        county: "(entire state)",
        scanSource: "—",
        path: "",
        platform: "",
        result: s.status === "not run" ? "NOT SCANNED this cycle" : `${s.status}${s.error ? ` — ${s.error}` : ""}`,
      });
      tint(row.getCell("result"), RED_TINT, RED_INK);
    }
  }

  // =========================================================================
  // 4. Source Log
  // =========================================================================
  const log = wb.addWorksheet("Source Log", { properties: { tabColor: { argb: BLUE } } });
  log.columns = [
    { header: "Source", key: "source", width: 40 },
    { header: "URL", key: "url", width: 78 },
    { header: "Use in Report", key: "use", width: 42 },
    { header: "Source Type", key: "type", width: 22 },
  ];
  headerRow(log.getRow(1));

  const cited = new Set(rows.map((r) => r.sourceUrl));
  for (const c of report.citations) {
    let host = c.url;
    try {
      host = new URL(c.url).hostname.replace(/^www\./, "");
    } catch {
      /* a source that will not parse is still a source; keep it as printed */
    }
    const official = /\.gov$|\.us$|county|sheriff|clerk|treasurer|collector/i.test(host);
    const row = log.addRow({
      source: c.title?.slice(0, 120) || host,
      url: c.url,
      use: cited.has(c.url) ? "Cited by a row in this report" : "Read during the scan; not cited",
      type: official ? "Official/public county" : "Platform or secondary",
    });
    link(row.getCell("url"), c.url);
  }

  // =========================================================================
  // 5. Source Coverage Audit
  // =========================================================================
  const audit = wb.addWorksheet("Source Coverage Audit", { properties: { tabColor: { argb: SLATE } } });
  audit.columns = [
    { header: "Source", key: "source", width: 26 },
    { header: "URL", key: "url", width: 44 },
    { header: "Coverage Result", key: "result", width: 26 },
    { header: "Rows Added / Affected", key: "rows", width: 26 },
    { header: "Follow-up Status", key: "followUp", width: 22 },
    { header: "Notes", key: "notes", width: 60 },
  ];
  headerRow(audit.getRow(1));

  for (const s of report.states) {
    const mine = byState(s.state);
    const row = audit.addRow({
      source: `${s.state} statewide scan`,
      url: "",
      result: s.status === "done" ? "Covered" : s.status === "not run" ? "NOT COVERED" : s.status,
      rows: `${mine.length} row(s) · ${s.countiesChecked || 0} counties checked`,
      followUp:
        s.status !== "done"
          ? "Run required"
          : s.manualVerification.length
            ? `${s.manualVerification.length} to verify`
            : "Complete",
      notes: s.error ?? s.summary ?? "",
    });
    if (s.status !== "done") tint(row.getCell("result"), RED_TINT, RED_INK);
    else if (s.manualVerification.length) tint(row.getCell("followUp"), AMBER_TINT, AMBER_INK);
  }

  const note = audit.addRow({
    source: "Source mix",
    url: "",
    result: `${rows.filter((r) => r.officialSource).length} official / ${rows.filter((r) => !r.officialSource).length} platform or aggregator`,
    rows: String(rows.length),
    followUp: "See Status column",
    notes:
      "Every source read is cited, aggregators included; the Status column marks which rows rest on an " +
      "official county or state page. Social platforms remain excluded at the search provider as unverifiable.",
  });
  tint(note.getCell("result"), PURPLE_TINT, PURPLE);

  const buffer = await wb.xlsx.writeBuffer();
  const stamp = (window?.start ?? today.toISOString().slice(0, 10)).replace(/-/g, "");

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Auction_Scout_Report_${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
