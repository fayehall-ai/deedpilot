import { num, percent } from "@/lib/format";
import type { CoverageBlock, StatusRule } from "@/lib/status";

/**
 * What a source's price column actually is, as colour.
 *
 * The distinction this encodes is the whole point of the page: 70,109 Cook
 * County rows are a real number measuring the delinquent tax owed, not what an
 * auction cleared at. Colouring them the same as Michigan's clearing prices
 * would restate the error the corpus was built to stop.
 */
function kindColor(kind: string): { color: string; label: string } {
  if (kind === "clearing_price")
    return { color: "var(--accent)", label: "Comparable clearing price" };
  if (kind === "unknown") return { color: "var(--muted)", label: "Quarantined" };
  return { color: "var(--warn)", label: "A real number measuring something else" };
}

export function CorpusBars({ rules, total }: { rules: StatusRule[]; total: number }) {
  const max = Math.max(...rules.map((r) => r.n), 1);
  return (
    <div>
      {rules.map((r) => {
        const { color } = kindColor(r.price_kind);
        return (
          <div
            key={r.rule}
            className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-4 border-t border-border py-2.5 first:border-t-0"
          >
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{r.rule}</div>
              <div className="text-xs text-muted">
                {percent(r.n / total, 0)} of rows
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="flex h-6 items-center rounded px-2"
                style={{ width: `${Math.max(2, (r.n / max) * 100)}%`, background: color }}
              >
                <span className="tnum whitespace-nowrap text-xs font-semibold text-white">
                  {num(r.n)}
                </span>
              </div>
              {r.price_usable > 0 ? (
                <span className="tnum whitespace-nowrap text-xs text-muted">
                  {num(r.price_usable)} usable
                </span>
              ) : (
                <span className="whitespace-nowrap text-xs text-muted">no price signal</span>
              )}
            </div>
          </div>
        );
      })}
      <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3">
        {["clearing_price", "tax_amount_bid_down", "unknown"].map((k) => {
          const { color, label } = kindColor(k);
          return (
            <span key={k} className="flex items-center gap-2 text-xs text-muted">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Predicted quantile against observed coverage, with the perfect-calibration
 * diagonal as the reference.
 *
 * A p90 that only covers 60% of outcomes would make the bid search overbid
 * systematically, so this is the chart that says whether the model can be
 * trusted to size a bid at all.
 */
export function CalibrationChart({ val, test }: { val: CoverageBlock; test: CoverageBlock }) {
  const W = 640;
  const H = 300;
  const L = 52;
  const R = 16;
  const T = 16;
  const B = 40;
  const pw = W - L - R;
  const ph = H - T - B;

  const levels = Object.keys(val.target_coverage).map((k) => Number(k.replace("p", "")) / 100);
  const x = (q: number) => L + q * pw;
  const y = (c: number) => T + (1 - c) * ph;
  const pts = (block: CoverageBlock) =>
    Object.values(block.coverage)
      .map((c, i) => `${x(levels[i]).toFixed(1)},${y(c).toFixed(1)}`)
      .join(" ");

  const series = [
    { name: "Validation", block: val, color: "var(--accent)" },
    { name: "Test", block: test, color: "var(--warn)" },
  ];

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full min-w-[420px]"
          role="img"
          aria-label="Predicted quantile versus observed coverage on the validation and test splits, against a perfect-calibration diagonal. Both series track the diagonal closely and sit slightly below it."
        >
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <line
              key={g}
              x1={L}
              y1={y(g)}
              x2={W - R}
              y2={y(g)}
              stroke="var(--border)"
              strokeWidth="1"
            />
          ))}
          <line x1={L} y1={T} x2={L} y2={H - B} stroke="var(--border)" strokeWidth="1" />

          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <text
              key={g}
              x={L - 8}
              y={y(g) + 4}
              textAnchor="end"
              className="tnum"
              fontSize="10"
              fill="var(--muted)"
            >
              {Math.round(g * 100)}%
            </text>
          ))}
          {levels.map((q) => (
            <text
              key={q}
              x={x(q)}
              y={H - B + 18}
              textAnchor="middle"
              className="tnum"
              fontSize="10"
              fill="var(--muted)"
            >
              p{Math.round(q * 100)}
            </text>
          ))}

          <line
            x1={x(0)}
            y1={y(0)}
            x2={x(1)}
            y2={y(1)}
            stroke="var(--muted)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            opacity="0.7"
          />
          <text x={W - R - 6} y={T + 54} textAnchor="end" fontSize="10" fill="var(--muted)">
            perfect calibration
          </text>

          {series.map((s) => (
            <polyline
              key={s.name}
              points={pts(s.block)}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
            />
          ))}
          {series.map((s) =>
            Object.values(s.block.coverage).map((c, i) => (
              <circle
                key={`${s.name}-${i}`}
                cx={x(levels[i])}
                cy={y(c)}
                r="4.5"
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth="2"
              />
            )),
          )}
        </svg>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-2 text-xs text-muted">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.name} · n={num(s.block.n)} · mean abs error{" "}
            {percent(s.block.mean_abs_coverage_error, 1)}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function PolicyBars({ rows }: { rows: Record<string, import("@/lib/status").PolicyRow> }) {
  const entries = Object.entries(rows).filter(([, r]) => r.nBid > 0);
  const max = Math.max(...entries.map(([, r]) => r.totalSurplus), 1);
  return (
    <div>
      {entries
        .sort((a, b) => b[1].totalSurplus - a[1].totalSurplus)
        .map(([name, r]) => {
          const isSearch = name === "search";
          const isShipped = name === "fixed_fraction_0.90";
          return (
            <div
              key={name}
              className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-4 border-t border-border py-2.5 first:border-t-0"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs">{name}</div>
                <div className="text-xs text-muted">
                  {isSearch ? "current" : isShipped ? "previously shipping" : "baseline"}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div
                  className="h-5 rounded"
                  style={{
                    width: `${Math.max(1, (r.totalSurplus / max) * 62)}%`,
                    background: isSearch
                      ? "var(--accent)"
                      : isShipped
                        ? "var(--warn)"
                        : "var(--muted)",
                  }}
                />
                <span className="tnum whitespace-nowrap text-xs text-muted">
                  ${(r.totalSurplus / 1e6).toFixed(2)}M · win {percent(r.winRate, 0)} · overpay $
                  {num(Math.round(r.meanOverpay))}
                  {r.oracleViolations > 0 ? (
                    <span style={{ color: "var(--danger)" }}>
                      {" "}
                      · {r.oracleViolations} oracle violations
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
    </div>
  );
}
