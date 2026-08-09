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
  experimental: {
    /** Next DevTools → "Instant Navs" — freezes a page at its static shell. */
    instantNavigationDevToolsToggle: true,
  },
};

export default nextConfig;
