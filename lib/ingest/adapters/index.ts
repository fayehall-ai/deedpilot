import type { SourceAdapter } from "../types";
import { georgiaAdapter } from "./georgia";
import { genericAdapter } from "./generic";
import { lgbsAdapter } from "./lgbs";
import { taxSaleInfoAdapter } from "./taxsaleinfo";
import { floridaAdapter } from "./florida";

/**
 * Order is precedence. Bespoke first, generic last.
 */
export const ADAPTERS: SourceAdapter[] = [
  lgbsAdapter,
  taxSaleInfoAdapter,
  georgiaAdapter,
  floridaAdapter,
  genericAdapter,
];

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}

export { lgbsAdapter, taxSaleInfoAdapter, georgiaAdapter, genericAdapter };
