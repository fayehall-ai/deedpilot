/**
 * Florida workaround adapter (stub).
 *
 * RealAuction is policy-blocked. This is a minimal placeholder so it doesn't
 * break the scout/ingest pipeline. Real FL coverage should come through
 * generic-county once prospector populates good direct county sources.
 */
import type { CountyBinding, SourceAdapter } from "../types";

export const floridaAdapter: SourceAdapter = {
  name: "fl-counties",
  platform: "county_site",
  description: "Placeholder for Florida direct sources (RealAuction avoided).",

  async discover() {
    return [] as any;
  },

  async discoverCounties() {
    return [] as any;
  },

  async listAuctions() {
    return [] as any;
  },

  async listLots() {
    return [] as any;
  },
};
