import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The copilot's status snapshot, exported from Python.
 *
 * Evaluation lives in Python and this site runs on Vercel, where there is no
 * Python runtime. Rather than host a service for numbers that change when a
 * model is refitted — a few times a week at most — the copilot writes one
 * committed JSON artifact and this reads it. `deedpilot-copilot export-status`
 * regenerates it.
 */

export interface StatusRule {
  rule: string;
  n: number;
  price_usable: number;
  redemption_observed: number;
  quarantined: number;
  price_kind: string;
  disposition: string;
  reason: string;
}

export interface StatusBucket {
  key: string;
  state: string | null;
  saleType: string | null;
  n: number;
  nObserved: number;
  pRedeem: number;
  expertPRedeem: number;
  source: "observed" | "expert";
}

export interface CoverageBlock {
  n: number;
  coverage: Record<string, number>;
  target_coverage: Record<string, number>;
  mean_abs_coverage_error: number;
  mean_pinball_loss: number;
  pinball_improvement_vs_global: number | null;
  county_group_hit_rate: number;
}

export interface PolicyRow {
  nBid: number;
  nWon: number;
  winRate: number;
  meanBid: number;
  meanOverpay: number;
  totalSurplus: number;
  cvar10: number;
  oracleViolations: number;
}

export interface CopilotStatus {
  generatedAt: string;
  corpus: {
    nRows: number;
    nPriceUsable: number;
    nRedemptionObserved: number;
    sharePriceUsable: number;
    byRule: StatusRule[];
    note: string;
  };
  priors: { buckets: StatusBucket[]; unobservedFields: string[]; nQuarantined: number };
  splits: {
    policy: { cutVal: string; cutTest: string };
    counts: Record<string, number>;
    clearingPrice: Record<string, number>;
  };
  worldModel:
    | { fitted: false }
    | {
        fitted: true;
        nTrain: number;
        nCounties: number;
        states: string[];
        yearSlope: number;
        levels: number[];
        val: CoverageBlock;
        test: CoverageBlock;
      };
  policies: Record<"val" | "test", Record<string, PolicyRow>>;
}

/**
 * Read the snapshot, or null when it has never been exported.
 *
 * Returning null rather than throwing lets the page say "not exported yet" and
 * name the command, which is more useful than a 500 on a status page whose whole
 * job is telling you what state things are in.
 */
export async function getCopilotStatus(): Promise<CopilotStatus | null> {
  try {
    const path = join(process.cwd(), "copilot", "data", "status.json");
    return JSON.parse(await readFile(path, "utf8")) as CopilotStatus;
  } catch {
    return null;
  }
}
