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

Coverage today is 5 states (FL, GA, TX, AZ, MI) against an atlas that markets 50
states and DC, which is why `compute_maxbid` returns `insufficient-data` for
Illinois and California — where 78% of the historical corpus lives.

### 2. Auction Scout — constantly running, event-driven

The existing `policy → fetch → adapter → judge → runner` spine in `lib/ingest/`.
Pulls upcoming auctions and lots into Postgres.

The important design change is *when* it fires. Polling 3,142 counties uniformly
is expensive and mostly returns nothing, because a given county sells once a
month or once a year. Driven from the sale calendar it instead crawls a window
around each county's known sale dates, turning a continuous national poll into a
few hundred targeted crawls a week.

### 3. Outcome Archivist — provenance-first

Imports results after auctions close. Every source must ship with its label rule
in `labels.py` — what its price column means, what its disposition flags observe
— or its rows quarantine by default and never reach a fitted parameter.

This is the agent that caused the problem described above, and the redesign is
entirely about making that failure impossible rather than about importing faster.

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
   blind, so this is what makes national coverage affordable.
2. **Source Prospector** — over the counties the calendar says are active.
3. **Auction Scout** — scaled onto that registry, fired by that calendar.
4. **Statute Cartographer** — Illinois and California first, where the data is
   stranded behind missing statutory parameters.
5. **Outcome Archivist** — last, because it is only safe once sources are known
   and their semantics are stated.
