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
