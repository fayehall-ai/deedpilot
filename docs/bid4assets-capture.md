# Bid4Assets capture workflow

Bid4Assets is **not crawled**. `lib/ingest/adapters/bid4assets.ts` imports
`node:fs`, not `politeFetch`; there is no code path from the adapter to the
host. The pages are opened in the operator's own browser and saved to
`data/bid4assets-capture/`, and the adapter only reads those files.

The distinction is structural rather than a matter of intent, the same as
`docs/govease-capture.md` and `docs/sri-capture.md`.

## Why, when there is an agreement

There is one, and `lib/ingest/policy.ts` records it. Capture is not a way around
the posture — it is what the source actually requires.

**The listings are not in the pages.** Four storefronts were checked, including
`AlamedaMar26`, a sale that closed six months earlier, and every one served zero
lot rows and zero auction links. Two page loads watched in a real browser
produced only tracking pixels. The grid's transport URL is in neither the page
nor the main bundle. There is nothing for a fetcher to ask for.

**And the host answers us with 403.** This one is easy to get backwards:
`robots.txt` returns 404, so there is no robots file and the host looks open.
It is not. `/storefront/taxsales` returns **200 to a browser user agent and 403
to this project's** — the block is on who is asking, not on what robots says.
Getting past it would mean sending a user agent that is not ours. An agreement
is a reason to be *given* access, not a reason to take it by looking like
someone else.

Opening a page in a browser you are sitting in front of is not crawling.

## What to capture

One JSON file per sale, named for its storefront slug:

```
data/bid4assets-capture/ColumbiaPATaxSaleSep26.json
```

`data/bid4assets-capture/` is gitignored. Captures are working artifacts with a
shelf life of days, not source.

There is no separate index file. Each capture carries its own county, state and
sale date, so auctions are derived from the captures themselves — a registry
listing which sales exist is a second thing to keep in sync, and it goes stale
in a different direction from the data.

## File shape

```json
{
  "slug": "ColumbiaPATaxSaleSep26",
  "county": "Columbia County",
  "state": "PA",
  "saleDate": "2026-09-15",
  "title": "County of Columbia, PA Tax Claim Bureau - Upset Sale",
  "capturedAt": "2026-09-11",
  "rows": [ { "Auction ID": "…", "APN": "…", "Minimum Bid": "$1,234.56" } ]
}
```

| field | required | notes |
|---|---|---|
| `slug` | yes | Falls back to the filename. Ties the capture to `/storefront/<slug>`. |
| `county`, `state` | yes | Read off the sale heading — "County of Columbia, PA". Resolved against the atlas; a file that does not resolve is skipped with a warning rather than guessed at. |
| `saleDate` | yes | ISO. **Without it the sale is skipped.** See below. |
| `title` | no | Used for the auction title and to tell a lien sale from a deed sale. |
| `rows` | yes | The grid rows, in whatever shape the grid gave them. |

### `rows` is deliberately untyped

The grid's column names could not be observed from outside a session, so the
adapter maps fields by alias — `APN`, `Parcel Number`, `Parcel`, `PIN` and so on
— ignoring case, spaces and punctuation. Capture the rows as they come; do not
rename the columns.

If a file produces rows but no parcel numbers, the adapter says so on the
console and names the columns it saw, so the missing alias can be added to
`pick()` in the adapter. It does not return an empty list quietly: a silent zero
is indistinguishable from a sale with nothing in it.

### Why `saleDate` is mandatory

A sale with no date is skipped rather than dated by inference. Projecting one
from a state's typical calendar is what put a Lake County sale on the wrong day
and gave every downstream CAPE package "Auction date is projected, not
county-published". A captured date is read off the sale's own page, so the
auction is written `saleDateConfirmed: true` — which has to stay true.

## Capture steps

1. Open `https://www.bid4assets.com/storefront/taxsales` in Chrome and sign in.
   Note the slug of each sale you want — the last path segment of its link.

2. Open a sale, e.g. `https://www.bid4assets.com/storefront/ColumbiaPATaxSaleSep26`,
   and let the auction grid render. Page through it if it paginates; the
   snippet below reads what is in the DOM.

3. In the console, extract the grid to JSON:

   ```js
   // Prefer the grid's own data source when it exposes one.
   const grid = window.jQuery && jQuery('[data-role="grid"]').data('kendoGrid');
   const rows = grid
     ? grid.dataSource.data().map(r => r.toJSON ? r.toJSON() : { ...r })
     : (() => {
         const table = document.querySelector('table');
         const head = [...table.querySelectorAll('thead th')].map(th => th.innerText.trim());
         return [...table.querySelectorAll('tbody tr')].map(tr => {
           const cells = [...tr.children].map(td => td.innerText.trim());
           return Object.fromEntries(head.map((h, i) => [h || `col${i}`, cells[i] ?? '']));
         });
       })();

   const capture = {
     slug: location.pathname.split('/').pop(),
     county: '',      // fill in, e.g. "Columbia County"
     state: '',       // fill in, e.g. "PA"
     saleDate: '',    // fill in, ISO — read it off this page
     title: document.title.replace(/^Bid4Assets:\s*/, ''),
     capturedAt: new Date().toISOString().slice(0, 10),
     rows,
   };
   copy(JSON.stringify(capture, null, 2));
   console.log(`${rows.length} row(s) copied — fill in county, state and saleDate`);
   ```

4. Paste into `data/bid4assets-capture/<slug>.json` and fill in the three blank
   fields. They are blank rather than scraped because the heading wording varies
   between counties and a wrong county is worse than a missing one.

5. Run it:

   ```
   npm run ingest -- --adapter bid4assets --dry-run
   npm run ingest -- --adapter bid4assets
   ```

   The dry run reports how many captures it found, which counties they resolved
   to, and how many lots each produced.

## When a capture goes stale

Nothing expires a capture. A sale that has closed keeps producing the rows as
they stood when it was taken, which is the right behaviour for a record of what
was offered — but it means a file left in place after the sale will keep
asserting a lot list that is no longer live. Delete captures once their sale has
run and been reconciled.
