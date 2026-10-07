/*
 * Lists every USTLA tax-sale auction from today through the next eight weeks.
 *
 * The data comes from the same JSON endpoint USTLA's calendar uses
 * (/api/research/auctions), fetched from inside a uls.ustla.com tab so it
 * rides the browser's existing USTLA session. The extension never sees or
 * stores a password: if the session has lapsed, it brings the USTLA tab
 * forward and asks you to sign in there.
 */
const ORIGIN = "https://uls.ustla.com";
const PAGE = `${ORIGIN}/research/auctions`;
const WEEKS = 8;

const $ = (id) => document.getElementById(id);
let auctions = [];
let ustlaTabId = null;

// ---------------------------------------------------------------- dates

/** Local calendar date → "YYYY-MM-DD". */
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** "YYYY-MM-DD" → "MM/DD/YYYY", the form USTLA's API takes and shows. */
function us(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${m}/${d}/${y}`;
}
function windowDates() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + WEEKS * 7 - 1);
  return { start, end };
}
/** Sunday that starts the week containing `isoDate`, matching USTLA's calendar. */
function weekStart(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - dt.getDay());
  return iso(dt);
}
function dayLabel(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
const money = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------- USTLA tab

function setStatus(text, error = false) {
  const el = $("status");
  el.hidden = !text;
  el.textContent = text ?? "";
  el.classList.toggle("error", error);
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === "complete") return resolve(tab);
      const listener = (id, info, t) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(t);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

/** An open uls.ustla.com tab, or a new background one on the auctions page. */
async function ustlaTab() {
  if (ustlaTabId !== null) {
    try {
      const t = await chrome.tabs.get(ustlaTabId);
      if (t.url?.startsWith(ORIGIN)) return waitForLoad(t.id);
    } catch {
      /* closed since */
    }
  }
  const [existing] = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  const tab = existing ?? (await chrome.tabs.create({ url: PAGE, active: false }));
  ustlaTabId = tab.id;
  return waitForLoad(tab.id);
}

/** Runs in the USTLA page, so the request carries its session cookies. */
async function inPage(path) {
  const r = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
  const type = r.headers.get("content-type") ?? "";
  if (!r.ok || !type.includes("json")) return { signin: true, status: r.status };
  return { data: await r.json() };
}

async function ustlaGet(path) {
  const tab = await ustlaTab();
  if (!tab.url?.startsWith(ORIGIN)) throw new SigninError();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: inPage,
    args: [path],
  });
  if (!res?.result || res.result.signin) throw new SigninError();
  return res.result.data;
}

class SigninError extends Error {}

// ---------------------------------------------------------------- dates per auction

/*
 * USTLA's list files a multi-day sale under the day it closes: Santa Clara,
 * which opens Oct 30, is listed on Nov 2. Only the per-auction record carries
 * saleStartDate and saleEndDate, so those are read for every auction and kept
 * for a day — a refresh should not cost USTLA four hundred requests again.
 */
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
const details = new Map();

const startOf = (a) => details.get(a.id)?.saleStartDate || a.saleDate;
function endOf(a) {
  const d = details.get(a.id);
  const end = d?.saleEndDate || null;
  return end && end > startOf(a) ? end : null;
}

async function loadDetailCache() {
  try {
    const { ustlaDetails = {} } = await chrome.storage.local.get("ustlaDetails");
    const now = Date.now();
    for (const [id, v] of Object.entries(ustlaDetails)) {
      if (now - v.at < DETAIL_TTL_MS) details.set(Number(id), v.d);
    }
  } catch {
    /* no cache: every detail is fetched */
  }
}

async function saveDetailCache() {
  try {
    const at = Date.now();
    const out = {};
    for (const [id, d] of details) out[id] = { d, at };
    await chrome.storage.local.set({ ustlaDetails: out });
  } catch {
    /* the cache is a convenience */
  }
}

/** Fetch the record of every auction not already known, four at a time. */
async function loadDetails(list) {
  const todo = list.filter((a) => !details.has(a.id));
  const total = todo.length;
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const a = todo.shift();
      const d = await ustlaGet(`/api/research/auctions/${encodeURIComponent(a.id)}`);
      details.set(a.id, d.auction ?? d);
      done++;
      if (done % 10 === 0 || done === total) {
        setStatus(`Reading each sale's start and end dates from USTLA… ${done} of ${total}`);
      }
    }
  };
  if (total) {
    setStatus(`Reading each sale's start and end dates from USTLA… 0 of ${total}`);
    await Promise.all([1, 2, 3, 4].map(worker));
    await saveDetailCache();
  }
}

// ---------------------------------------------------------------- load

async function load() {
  const { start, end } = windowDates();
  $("range").textContent = `${dayLabel(iso(start))} – ${dayLabel(iso(end))}, ${end.getFullYear()} · tax-sale auctions (deed, lien, redeemable deed)`;
  $("csv").disabled = true;
  setStatus("Loading auctions from USTLA…");

  try {
    const all = [];
    // Two weeks past the window: a sale that opens inside it but closes after
    // is listed under its closing day, which can fall outside.
    const fetchTo = new Date(end);
    fetchTo.setDate(fetchTo.getDate() + 14);
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({
        auctionTime: "future",
        purchased: "all",
        minSaleDate: us(iso(start)),
        maxSaleDate: us(iso(fetchTo)),
        perPage: "1000",
        page: String(page),
      });
      const data = await ustlaGet(`/api/research/auctions?${q}`);
      all.push(...(data.auctions ?? []));
      const pages = data.pagination?.totalPages ?? 1;
      if (page >= pages) break;
    }
    await loadDetailCache();
    await loadDetails(all);
    // In the window if any day of the sale is: opened by its end, still running at its start.
    auctions = all
      .filter((a) => (endOf(a) ?? startOf(a)) >= iso(start) && startOf(a) <= iso(end))
      .sort(
        (a, b) =>
          startOf(a).localeCompare(startOf(b)) ||
          (a.stateName ?? "").localeCompare(b.stateName ?? "") ||
          (a.countyName ?? "").localeCompare(b.countyName ?? ""),
      );
    setStatus(null);
    fillFilters();
    render();
    $("csv").disabled = auctions.length === 0;
  } catch (e) {
    if (e instanceof SigninError) {
      setStatus("USTLA isn't signed in. Sign in on the USTLA tab (now in front), then press Refresh.", true);
      if (ustlaTabId !== null) chrome.tabs.update(ustlaTabId, { active: true });
    } else {
      setStatus(`Could not load auctions: ${e.message ?? e}`, true);
    }
  }
}

// ---------------------------------------------------------------- render

function fillFilters() {
  const opts = (id, values, all) => {
    const el = $(id);
    const keep = el.value;
    el.innerHTML = `<option value="">${all}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join("");
    el.value = values.includes(keep) ? keep : "";
  };
  const uniq = (k) => [...new Set(auctions.map((a) => a[k]).filter(Boolean))].sort();
  opts("state", uniq("stateName"), "All states");
  opts("type", uniq("auctionType"), "All types");
  opts("format", uniq("onlineOffer"), "All formats");
  $("filters").hidden = false;
}

function filtered() {
  const q = $("q").value.trim().toLowerCase();
  const st = $("state").value;
  const ty = $("type").value;
  const fo = $("format").value;
  return auctions.filter(
    (a) =>
      (!st || a.stateName === st) &&
      (!ty || a.auctionType === ty) &&
      (!fo || a.onlineOffer === fo) &&
      (!q ||
        [a.countyName, a.stateName, a.bidProcedures, a.auctionType, a.onlineOffer]
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
}

function render() {
  const rows = filtered();
  $("shown").textContent = `${rows.length} of ${auctions.length} auctions`;

  const parcels = rows.reduce((n, a) => n + (Number(a.parcelNum) || 0), 0);
  const amount = rows.reduce((n, a) => n + (Number(a.aggregateSaleAmount) || 0), 0);
  const byType = (t) => rows.filter((a) => a.auctionType === t).length;
  const summary = $("summary");
  summary.hidden = false;
  summary.innerHTML = [
    ["Auctions", rows.length.toLocaleString()],
    ["States", new Set(rows.map((a) => a.stateName)).size],
    ["Deed", byType("Deed")],
    ["Lien", byType("Lien")],
    ["Redeemable deed", byType("Redeemable Deed")],
    ["Parcels", parcels.toLocaleString()],
    ["Aggregate amount", money(amount)],
  ]
    .map(([k, v]) => `<div><span class="muted">${k}</span><b>${v}</b></div>`)
    .join("");

  const weeks = new Map();
  for (const a of rows) {
    const w = weekStart(startOf(a) < iso(windowDates().start) ? iso(windowDates().start) : startOf(a));
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(a);
  }

  const list = $("list");
  if (!rows.length) {
    list.innerHTML = auctions.length ? `<p class="muted">No auctions match the filters.</p>` : "";
    return;
  }
  list.innerHTML = [...weeks]
    .map(([w, items]) => {
      const [y, m, d] = w.split("-").map(Number);
      const endOfWeek = iso(new Date(y, m - 1, d + 6));
      return `<section class="week">
        <h2><span>Week of ${dayLabel(w)} – ${dayLabel(endOfWeek)}</span><span class="muted">${items.length} auctions</span></h2>
        <div class="scroll"><table>
          <thead><tr>
            <th>Date</th><th>Time</th><th>State</th><th>County</th><th>Type</th><th>Format</th>
            <th class="num">Parcels</th><th class="num">Aggregate</th><th>Bid procedure</th><th>List uploaded</th>
          </tr></thead>
          <tbody>${items.map(row).join("")}</tbody>
        </table></div>
      </section>`;
    })
    .join("");
}

function row(a) {
  const typeClass = (a.auctionType ?? "").split(" ")[0];
  return `<tr class="row" data-id="${esc(a.id)}">
    <td>${esc(dayLabel(startOf(a)))}${
      endOf(a) ? ` <span class="muted">– ${esc(dayLabel(endOf(a)))}</span>` : ""
    }</td>
    <td>${esc(a.saleTime ?? "")}</td>
    <td>${esc(a.stateName ?? "")}</td>
    <td>${esc(a.countyName ?? "")}</td>
    <td><span class="dot ${esc(typeClass)}"></span>${esc(a.auctionType ?? "")}</td>
    <td>${esc(a.onlineOffer ?? "")}</td>
    <td class="num">${a.parcelNum ? Number(a.parcelNum).toLocaleString() : "—"}</td>
    <td class="num">${money(a.aggregateSaleAmount)}</td>
    <td>${esc(a.bidProcedures ?? "")}</td>
    <td>${a.fileUploadDate ? esc(us(a.fileUploadDate)) : "—"}</td>
  </tr>`;
}

// Details on demand: one request per auction you open, not 400 up front.
async function toggleDetail(tr) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains("detail")) return next.remove();
  const id = tr.dataset.id;
  const cell = document.createElement("tr");
  cell.className = "detail";
  cell.innerHTML = `<td colspan="10">Loading…</td>`;
  tr.after(cell);
  try {
    // Already read for its dates on load, normally; fetched only if not.
    const a =
      details.get(Number(id)) ??
      (await ustlaGet(`/api/research/auctions/${encodeURIComponent(id)}`).then((d) => d.auction ?? d));
    const site = a.onlineSiteDeed || a.onlineSiteLien || a.onlineSiteForeclosure;
    const venue = [a.saleAddress1, a.saleAddress2, a.saleCity, a.saleZipCode].filter(Boolean).join(", ");
    const fields = [
      ["Sale start", a.saleStartDate ? us(a.saleStartDate) : null],
      ["Sale end", a.saleEndDate ? us(a.saleEndDate) : null],
      ["Start time", a.saleTime],
      ["Duration", a.saleDuration],
      ["Venue", venue],
      ["Auction website", site ? `<a href="${esc(site)}" target="_blank" rel="noopener">${esc(site)}</a>` : null],
      ["Parcel data on USTLA", a.hasParcelsData ? "Yes" : "No"],
      ["Additional notes", a.additionalSaleNotes],
      ["Recent notes", a.recentNotes],
      ["Sale notes", a.countyLaws],
    ].filter(([, v]) => v && v !== "None");
    cell.innerHTML = `<td colspan="10"><dl>${fields
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${k === "Auction website" ? v : esc(v)}</dd></div>`)
      .join("")}</dl></td>`;
  } catch (e) {
    cell.innerHTML = `<td colspan="10">${
      e instanceof SigninError ? "USTLA session expired — sign in on the USTLA tab and press Refresh." : esc(e.message ?? e)
    }</td>`;
  }
}

// ---------------------------------------------------------------- CSV

function downloadCsv() {
  /*
   * USTLA's own export columns, so the file goes straight into DeedPilot's
   * /admin import, plus the start and end the export lacks. "Sale Date" is the
   * opening day here, where the export puts the closing one; the importer
   * reads "Sale Start Date" first either way.
   */
  const det = (a) => details.get(a.id) ?? {};
  const none = (v) => (v && v !== "None" ? v : "");
  const cols = [
    ["State", (a) => a.stateName],
    ["County", (a) => a.countyName],
    ["Sale Date", (a) => startOf(a)],
    ["Sale Start Date", (a) => startOf(a)],
    ["Sale End Date", (a) => endOf(a) ?? startOf(a)],
    ["Sale Time", (a) => a.saleTime ?? det(a).saleTime],
    ["Sale Duration", (a) => det(a).saleDuration],
    ["Auction Type", (a) => a.auctionType],
    ["Online or Onsite", (a) => a.onlineOffer],
    ["Bid Procedures", (a) => a.bidProcedures],
    ["Parcel Count", (a) => a.parcelNum],
    ["Aggregate Sale Amount (USD)", (a) => a.aggregateSaleAmount],
    ["Sale Address 1", (a) => det(a).saleAddress1],
    ["Sale Address 2", (a) => det(a).saleAddress2],
    ["Sale City", (a) => det(a).saleCity],
    ["Sale Zip", (a) => det(a).saleZipCode],
    ["Online Site (Lien)", (a) => det(a).onlineSiteLien],
    ["Online Site (Deed)", (a) => det(a).onlineSiteDeed],
    ["Online Site (Foreclosure)", (a) => det(a).onlineSiteForeclosure],
    ["Additional Sale Notes", (a) => none(det(a).additionalSaleNotes)],
    ["Recent Notes", (a) => none(det(a).recentNotes)],
    ["Registration / County Laws", (a) => none(det(a).countyLaws)],
    ["Has Parcel Data", (a) => (det(a).hasParcelsData ? "true" : "false")],
    ["File Upload Date", (a) => a.fileUploadDate],
    ["Auction ID", (a) => a.id],
  ];
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(([h]) => h).join(","), ...filtered().map((a) => cols.map(([, f]) => cell(f(a))).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `ustla-auctions-${iso(new Date())}-next-${WEEKS}-weeks.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---------------------------------------------------------------- wire up

$("refresh").addEventListener("click", load);
$("csv").addEventListener("click", downloadCsv);
$("open").addEventListener("click", async () => {
  const tab = await ustlaTab();
  chrome.tabs.update(tab.id, { active: true });
});
for (const id of ["q", "state", "type", "format"]) $(id).addEventListener("input", render);
$("list").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const tr = e.target.closest("tr.row");
  if (tr) toggleDetail(tr);
});

load();
