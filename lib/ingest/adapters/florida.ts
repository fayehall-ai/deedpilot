/**
 * Florida placeholder adapter.
 *
 * RealAuction hosts most of Florida's tax deed sales and publishes
 * `User-agent: * / Disallow: /`, so it stays policy-blocked. Real Florida
 * coverage comes through `generic-county` once the Prospector finds the county
 * clerks, who are the legal publishers of these lists.
 *
 * This exists so Florida is a named, empty adapter rather than an unexplained
 * absence — the same reason blocked counties appear on /coverage instead of
 * silently missing. It returns nothing, and that is the honest answer today.
 */
import type { CountyBinding, DiscoveredAuction, DiscoveredLot, SourceAdapter } from "../types";

export const floridaAdapter: SourceAdapter = {
  name: "fl-counties",
  platform: "county_site",
  description:
    "Florida placeholder — RealAuction is policy-blocked; coverage arrives via generic-county once clerk sources are verified.",

  async discoverCounties(): Promise<CountyBinding[]> {
    return [];
  },

  async listAuctions(): Promise<DiscoveredAuction[]> {
    return [];
  },

  async listLots(): Promise<DiscoveredLot[]> {
    return [];
  },
};
