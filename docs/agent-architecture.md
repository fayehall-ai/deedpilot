# Data agents

How DeedPilot acquires the four kinds of data it runs on, and why they are not
acquired the same way.

> Scope note: this document is about **runtime services** — scheduled code that
> calls an LLM inside a deterministic pipeline. It is not about Claude Code
> agents, which are the right tool for *authoring* adapters, statute records and
> label rules, and the wrong tool for a loop that has to be cheap, observable and
> repeatable.

## The constraint everything else follows from

More data made this system worse once already, and it is worth being precise
about how, because the failure is not intuitive.

92,208 historical rows were imported across several states. Most carried no
statement of what their fields meant. `redeemed=False` is a schema default, and
Cook County — which publishes which liens sold and never revisits them —
contributed 70,109 rows where that default was read as an observed
non-redemption. With sample-size shrinkage weighting by row count, those
non-observations buried the expert prior and pinned Illinois tax liens at
`p_redeem = 0.02`.

The simulator concluded that an Illinois lien almost never redeems. Redemption is
the entire thesis of buying one. Every downstream path — expected value, risk,
the suggested bid on the lot page — inherited that inversion, and it got *more*
confident as more rows arrived, because confidence is a function of `n`.

So the governing rule:

> **An agent may not add a row without stating what that row observes.**
> Volume without provenance is negative value, and it is negative in a way that
> scales with volume.

This is enforced in code. `copilot/deedpilot_copilot/labels.py` maps each source
to its semantics — `disposition` (what happened to the position) and `price_kind`
(what the recorded number actually is) — and anything unmatched is quarantined
rather than pooled. Adding a source is therefore a reviewed code change. The
friction is the point.

## Four data classes

They differ by what happens when the agent is wrong, and that determines
everything else about how each one is built.

| Class | Volume | Change rate | Failure mode | Destination | Gate |
|---|---|---|---|---|---|
| **Statutory parameters** | ~50 states × 8 fields | Per legislative session | A subscriber overbids on a wrong redemption penalty | Version control | Human sign-off |
| **Sale calendar** | 3,142 counties | Rarely | Crawls miss a sale, or waste money | Version control | Invariant checks |
| **Upcoming auctions** | 3,142 counties, weekly | Constant | A stale listing; the user can see it | Postgres | Judge (reject/repair) |
| **Historical outcomes** | Unbounded | Append-only | *Silent model poisoning* | Postgres + label rule | Label rule required |
| **Source registry** | 3,142 URLs | Slowly | Coverage gap; visible on `/coverage` | Version control | Verification fetch |

Two principles fall out of this table.

**Trust tier determines destination.** Low-volume, high-stakes, slow-changing
facts live in version control where they get reviewed, diffed and blamed.
High-volume perishable observations live in Postgres where they get judged and
replaced. Statutes are not database rows; auction listings are not source code.
This is the same reasoning that already keeps the county atlas in `lib/atlas/`
rather than the database.

**The judge is not the same as the reviewer.** Auction rows are checked by code
at ingest (`lib/ingest/judge.ts` splits *rejected* from *repaired*) because a bad
row is cheap and self-correcting. Statutory parameters are checked by a person,
because a bad assessment ratio silently shifts every walk-away price in a state
and nothing downstream will notice.

## The agents

### 1. Statute Cartographer — proposal pipeline, not a daemon

Drafts a structured statutory record for a state: assessment ratio, redemption
tiers, quiet-title cost range, closing costs, holding assumptions. Each field
carries its own source URL, `asOf` date and confidence — not one citation for the
record, because these facts come from different places and age differently.

Code then validates invariants that do not require domain judgement:

- assessment ratio in `(0, 1]`
- redemption tiers monotonic in days, penalties non-decreasing
- quiet-title `typicalLow < typicalHigh`
- penalty rates within a plausible statutory band
- sale type consistent with the atlas prose already on file

Output is a **pull request**, never a write to production. Runs on demand and
re-verifies annually, because statutes change per legislative session rather than
per day. A continuously-running statute agent is a category error: it would spend
money re-deriving facts that did not change, and its errors are the only errors
in this system that a user cannot see.

Coverage is 7 states (AZ, CA, FL, GA, IL, MI, TX) against an atlas that markets
50 states and DC, so `compute_maxbid` still returns `insufficient-data` for 44.

Illinois and California were the first two drafted, and reviewing them is the
argument for this design rather than an illustration of it. Both proposals
passed validation, and both contained an error that would have been worse than
the gap they filled:

- The Illinois draft gave the statutory 33⅓% assessment ratio and flagged in its
  own uncertainty note that Cook County does not use it — Cook runs a classified
  system nearer 10%. Cook is also 70,109 of our historical rows.
- It gave the penalty as 18%, the statutory ceiling. Checked against our own
  data, the rate cleared at a **0% median across 64,526 recorded Cook sales**;
  81.4% were bid all the way to zero. Pricing the lien at the cap overstates its
  return by an order of magnitude.

Neither is something code can catch. Both were caught by reading the citations
and cross-checking against recorded outcomes, which is exactly the work the human
gate exists to make someone do.

### 2. Auction Scout — constantly running, event-driven

The existing `policy → fetch → adapter → judge → runner` spine in `lib/ingest/`.
Pulls upcoming auctions and lots into Postgres.

The important design change is *when* it fires. Polling 3,142 counties uniformly
is expensive and mostly returns nothing, because a given county sells once a
month or once a year. Driven from the sale calendar it instead crawls a window
around each county's known sale dates.

Two mechanisms produce the saving, and it is worth separating them because the
first is much weaker than it looks:

- **Window membership** — only crawl counties inside a listing or results
  window. Measured over a simulated year this is worth 2–3×, not the order of
  magnitude one might assume. A Texas county sells every month with a 21-day
  notice period, so it is legitimately in a window most of the time.
- **Re-crawl interval** — being inside a window is not a reason to fetch daily.
  A listing posts weeks ahead and barely changes until parcels start getting
  pulled for late payment near the sale, so the interval is weekly by default and
  tightens to daily in the last three days.

Together, measured across 25 counties per confidence tier over 365 simulated
days: **5.6× fewer fetches for statutory schedules, 13× for typical, 6.4× for
unresearched**, against daily polling of the same counties.

One trap worth recording, because it produced exactly zero saving until it was
measured: sweep dates for counties with no known schedule must be anchored to a
fixed epoch, not to the query date. Derived from "today", every window slides
with the caller, every day falls inside one, and an `irregular` county gets
polled daily by a system that believes it is being clever. A per-county phase
offset also staggers the sweeps so 2,900 unscheduled counties do not all come due
on the same morning.

### 3. Outcome Archivist — provenance-first

Imports results after auctions close. Every source must ship with its label rule
in `labels.py` — what its price column means, what its disposition flags observe
— or the batch is refused.

This is the agent that caused the problem described above, and the redesign is
entirely about making that failure impossible rather than about importing faster.
`copilot/deedpilot_copilot/archivist.py` enforces it:

- **An unlabelled source stops the batch.** Not "imports the labelled 90% and
  drops the rest" — that leaves unexplained gaps that later read as real market
  signal. `import_batch(strict=True)` raises `UnlabelledSourceError` naming the
  sources and pointing at `labels.py`.
- **Quarantined rows are excluded but retainable.** Maryland's 2,524 premium
  bids become usable the moment someone works out the field mapping, so
  `allow_quarantined=True` keeps them in the corpus without letting them reach a
  fitted parameter.
- **Structural checks are thin on purpose.** Negative bids, a row that is both
  redeemed and ownership-taken, an unparseable date. The Archivist's job is not
  to second-guess a county's published figures, only to refuse rows that cannot
  mean anything.
- **`corpus_report()` leads with what is fittable, not with the row count.**
  `deedpilot-copilot corpus` prints price-usable and redemption-observed counts
  per source rule, so "92,208 rows" can never again be quoted as if it were
  92,208 usable observations.

### 4. Source Prospector — discovery

Finds and verifies the government source-of-record URL for each county: the
clerk, treasurer or tax collector that legally publishes the sale list. Feeds the
other three.

This is the real bottleneck for national coverage. Adapters and models are
worthless for a county whose URL is unknown, and the resolution to the
RealAuction policy block — prefer the government source of record — only works if
that source has been located.

## Shared infrastructure

**Access policy is architectural, not advisory.** Every agent fetches through
`lib/ingest/policy.ts` / `politeFetch`, which throws `PolicyBlockedError` rather
than fetching a disallowed host. RealAuction publishes `User-agent: * /
Disallow: /` and hosts most of Florida's tax deed sales; those counties are
recorded as blocked and shown on `/coverage` instead of silently missing. An
agent that could bypass this would make the policy a comment.

**LLM extracts, code judges.** Extraction from unstructured county pages may be
fuzzy. Acceptance never is. The model proposes structure; deterministic code
decides what is kept, repaired or rejected, and both counters land in
`ingest_runs` so a moved source shows up as a spike rather than a slow drift.

**The evaluator gates promotion.** A new statute record, a new source or a new
adapter does not ship if held-out metrics regress. Promotion is decided on the
validation split; the test split is reported and never gated on, so it can still
answer whether we fooled ourselves on validation.

**Nothing an agent produces is a walk-away price.** `compute_maxbid` remains the
only thing that computes a number a subscriber acts on, and it consumes agent
output only after that output has been reviewed and merged.

## Build order

Each step unblocks the next.

1. **Sale calendar** — the scheduling primitive. Without it the scout polls
   blind, so this is what makes national coverage affordable (measured 5.6–13×
   fewer fetches; see the Scout section).
2. **Source Prospector** — over the counties the calendar says are active.
3. **Auction Scout** — scaled onto that registry, fired by that calendar.
4. **Statute Cartographer** — Illinois and California first, where the data is
   stranded behind missing statutory parameters.
5. **Outcome Archivist** — last, because it is only safe once sources are known
   and their semantics are stated.

## Commands

```bash
npm run scout -- --plan                  # today's queue; no network, no writes
npm run scout -- --plan --backlog        # counties with a live source, no parser
npm run scout -- --dry-run --max 5       # crawl and judge, write nothing
npm run prospect -- --dry-run            # candidate plan for the registry
npm run prospect -- --state MI --limit 5 # verify a handful, live
npm run cartographer -- --gaps           # which states cannot be priced
npm run cartographer -- --state IL --pr  # draft proposals, open a PR

deedpilot-copilot corpus                 # what fraction of the corpus is fittable
deedpilot-copilot archive rows.jsonl     # dry-run import; refuses unlabelled sources
```

## Status

| Piece | State |
|---|---|
| Sale calendar | 21 states scheduled (4 statutory, 17 typical), 30 unresearched, 3 county overrides |
| Source Prospector | 194 candidates across 152 researched counties, 164 hosts, 98 government |
| Auction Scout | Scheduling, backoff, re-crawl intervals, coverage accounting |
| Statute Cartographer | Drafting + validation + PR flow; IL and CA reviewed and promoted |
| Outcome Archivist | Admission control enforcing label rules |
| Generic adapter | Registry-driven; adapter backlog now 0 |

### Where the bottleneck moved

The generic adapter closed the "we cannot parse this" gap. What made per-county
adapters seem necessary was that each one hardcoded three things it had no other
way to know, and all three are now supplied:

| Hardcoded in a bespoke adapter | Now comes from |
|---|---|
| where the county publishes | the Prospector's source registry |
| when it sells | `resolveSaleSchedule` |
| what instrument it sells | `resolveCountyRule` |

What remained was parsing, and parsing was never county-specific — a table of
parcels looks the same in Ohio as in Georgia. Registration order is precedence,
so the bespoke adapters keep the counties they cover and the generic one takes
everything else.

The remaining gap is **`no_source`: 2,165 counties nationally have a crawl window
open and no verified source of record**. That is the Prospector's backlog, not
the adapter's, and it is a far more tractable shape of problem: a crawl to run
rather than thousands of parsers to write.
