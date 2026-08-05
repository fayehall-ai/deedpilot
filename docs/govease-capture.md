# GovEase capture workflow

GovEase is **not crawled**. `liveauctions.govease.com/robots.txt` is
`User-agent: * / Disallow: /`, and `lib/ingest/policy.ts` records the host as
`requires_agreement`. The pages are opened in the operator's own browser and
saved to `data/govease-capture/`; the adapter only reads those files and never
makes a network request.

The distinction is structural rather than a matter of intent: `govease.ts`
imports `node:fs`, not `politeFetch`. There is no code path from the adapter to
the network.

## Why the data is worth the trouble

GovEase runs online tax lien and deed sales for counties in 13 states — AL, CA,
CO, GA, IA, IN, LA, MO, MS, OK, PA, TN, TX, WA — and publishes the auction
registry and per-auction parcel catalogs with no login. It is the widest-reach
platform in the researched county set.

## What to capture

Two kinds of file, both HTML fragments rather than whole pages:

| File | Source page |
|---|---|
| `registry.html` | `/PublicPortal/PublicRegisterAuctions` |
| `auction-<id>.html` | `/{state}/{slug}/{id}/browsestandard` |

`data/govease-capture/` is gitignored. Captures are working artifacts with a
shelf life of days, not source.

## Capture steps

1. Open `https://liveauctions.govease.com/PublicPortal/PublicRegisterAuctions`
   in Chrome. The page performs a timezone handshake on load and only then
   renders the real grid — if you see a near-blank page, let it finish.

2. Extract the registry fragment. In the console:

   ```js
   const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                           .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
   const today = new Date().toISOString().slice(0,10);
   const slug = new Map();
   document.querySelectorAll('option').forEach(o => {
     const m = /^([a-z]{2})\|([^|]+)\|(\d+)$/.exec(o.value);
     if (m) slug.set(m[3], o.value);
   });
   const keep = [];
   document.querySelectorAll('tr').forEach(r => {
     const m = /AuctionID=(\d+)/.exec(r.innerHTML); if (!m) return;
     const tds = [...r.querySelectorAll('td')]
       .map(td => td.textContent.replace(/\s+/g,' ').trim());
     if (tds.length < 7) return;
     const d = /(\d{2})\/(\d{2})\/(\d{4})/.exec(tds[5]); if (!d) return;
     if (`${d[3]}-${d[1]}-${d[2]}` < today) return;
     if (!slug.has(m[1])) return;
     keep.push({ id: m[1], tds });
   });
   const opts = keep.map(k => `<option value="${esc(slug.get(k.id))}"></option>`).join('');
   const rows = keep.map(k =>
     `<tr onclick="AuctionID=${k.id}">${k.tds.slice(0,7).map(t=>`<td>${esc(t)}</td>`).join('')}</tr>`
   ).join('');
   copy(`<select>${opts}</select><table>${rows}</table>`);
   ```

   Save the clipboard to `data/govease-capture/registry.html`.

3. For each auction worth ingesting, open its catalog and extract:

   ```js
   const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                           .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
   const rows = [...document.querySelectorAll('tr')]
     .filter(r => r.querySelector("a[href*='openstandardparcel']"));
   copy('<table>' + rows.map(r => {
     const a = r.querySelector("a[href*='openstandardparcel']");
     const tds = [...r.querySelectorAll('td')]
       .map(td => esc(td.textContent.replace(/\s+/g,' ').trim()));
     while (tds.length < 8) tds.push('');
     const owner = r.querySelector('[data-content]');
     const attr = owner ? ` data-content="${esc(owner.getAttribute('data-content'))}"` : '';
     return '<tr>' + tds.slice(0,8).map((t,i) =>
       i === 2 ? `<td><a href="${esc(a.getAttribute('href'))}">${esc(a.textContent.trim())}</a></td>`
       : i === 4 ? `<td><span${attr}>${t}</span></td>`
       : `<td>${t}</td>`).join('') + '</tr>';
   }).join('') + '</table>');
   ```

   Save to `data/govease-capture/auction-<id>.html`.

   The owner column truncates on screen; the full name is on the popover's
   `data-content`, which is why the snippet preserves that attribute.

4. Ingest:

   ```bash
   npm run ingest -- --adapter govease --dry-run
   npm run ingest -- --adapter govease
   ```

## Which auctions are worth capturing

Most are not, most of the time. **Counties upload catalogs days before the
sale, not when it is scheduled.** On 2026-08-05, 43 upcoming auctions had
parcels in only two:

| Auction | Sale date | Days out | Lots |
|---|---|---|---|
| Costilla County CO Treasurer's Deed | 2026-08-11 | 6 | 24 |
| Saguache County CO Deed Sale | 2026-08-12 | 7 | 2 |

All 38 Mississippi sales set for 2026-08-31 were empty, as were Marion County
IN's three for 10-13. So the practical rule is: **capture the registry, then
capture catalogs for auctions inside ~10 days of their sale date.** Re-run
weekly. The 38 Mississippi counties should be worth capturing in late August.

`discoverCounties` reports the captured/total ratio on every run so an empty
state is never mistaken for a parse failure.

## Gotchas

- **A wrong slug returns an empty grid, not a 404.** `/{state}/x/1435/browsestandard`
  renders a valid page with zero parcels. A guessed slug is indistinguishable
  from an auction with no catalog. Always take slugs from the registry select.
- **The registry needs its timezone handshake.** A cold request returns a
  1.8 KB shell that parses to zero auctions.
- **Municipal sellers are skipped deliberately.** City of Collins, Grenada,
  Louisville, Okolona and Oxford MS resolve to no county: a city levy is a
  different sale under different rules, and attributing it to the surrounding
  county would list lots that county is not selling.
- **Opening bid is not an assessed value.** GovEase publishes the county's
  opening — taxes, interest and costs. Max bid stays dark until ARV arrives
  from enrichment or a user's comps.

## If a data agreement is signed

Add a fetching transport and leave `parseRegistry` and `parseCatalog` alone.
They are pure functions over HTML and do not care where it came from —
`politeFetch` already supports `method`, `body` and `set-cookie` for the
session handshake, and `underAgreement: true` is the documented bypass.
