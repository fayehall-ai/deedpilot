# Capturing a RealAuction sale

RealAuction hosts the tax deed sale for about thirty-five Florida counties and
El Paso, Colorado — 86 scheduled sales at the time of writing. The pages are
public and need no login; what they refuse is *us*.

## Why this is a capture and not a crawl

Measured 2026-09-15, twice:

- `robots.txt` on every RealAuction host is `Disallow: /`.
- The sale pages answer **403, 118 bytes** to `DeedPilotBot`, and render fully
  in a browser. Setting `underAgreement` changes nothing: that flag skips
  robots, not the agent check.

The operator holds a data agreement. That is a reason to be *given* access, not
a reason to present a user agent that is not ours — the position
`lib/ingest/adapters/bid4assets.ts` takes, and the reason it reads captures.
Opening a public page in a browser you are sitting in front of is not crawling.

An allow-listed agent or an API would replace all of this. See
`artifacts/realauction-access-request.md`.

## What a sale page holds

Measured in the browser on 2026-09-15, on Duval's 14 October sale.

A sale page is **three independent lists**, each with its own pager:

    #Area_R   "Running Auctions"            live right now
    #Area_W   "Auctions Waiting"            still to be sold  — 16 pages
    #Area_C   "Auctions Closed or Canceled" already settled   —  7 pages

Ten parcels render per page **per area**, not twenty. The earlier note here
said twenty because it counted `Area_W` and `Area_C` together, and it said
"padded with empties" because `.AUCTION_ITEM_SPACER` sits between the real
`.AUCTION_ITEM PREVIEW` blocks. A selector of `[class*=AUCTION_ITEM]` therefore
returns exactly twice the parcels that exist.

**All three areas are inventory.** A sale of ten parcels where the other
seventy redeemed is a different thing from a sale of ten, and only `Area_C`
says which one you are looking at.

Each parcel is a label/value table, which is what to parse rather than the
running text:

    td.AD_LBL  "Parcel ID:"          td.AD_DTA  "046282-0000"
    td.AD_LBL  "Opening Bid:"        td.AD_DTA  "$12,434.01"
    td.AD_LBL  "Property Address:"   td.AD_DTA  "1982 W 16TH ST"
    td.AD_LBL  ""                    td.AD_DTA  "JACKSONVILLE, FL- 32209"
    td.AD_LBL  "Assessed Value:"     td.AD_DTA  "$8,663.00"
    td.AD_LBL  "Auction Type:"       td.AD_DTA  "TAXDEED"
    td.AD_LBL  "Case #:"             td.AD_DTA  "2023-0007TD"
    td.AD_LBL  "Certificate #:"      td.AD_DTA  "08330-2016"

An **empty label continues the previous one** — that is how the address gets
its second line.

Status lives outside the table, and the slot holds two different things:

    .ASTAT_MSGA  "Auction Starts"   .ASTAT_MSGB  "10/14/2026 09:00 AM ET"
    .ASTAT_MSGA  "Auction Status"   .ASTAT_MSGB  "Redeemed"

Only the label says which. Reading `.ASTAT_MSGB` on its own gives every
scheduled parcel a start time where its status should be — and a start time is
not nothing, it is the sale's own hour, so the capture records both.

**The grouping is a claim, so the area is captured too.** Thirteen of the
fifty-two parcels in Charlotte's 29 September sale sit in the closed list with
no status text whatsoever — `.ASTAT_MSGA` is empty, not "Auction Status". Read
by its words alone each is `pending`, which would publish it as inventory for a
sale that will not offer it. The sale has not happened yet, so nothing in that
list can have closed; the adapter reads them as cancelled.

**`Auction Type` is why the capture records it.** Counties like Charlotte and
Manatee run their tax deed sale and their mortgage foreclosure sale on one
host, separated only by the sale date, so the host cannot say which a capture
holds and the page's own label can.

**Redeemed parcels are not dropped.** `lib/ingest/lot-status.ts` decides what a
status means, so the capture records it verbatim.

## Paging

The pager is `.PageFrame[area=W] .PageRight`, with the total in `#maxWA`
(`#maxCA` for the closed list). Clicking it is the reliable way to advance.

Two things not to try, both measured:

- **The paging request cannot be replayed usefully.** It is
  `Zmethod=UPDATE&FNC=LOAD&AREA=W&PageDir=1`, and it returns JSON whose
  `retHTML` is markup compressed with the site's own placeholder tokens
  (`@A` for `<div class="`, and so on) that only the page's script expands.
- **It is a server-side cursor, not a page number.** `PageDir=1` means "next
  from wherever this session is", so fetching it out of band desynchronises the
  visible page.

**The site throttles.** After roughly forty requests in a few minutes, every
RealAuction host served this browser the page shell with no auction area at
all — no error, just an empty calendar, across hosts. It clears with time. Move
at a person's pace: one sale at a time, a second between pages.

## Capturing a sale

1. Start the dev server — the capture endpoint is development-only:

       npm run dev

2. Open the sale's PREVIEW page in Chrome, e.g.

       https://duval.realtaxdeed.com/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&AUCTIONDATE=10/14/2026

   Without the `www.` — the certificate on `www.putnam.realtaxdeed.com` and
   `www.bay.realtaxdeed.com` does not cover the name, and the browser refuses
   the page. The bare host works on every RealAuction host.

   Wait for the parcels to render. An empty calendar means the throttle above,
   not an empty sale — come back later rather than reloading.

3. Paste this into the console. It walks every page of all three areas by
   clicking the pager, then posts what it found. It prints what it stored.

   ```js
   (async () => {
     const TOKEN = "PASTE_YOUR_DEEDPILOT_ADMIN_TOKEN";
     const ENDPOINT = "http://localhost:3000/api/admin/realauction-capture";

     const cl = (s) => (s || "").replace(/[\s\u00a0]+/g, " ").trim();
     const label = (it) => cl(it.querySelector(".ASTAT_MSGA")?.textContent);

     /* Label/value pairs; an empty label continues the previous one. */
     const parse = (it) => {
       const f = {};
       let last = null;
       for (const tr of it.querySelectorAll("tr")) {
         const c = tr.children;
         if (c.length < 2) continue;
         const l = cl(c[0].textContent).replace(/:$/, ""), v = cl(c[1].textContent);
         if (l) { f[l] = v; last = l; } else if (last) f[last] = cl((f[last] || "") + " " + v);
       }
       return {
         parcelNumber: f["Parcel ID"] || "",
         openingBid: f["Opening Bid"] || "",
         addressLine: f["Property Address"] || "",
         certificate: f["Certificate #"] || "",
         caseNumber: f["Case #"] || "",
         assessedValue: f["Assessed Value"] || "",
         auctionType: f["Auction Type"] || "",
         /*
          * One slot, two meanings, and the label is the only thing that says
          * which. `ASTAT_MSGA` reads "Auction Starts" on a scheduled parcel and
          * "Auction Status" on a settled one — so reading `ASTAT_MSGB` blind
          * files every scheduled parcel with a start time as its status.
          */
         status: /Status/i.test(label(it)) ? cl(it.querySelector(".ASTAT_MSGB")?.textContent) : "",
         startsAt: /Starts/i.test(label(it)) ? cl(it.querySelector(".ASTAT_MSGB")?.textContent) : "",
       };
     };

     const rows = [], seen = new Set();
     /* The area is captured with each parcel: see "the grouping is a claim". */
     for (const area of ["W", "C", "R"]) {
       const root = document.querySelector("#Area_" + area);
       if (!root) continue;
       const max = Number(document.querySelector("#max" + area + "A")?.textContent || 1) || 1;
       for (let page = 1; ; page++) {
         for (const it of root.querySelectorAll(".AUCTION_ITEM")) {
           if (/SPACER/.test(it.className)) continue;          // spacers are not parcels
           const r = { ...parse(it), area };
           if (r.parcelNumber && !seen.has(area + r.parcelNumber)) {
             seen.add(area + r.parcelNumber);
             rows.push(r);
           }
         }
         if (page >= max) break;
         const next = document.querySelector(`.PageFrame[area=${area}] .PageRight`);
         if (!next) break;
         const before = root.innerHTML;
         next.click();
         let loaded = false;
         for (let i = 0; i < 16 && !loaded; i++) {
           await new Promise((r) => setTimeout(r, 250));
           loaded = root.innerHTML !== before;
         }
         if (!loaded) break;
         await new Promise((r) => setTimeout(r, 600));   // be a guest, not a load test
       }
     }

     const [m, d, y] = new URL(location.href).searchParams.get("AUCTIONDATE").split("/");
     console.log(
       await fetch(ENDPOINT, {
         method: "POST",
         headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
         body: JSON.stringify({ host: location.hostname, saleDate: `${y}-${m}-${d}`, rows }),
       }).then((r) => r.json()),
     );
   })();
   ```

4. Repeat per sale. Captures land in
   `data/realauction-capture/<host>__<YYYY-MM-DD>.json`, which is gitignored —
   they are working artifacts with a shelf life of days.

5. Read them into the database:

       npm run ingest -- --adapter realauction

   `lib/ingest/adapters/realauction.ts` maps each capture's host to a county,
   takes the sale type from the page's own `Auction Type`, and drops mortgage
   foreclosure sales. A host it cannot place is named in the run's output
   rather than guessed at.

The 600 ms pause between pages is deliberate and should stay. We are a guest on
someone else's server with an agreement, not a crawler with a budget — and the
throttle described above is what ignoring that looks like.
