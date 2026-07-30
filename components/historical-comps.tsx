import { money, num } from "@/lib/format";
import { Card } from "@/components/ui";
import { getComparables, type HistoryComp } from "@/lib/history/comparables";

export function HistoricalComps({
  state,
  saleType,
  assessedValue,
  openingBid,
  fips,
}: {
  state: string;
  saleType: string;
  assessedValue?: number;
  openingBid?: number;
  fips?: string;
}) {
  const result = getComparables({
    state,
    saleType,
    assessedValue,
    openingBid,
    fips,
    limit: 8,
  });

  const b = result.bucket;

  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold">Historical comps</h3>
      <p className="mb-3 text-xs leading-relaxed text-muted">{result.note}</p>

      {b ? (
        <dl className="mb-3 grid grid-cols-2 gap-2 text-xs">
          <Stat label="Sample size" value={num(b.n)} />
          <Stat
            label="p(redeem) prior"
            value={b.pRedeem != null ? `${(b.pRedeem * 100).toFixed(0)}%` : "—"}
          />
          <Stat label="Median sold" value={money(b.medianWinningBid)} />
          <Stat
            label="Med bid/assessed"
            value={
              b.medianBidToAssessed != null
                ? `${(b.medianBidToAssessed * 100).toFixed(1)}%`
                : "—"
            }
          />
        </dl>
      ) : null}

      {result.comps.length === 0 ? (
        <p className="text-xs text-muted">
          No recorded comps yet for this state/sale type. Run{" "}
          <code className="text-[11px]">deedpilot-copilot import-history --deep</code>{" "}
          and{" "}
          <code className="text-[11px]">build-history-index</code>.
        </p>
      ) : (
        <ul className="divide-y divide-border text-xs">
          {result.comps.map((c) => (
            <CompRow key={c.id} c={c} />
          ))}
        </ul>
      )}

      {result.builtAt ? (
        <p className="mt-3 text-[10px] text-muted">
          Index {result.builtAt.slice(0, 10)} · {num(result.nOutcomesTotal)} total recorded
          outcomes
        </p>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="tnum font-medium">{value}</dd>
    </div>
  );
}

function CompRow({ c }: { c: HistoryComp }) {
  return (
    <li className="flex items-baseline justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {c.county ?? c.state}
          {c.saleDate ? (
            <span className="ml-1 font-normal text-muted">{c.saleDate}</span>
          ) : null}
        </div>
        <div className="truncate text-muted">
          {c.ownershipTaken ? "Owned" : c.redeemed ? "Redeemed" : "Recorded"}
          {c.bidToAssessed != null
            ? ` · ${(c.bidToAssessed * 100).toFixed(1)}% of assessed`
            : ""}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="tnum font-semibold">{money(c.winningBid)}</div>
        {c.assessedValue != null ? (
          <div className="tnum text-muted">AV {money(c.assessedValue)}</div>
        ) : null}
      </div>
    </li>
  );
}
