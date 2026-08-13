/**
 * Statute Cartographer CLI.
 *
 *   npm run cartographer -- --gaps                 # which states cannot be priced
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
    console.log(
      "\nAR, LA and NM hold live crawled inventory and cannot be priced — " +
        "see proposals/ for drafts awaiting review.\n",
    );
    return;
  }

  const states = args("state").map((s) => s.toUpperCase());
  if (!states.length) {
    console.error("Specify at least one --state, or use --gaps. Nothing was drafted.");
    process.exit(1);
  }

  console.log(`Drafting proposals for ${states.join(", ")} …`);
  const drafts = [];
  for (const s of states) {
    const d = await draftState(s);
    const status = d.error
      ? `failed: ${d.error}`
      : d.validation?.ok
        ? "validation passed"
        : `validation FAILED (${d.validation?.issues.filter((i) => i.severity === "error").length} errors)`;
    console.log(`  ${s}: ${status}`);
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
