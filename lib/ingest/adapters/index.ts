import type { SourceAdapter } from "../types";
import { georgiaAdapter } from "./georgia";
import { genericAdapter } from "./generic";
import { lgbsAdapter } from "./lgbs";
import { taxSaleInfoAdapter } from "./taxsaleinfo";
import { floridaAdapter, floridaClerksAdapter } from "./florida";

/**
 * Order is precedence. Bespoke first, generic last.
 */
export const ADAPTERS: SourceAdapter[] = [
  lgbsAdapter,
  taxSaleInfoAdapter,
  georgiaAdapter,
  floridaClerksAdapter,
  genericAdapter,
];

export function getAdapter(name: string): SourceAdapter | undefined {
  // Historic alias: fl-counties → fl-clerks
  if (name === "fl-counties" || name === "florida") return floridaClerksAdapter;
  return ADAPTERS.find((a) => a.name === name);
}

export {
  lgbsAdapter,
  taxSaleInfoAdapter,
  georgiaAdapter,
  floridaAdapter,
  floridaClerksAdapter,
  genericAdapter,
};
