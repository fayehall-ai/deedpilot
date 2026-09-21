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
  /*
   * `@napi-rs/canvas` is what pdf.js polyfills DOMMatrix from on Node. Loaded by
   * a computed require, it was left out of every function bundle, and every PDF
   * the crawler fetched on Vercel failed with "DOMMatrix is not defined" — a
   * county whose parcel list is a PDF read as a county with no parcels. External
   * here, and its native binary traced into the routes that crawl, below.
   */
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
  /**
   * Data the server reads at runtime by path, which tracing cannot infer.
   *
   * `lib/ingest/adapters/generic.ts` reads `data/source-registry.json` — 1,583
   * county bindings, the Prospector's whole output — with `readFileSync` on a
   * string path. Nothing imports it, so Next's file tracing has no way to know
   * it is needed and does not include it in the function bundle. The read then
   * fails inside a `catch` that returns null, `discoverCounties` returns an
   * empty list, and every crawl job completes in twelve milliseconds reporting
   * `counties: 0` and no error.
   *
   * That is what 869 "successful" crawl jobs did on the first afternoon the
   * dispatcher ran: drained a queue perfectly and fetched nothing. Locally the
   * same adapter binds 774 counties, which is why it had never shown up.
   */
  outputFileTracingIncludes: {
    "/api/cron/**": ["./data/source-registry.json", "./data/*.json", "./node_modules/@napi-rs/canvas*/**/*"],
    "/admin/**": ["./data/source-registry.json", "./node_modules/@napi-rs/canvas*/**/*"],
    /* Read at request time by `lib/statutory/page.ts`. */
    "/statutory": ["./templates/statutory-ground.html"],
    /*
     * The render worker's runtime files, all read by path and so invisible to
     * tracing — the same trap as the registry above, and it would fail the
     * same quiet way: no ffmpeg means no video, no font means slides with no
     * words on them, no logo means the wordmark instead of the brand.
     *
     *  - ffmpeg: `ffmpeg-static` downloads the build machine's binary on
     *    install; `lib/cape/ffmpeg.ts` resolves it from the working directory.
     *    One binary, ~75 MB on linux-x64 — there is deliberately no ffprobe
     *    (see that file) to stay well inside the 250 MB function limit.
     *  - sharp's native binding and libvips are loaded through a computed
     *    `require`; listed so the rasteriser cannot be left behind. The globs
     *    match nothing on a Mac and the linux packages on Vercel's builders.
     *  - The slide fonts and the brand logo.
     */
    "/api/cron/render": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/@img/sharp-linux-x64/**/*",
      "./node_modules/@img/sharp-libvips-linux-x64/**/*",
      "./lib/cape/fonts/*.ttf",
      "./public/brand/tdc-logo.png",
    ],
  },

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

    /**
     * The sale-calendar import posts a whole CSV through a Server Action.
     *
     * Action bodies are capped at 1 MB by default, and eight weeks of national
     * sale dates is already over half of that — a year would be rejected by the
     * framework before `uploadAuctionCsv` ever ran, and the failure surfaces as
     * a generic action error rather than anything naming the size. 8 MB matches
     * the cap the action enforces itself; the two have to move together.
     */
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
