/**
 * Subscription plans and entitlements.
 *
 * Single source of truth: the marketing page, the Stripe setup script, and
 * the server-side gate all read this table, so a limit can never drift
 * between what is advertised and what is enforced.
 */

export type PlanId = "free" | "starter" | "pro" | "team";

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in whole dollars. */
  price: number;
  tagline: string;
  /** Env var holding the Stripe price id, for the paid tiers. */
  priceEnvVar?: string;
  features: string[];
  limits: {
    /** Number of states with parcel-level access. null = all covered states. */
    states: number | null;
    /** AI parcel briefs per month. null = unlimited. */
    briefsPerMonth: number | null;
    liveCopilot: boolean;
    csvExport: boolean;
    apiAccess: boolean;
    seats: number;
  };
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    tagline: "The whole rules atlas, and the auction calendar.",
    features: [
      "All 3,142 county rule profiles",
      "152 counties researched in depth",
      "Upcoming auction calendar",
      "Lot counts and opening bids",
    ],
    limits: {
      states: 0,
      briefsPerMonth: 0,
      liveCopilot: false,
      csvExport: false,
      apiAccess: false,
      seats: 1,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    price: 49,
    tagline: "Parcel-level data for the one state you actually bid in.",
    priceEnvVar: "STRIPE_PRICE_STARTER",
    features: [
      "Everything in Free",
      "Full parcel lists for 1 state",
      "Max-bid calculator on every lot",
      "25 AI parcel briefs per month",
      "Watchlists",
    ],
    limits: {
      states: 1,
      briefsPerMonth: 25,
      liveCopilot: false,
      csvExport: false,
      apiAccess: false,
      seats: 1,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 149,
    tagline: "Every covered state, and the co-pilot on auction day.",
    priceEnvVar: "STRIPE_PRICE_PRO",
    features: [
      "Everything in Starter",
      "All covered states",
      "Unlimited AI parcel briefs",
      "Live auction co-pilot",
      "Bid sheets with budget tracking",
      "CSV export",
    ],
    limits: {
      states: null,
      briefsPerMonth: null,
      liveCopilot: true,
      csvExport: true,
      apiAccess: false,
      seats: 1,
    },
  },
  team: {
    id: "team",
    name: "Team",
    price: 349,
    tagline: "For funds and groups bidding in parallel.",
    priceEnvVar: "STRIPE_PRICE_TEAM",
    features: [
      "Everything in Pro",
      "5 seats",
      "Shared bid sheets and watchlists",
      "API access",
      "Portfolio and redemption tracking",
    ],
    limits: {
      states: null,
      briefsPerMonth: null,
      liveCopilot: true,
      csvExport: true,
      apiAccess: true,
      seats: 5,
    },
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "starter", "pro", "team"];

/** Server-side entitlement check. Never trust the client for these. */
export function can(plan: PlanId, capability: keyof Plan["limits"]): boolean {
  const v = PLANS[plan].limits[capability];
  if (typeof v === "boolean") return v;
  if (v === null) return true;
  return v > 0;
}
