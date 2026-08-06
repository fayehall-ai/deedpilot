# SRI capture workflow

SRI is **not crawled**. `sriservices.com/robots.txt` permits crawling, but the
listings are not served from that origin — they come from a JSON API at
`sriservicesusermgmtprod.azurewebsites.net/api`, which rejects any request
without the SPA's `x-api-key` header:

```
$ curl -X POST .../api/property/countysalesinformation -d '{"stateName":"IN","countyName":"Adams"}'
{"error":"Unauthorized access - API key mismatch"}   # 401, verified 2026-08-05
```

That key is an access control. Lifting it out of the public bundle to
authenticate a server we do not own is a different act from reading a public
page, so we do not. Pages are opened in the operator's browser — where the app
supplies its own key, as intended — and the listings are saved to
`data/sri-capture/`. `lib/ingest/adapters/sri.ts` imports `node:fs`, not
`politeFetch`; there is no code path from it to SRI.

## Why SRI is worth the trouble

Seven states — AL, CO, FL, IN, LA, MI, TN — and roughly 350 counties in the
picker, including all 92 Indiana counties.

More importantly, **SRI listings carry a street address per parcel**, which
almost no other source does. Most publish a legal description only
("S.D.C.R. UNIT B BLK 56 LOT 610"), which no property API can resolve. An
address feeds the RentCast enrichment path directly, so SRI lots can reach an
ARV without an APN match — the exact thing that has ~130 Brevard FL lots stuck
(see `docs/brevard-apn-resolution.md`).

## Capture format

One JSON file per county and sale type: `data/sri-capture/<STATE>-<County>-<type>.json`.

```json
{
  "source": "sriservices.com/properties",
  "capturedFor": { "state": "MI", "county": "Lenawee", "saleTypeParam": "deed" },
  "properties": [
    {
      "addr": "362 S MONROE ST", "city": "BLISSFIELD, Michigan",
      "saleId": "462300016", "parcel": "BL2-231-1840-00",
      "date": "08/11/2026", "time": "10:00 AM",
      "status": "DELINQUENT", "saleType": "Deed Sale", "method": "Online"
    }
  ]
}
```

Every property carries its own sale date and type, so auctions are derived from
the listings. There is no separate registry file to keep in sync, and a county
running two sales in one capture splits into two auctions on `(date, saleType)`.

`data/sri-capture/` is gitignored — captures are working artifacts.

## Large counties: use the site's own Excel export

The rendered cards are fine for a small county, but Jefferson Parish LA is
1,638 properties across **182 pages**, and the Excel export is both faster and
strictly richer — it carries the **minimum bid**, owner and full legal
description, none of which appear on screen.

1. Filter to the county and sale type, then **Download List → Excel**.
2. Convert:

   ```bash
   python3 scripts/sri_xlsx_to_capture.py \
     ~/Downloads/Jefferson_Tax\ Lien\ Sale_Sale_Properties_Downloaded_2026-08-06.xlsx \
     --state LA --county Jefferson --type "tax lien"
   ```

   It writes `data/sri-capture/LA-Jefferson-tax-lien.json` and reports counts to
   check against the page's own *"Showing N properties"*.

Export columns: `Sale Date · Sale Time · Sale Location · Sale ID · Owner Name ·
Property Street · Property ID · Minimum Bid · Legal`. `Property ID` is the
parcel; there is no city column, which the adapter tolerates.

## Louisiana bids down the ownership interest

Jefferson Parish minimum bids run from **$0.21** to $312,055. The low figures
are not errors. Louisiana tax sales bid down the *percentage interest* conveyed
rather than the price, which is why legal descriptions read
`97% INT IN 2024 GRETNA TAX SALE`. A winning bidder may take a fractional
undivided interest, not the whole property.

`StatuteParams.redemption.bidDown` exists for exactly this, but **LA has no
STATUTE_PARAMS entry**, so these lots list without a walk-away price — the same
position as Arkansas. Do not price them until the bid-down mechanic is encoded,
because a max bid that assumes fee simple is wrong on every one of them.

## Capture steps

1. Go to `https://sriservices.com/properties`, then pick **State → County →
   Sale Type**. The sale-type dropdown shows counts, e.g. `Deed Sale (1)`.
   If it reads *No Active Listings At This Time*, that county has nothing.

2. Page through and collect. In the console:

   ```js
   window.__cards = () => {
     const t = document.body.innerText;
     const re = /([^\n]+),?\s*\n([^\n]*(?:Michigan|Indiana|Louisiana|Alabama|Colorado|Florida|Tennessee))\nSale ID:\s*\n([^\n]+)\nParcel #:\s*\n([^\n]+)\nSale Date:\s*\n([^\n]+)\nSale Time:\s*\n([^\n]+)\n[^\n]*\nStatus:\s*\n([^\n]+)\nSale Type:\s*\n([^\n]+)\nMethod:\s*\n([^\n]+)/g;
     const out = []; let m;
     while ((m = re.exec(t))) out.push({
       addr: m[1].replace(/,$/,'').trim(), city: m[2].trim(), saleId: m[3].trim(),
       parcel: m[4].trim(), date: m[5].trim(), time: m[6].trim(),
       status: m[7].trim(), saleType: m[8].trim(), method: m[9].trim() });
     return out;
   };
   const map = new Map();
   const pg = () => (/Page (\d+) of (\d+)/.exec(document.body.innerText) || [0,0,0]).slice(1).map(Number);
   window.__cards().forEach(c => map.set(c.saleId, c));
   let [cur, tot] = pg();
   while (cur < tot) {
     const before = cur;
     const nxt = [...document.querySelectorAll('a,button')]
       .find(b => /^Next$/i.test(b.textContent.trim()));
     if (!nxt) break;
     nxt.click();
     await new Promise(r => setTimeout(r, 2200));
     [cur, tot] = pg();
     if (cur === before) break;           // guard: see gotcha below
     window.__cards().forEach(c => map.set(c.saleId, c));
   }
   copy(JSON.stringify({ source: 'sriservices.com/properties',
     capturedFor: { state: 'MI', county: 'Lenawee', saleTypeParam: 'deed' },
     properties: [...map.values()] }));
   ```

3. Save to `data/sri-capture/<STATE>-<County>-<type>.json` and check the count
   matches the page's own *"Showing N properties"*.

4. Ingest:

   ```bash
   npm run ingest -- --adapter sri --dry-run
   npm run ingest -- --adapter sri
   ```

## Mortgage foreclosures are out of scope

SRI runs mortgage-foreclosure sheriff's sales alongside tax sales, and the
filters present them identically. They are a different instrument — the debt is
a defaulted note, not delinquent taxes — so no `STATUTE_PARAMS` entry applies
and the max-bid engine would produce a confident meaningless number.

Tell them apart by the card schema:

| Tax sale | Mortgage foreclosure |
|---|---|
| `Sale ID:` + `Parcel #:` | `Cause #:` + `Defendant:` |
| `Status: DELINQUENT` | `Status: Sale Active` / `Cancelled` |
| — | Indiana cause numbers carry `-MF-` |

As of 2026-08-05 **all 20** of SRI's upcoming Indiana auctions were mortgage
foreclosures, as was Plaquemines Parish LA. Jefferson, Livingston and Town of
Roseland LA were genuine Tax Lien Sales. Indiana's actual tax sales run
August–October and had not been posted.

Do not capture the foreclosure listings. `isMortgageForeclosure` in the adapter
drops them if any slip through, and the capture regex needs a `Parcel #` so it
already returns nothing for them — which is why an Indiana capture reads as
"no inventory" rather than "wrong instrument".

## Gotchas

- **Clicking Next past the last page re-adds the last page.** It does not
  no-op. Loop on the `Page X of Y` indicator and break when the number stops
  advancing — a naive `for` loop over Next produced 36 rows from a 30-property
  county, all six extras being repeats of the final page.
- **Verify against "Showing N properties".** It is the source's own count and
  the only cheap check on a capture.
- **Addresses can carry an appended note** after a triple dash:
  `4067 HOADLEY ST --- Township requires immediate blight clean-up`.
  `splitAddressNote` keeps the address clean for geocoding and preserves the
  note in `raw.addressNote` — a required blight cleanup is a cost the bidder
  eats, so it is worth keeping, just not in the address field.
- **Some listings have no city** (2 of 30 in Lenawee). Expected, not a bug.
- **No opening bid or assessed value.** SRI's listing page publishes neither,
  so both are left unset and max bid stays dark until enrichment supplies an
  ARV. Do not derive one from anything on this page.
- **Inventory is seasonal.** On 2026-08-05, Adams IN showed `Tax Sale (1)` but
  *No properties match your search*, and Marion IN had no active listings at
  all, while Lenawee MI had 30. Indiana tax sales run August–October. Re-run as
  dates approach; this is a recurring harvester, not a bulk load.

## The Auction List modal

`Sale Information → Auction List` in the navbar is a separate surface listing
scheduled sales as cards (county, state, type, date, time, format, venue) with
filters for state, type and county, plus a *Download List* export. On
2026-08-05 it showed 25 upcoming auctions across IN, LA and MI.

It is useful for deciding **which counties are worth capturing**, but it carries
no parcels, so it is not itself a capture target. Note the older
`/properties` page is deprecated in the UI: a banner says access moved to
*Sale Information*.
