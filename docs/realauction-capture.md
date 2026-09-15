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

Per parcel, on the PREVIEW page and with no login:

    Auction Status   blank when still scheduled, "Redeemed" when paid off
    Auction Type     TAXDEED
    Case #           26-0282
    Certificate #    2024-10009
    Opening Bid      $12,434.01
    Parcel ID        046282-0000
    Property Address 1982 W 16TH ST JACKSONVILLE, FL- 32209
    Assessed Value   $10,902.00

Twenty item blocks render per page, padded with empties — Charlotte's twenty
blocks held ten parcels. Duval's 14 October sale is sixteen pages.

**Redeemed parcels are not inventory.** The owner has paid; the parcel is not
sold. `lib/ingest/lot-status.ts` is what decides that, so the capture records
the status verbatim rather than filtering here.

## Capturing a whole county

1. Start the dev server — the capture endpoint is development-only:

       npm run dev

2. Open the sale's PREVIEW page in Chrome, e.g.

       https://www.duval.realtaxdeed.com/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&AUCTIONDATE=10/14/2026

3. Paste this into the console. It walks every page of that sale in the browser
   you are already in, then posts the result to the local endpoint. One paste
   per sale; it prints what it stored.

   ```js
   (async () => {
     const TOKEN = "PASTE_YOUR_DEEDPILOT_ADMIN_TOKEN";
     const ENDPOINT = "http://localhost:3000/api/admin/realauction-capture";

     const field = (t, label) =>
       (new RegExp(label + ":\\s*([^:]*?)(?=\\s+[A-Z][A-Za-z ]*:|$)").exec(t) || [, ""])[1].trim();

     const parse = (doc) =>
       [...doc.querySelectorAll("[class*=AUCTION_ITEM]")].map((it) => {
         const t = it.innerText.replace(/\s+/g, " ");
         return {
           parcelNumber: field(t, "Parcel ID"),
           openingBid: field(t, "Opening Bid"),
           addressLine: field(t, "Property Address"),
           certificate: field(t, "Certificate #"),
           caseNumber: field(t, "Case #"),
           assessedValue: field(t, "Assessed Value"),
           status: (/Auction Status\s+([\w ]+?)(?=\s+Auction Type|$)/.exec(t) || [, ""])[1].trim(),
         };
       }).filter((r) => r.parcelNumber);

     const url = new URL(location.href);
     const date = url.searchParams.get("AUCTIONDATE");
     const [m, d, y] = date.split("/");
     const rows = [...parse(document)];

     /* Same-origin fetches, so the browser sends the session it already has. */
     const pages = Number((/page\s+of\s+(\d+)/i.exec(document.body.innerText) || [, "1"])[1]);
     for (let p = 2; p <= pages; p++) {
       url.searchParams.set("AUCTIONDATE", date);
       const res = await fetch(`${location.pathname}?zaction=AUCTION&Zmethod=PREVIEW&AUCTIONDATE=${encodeURIComponent(date)}&selPS=20&page=${p}`, { credentials: "include" });
       const html = await res.text();
       rows.push(...parse(new DOMParser().parseFromString(html, "text/html")));
       await new Promise((r) => setTimeout(r, 1500));   // be a guest, not a load test
     }

     const out = await fetch(ENDPOINT, {
       method: "POST",
       headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
       body: JSON.stringify({ host: location.hostname, saleDate: `${y}-${m}-${d}`, rows }),
     }).then((r) => r.json());
     console.log(out);
   })();
   ```

4. Repeat for each sale you want. Captures land in
   `data/realauction-capture/<host>__<YYYY-MM-DD>.json`, which is gitignored —
   they are working artifacts with a shelf life of days.

The 1.5-second pause between pages is deliberate and should stay. We are a guest
on someone else's server with an agreement, not a crawler with a budget.
