import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Cache Components. Required by the `unstable_instant` export the
   * DB-backed routes use to guarantee instant client navigation.
   *
   * Under this flag every page is dynamic by default, so `force-dynamic` is
   * gone from all seven routes that carried it. What replaces it is more
   * precise: the part of a page that does not depend on the database renders
   * as a static shell and ships on prefetch, and each Postgres read sits
   * behind its own <Suspense> boundary and streams in. A click paints the
   * page immediately instead of waiting on a query.
   */
  cacheComponents: true,
  /**
   * `pdf-parse` must be required from `node_modules`, not bundled.
   *
   * Its ESM entry imports the PDF.js worker as a *sibling file*:
   *
   *     node_modules/pdf-parse/dist/pdf-parse/esm/index.js
   *     node_modules/pdf-parse/dist/pdf-parse/esm/pdf.worker.mjs   ← beside it
   *
   * Bundling rewrites the entry into `.next/server/chunks/` and does not carry
   * the worker across, because nothing statically references it — the import is
   * resolved relative to the module at runtime. The build succeeds and the
   * package is silently broken:
   *
   *     Cannot find module '.next/server/chunks/pdf.worker.mjs'
   *     imported from '.next/server/chunks/node_modules_pdf-parse_…_index.js'
   *
   * This only bites the built server, never `next dev` and never `tsx`, which is
   * why every terminal-driven ingest run passed while a dispatched `tx-mvba` job
   * came back partial. Adapters that read statutory notices as PDFs — `nm-ptd`,
   * `tx-mvba`, `mo-notice` — are the ones that lose data to it, and they lose it
   * as a *partial* result rather than a failure, which is the worse outcome: a
   * county reports "ok — 1 auction, 0 lots" and looks like a county with no
   * sales.
   */
  serverExternalPackages: ["pdf-parse"],

  /**
   * `/admin` must never be stored by a shared cache.
   *
   * `await connection()` in the gate is the real fix — it stops the route being
   * prerendered with the anonymous branch baked in. This is the second lock,
   * because the failure mode is bad in both directions and only one of them was
   * observed.
   *
   * Observed: an operator with a valid cookie received a ten-minute-old cached
   * copy of the *sign-in form* and the console never loaded, because the route
   * advertised `vary: rsc, next-router-state-tree, …` with no `Cookie`, so one
   * copy was served to everyone.
   *
   * Not observed, and worse: the same missing `Vary` means an *authenticated*
   * render could be cached and handed to anonymous visitors — every source, run,
   * access decision and CAPE stage on a page whose own header says "not public".
   * `private` bars shared caches from storing it at all; `no-store` bars the
   * browser too, which is right for a console whose whole value is being current.
   */
  async headers() {
    return [
      {
        source: "/admin/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
          { key: "Vary", value: "Cookie" },
        ],
      },
      {
        source: "/admin",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
          { key: "Vary", value: "Cookie" },
        ],
      },
    ];
  },

  experimental: {
    /** Next DevTools → "Instant Navs" — freezes a page at its static shell. */
    instantNavigationDevToolsToggle: true,
  },
};

export default nextConfig;
