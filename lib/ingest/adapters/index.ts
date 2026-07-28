import type { SourceAdapter } from "../types";
import { lgbsAdapter } from "./lgbs";
import { taxSaleInfoAdapter } from "./taxsaleinfo";

/** Every registered ingestion source. Order is not significant. */
export const ADAPTERS: SourceAdapter[] = [lgbsAdapter, taxSaleInfoAdapter];

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}

export { lgbsAdapter, taxSaleInfoAdapter };
