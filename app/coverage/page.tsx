import { Suspense } from "react";
import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/ui";
import { StatsSkeleton } from "@/components/skeleton";
import { CoverageReport } from "@/components/coverage-report";

export const metadata: Metadata = {
  title: "Coverage and data health",
  description:
    "Which counties DeedPilot ingests, where the data comes from, what is blocked, and when each source last ran cleanly.",
};

/**
 * The honesty route. Renders the full report, including the per-county ingest
 * log the home page's compact section leaves out.
 */
export default function CoveragePage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Breadcrumbs items={[{ href: "/", label: "Home" }, { label: "Coverage" }]} />
      <Suspense fallback={<StatsSkeleton />}>
        <CoverageReport />
      </Suspense>
    </div>
  );
}
