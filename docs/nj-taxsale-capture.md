# Capturing a New Jersey municipal tax lien sale

New Jersey has no county tax sales. Every one is run by a municipality under
N.J.S.A. 54:5, and 110 of them are scheduled on `newjerseytaxsale.com` with
4,667 parcels between them.

## This is RealAuction again

`randolph.newjerseytaxsale.com` serves "RealTaxLien" and is copyright
Realauction.com — the same engine `docs/realauction-capture.md` covers, with the
same `Disallow: /` and the same 403-in-118-bytes to this project's user agent,
and the same answer: the pages are public in a browser and are read there.

What differs is the page. Florida's deed sites publish a sale-day preview at
`zaction=AUCTION&Zmethod=PREVIEW`; the New Jersey lien sites publish
`index.cfm?folder=previewitems`.

## Finding the sales

Every one is already in the database. The imported calendar rows carry the
municipality, the county, the sale date, the start time, the advertised parcel
count *and the exact host* — so the work queue is a query, not a search:

```sql
select sale_date, county_fips, title, source_url, announced_parcel_count
from auctions
where sale_date >= current_date and source_url ilike '%newjerseytaxsale.com%'
order by sale_date;
```

`https://www.tctanj.org/cn/webpage.cfm?tpid=14659` — the Tax Collectors and
Treasurers Association's notice board — is the upstream source and is openly
crawlable (`robots.txt` allows all, and it answers our own agent with 200). It
carries sale dates, times, venues and these same hosts, so it is the place to
look when a town is missing from the table.

## A sale is not published until it is

A town whose list is not up yet serves "Important Messages — the Tax Sale
website is currently offline" instead of the table. Willingboro and Maplewood
both did, a month before their sales. That is a *not yet*, not a failure; the
advertised count in the table is 0 for exactly those.

## Capturing one

1. Open `https://<town>.newjerseytaxsale.com/index.cfm?folder=previewitems`.
2. Paste this. It walks every page — the table is fifty rows a page and
   `?pageNum=N` serves the rest to a same-origin fetch — and copies a capture.

   ```js
   (async () => {
     const cl = s => (s || '').replace(/[\s ]+/g, ' ').trim();
     const grab = doc => [...doc.querySelectorAll('tr')]
       .map(r => [...r.querySelectorAll('td')].map(td => cl(td.textContent)))
       /* The ADVNUM column is all digits; headers and chrome rows are not. */
       .filter(c => c.length >= 6 && /^\d+$/.test(c[0]));

     const pages = document.querySelector('#goToPageNumTop')?.options.length ?? 1;
     const rows = grab(document);
     const seen = new Set(rows.map(c => c[0] + c[2]));
     for (let p = 2; p <= pages; p++) {
       const res = await fetch(`index.cfm?folder=previewitems&pageNum=${p}`, { credentials: 'include' });
       const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
       for (const c of grab(doc)) {
         const k = c[0] + c[2];
         if (!seen.has(k)) { seen.add(k); rows.push(c); }
       }
       await new Promise(r => setTimeout(r, 500));   // be a guest, not a load test
     }

     copy(JSON.stringify({
       host: location.hostname,
       municipality: 'FILL IN, e.g. Randolph Township',
       countyFips: 'FILL IN, e.g. 34027',
       saleDate: 'FILL IN, e.g. 2026-09-16',
       startTime: 'FILL IN, e.g. 08:30 AM',
       announced: Number('FILL IN the advertised count'),
       capturedAt: new Date().toISOString(),
       rows: rows.map(c => ({
         advNum: c[0], taxYear: c[1], parcelNumber: c[2],
         ownerName: c[3], chargeType: c[4], faceAmount: c[5], status: c[6],
       })),
     }, null, 1));
     console.log(`${rows.length} rows across ${pages} page(s)`);
   })();
   ```

   The five FILL INs all come from the query above — municipality, county,
   date, start time and advertised count are already on the row this capture
   fills in.

3. Save to `data/nj-taxsale-capture/<host>__<YYYY-MM-DD>.json`, then:

       npm run ingest -- --adapter nj-taxsale

**Check the count.** The adapter says so loudly when a capture holds less than
90% of what the town advertised, because a sale showing 50 of 764 reads as a
small sale rather than as a page that was not finished — fifty is the page size,
and stopping at one page is the easy mistake.

## What the columns mean

    ADVNUM       0001          the advertisement number — the sale's own id
    Tax Year     2025          which year's delinquency is being sold
    Parcel ID    12 - 2.04     block and lot
    Owner Name   ...
    Charge Type  T W S         taxes / water / sewer, combinable
    Face Amount  $2,799.34     the certificate's face value
    Status       Active        or Unavailable, once paid or pulled

**Face amount is not an opening bid.** A New Jersey lien is bid down on interest
from 18% and then up as a premium; the face amount is what the certificate is
worth on day one. It lands in `taxesOwed`, not `openingBid` — a $458 sewer lien
must not look like a $458 house.
