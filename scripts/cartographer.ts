/**
 * Statute Cartographer CLI.
 *
 *   npm run cartographer -- --gaps                 # which states cannot be priced
 *   npm run cartographer -- --market AR            # only the searched pass
 *   npm run cartographer -- --state AR --no-market # statutory draft only
 *   npm run cartographer -- --state IL --state CA  # draft proposals
 *   npm run cartographer -- --state IL --pr        # draft and open a PR
 *
 * Writes to `proposals/` and never to `lib/deal/statute.ts`. Promotion is a
 * human edit, on purpose — see lib/cartographer/index.ts for why.
 */
import "../lib/env";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  coveredStates,
  draftState,
  renderReviewPacket,
  uncoveredStates,
} from "../lib/cartographer";
import { STATE_NAMES } from "../lib/atlas";

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function openPr(branch: string, path: string, states: string[]) {
  const title = `Statute proposals for ${states.join(", ")} — review required`;
  const body = [
    `Drafted statutory parameters for ${states.map((s) => STATE_NAMES[s] ?? s).join(", ")}.`,
    "",
    "**These are proposals, not data.** Nothing in this PR is used by the deal",
    "engine until someone moves it into `lib/deal/statute.ts` by hand.",
    "",
    "Reviewer checklist:",
    "",
    "- [ ] Every `assessmentRatio` is a fraction of market value, checked against its cited source",
    "- [ ] Redemption tiers and penalties match the cited statute",
    "- [ ] Penalties are fractions (0.25), not percentages (25)",
    "- [ ] Quiet-title costs are labelled as market practice, not statute",
    "- [ ] No citation is fabricated — open each link",
    "",
    `See \`${path}\` for the validation results and per-field citations.`,
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");

  execFileSync("git", ["checkout", "-b", branch], { stdio: "inherit" });
  execFileSync("git", ["add", path], { stdio: "inherit" });
  execFileSync("git", ["commit", "-m", title, "-m", body], { stdio: "inherit" });
  execFileSync("git", ["push", "-u", "origin", branch], { stdio: "inherit" });
  execFileSync("gh", ["pr", "create", "--title", title, "--body", body], { stdio: "inherit" });
}

async function main() {
  /*
   * The market-practice pass, kept behind its own flag.
   *
   * Separate from --state on purpose: the statutory draft costs one structured
   * call and can be re-run freely, while this one runs a paid searched call per
   * state. Different price, different cadence, different gate — these figures
   * are estimates by nature and are labelled as such rather than waiting on a
   * citation nobody can produce.
   */
  const marketStates = args("market");
  if (marketStates.length > 0) {
    for (const raw of marketStates) {
      const state = raw.toUpperCase();
      console.log(`\nResearching market practice for ${STATE_NAMES[state] ?? state}…`);
      const { researchMarketPractice, validateMarketPractice } = await import(
        "../lib/cartographer/market-practice"
      );
      const result = await researchMarketPractice(state);
      const problems = validateMarketPractice(result.data);

      const { quietTitle: qt, closingCosts: cc } = result.data;
      console.log(`\n  quiet title   $${qt.low.toLocaleString()}–$${qt.high.toLocaleString()}, ~${qt.months} months  [${qt.confidence}]`);
      console.log(`    basis       ${qt.basis}`);
      for (const u of qt.sources.slice(0, 4)) console.log(`    source      ${u}`);
      console.log(`\n  closing      $${cc.low.toLocaleString()}–$${cc.high.toLocaleString()}  [${cc.confidence}]`);
      console.log(`    basis       ${cc.basis}`);
      for (const u of cc.sources.slice(0, 4)) console.log(`    source      ${u}`);
      console.log(`\n  survives the sale (NOT a closing cost):\n    ${result.data.survivingLiens}`);
      if (result.data.caveats.length) {
        console.log("\n  caveats:");
        for (const c of result.data.caveats) console.log(`    - ${c}`);
      }
      console.log(`\n  ${result.searchCount} searches, ${result.citations.length} sources read, model ${result.model}`);
      if (problems.length) {
        console.log("\n  REFUSED — these figures must not reach a proposal:");
        for (const e of problems) console.log(`    - ${e}`);
      }
    }
    return;
  }

  if (flag("gaps")) {
    const covered = coveredStates();
    const uncovered = uncoveredStates();
    console.log(`\nDeal engine covers ${covered.length} states: ${covered.join(", ")}`);
    console.log(
      `Atlas markets ${covered.length + uncovered.length}; ` +
        `${uncovered.length} cannot be priced:\n  ${uncovered.join(" ")}`,
    );
    /*
     * This line used to say IL and CA were in the uncovered list, holding 78%
     * of the corpus. Both were reviewed and promoted, so it contradicted the
     * line printed directly above it. The pressure has moved to live inventory:
     * AR, LA and NM carry thousands of crawled lots and no entry here, so the
     * engine returns insufficient-data on every one of them.
     */
    /*
     * Arkansas was promoted on 13 August, so the pressure moved again. Listing
     * the states by *live crawled inventory* rather than alphabetically is the
     * point of this line — a state with thousands of parcels and no entry costs
     * more than one with none.
     */
    console.log(
      "\nLA and NM hold live crawled inventory and cannot be priced — " +
        "see proposals/ for drafts awaiting review.\n",
    );
    return;
  }

  const states = args("state").map((s) => s.toUpperCase());
  if (!states.length) {
    console.error("Specify at least one --state, or use --gaps. Nothing was drafted.");
    process.exit(1);
  }

  /*
   * The searched market pass is on by default, because a draft without
   * quiet-title and closing figures is not reviewable — it was the reason the
   * Arkansas proposal sat unmergeable for a week. `--no-market` skips it for
   * iterating on the statutory half, which is one cheap structured call against
   * the searched pass's paid one.
   */
  const skipMarket = flag("no-market");
  console.log(
    `Drafting proposals for ${states.join(", ")} …` +
      (skipMarket
        ? " (statutory only — --no-market)"
        : ` (with searched market-practice pass, ~1-2 min and one paid call per state)`),
  );

  const drafts = [];
  for (const s of states) {
    const d = await draftState(s, { skipMarket });
    const status = d.error
      ? `failed: ${d.error}`
      : d.validation?.ok
        ? "validation passed"
        : `validation FAILED (${d.validation?.issues.filter((i) => i.severity === "error").length} errors)`;
    console.log(`  ${s}: ${status}`);

    if (d.marketError) {
      console.log(`    market pass FAILED (${d.marketError}) — quiet-title and closing figures are recalled, not searched`);
    } else if (d.marketProblems?.length) {
      console.log(`    market pass REFUSED, figures left as drafted:`);
      for (const e of d.marketProblems) console.log(`      - ${e}`);
    } else if (d.market) {
      const { quietTitle: qt, closingCosts: cc } = d.market.data;
      console.log(
        `    quiet title  $${qt.low.toLocaleString()}–$${qt.high.toLocaleString()}, ~${qt.months}mo [${qt.confidence}] · ` +
          `closing $${cc.low}–$${cc.high} [${cc.confidence}] · ` +
          `${d.market.searchCount} searches, ${d.market.citations.length} sources`,
      );
      /*
       * Printed at the top level rather than buried in the file: a confidence
       * of `inferred` means no authoritative fee schedule exists for the state,
       * and that is the thing a reviewer most needs to decide whether to trust
       * a number the engine subtracts straight off a bid.
       */
      if (qt.confidence !== "sourced") {
        console.log(`    NOTE quiet-title confidence is '${qt.confidence}' — one call to a ${s} title attorney settles it`);
      }
    }
    drafts.push(d);
  }

  mkdirSync("proposals", { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const path = `proposals/statute-${states.join("-").toLowerCase()}-${stamp}.md`;
  writeFileSync(path, renderReviewPacket(drafts));
  console.log(`\nWrote ${path}`);
  console.log("Nothing was written to lib/deal/statute.ts — promotion is a human edit.");

  if (flag("pr")) {
    openPr(`statute/${states.join("-").toLowerCase()}-${stamp}`, path, states);
  } else {
    console.log("Re-run with --pr to open a pull request.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
