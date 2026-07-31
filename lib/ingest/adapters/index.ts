import type { SourceAdapter } from "../types";
import { georgiaAdapter } from "./georgia";
import { genericAdapter } from "./generic";
import { lgbsAdapter } from "./lgbs";
import { taxSaleInfoAdapter } from "./taxsaleinfo";

/**
 * Order is precedence. `buildAdapterIndex` gives the first adapter to claim a
 * county the binding, so bespoke parsers come first and the registry-driven
 * generic one picks up everything they do not cover.
 */
export const ADAPTERS: SourceAdapter[] = [
  lgbsAdapter,
  taxSaleInfoAdapter,
  georgiaAdapter,
  genericAdapter,
];

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}

export { lgbsAdapter, taxSaleInfoAdapter, georgiaAdapter, genericAdapter };
