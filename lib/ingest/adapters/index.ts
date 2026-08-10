import type { SourceAdapter } from "../types";
import { arkansasCoslAdapter } from "./arkansas";
import { georgiaAdapter } from "./georgia";
import { genericAdapter } from "./generic";
import { goveaseAdapter } from "./govease";
import { lgbsAdapter } from "./lgbs";
import { missouriCollectorAdapter } from "./missouri";
import { mvbaAdapter } from "./mvba";
import { newMexicoPtdAdapter } from "./new-mexico";
import { sriAdapter } from "./sri";
import { taxSaleInfoAdapter } from "./taxsaleinfo";
import { floridaAdapter, floridaClerksAdapter } from "./florida";

/**
 * Order is precedence. Bespoke first, generic last.
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
  goveaseAdapter,
  sriAdapter,
  genericAdapter,
];

export function getAdapter(name: string): SourceAdapter | undefined {
  // Historic alias: fl-counties → fl-clerks
  if (name === "fl-counties" || name === "florida") return floridaClerksAdapter;
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
  goveaseAdapter,
  sriAdapter,
  genericAdapter,
};
