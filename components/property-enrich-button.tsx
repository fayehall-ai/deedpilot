"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * On-demand property enrichment. Calls POST /api/lots/:id/enrich and reloads
 * the page when assessed value / address land so max-bid can recompute.
 */
export function PropertyEnrichButton({ lotId }: { lotId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(force = false) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/lots/${lotId}/enrich`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = (await res.json()) as {
        updated?: boolean;
        provider?: string | null;
        reason?: string;
        error?: string;
        providers?: string[];
      };
      if (!res.ok) {
        setMsg(data.error ?? `Enrichment failed (${res.status})`);
        return;
      }
      if (data.updated) {
        setMsg(`Enriched via ${data.provider ?? "provider"}`);
        router.refresh();
        return;
      }
      if (!data.providers?.length) {
        setMsg(
          "No property API key configured. Add ATTOM_API_KEY (parcel) or RENTCAST_API_KEY (address) to .env.local",
        );
        return;
      }
      setMsg(data.reason ?? "No property match");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => run(false)}
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium hover:border-accent disabled:opacity-50"
      >
        {busy ? "Looking up property…" : "Fetch property details"}
      </button>
      {msg ? <p className="text-xs leading-relaxed text-muted">{msg}</p> : null}
    </div>
  );
}
