"use client";

import { useMemo, useState } from "react";
import { computeMaxBid, type DealInputs } from "@/lib/deal/maxbid";
import { computeSuggestedBid } from "@/lib/history/suggested-bid";
import type { HistoryBucket } from "@/lib/history/types";
import { money, percent } from "@/lib/format";
import { AssumedTag, Callout } from "./ui";
import type { SaleType } from "@/lib/atlas/types";

/**
 * The max-bid panel.
 *
 * Runs entirely client-side: `computeMaxBid` is pure arithmetic over static
 * statutory data, so dragging the margin slider recomputes instantly with no
 * round trip. The model never sees these inputs — the walk-away number is
 * deterministic by design.
 *
 * History-guided suggested bid is recomputed from the same inputs and is
 * always ≤ maxBid (oracle ceiling).
 */
export function DealCalculator({
  state,
  saleType,
  openingBid,
  assessedValue,
  marketValue,
  fips,
  historyBucket = null,
  historyKey,
  thinListing = false,
}: {
  state: string;
  saleType: SaleType;
  openingBid?: number;
  assessedValue?: number;
  /** Provider market estimate; ranks above assessed ÷ ratio in deriveArv. */
  marketValue?: number;
  fips?: string;
  /** Server-loaded history bucket (no fs on the client). */
  historyBucket?: HistoryBucket | null;
  historyKey?: string;
  /** Listing has no address/assessed — show clearer empty state. */
  thinListing?: boolean;
}) {
  const [arvOverride, setArvOverride] = useState<string>("");
  const [rehab, setRehab] = useState<string>("");
  const [liens, setLiens] = useState<string>("");
  const [margin, setMargin] = useState<number>(30);

  const result = useMemo(() => {
    const inputs: DealInputs = {
      state,
      saleType,
      fips,
      openingBid,
      assessedValue,
      marketValue,
      targetMargin: margin / 100,
    };
    if (arvOverride.trim() !== "") inputs.arvOverride = Number(arvOverride.replace(/[^0-9.]/g, ""));
    if (rehab.trim() !== "") inputs.rehabCost = Number(rehab.replace(/[^0-9.]/g, ""));
    if (liens.trim() !== "") inputs.survivingLiens = Number(liens.replace(/[^0-9.]/g, ""));
    return computeMaxBid(inputs);
  }, [state, saleType, fips, openingBid, assessedValue, marketValue, arvOverride, rehab, liens, margin]);

  const suggestion = useMemo(() => {
    return computeSuggestedBid({
      state,
      saleType,
      openingBid,
      assessedValue,
      fips,
      historyBucket,
      historyKey,
      deal: {
        maxBid: result.maxBid,
        recommendation: result.recommendation,
        bidRoom: result.bidRoom,
        projectedProfit: result.projectedProfit,
      },
    });
  }, [
    state,
    saleType,
    openingBid,
    assessedValue,
    fips,
    historyBucket,
    historyKey,
    result,
  ]);

  const tone =
    result.recommendation === "no-bid"
      ? "var(--danger)"
      : result.recommendation === "insufficient-data"
        ? "var(--muted)"
        : "var(--ok)";

  const suggestTone =
    suggestion.action === "pass"
      ? "var(--danger)"
      : suggestion.action === "insufficient-data"
        ? "var(--muted)"
        : "var(--accent)";

  return (
    <div className="space-y-5">
      {/* --- Headline ---------------------------------------------------- */}
      <div className="rounded-xl border-2 p-5" style={{ borderColor: tone }}>
        <div className="text-xs uppercase tracking-wide text-muted">Your maximum bid</div>
        <div className="tnum mt-1 text-4xl font-semibold" style={{ color: tone }}>
          {result.maxBid === null
            ? thinListing
              ? "Needs ARV"
              : "Not enough data"
            : money(result.maxBid)}
        </div>

        {result.recommendation === "no-bid" ? (
          <p className="mt-2 text-sm font-medium" style={{ color: "var(--danger)" }}>
            Do not bid — the numbers do not clear your margin.
          </p>
        ) : result.maxBid === null ? (
          /*
            Thin sale lists (parcel + opening bid only) are not a bug — the clerk
            never published an assessed value. Max bid needs ARV from comps or
            property enrichment; opening bid is not a substitute for market value.
          */
          <div className="mt-2 space-y-2 text-sm text-muted">
            {thinListing ? (
              <p className="leading-relaxed text-foreground">
                This sale list only published a <strong>parcel number</strong> and{" "}
                <strong>opening bid</strong> — not an assessed value. Enter an after-repair
                (comps) estimate below, open the county appraiser (sidebar), or run{" "}
                <em>Fetch property details</em> if you have an API key.
              </p>
            ) : result.warnings.length ? (
              <ul className="space-y-1">
                {result.warnings.slice(0, 2).map((w) => (
                  <li key={w} className="leading-relaxed">
                    {w}
                  </li>
                ))}
              </ul>
            ) : (
              <p>This listing does not carry enough to compute a walk-away price.</p>
            )}
            {result.arv.value === null ? (
              <p className="font-medium text-foreground">
                Enter an after-repair value below and the ceiling will compute.
              </p>
            ) : null}
          </div>
        ) : result.maxBid !== null ? (
          <p className="mt-2 text-sm text-muted">
            Walk away above this. Projected profit at the ceiling:{" "}
            <span className="tnum font-medium text-foreground">
              {money(result.projectedProfit)}
            </span>{" "}
            ({margin}% of ARV).
          </p>
        ) : null}

        {openingBid !== undefined && result.bidRoom !== null ? (
          <div className="mt-3 flex items-center gap-4 border-t border-border pt-3 text-sm">
            <div>
              <span className="text-muted">Opening bid </span>
              <span className="tnum font-medium">{money(openingBid)}</span>
            </div>
            <div>
              <span className="text-muted">Room to bid </span>
              <span
                className="tnum font-medium"
                style={{ color: result.bidRoom > 0 ? "var(--ok)" : "var(--danger)" }}
              >
                {money(result.bidRoom)}
              </span>
            </div>
          </div>
        ) : null}

        <div className="mt-3 text-xs text-muted">
          Confidence: <span className="capitalize text-foreground">{result.confidence}</span>
          {result.arv.assumed
            ? " — built on an assumed floor from the opening bid, not a valuation of this parcel."
            : result.arv.derived
              ? " — ARV derived from assessed value, not comps."
              : ""}
        </div>
      </div>

      {/* --- History-guided suggestion (always ≤ maxBid) --------------- */}
      <div
        className="rounded-xl border border-border bg-surface p-5"
        style={{ borderColor: suggestTone }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">
              History-guided suggestion
            </div>
            <div className="tnum mt-1 text-3xl font-semibold" style={{ color: suggestTone }}>
              {suggestion.action === "bid" && suggestion.suggestedBid != null
                ? money(suggestion.suggestedBid)
                : suggestion.action === "pass"
                  ? "Pass"
                  : "—"}
            </div>
          </div>
          {suggestion.action === "bid" &&
          suggestion.suggestedBid != null &&
          result.maxBid != null ? (
            <div className="text-right text-xs text-muted">
              <div>
                Under max by{" "}
                <span className="tnum font-medium text-foreground">
                  {money(suggestion.headroomVsMaxBid)}
                </span>
              </div>
              {suggestion.withinOracle ? (
                <div className="mt-0.5 font-medium" style={{ color: "var(--ok)" }}>
                  ≤ oracle maxBid
                </div>
              ) : (
                <div className="mt-0.5 font-medium" style={{ color: "var(--danger)" }}>
                  Oracle violation (should not happen)
                </div>
              )}
            </div>
          ) : null}
        </div>

        <p className="mt-2 text-sm text-muted">
          {suggestion.action === "bid"
            ? "Co-pilot target using recorded auction history. Never above your maximum bid."
            : suggestion.action === "pass"
              ? "History + oracle say stay out or wait — do not chase."
              : "Add assessed value or ARV so the oracle can price a ceiling."}
        </p>

        <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs sm:grid-cols-3">
          <div>
            <div className="text-muted">History sample</div>
            <div className="tnum font-medium">{suggestion.historyN || "—"}</div>
          </div>
          <div>
            <div className="text-muted">Median sold</div>
            <div className="tnum font-medium">{money(suggestion.medianWinningBid)}</div>
          </div>
          <div>
            <div className="text-muted">p(redeem) prior</div>
            <div className="tnum font-medium">
              {suggestion.pRedeem != null ? percent(suggestion.pRedeem, 0) : "—"}
            </div>
          </div>
        </div>

        {suggestion.notes.length > 0 ? (
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted">
            {suggestion.notes.slice(0, 3).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* --- Inputs ------------------------------------------------------ */}
      <div className="rounded-xl border border-border bg-surface p-5">
        <h3 className="mb-4 text-sm font-semibold">Your assumptions</h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="After-repair value (ARV)"
            hint={result.arv.derived ? "Override the derived estimate with real comps" : undefined}
            value={arvOverride}
            onChange={setArvOverride}
            placeholder={result.arv.value ? String(Math.round(result.arv.value)) : "e.g. 180000"}
          />
          <Field
            label="Rehab budget"
            hint="You cannot inspect before bidding — budget for the worst plausible condition"
            value={rehab}
            onChange={setRehab}
            placeholder="e.g. 45000"
          />
          <Field
            label="Known surviving liens"
            hint="Municipal code enforcement, special assessments, federal tax liens"
            value={liens}
            onChange={setLiens}
            placeholder="e.g. 8000"
          />
          <div>
            <label className="block text-xs font-medium text-muted" htmlFor="margin">
              Target margin — {margin}%
            </label>
            <input
              id="margin"
              type="range"
              min={10}
              max={60}
              step={5}
              value={margin}
              onChange={(e) => setMargin(Number(e.target.value))}
              className="mt-3 w-full accent-[var(--accent)]"
            />
            <div className="mt-1 text-xs text-muted">
              Required profit as a share of ARV. 30% is a common floor for tax-sale flips.
            </div>
          </div>
        </div>
      </div>

      {/* --- Cost breakdown ---------------------------------------------- */}
      {result.costs.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-5">
          <h3 className="mb-1 text-sm font-semibold">How that number is built</h3>
          <p className="mb-4 text-xs text-muted">{result.arv.basis}</p>

          <dl className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
              {/*
                Renamed, not just annotated, when the figure is a floor. "After-repair
                value" is a claim about this parcel; the floor is a quartile of a
                state-wide ratio and calling it an ARV would be the page asserting
                something nobody measured.
              */}
              <dt className="font-medium">
                {result.arv.assumed ? "Assumed floor (not an ARV)" : "After-repair value"}
              </dt>
              <dd className="tnum font-medium">
                {money(result.arv.value)}
                {result.arv.assumed ? (
                  <span className="ml-1.5 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn">
                    assumed
                  </span>
                ) : null}
              </dd>
            </div>
            {result.costs.map((c) => (
              <div key={c.label} className="flex items-baseline justify-between gap-4">
                <dt className="text-muted">
                  {c.label}
                  {c.assumed ? <AssumedTag /> : null}
                  <div className="mt-0.5 max-w-md text-xs leading-snug text-muted/80">{c.note}</div>
                </dt>
                <dd className="tnum shrink-0 text-muted">−{money(c.amount)}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
              <dt className="text-muted">Target profit ({margin}% of ARV)</dt>
              <dd className="tnum text-muted">−{money(result.projectedProfit)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t-2 border-border pt-2 font-semibold">
              <dt>Maximum bid</dt>
              <dd className="tnum">{money(result.maxBid)}</dd>
            </div>
          </dl>
        </div>
      )}

      {/* --- Redemption --------------------------------------------------- */}
      {result.redemption ? (
        <div className="rounded-xl border border-border bg-surface p-5">
          <h3 className="mb-3 text-sm font-semibold">If the owner redeems</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Flat penalty</div>
              <div className="tnum mt-1 text-xl font-semibold">
                {percent(result.redemption.flatPenalty)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">You&apos;d receive</div>
              <div className="tnum mt-1 text-xl font-semibold">
                {money(result.redemption.penaltyAtMaxBid)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Window</div>
              <div className="tnum mt-1 text-xl font-semibold">
                {result.redemption.windowDays} days
              </div>
            </div>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted">{result.redemption.note}</p>
          {result.redemption.extendedFor ? (
            <p className="mt-2 text-xs text-muted">{result.redemption.extendedFor}</p>
          ) : null}
          <p className="mt-3 text-xs text-muted">
            Quoted elsewhere as{" "}
            <span className="tnum">{percent(result.redemption.annualisedBestCase)} annualised</span>{" "}
            — true only if they redeem on the last possible day and you immediately redeploy the
            capital. Treat the flat penalty as the real number.
          </p>
        </div>
      ) : null}

      {/* --- Warnings ----------------------------------------------------- */}
      {result.warnings.length > 0 && (
        <Callout tone="warn" title="Before you bid">
          <ul className="list-disc space-y-1.5 pl-4">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div>
      <label className="block text-xs font-medium text-muted" htmlFor={id}>
        {label}
      </label>
      <div className="relative mt-1">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          $
        </span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="tnum w-full rounded-lg border border-border bg-background py-2 pl-7 pr-3 text-sm outline-none focus:border-accent"
        />
      </div>
      {hint ? <p className="mt-1 text-xs leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}
