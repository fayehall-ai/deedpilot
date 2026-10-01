import type { SourceAdapter } from "../types";
import { arkansasCoslAdapter } from "./arkansas";
import { georgiaAdapter } from "./georgia";
import { genericAdapter } from "./generic";
import { lgbsAdapter } from "./lgbs";
import { missouriCollectorAdapter } from "./missouri";
import { mvbaAdapter } from "./mvba";
import { newMexicoPtdAdapter } from "./new-mexico";
import { taxSaleInfoAdapter } from "./taxsaleinfo";
import { floridaAdapter, floridaClerksAdapter } from "./florida";
import { clarkNvAdapter } from "./clark-nv";
import { zeusAdapter } from "./zeus";

/**
 * Order is precedence. Bespoke first, generic last.
 *
 * Only adapters that fetch for themselves. The hand-capture adapters —
 * RealAuction, Bid4Assets, GovEase, SRI and New Jersey's municipal sales, all
 * read from pages saved in a browser because those sites refuse crawlers —
 * were removed on 2026-10-01 at the operator's request.
 */
export const ADAPTERS: SourceAdapter[] = [
  lgbsAdapter,
  mvbaAdapter,
  taxSaleInfoAdapter,
  georgiaAdapter,
  floridaClerksAdapter,
  arkansasCoslAdapter,
  newMexicoPtdAdapter,
  missouriCollectorAdapter,
  clarkNvAdapter,
  zeusAdapter,
  genericAdapter,
];

export function getAdapter(name: string): SourceAdapter | undefined {
  // Historic alias: fl-counties → fl-clerks
  if (name === "fl-counties" || name === "florida") return floridaClerksAdapter;
  if (name === "clark" || name === "clark-nv" || name === "32003") return clarkNvAdapter;
  return ADAPTERS.find((a) => a.name === name);
}

export {
  lgbsAdapter,
  mvbaAdapter,
  taxSaleInfoAdapter,
  georgiaAdapter,
  floridaAdapter,
  floridaClerksAdapter,
  arkansasCoslAdapter,
  newMexicoPtdAdapter,
  missouriCollectorAdapter,
  clarkNvAdapter,
  zeusAdapter,
  genericAdapter,
};
