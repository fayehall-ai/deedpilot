"use client";

import { useEffect, useState } from "react";
import { Callout, Card } from "./ui";

interface RiskFlag {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
}

interface Brief {
  headline: string;
  riskFlags: RiskFlag[];
  dueDiligence: string[];
  unknowns: string[];
  narrative: string;
}

const SEVERITY_COLOR: Record<RiskFlag["severity"], string> = {
  critical: "var(--danger)",
  high: "var(--danger)",
  medium: "var(--warn)",
  low: "var(--muted)",
};

/**
 * On-demand AI risk brief.
 *
 * Generation is explicit rather than automatic: briefs cost money and take
 * ~30s, and most people scanning a 200-lot sale want the deterministic numbers
 * first and the narrative only on the handful they're serious about.
 */
export function ParcelBrief({
  lotId,
  countyName,
  initialBrief = null,
  initialModel = null,
}: {
  lotId: string;
  countyName: string;
  /** A brief already stored for these inputs, rendered without a round trip. */
  initialBrief?: Brief | null;
  initialModel?: string | null;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    initialBrief ? "done" : "idle",
  );
  const [brief, setBrief] = useState<Brief | null>(initialBrief);
  const [model, setModel] = useState<string>(initialModel ?? "");
  const [error, setError] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);

  // Generation runs ~35s. A static message for that long reads as a hang, so
  // show the clock actually moving.
  useEffect(() => {
    if (state !== "loading") return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  async function generate() {
    setState("loading");
    setError("");
    try {
      const res = await fetch(`/api/lots/${lotId}/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not generate a brief.");
        setState("error");
        return;
      }
      setBrief(data.brief);
      setModel(data.model ?? "");
      setState("done");
    } catch {
      setError("Network error while generating the brief.");
      setState("error");
    }
  }

  if (state === "idle") {
    return (
      <Card>
        <h3 className="text-sm font-semibold">AI risk brief</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Reads this parcel against {countyName} County&apos;s rules and flags what could go wrong —
          surviving liens, redemption exposure, title cost, and the facts we don&apos;t have. Takes
          about 35 seconds; the result is saved, so opening this lot again is instant.
        </p>
        <button
          onClick={generate}
          className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
        >
          Generate brief
        </button>
      </Card>
    );
  }

  if (state === "loading") {
    return (
      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">AI risk brief</h3>
          <span className="tnum text-xs text-muted">{elapsed}s</span>
        </div>
        <p className="mt-2 animate-pulse text-sm text-muted">
          Reading this parcel against {countyName} County statutes, lien survival, and title risk.
        </p>
        <div className="mt-3 h-1 w-full overflow-hidden rounded bg-surface-2">
          <div
            className="h-full rounded bg-accent transition-all duration-1000 ease-linear"
            // Approaches but never reaches 100% — it's an estimate, not a
            // measurement, and a bar that sits full while still working is worse
            // than one that's honestly still moving.
            style={{ width: `${Math.min(95, (elapsed / 35) * 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          Usually ~35 seconds. Generated once, then saved.
        </p>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Callout tone="warn" title="Brief unavailable">
        {error}
        <div className="mt-2">
          <button onClick={generate} className="text-sm underline">
            Try again
          </button>
        </div>
        <p className="mt-2 text-xs">
          The max-bid analysis above is computed deterministically and is unaffected.
        </p>
      </Callout>
    );
  }

  if (!brief) return null;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">AI risk brief</h3>
          {model ? <span className="font-mono text-xs text-muted">{model}</span> : null}
        </div>
        <p className="mt-2 text-base leading-relaxed">{brief.headline}</p>
      </Card>

      {brief.riskFlags.length > 0 && (
        <Card>
          <h3 className="mb-3 text-sm font-semibold">Risk flags</h3>
          <ul className="space-y-3">
            {brief.riskFlags.map((f) => (
              <li key={f.title} className="border-l-2 pl-3" style={{ borderColor: SEVERITY_COLOR[f.severity] }}>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs font-medium uppercase tracking-wide"
                    style={{ color: SEVERITY_COLOR[f.severity] }}
                  >
                    {f.severity}
                  </span>
                  <span className="text-sm font-medium">{f.title}</span>
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">{f.detail}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {brief.dueDiligence.length > 0 && (
        <Card>
          <h3 className="mb-2 text-sm font-semibold">Before you bid</h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
            {brief.dueDiligence.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </Card>
      )}

      {brief.unknowns.length > 0 && (
        <Callout tone="warn" title="What we don't know">
          <ul className="list-disc space-y-1 pl-4">
            {brief.unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </Callout>
      )}

      <Card>
        <h3 className="mb-2 text-sm font-semibold">Analysis</h3>
        <div className="space-y-3 text-sm leading-relaxed text-muted">
          {brief.narrative.split(/\n\n+/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </Card>
    </div>
  );
}
