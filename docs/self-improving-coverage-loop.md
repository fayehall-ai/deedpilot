# Self-improving loop: national live inventory, history, and max-bid

**Goal:** live auctions for all states, historical outcomes for all states, and a
responsible max bid for every county.

**Non-goals:** inventing walk-away prices; pooling unlabelled history; promoting
statutes without a human; scraping policy-blocked platforms.

This document is the operating system for that goal. It composes agents you
already have (Prospector, Scout, Archivist, Cartographer, generic adapter,
copilot flywheel) into one **meta-loop** with an explicit scoreboard, promotion
gates, and a hard rule:

> **An agent may not add a fact without stating what that fact observes, and
> may not ship a number a subscriber can bid on without a reviewed path to that
> number.**

---

## 1. Goal decomposition

The gold is three independent products that only look like one dashboard.

| Product | Unit of success | Destination | Failure mode if wrong |
|---------|-----------------|-------------|------------------------|
| **Live inventory** | County-sale with ≥1 judged lot, fresh within SLA | Postgres | User misses a sale or trusts a ghost auction |
| **Historical outcomes** | Labelled, price-kind-typed result row | Corpus + DB | Silent model poisoning (Cook 70k lesson) |
| **Max bid capacity** | County can produce a non-null `computeMaxBid` when given assessed or comps | `lib/deal/statute.ts` + enrichment | Subscriber overbids on bad ratio/penalty |

**Max bid for all counties** does **not** mean a precomputed number on every
FIPS. It means:

1. **State statutory parameters** exist and are reviewed (or county override).
2. **ARV path** exists: assessed ÷ ratio, assessor enrichment, or user comps.
3. **Engine returns a number** (or a specific reason it cannot), never a guess.

National “coverage %” is therefore a **vector**, not a scalar:

```
C_live(c)     = 1 if county has upcoming lots with opening bid
C_hist(c)     = 1 if county has ≥N price-usable historical rows (or expert prior only flagged)
C_statute(s)  = 1 if state has reviewed STATUTE_PARAMS
C_arv(c)      = 1 if last live lots had assessed|enrichment rate ≥ threshold
C_price(c)    = C_statute(state(c)) ∧ (C_arv(c) ∨ comps_ui)

Gold_score    = w1·mean(C_live) + w2·mean(C_hist) + w3·mean(C_price)
                − penalties(skeletons, unlabelled_imports, stale_statutes)
```

Suggested weights (tunable): `w1=0.35, w2=0.25, w3=0.40` — pricing capacity is
the product promise; live inventory without max bid is a classifieds site.

---

## 2. Why one naive loop fails

A single “crawl more → train more → ship more” loop already hurt you once:

- Unlabelled Illinois rows inverted redemption priors.
- Volume increased **confidence in the wrong number**.
- 0-lot auctions created **false coverage**.
- URL pattern prospecting resolved **~9%** of counties (0% in the bottom half
  by population).

So the system is **four specialized loops** under one **meta-controller**. Each
loop has its own judge. The meta-controller only chooses *where to spend the
next budget*.

```
                    ┌─────────────────────────────┐
                    │     META-CONTROLLER         │
                    │  scoreboard → rank work     │
                    │  budget → dispatch agents   │
                    │  gates → promote or quarantine │
                    └─────────────┬───────────────┘
           ┌──────────┬──────────┼──────────┬──────────┐
           ▼          ▼          ▼          ▼          ▼
      PROSPECT    SCOUT/LIVE  ARCHIVIST  CARTOGRAPHER  ENRICH
      (sources)   (auctions)  (history)  (statutes)    (ARV)
           │          │          │          │          │
           └──────────┴──────────┴──────────┴──────────┘
                              │
                              ▼
                    EVALUATION + LESSONS
                    (metrics, memory, next rank)
```

---

## 3. The meta-loop (one cycle)

Run on a fixed cadence (e.g. nightly) and on-demand after large merges.

### Step 0 — Observe (read-only)

Emit `coverage_scoreboard.json` (and surface on `/coverage` + `/status`):

| Metric | Definition |
|--------|------------|
| `states_with_upcoming_lots` | Distinct states with sale_date≥today and lot_count>0 |
| `counties_with_upcoming_lots` | Same at county grain |
| `lots_upcoming` / `lots_with_assessed` / `lots_auto_priceable` | Opening + assessed + statute |
| `skeleton_auctions` | sale_date≥today and lot_count=0 (debt) |
| `registry_listing_verified` | Counties with kind=`listing`, verified, gov preferred |
| `registry_results_verified` | kind=`results` for archivist |
| `states_with_statute` | `coveredStateList().length` / 51 |
| `counties_maxbid_ready` | statute ∧ (assessed path or assessor binding) |
| `hist_price_usable_by_state` | From label rules, not raw row count |
| `hist_redemption_observed_by_state` | Same |
| `ingest_fail_rate_7d` | failed / (ok+partial+failed) |
| `stale_sources` | verifiedOn older than N days and in calendar window |

**Honesty rule:** never report raw historical row count as progress. Report
`price_usable` and `redemption_observed` only (see archivist `corpus_report`).

### Step 1 — Rank work (priority function)

For each county `c` (and each state `s` for statutes):

```
priority(c) =
    pop_weight(c)                    # bidders care about volume markets first
  × sale_proximity(c)                # calendar window open → urgent for live
  × gap_type_weight                  # listing gap > results gap > rules gap
  × (1 + fail_streak(c))             # broken parsers climb the queue
  × (1 − duplicate_adapter_coverage) # don't generic-scrape LGBS/MI platforms
  − recent_budget_spent(c)           # explore/exploit: don't starve long-tail
```

**State statute priority:**

```
priority(s) =
    live_lots(s) + hist_rows_unusable_without_statute(s)
  × (1 if no STATUTE_PARAMS else years_since_asOf)
```

IL/CA already showed: draft only where data or inventory is stranded.

**Global work classes** (meta-controller allocates budget %):

| Work class | Initial budget share | Escalates when |
|------------|---------------------:|----------------|
| A. Fix broken live feeds (MI SEV, parse fails) | 25% | `lots_auto_priceable` ≪ `lots_upcoming` |
| B. Expand listing registry + scout | 30% | `states_with_upcoming_lots` < 50 |
| C. Historical results + label rules | 20% | `hist_price_usable` states < 50 |
| D. Statute cartography + human review queue | 15% | `states_with_statute` < 51 |
| E. Skeleton debt / QA / policy | 10% | `skeleton_auctions` > 0 |

Shares rebalance each cycle from scoreboard deltas (PID-style, capped).

### Step 2 — Act (agents, never end-to-end auto-ship for high-stakes)

See §4–7. Every action returns a structured `ActionResult`.

### Step 3 — Judge (code, not the model)

| Artifact | Judge |
|----------|--------|
| Live lot | `judgeLots` / `judgeAuctions` — reject vs repair |
| Auction persist | **must have >0 accepted lots** (already in runner) |
| Historical batch | `labels.py` rule required; `UnlabelledSourceError` aborts batch |
| Statute draft | Cartographer invariants + **human PR** |
| Source registry | HTTP 200 + tax-sale signals + policy allow; prefer `.gov` |
| World model / priors | Val promotion gate; test split never used for gate |
| Max bid | Only `computeMaxBid`; no LLM path |

### Step 4 — Promote or quarantine

| Outcome | Action |
|---------|--------|
| Pass judge + low stakes (listing URL, live lot) | Write Postgres / registry file |
| Pass judge + high stakes (statute, label rule, assessment ratio) | Open PR / proposal; **block merge without human** |
| Fail judge | Quarantine with reason; do not delete evidence |
| Metrics regress on val | Revert agent config; store lesson |

### Step 5 — Learn (self-improvement surfaces)

The loop improves **itself**, not only the dataset:

1. **Lesson memory** (existing copilot) — parse failures, bad hosts, wrong kinds.
2. **Priority model** — counties that never yield lots after K attempts drop in
   rank; counties that suddenly publish climb.
3. **Adapter router** — bespoke > platform > generic; learn host→parser hints
   (table selector, PDF-only, SPA).
4. **Calendar refinement** — schedule hints from prospected pages feed
   `lib/atlas/calendar.ts` proposals (human merge for statutory claims).
5. **Label rule proposals** — archivist suggests `labels.py` stubs; human
   writes semantics before import.
6. **Enrichment playbook** — which hosts expose SEV/assessed on detail pages
   (MI pattern generalized).

---

## 4. Loop A — Live auctions (all states)

### Pipeline

```
Calendar window? ──no──► skip (or low-rate sweep with fixed epoch phase)
       │ yes
       ▼
Registry has listing URL? ──no──► enqueue PROSPECT (kind=listing)
       │ yes
       ▼
Adapter claim (lgbs | taxsaleinfo | ga | fl | generic)
       │
       ▼
politeFetch → extract → judge → persist iff lots>0
       │
       ▼
Enrichment pass (assessed/SEV/parcel) ──► lot_valuations + lots.assessed_value
       │
       ▼
Scoreboard: C_live, assessed_rate, auto_priceable
```

### Self-improvement inside Loop A

| Signal | Learning response |
|--------|-------------------|
| `partial` / 0 lots but page has table | Parser lesson: store CSS/PDF strategy per host |
| `fetch_failed` streak | Backoff; re-prospect alternate URL |
| Lots without assessed > 80% | Escalate **Enricher** for that platform (MI SEV pattern) |
| Skeleton auctions | Delete/hide; never count toward C_live |
| Policy block | Mark coverage “agreement needed”; prospect gov alternate |

### National expansion strategy (not uniform crawl)

1. **Platform islands first** (known APIs: LGBS, Title Check, state land offices).
2. **Population × sale-frequency ranking** for generic counties.
3. **State pilots**: 5–10 verified listing URLs → prove lots → then flood state.
4. **FL special case**: clerk-of-court registry only; never RealAuction unless
   agreement flips policy.

### SLA targets (phased)

| Phase | Target |
|-------|--------|
| P0 | MI+TX: 0 skeletons; MI assessed ≥70% of lots |
| P1 | 15 states with ≥1 real upcoming auction (lots>0) |
| P2 | 35 states |
| P3 | 50+DC with at least annual presence or explicit “no public list” |

“No public list” is a first-class coverage state (honest), not a silent zero.

---

## 5. Loop B — Historical data (all states)

### Pipeline

```
Sale closed (calendar or listing went offline)
       │
       ▼
Results URL (registry kind=results) or platform history API
       │
       ▼
Fetch → structural parse
       │
       ▼
Label rule exists for source_id? ──no──► DRAFT label stub → human → labels.py
       │ yes
       ▼
Archivist import (strict) → quarantine unknowns
       │
       ▼
Recalibrate priors / refit world model on train only
       │
       ▼
Promotion gate on val (existing evaluate.promotion_gate)
```

### Self-improvement inside Loop B

| Signal | Learning response |
|--------|-------------------|
| High quarantine rate | Field-mapping review ticket; do not force-fit |
| Bid-down / premium / tax_amount patterns | New `price_kind`; never pool with clearing_price |
| State with sales but 0 results URLs | Prospect kind=results with higher weight post-sale |
| Prior flips vs expert | Require dual confirmation before overwriting expert prior |

### Hard laws (non-negotiable)

1. **No import without label rule.**
2. **Row count is not a KPI.**
3. **Expert priors stay until `n_observed` and semantics justify override.**
4. **Test split never gates promotion.**

Historical coverage for “all states” will be uneven forever (many counties do
not publish machine-readable results). The loop’s job is to maximize
**fittable** geography and explicitly mark the rest as expert-prior-only.

---

## 6. Loop C — Max bid for all counties

Max bid is a **stack**, not a crawl.

```
County c
  ├─ State statute s(c)     → Cartographer loop (human merge)
  ├─ County overrides       → rare; Cook-style ratio, local QT practice
  ├─ ARV inputs             → listing assessed | Enricher | user comps
  └─ computeMaxBid(...)     → only oracle
```

### C1 — Statute cartography flywheel

```
scoreboard: states missing STATUTE_PARAMS or asOf stale
       │
       ▼
cartographer draft → invariant validation
       │
       ▼
proposal markdown (citations, confidence per field)
       │
       ▼
HUMAN REVIEW (required) ──► merge to statute.ts
       │ reject
       ▼
lesson: which field was wrong (ratio, penalty, QT)
```

**Self-improvement:** after each review, store structured diffs (e.g. “IL draft
used statutory 18%; market is 0% median”) into cartographer prompts / checklists
so the next draft asks the right questions. **Never auto-merge.**

County-level max bid requires state params first; then county overrides only
where evidence demands (Cook, NYC-class home rule, etc.).

### C2 — ARV / assessed enrichment flywheel

Without ARV, statute alone cannot price a lot.

```
lots missing assessed
       │
       ▼
Platform enricher (detail page, assessor link, parcel ID)
       │
       ▼
Validate: assessed > 0, not equal to opening bid, ratio-plausible vs state
       │
       ▼
Write assessed_value / lot_valuations with source + asOf
```

**MI is the template:** catalog lacks SEV; detail page has it. Generalize to
“two-pass enrich” for any host where listing cards are thin.

**Assessor graph (later):** parcel number → county assessor API/scrape (policy
checked). Separate agent; same judge.

### C3 — County readiness definition

A county is **max-bid ready** when:

1. `hasStatuteParams(state)`  
2. At least one of:  
   - live lots routinely carry assessed, or  
   - enricher success rate ≥ threshold, or  
   - documented assessor binding  
3. UI always allows comps override  
4. `fips` is passed into `computeMaxBid` (county overrides)

Scoreboard tracks `% counties max-bid ready`, not “we computed a number for
empty counties.”

---

## 7. Loop D — Source Prospector (the real bottleneck)

National live+history both die without URLs.

### What already failed

Hostname guessing: **~9%** resolve; **0%** in smallest half of counties by
population. Do not spend meta-budget there at scale.

### What scales better (priority order)

1. **Atlas / tax-deed-map researched links** (high confidence).  
2. **Platform patterns** (state-known systems).  
3. **Link following** from verified pages (same host and .gov neighbors).  
4. **Post-sale newspaper / legal-ad indexes** where statute requires publication
   (GA pattern) — results and listings often only there.  
5. **Human/task queue** for residual high-pop counties.  
6. Hostname probing only as a **low-budget explore** arm.

### Registry quality bar

Promote a URL only if:

- policy allows  
- signals indicate tax sale content  
- `kind` classified (listing | results | calendar | rules)  
- government preferred when available  
- re-verify on schedule (and when scout fails)

**Self-improvement:** wrong-kind labels (calendar marked as listing) get
corrected when scout extracts 0 lots but calendar text matches — update kind,
don’t invent lots.

---

## 8. Unified cycle implementation sketch

One orchestrator command (new):

```bash
npm run flywheel:coverage -- --cycle
# or: deedpilot-coverage cycle
```

### Pseudocode

```text
function coverage_cycle(budget_usd, max_fetches):
  board = build_scoreboard()                    # DB + registry + statute + corpus
  write(board → data/coverage_scoreboard.json)
  plan = rank_work(board, budget_shares(board)) # work items with class A–E

  results = []
  for item in plan until budget exhausted:
    match item.class:
      A: results += enrich_or_repair(item)
      B: results += prospect_and_scout(item)
      C: results += archive_or_label_stub(item)
      D: results += cartographer_draft(item)    # never auto-merge
      E: results += qa_skeletons_and_policy(item)

  board2 = build_scoreboard()
  delta = board2 - board
  lessons = reflect(results, delta)             # rules + optional LLM
  append lessons.jsonl
  rebalance_budget_shares(delta)
  if val metrics configured: run promotion_gate on model pieces only
  export status for /coverage and /status
  return CycleReport(delta, lessons, blocked_on_humans)
```

### Human queue (always visible)

The cycle must emit a **blocked_on_humans** list:

- Statute PRs awaiting review  
- Label rule stubs awaiting semantics  
- Policy-agreement hosts (RealAuction)  
- High-pop counties with no public list after N strategies  

Gold is not “fully automated nation”; it is **automated everything that is
safe**, with a short, ranked human inbox for the rest.

---

## 9. Scoreboard productization

Extend `/coverage` (and optionally landing metrics) with three gauges:

1. **Live nation** — states/counties with real upcoming lots (lots>0).  
2. **History nation** — states with price-usable rows or explicit expert-only.  
3. **Price nation** — % counties max-bid ready; % upcoming lots auto-priceable.

Kill vanity metrics:

- Auction rows with 0 lots  
- Unlabelled historical row counts  
- “Covered states” that only have calendar shells  

---

## 10. Phased roadmap to gold

### Phase 0 — Make the loop honest (1–2 weeks)

- [ ] Scoreboard artifact + UI  
- [ ] Query filter: upcoming = `lot_count > 0`  
- [ ] Purge or archive skeleton auctions  
- [ ] Wire `fips` into client `computeMaxBid`  
- [ ] Meta-controller skeleton (plan-only mode first)

### Phase 1 — Unlock price on existing volume (2–4 weeks)

- [ ] MI detail-page SEV enricher (largest auto_priceable lift)  
- [ ] TX assessed QA (already strong; monitor drift)  
- [ ] Generic enricher interface: `enrichLot(host) → assessed?`  
- [ ] Target: **auto_priceable / upcoming_lots ≥ 0.5** overall

### Phase 2 — Expand live states with proof, not hope (1–3 months)

- [ ] Per-state pilot: 5 verified **listing** URLs → lots → then scale  
- [ ] FL clerk pilot (10 counties) via generic + registry  
- [ ] GA extract fix until Cobb/Forsyth produce lots when lists exist  
- [ ] Calendar-driven scout at national scale with measured fetch budget  
- [ ] Target: **≥15 states** with real upcoming lots

### Phase 3 — History with labels (parallel, continuous)

- [ ] Results prospecting after each sale window  
- [ ] Label stub generator + human merge workflow  
- [ ] Refit world model only when new price_usable ≥ threshold  
- [ ] Target: price-usable signal in **≥20 states**; expert priors documented elsewhere

### Phase 4 — Statutes to 51 (slow, high rigor)

- [ ] Cartographer queue ordered by live_lots + stranded history  
- [ ] One human review session per state (IL/CA standard)  
- [ ] County overrides only with data evidence  
- [ ] Target: **51 statute entries**, `asOf` ≤ 18 months

### Phase 5 — All-counties max-bid ready (long)

- [ ] Assessor enrichment graph for residual counties  
- [ ] Explicit “no assessed feed — comps required” county flag  
- [ ] Target: **100% counties** either auto-ARV path or declared comps-required  
      with working statute

---

## 11. Mapping onto existing code

| Loop piece | Existing code | New work |
|------------|---------------|----------|
| Scout | `lib/scout`, `scripts/scout.ts`, ingest runner | Budget-aware dispatch from scoreboard |
| Prospector | `lib/prospector`, `scripts/prospect*.ts` | Prefer listing/results; deprioritize DNS guessing |
| Generic adapter | `lib/ingest/adapters/generic.ts` | Host lessons; kind-aware |
| Archivist | `copilot/.../archivist.py`, `labels.py` | Label stub queue; results cron |
| Cartographer | `scripts/cartographer.ts`, `lib/cartographer` | Review checklist from past mistakes |
| Max bid | `lib/deal/maxbid.ts`, `statute.ts` | Completeness only via statutes + ARV |
| Copilot flywheel | `flywheel.py`, `improve.py` | Subordinate to coverage meta-loop |
| Coverage UI | `app/coverage/page.tsx` | Scoreboard gauges |
| Cron | `vercel.json` ingest | Add: scoreboard, enrich, results, prospect |

Do **not** replace the copilot flywheel. It optimizes **bid policy under the
oracle ceiling**. The coverage loop optimizes **whether the oracle can fire
everywhere**. Different objectives; same promotion discipline.

---

## 12. Invariants (constitution of the loop)

1. **LLM extracts; code judges; human ships statutes and label semantics.**  
2. **No walk-away price from a model.**  
3. **No historical import without a label rule.**  
4. **No auction row without accepted lots.**  
5. **No policy bypass** (`politeFetch` / `SOURCE_POLICIES`).  
6. **Government source of record preferred** over auction platforms.  
7. **Volume without provenance is negative value.**  
8. **Test split is sacred** (reporting only).  
9. **Expert priors outrank unlabelled silence.**  
10. **Coverage claims must match the scoreboard vector**, not a single number.

---

## 13. Definition of done (gold)

Gold is reached when all of the following hold:

1. **Live:** Every state either has at least one recurring public-list pipeline
   with judged lots, or is marked `no_public_machine_list` with evidence.  
2. **History:** Every state either has price-usable (or redemption-observed)
   rows under label rules, or an explicit expert-prior-only profile.  
3. **Max bid:** Every county is `maxbid_ready` or `maxbid_comps_required` with
   reviewed state statutes; Cook-class overrides where required.  
4. **Loop:** Nightly coverage cycle runs, rebalances budget, and never
   auto-merges high-stakes artifacts.  
5. **Honesty:** `/coverage` cannot show a green county that has zero lots and
   no assessed path.

Until then, the meta-controller’s job is to **increase the gold score each
week without decreasing trust**.

---

## 14. First cycle to run after implementing the scoreboard

Given current measured state (approx.):

| Fact | Implication for budget |
|------|------------------------|
| ~2.2k MI lots, ~10 with assessed | **Class A:** MI SEV enrich (highest EV) |
| ~580 TX lots auto-priceable | Maintain; don’t over-invest |
| Many 0-lot shells | **Class E:** purge/filter |
| 7 statutes, 44 missing | **Class D:** queue by stranded inventory/history |
| Registry 171 thin counties | **Class B:** listing URLs for FL/GA pilots, not DNS spray |
| 92k hist rows, ~18k price-usable | **Class C:** labels + results, not raw import volume |

That ordering is the self-improving loop working: **it spends on the binding
constraint**, which today is ARV on existing live inventory, not more empty
states on the map.

---

## 15. Implementation status (started 2026-08-01)

| Piece | Status |
|-------|--------|
| Scoreboard `lib/coverage/scoreboard.ts` | **Shipped** → `data/coverage-scoreboard.json` |
| Meta-controller `npm run flywheel:coverage` | **Shipped** (`--plan` / `--cycle` / `--enrich-mi` / `--purge-skeletons`) |
| `/coverage` gold gauges | **Shipped** |
| Auction browse hides skeletons (`lot_count > 0`) | **Shipped** |
| `fips` wired into client max-bid | **Shipped** |
| Skeleton purge | **Done** (60 removed) |
| MI SEV enrich | **~75%+ of inventory auto-priceable**; finish remaining with `enrich:mi` |
| Prospector merge (no wipe on partial state) | **Shipped** + unit test |
| Cron `/api/cron/coverage` | **Shipped** (scoreboard + purge; optional small enrich) |
| GA Fulton/Gwinnett in adapter list | **Added** |
| LLM PDF extract (GA/AZ booklets) | **Blocked** — XAI credits exhausted; `ANTHROPIC_API_KEY` empty |

### Commands

```bash
npm run flywheel:coverage -- --plan
npm run flywheel:coverage -- --cycle --limit 300
npm run enrich:mi -- --limit 500
npm run purge:skeletons
npm run prospect -- --state FL --limit 15 --no-llm   # merges; never use --replace lightly
```
