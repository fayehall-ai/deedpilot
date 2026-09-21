import { Suspense } from "react";
import { connection } from "next/server";
import type { Metadata } from "next";
import { desc, inArray } from "drizzle-orm";
import { Breadcrumbs, Card } from "@/components/ui";
import { AdminGate } from "@/components/admin-gate";
import { DetailSkeleton } from "@/components/skeleton";
import { isAdmin } from "@/lib/admin/auth";
import { db } from "@/lib/db";
import { capeProductions, capeReviews } from "@/lib/db/schema";
import { capePackageInputs } from "@/lib/cape/inputs";
import { capeInputsHash } from "@/lib/cape/components";
import { deliverableInputs, selectVideoCandidates } from "@/lib/admin/video-jobs";
import { DEFAULT_CONFIG, getPipelineConfig } from "@/lib/admin/pipeline-settings";
import { saveCapeReview } from "./actions";

export const metadata: Metadata = {
  title: "CAPE — script review",
  robots: { index: false, follow: false },
};

/**
 * The briefings going out this week and next, to read before or after they
 * are voiced.
 *
 * Only the sales that get a video — the largest in each weekly batch — because
 * those are the scripts anyone will hear. "Needs a change" with a note is the
 * redo: the note is handed to the narrator as a confirmed correction, the
 * script is rewritten on the next CAPE pass, and the video is re-rendered and
 * replaced in Drive under the same name.
 */
export default function ReviewPage(props: PageProps<"/cape/review">) {
  return (
    <div className="shell py-band">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { href: "/cape", label: "CAPE" }, { label: "Review" }]} />
      <header className="mb-8 max-w-3xl">
        <h1 className="text-section">Script review</h1>
        <p className="mt-3 text-lg leading-relaxed text-muted">
          The briefings for this week&rsquo;s and next week&rsquo;s largest sales. Mark one &ldquo;Needs a
          change&rdquo; and say what is wrong: the script is rewritten with your note within the hour and its
          video re-rendered and replaced in Drive.
        </p>
      </header>
      <Suspense fallback={<DetailSkeleton />}>
        <Gate searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function Gate({ searchParams }: { searchParams: PageProps<"/cape/review">["searchParams"] }) {
  await connection();
  const { e } = await searchParams;
  if (!(await isAdmin())) return <AdminGate next="/cape/review" failed={e === "1"} />;
  return <List />;
}

type Script = { title: string; keyTakeaway?: string; sections: { heading: string; narration: string }[] };

async function List() {
  const today = new Date().toISOString().slice(0, 10);
  const { videoTopN } = await getPipelineConfig();
  /*
   * With delivery paused the scripts are still written, and still worth reading
   * before anything is voiced — so the list falls back to the default batch size
   * rather than going empty.
   */
  const paused = videoTopN === 0;
  const inputs = await deliverableInputs(await capePackageInputs({ today }));
  const candidates = selectVideoCandidates(inputs, { topN: paused ? DEFAULT_CONFIG.videoTopN : videoTopN, today });
  const ids = candidates.map((c) => c.input.auctionId);
  if (ids.length === 0) return <p className="text-muted">No briefings are due in the next two weeks.</p>;

  const [productions, reviews] = await Promise.all([
    db.select().from(capeProductions).where(inArray(capeProductions.auctionId, ids)),
    db.select().from(capeReviews).where(inArray(capeReviews.auctionId, ids)).orderBy(desc(capeReviews.createdAt)),
  ]);
  const productionOf = new Map(productions.map((p) => [p.auctionId, p]));
  const reviewsOf = new Map<string, typeof reviews>();
  for (const r of reviews) reviewsOf.set(r.auctionId, [...(reviewsOf.get(r.auctionId) ?? []), r]);

  return (
    <div className="space-y-4">
      {paused ? (
        <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
          Scripts only: videos and frameworks are paused (&ldquo;Sales delivered per weekly batch&rdquo; is 0 on
          the console). A change note still rewrites the script; nothing is voiced or sent to Drive.
        </p>
      ) : null}
      {candidates.map((c, i) => {
        const p = productionOf.get(c.input.auctionId);
        const script = p?.script as Script | null | undefined;
        const current = p?.inputsHash === capeInputsHash(c.input);
        const past = reviewsOf.get(c.input.auctionId) ?? [];
        const header =
          i === 0 || candidates[i - 1].batch !== c.batch ? (
            <h2 key={`h-${c.batch}`} className="pt-4 text-sm font-semibold uppercase tracking-wide text-faint">
              Week of {c.batch}
            </h2>
          ) : null;
        return (
          <div key={c.input.auctionId} className="space-y-4">
            {header}
            <Card>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold">
                  {c.input.countyName} County, {c.input.state} — {c.input.saleDate}
                </h3>
                <span className="text-sm text-muted">
                  {c.parcels.toLocaleString()} parcels ·{" "}
                  {!script ? "script not written yet" : current ? "script current" : "rewrite pending"}
                  {p?.videoUrl ? (
                    <>
                      {" · "}
                      <a href={p.videoUrl} target="_blank" rel="noreferrer" className="underline">
                        video
                      </a>
                    </>
                  ) : null}
                </span>
              </div>

              {script ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium">{script.title}</summary>
                  <div className="mt-3 space-y-3">
                    {script.sections.map((s, n) => (
                      <div key={n}>
                        <div className="text-xs font-semibold uppercase tracking-wide text-faint">{s.heading}</div>
                        <p className="text-sm leading-relaxed">{s.narration}</p>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              {past.length ? (
                <ul className="mt-3 space-y-1 text-xs text-muted">
                  {past.slice(0, 4).map((r) => (
                    <li key={r.id}>
                      {r.verdict === "needs-change" ? "Needs a change" : "Reads correctly"} — {r.reviewer},{" "}
                      {r.createdAt.toISOString().slice(0, 10)}
                      {r.note ? `: ${r.note}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}

              {script ? (
                <form action={saveCapeReview} className="mt-3 space-y-2">
                  <input type="hidden" name="auctionId" value={c.input.auctionId} />
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="verdict" value="reads-correctly" defaultChecked /> Reads correctly
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="verdict" value="needs-change" /> Needs a change
                    </label>
                  </div>
                  <textarea
                    name="note"
                    rows={2}
                    placeholder="What should it say instead? Required for a change — it is handed to the narrator as a correction."
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  />
                  <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-accent">
                    Save verdict
                  </button>
                </form>
              ) : null}
            </Card>
          </div>
        );
      })}
    </div>
  );
}
