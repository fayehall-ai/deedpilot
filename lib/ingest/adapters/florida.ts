/**
 * Florida tax-deed coverage.
 *
 * RealAuction hosts most live bidding and stays policy-blocked. Public parcel
 * lists come from clerk-published PDFs via `florida-clerks` (Brevard first).
 *
 * This module re-exports that adapter under the historic `fl-counties` name so
 * existing cron/docs keep working, and also exports the clerks adapter name.
 */
export { floridaClerksAdapter as floridaAdapter } from "./florida-clerks";
export { floridaClerksAdapter } from "./florida-clerks";
