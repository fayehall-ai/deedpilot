/**
 * The same framework as a web page, for sharing by link instead of attachment.
 *
 * Deliberately print-shaped rather than app-shaped: one column, the same navy
 * and gold, and an `@media print` block so a browser prints what Word would.
 * Anyone who wants the Word file gets the .docx; this is for the link.
 */
import type { Framework } from "./content";

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const linkify = (s: string) =>
  esc(s).replace(/(https?:\/\/[^\s<)]+)/g,
    '<a href="$1" rel="noopener">$1</a>');

export function frameworkHtml(f: Framework): string {
  return `<title>${esc(f.countyLine)} — Tax Sale Framework</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root{
    --paper:#FFFFFF; --ground:#EEF0EC; --ink:#171C19; --muted:#6E766E; --line:#D6DAD4;
    --navy:#1F3864; --gold:#BF9000; --flag:#9C4221; --flag-soft:#F6E9E2;
    --serif:"Newsreader",Georgia,"Times New Roman",serif;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  :root:not([data-theme="light"]){ @media (prefers-color-scheme:dark){
    --paper:#1B1F1A; --ground:#12150F; --ink:#E7EBE3; --muted:#949C92; --line:#2C3229;
    --navy:#9DB6DE; --gold:#E4BE7C; --flag:#E0906A; --flag-soft:#33241C;
  }}
  :root[data-theme="dark"]{
    --paper:#1B1F1A; --ground:#12150F; --ink:#E7EBE3; --muted:#949C92; --line:#2C3229;
    --navy:#9DB6DE; --gold:#E4BE7C; --flag:#E0906A; --flag-soft:#33241C;
  }
  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);font-family:var(--serif);margin:0;
       -webkit-font-smoothing:antialiased}
  .sheet{background:var(--paper);max-width:820px;margin:0 auto;
         padding-inline:clamp(20px,5vw,60px);padding-block:44px 64px;
         box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.06)}
  .eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;
           color:var(--navy);font-weight:600;text-align:right;margin:0 0 18px}
  h1{font-size:clamp(26px,4.4vw,38px);font-weight:600;color:var(--navy);text-align:center;
     margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}
  .doctype{font-size:clamp(17px,2.6vw,23px);font-weight:600;color:var(--gold);text-align:center;
           margin:0 0 6px;letter-spacing:.01em}
  .when{font-size:clamp(15px,2.2vw,19px);font-weight:600;color:var(--navy);text-align:center;margin:0 0 26px}
  table{width:100%;border-collapse:collapse;margin-bottom:30px;font-size:14.5px}
  th,td{border:1px solid var(--line);padding:8px 11px;text-align:left;vertical-align:top;line-height:1.5}
  th{width:34%;color:var(--navy);font-weight:600}
  .def{display:inline-block;font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;
       text-transform:uppercase;padding:1px 6px;border-radius:999px;margin-left:6px;white-space:nowrap}
  .def.ask{color:var(--flag);background:var(--flag-soft)}
  .def.law{color:var(--muted);background:transparent;border:1px solid var(--line)}
  h2{font-size:19px;font-weight:600;color:var(--navy);margin:28px 0 10px}
  p{font-size:15.5px;line-height:1.66;margin:0 0 12px;max-width:70ch}
  ul{margin:0 0 14px;padding-left:20px} li{font-size:15.5px;line-height:1.6;margin-bottom:6px;max-width:70ch}
  a{color:var(--navy);word-break:break-word}
  .sources li{font-family:var(--mono);font-size:12px;color:var(--muted)}
  footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);
         font-size:12.5px;color:var(--muted);font-style:italic;line-height:1.6}
  @media print{
    body{background:#fff} .sheet{box-shadow:none;max-width:none;padding:0}
    h2{break-after:avoid} table{break-inside:avoid}
  }
</style>
<div class="sheet">
  <p class="eyebrow">The Tax Deed Collective &nbsp;|&nbsp; County Framework</p>
  <h1>${esc(f.countyLine)}</h1>
  <p class="doctype">Tax Sale Due Diligence Framework</p>
  <p class="when">${esc(f.auctionLine)}</p>

  <table><tbody>
    ${f.rows.map((r) => `<tr><th>${esc(r.label)}</th><td>${esc(r.value)}${
      r.source === "ask" ? '<span class="def ask">confirm with the county</span>'
      : r.source === "statute" ? '<span class="def law">statewide rule</span>' : ""}</td></tr>`).join("\n    ")}
  </tbody></table>

  <h2>Executive Auction Description</h2>
  <p>${esc(f.executive)}</p>

  ${f.sections.map((s) => `<h2>${esc(s.heading)}</h2>
  ${s.paragraphs.map((x) => `<p>${linkify(x)}</p>`).join("\n  ")}
  ${s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${linkify(b)}</li>`).join("")}</ul>` : ""}`).join("\n\n  ")}

  ${f.sources.length ? `<h2>Sources</h2><ul class="sources">${
    f.sources.map((s) => `<li>${linkify(s)}</li>`).join("")}</ul>` : ""}

  <footer>Prepared ${esc(f.generated)}${f.asOf ? ` · county research last verified ${esc(f.asOf)}` : ""}.
  This document is a research aid, not legal advice. Confirm every figure with the county before
  committing funds.</footer>
</div>`;
}

export interface BookEntry { fips: string; framework: Framework }

/**
 * Every framework in one page.
 *
 * ## The client script is built inside a template literal, so escapes double
 *
 * The template literal eats one level of backslash before the browser sees it.
 * A plain "backslash-d" written below arrives in the page as a bare "d", and
 * an escaped forward slash arrives unescaped. The first cut shipped a FIPS
 * regex and a URL regex written the ordinary way; they reached the browser as
 * a character class with no digits and an unterminated group. The page
 * rendered its header, threw on the first of them, and showed an empty list
 * with no visible error — which is the dangerous part, because nothing on
 * screen said anything was wrong. Double every backslash in the script.
 *
 * A folder of 485 documents is shareable only as a folder. This is shareable as
 * a link, which is what anyone actually sends — and it stays under the artifact
 * host's 255-file ceiling, which 485 separate pages would not.
 *
 * The list is ordered by sale date, not alphabetically, because a framework is
 * read in the weeks before its auction and the only question anyone brings to a
 * list this long is which ones are close. Counties needing a fact confirmed are
 * marked in the list rather than only inside their own document: that is the
 * work queue, and it should be visible without opening 485 files.
 *
 * Each county is addressable as `#c<fips>` — a FIPS rather than a name, because
 * there are thirty-one Washington Counties and a name is not an answer.
 */
export function frameworkBook(entries: BookEntry[]): string {
  const data = entries
    .map((e) => ({ fips: e.fips, f: e.framework }))
    .sort((a, b) =>
      a.f.sortKey.localeCompare(b.f.sortKey) || a.f.countyLine.localeCompare(b.f.countyLine));
  const needing = data.filter((d) => d.f.rows.some((r) => r.source === "ask")).length;
  const parcels = data.reduce((n, d) => n + (d.f.lotCount ?? 0), 0);

  return `<title>County Frameworks</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root{
    --ground:#EEF0EC; --surface:#F7F8F5; --paper:#FFFFFF; --ink:#171C19;
    --muted:#6E766E; --line:#D6DAD4; --navy:#1F3864; --gold:#BF9000;
    --flag:#9C4221; --flag-soft:#F6E9E2;
    --serif:"Newsreader",Georgia,serif; --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  }
  :root:not([data-theme="light"]){ @media (prefers-color-scheme:dark){
    --ground:#12150F; --surface:#191D17; --paper:#1B1F1A; --ink:#E7EBE3;
    --muted:#949C92; --line:#2C3229; --navy:#9DB6DE; --gold:#E4BE7C;
    --flag:#E0906A; --flag-soft:#33241C;
  }}
  :root[data-theme="dark"]{
    --ground:#12150F; --surface:#191D17; --paper:#1B1F1A; --ink:#E7EBE3;
    --muted:#949C92; --line:#2C3229; --navy:#9DB6DE; --gold:#E4BE7C;
    --flag:#E0906A; --flag-soft:#33241C;
  }
  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);font-family:var(--serif);margin:0}
  .wrap{padding-inline:20px;padding-block:28px 64px;max-width:1240px;margin:0 auto}
  .eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;
           color:var(--navy);font-weight:600;margin:0 0 10px}
  h1{font-size:clamp(26px,4vw,38px);font-weight:600;color:var(--navy);margin:0 0 8px;letter-spacing:-.015em}
  .lede{font-size:16.5px;line-height:1.62;margin:0;max-width:66ch}
  .stats{display:flex;gap:24px;flex-wrap:wrap;margin:22px 0 0}
  .stat b{display:block;font-family:var(--mono);font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}
  .stat span{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.07em;text-transform:uppercase}

  .desk{display:grid;grid-template-columns:minmax(260px,330px) minmax(0,1fr);gap:24px;
        align-items:start;margin-top:24px}
  @media(max-width:900px){.desk{grid-template-columns:1fr}}
  .rail{position:sticky;top:16px;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 34px)}
  @media(max-width:900px){.rail{position:static;max-height:none}}
  input[type=search]{width:100%;font-family:var(--mono);font-size:13px;padding:10px 12px;
    border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--ink)}
  .list{overflow-y:auto;border:1px solid var(--line);border-radius:10px;background:var(--surface);flex:1}
  @media(max-width:900px){.list{max-height:44vh}}
  .month{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;
         color:var(--muted);padding:9px 13px 5px;background:var(--ground);
         position:sticky;top:0;border-bottom:1px solid var(--line)}
  .row{display:grid;grid-template-columns:46px minmax(0,1fr);gap:2px 10px;width:100%;text-align:left;
       padding:9px 13px;background:none;border:0;border-bottom:1px solid var(--line);
       cursor:pointer;color:inherit;font:inherit}
  .row:last-child{border-bottom:0}
  .row:hover{background:var(--paper)}
  .row[aria-current=true]{background:var(--paper);box-shadow:inset 3px 0 0 var(--navy)}
  .row .d{font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
  .row .n{font-size:14.5px;font-weight:500}
  .row .m{grid-column:2;font-family:var(--mono);font-size:10px;color:var(--muted)}
  .ask{display:inline-block;font-family:var(--mono);font-size:9px;letter-spacing:.05em;
       text-transform:uppercase;color:var(--flag);background:var(--flag-soft);
       padding:1px 5px;border-radius:999px;margin-left:6px}

  .sheet{background:var(--paper);border:1px solid var(--line);border-radius:12px;
         padding-inline:clamp(18px,4vw,48px);padding-block:36px 46px;min-width:0;
         box-shadow:0 1px 2px rgba(0,0,0,.05),0 10px 28px rgba(0,0,0,.05)}
  .sheet .eyebrow{text-align:right}
  .sheet h2{font-size:clamp(23px,3.4vw,33px);font-weight:600;color:var(--navy);text-align:center;
            margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}
  .doctype{font-size:clamp(16px,2.4vw,21px);font-weight:600;color:var(--gold);text-align:center;margin:0 0 6px}
  .when{font-size:clamp(14px,2vw,18px);font-weight:600;color:var(--navy);text-align:center;margin:0 0 24px}
  table{width:100%;border-collapse:collapse;margin-bottom:26px;font-size:14px}
  th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top;line-height:1.5}
  th{width:34%;color:var(--navy);font-weight:600}
  .def{display:inline-block;font-family:var(--mono);font-size:9px;letter-spacing:.05em;
       text-transform:uppercase;padding:1px 6px;border-radius:999px;margin-left:6px;white-space:nowrap}
  .def.ask{color:var(--flag);background:var(--flag-soft)}
  .def.law{color:var(--muted);border:1px solid var(--line)}
  .sheet h3{font-size:17.5px;font-weight:600;color:var(--navy);margin:24px 0 9px}
  .sheet p{font-size:15px;line-height:1.66;margin:0 0 11px;max-width:70ch}
  .sheet ul{margin:0 0 13px;padding-left:20px}
  .sheet li{font-size:15px;line-height:1.6;margin-bottom:5px;max-width:70ch}
  .sheet a{color:var(--navy);word-break:break-word}
  .sources li{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
  .foot{margin-top:28px;padding-top:14px;border-top:1px solid var(--line);
        font-size:12.5px;color:var(--muted);font-style:italic;line-height:1.6}
  .tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
  .tools button{font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
    padding:6px 11px;border-radius:999px;border:1px solid var(--line);background:var(--surface);
    color:var(--muted);cursor:pointer}
  .tools button:hover{color:var(--navy);border-color:var(--navy)}
  button:focus-visible,input:focus-visible{outline:2px solid var(--navy);outline-offset:2px}
  @media print{
    body{background:#fff} .wrap{max-width:none;padding:0}
    header.top,.rail,.tools{display:none} .desk{display:block}
    .sheet{border:0;box-shadow:none;padding:0}
  }
</style>
<div class="wrap">
  <header class="top">
    <p class="eyebrow">The Tax Deed Collective &nbsp;|&nbsp; County Frameworks</p>
    <h1>County Frameworks</h1>
    <p class="lede">One tax sale due diligence framework per county with a scheduled auction, built
    from that county's statutory research and that sale's own notice.</p>
    <div class="stats">
      <div class="stat"><b>${data.length}</b><span>frameworks</span></div>
      <div class="stat"><b>${parcels.toLocaleString()}</b><span>parcels listed</span></div>
      <div class="stat"><b>${data.length - needing}</b><span>complete</span></div>
      <div class="stat"><b>${needing}</b><span>need a fact from the county</span></div>
    </div>
  </header>

  <div class="desk">
    <aside class="rail">
      <input type="search" id="q" placeholder="county, state, sale type…" autocomplete="off">
      <div class="list" id="list" role="listbox" aria-label="Counties"></div>
    </aside>
    <main class="sheet" id="sheet" aria-live="polite"></main>
  </div>
</div>
<script id="d" type="application/json">__BOOK__</script>
<script>
(function(){
  var D = JSON.parse(document.getElementById("d").textContent);
  var $ = function(id){ return document.getElementById(id); };
  var esc = function(s){ return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); };
  var link = function(s){ return esc(s).replace(/(https?:\\/\\/[^\\s<)]+)/g,
    '<a href="$1" rel="noopener">$1</a>'); };
  var MON = ["January","February","March","April","May","June","July",
             "August","September","October","November","December"];
  var current = (location.hash.match(/^#c?(\\d{5})$/) || [])[1] || (D[0] && D[0].fips);

  function visible(){
    var q = ($("q").value || "").trim().toLowerCase();
    if (!q) return D;
    return D.filter(function(d){
      return (d.f.countyLine + " " + d.f.rows[3].value).toLowerCase().indexOf(q) > -1; });
  }

  function renderList(){
    var rows = visible(), seen = "", out = [];
    rows.forEach(function(d){
      var p = d.f.sortKey.split("-");
      var mon = MON[Number(p[1]) - 1] + " " + p[0];
      if (mon !== seen) { seen = mon; out.push('<div class="month">' + mon + '</div>'); }
      var meta = [];
      if (d.f.lotCount) meta.push(d.f.lotCount.toLocaleString() + " parcels");
      meta.push(d.f.rows[3].value);
      var ask = d.f.rows.some(function(r){ return r.source === "ask"; });
      out.push('<button class="row" role="option" data-f="' + d.fips + '"' +
        ' aria-current="' + (current === d.fips) + '">' +
        '<span class="d">' + esc(p[1] + "/" + p[2]) + '</span>' +
        '<span class="n">' + esc(d.f.countyLine.replace(/,.*$/, "")) + '</span>' +
        '<span class="m">' + esc(meta.join(" \u00b7 ")) +
          (ask ? '<span class="ask">confirm</span>' : "") + '</span></button>');
    });
    $("list").innerHTML = out.join("") || '<div class="month">Nothing matches that.</div>';
    if (rows.length && !rows.some(function(d){ return d.fips === current; })) show(rows[0].fips);
  }

  function show(fips){
    current = fips;
    var d = D.filter(function(x){ return x.fips === fips; })[0];
    if (!d) return;
    var f = d.f;
    $("sheet").innerHTML =
      '<div class="tools"><button id="copy">copy link to this county</button>' +
      '<button id="print">print</button></div>' +
      '<p class="eyebrow">The Tax Deed Collective &nbsp;|&nbsp; County Framework</p>' +
      '<h2>' + esc(f.countyLine) + '</h2>' +
      '<p class="doctype">Tax Sale Due Diligence Framework</p>' +
      '<p class="when">' + esc(f.auctionLine) + '</p>' +
      '<table><tbody>' + f.rows.map(function(r){
        return '<tr><th>' + esc(r.label) + '</th><td>' + esc(r.value) +
          (r.source === "ask" ? '<span class="def ask">confirm with the county</span>'
           : r.source === "statute" ? '<span class="def law">statewide rule</span>' : "") +
          '</td></tr>'; }).join("") + '</tbody></table>' +
      '<h3>Executive Auction Description</h3><p>' + esc(f.executive) + '</p>' +
      f.sections.map(function(s){
        return '<h3>' + esc(s.heading) + '</h3>' +
          s.paragraphs.map(function(x){ return '<p>' + link(x) + '</p>'; }).join("") +
          (s.bullets && s.bullets.length
            ? '<ul>' + s.bullets.map(function(b){ return '<li>' + link(b) + '</li>'; }).join("") + '</ul>'
            : ""); }).join("") +
      (f.sources.length
        ? '<h3>Sources</h3><ul class="sources">' +
          f.sources.map(function(s){ return '<li>' + link(s) + '</li>'; }).join("") + '</ul>'
        : "") +
      '<p class="foot">Prepared ' + esc(f.generated) +
        (f.asOf ? ' \u00b7 county research last verified ' + esc(f.asOf) : "") +
        '. This document is a research aid, not legal advice. Confirm every figure with the county ' +
        'before committing funds.</p>';
    $("copy").onclick = function(){
      var url = location.origin + location.pathname + "#c" + fips;
      var b = $("copy");
      var done = function(){ b.textContent = "link copied";
        setTimeout(function(){ b.textContent = "copy link to this county"; }, 1800); };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
      else { location.hash = "#c" + fips; done(); }
    };
    $("print").onclick = function(){ window.print(); };
    document.querySelectorAll(".row").forEach(function(el){
      el.setAttribute("aria-current", String(el.getAttribute("data-f") === fips)); });
  }

  $("list").addEventListener("click", function(e){
    var b = e.target.closest(".row"); if (b) { show(b.getAttribute("data-f")); }
  });
  $("q").addEventListener("input", renderList);
  window.addEventListener("hashchange", function(){
    var m = (location.hash.match(/^#c?(\\d{5})$/) || [])[1];
    if (m) { show(m); renderList(); }
  });

  renderList(); show(current);
})();
</script>`.replace("__BOOK__", JSON.stringify(data).replace(/<\//g, "<\\/"));
}
