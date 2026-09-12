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
import { clarkNvAdapter } from "./clark-nv";
import { zeusAdapter } from "./zeus";
import { bid4assetsAdapter } from "./bid4assets";

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
  clarkNvAdapter,
  zeusAdapter,
  bid4assetsAdapter,
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
  goveaseAdapter,
  sriAdapter,
  clarkNvAdapter,
  genericAdapter,
};
