import type { SourceAdapter } from "../types";
import { lgbsAdapter } from "./lgbs";
import { taxSaleInfoAdapter } from "./taxsaleinfo";
import { georgiaAdapter } from "./georgia";

/** Every registered ingestion source. Order is not significant. */
export const ADAPTERS: SourceAdapter[] = [lgbsAdapter, taxSaleInfoAdapter, georgiaAdapter];

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}

export { lgbsAdapter, taxSaleInfoAdapter, georgiaAdapter };
