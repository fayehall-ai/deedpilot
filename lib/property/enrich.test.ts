/**
 * Provider fallthrough assertions.
 * Run: npx tsx lib/property/enrich.test.ts
 *
 * No network and no queries — `lookupProperty` is exercised against fake
 * providers so the branch that matters can be checked directly: whether a null
 * means "nobody had a record" or "nobody was asked". Those are different facts
 * and only one of them is about the property.
 *
 * `../env` is imported only because `enrich.ts` pulls in the db module, which
 * constructs a client at import time. Nothing here issues a query.
 */
import "../env";
import { lookupProperty } from "./enrich";
import { ProviderUnavailableError, type PropertyProvider, type PropertyRecord } from "./types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

/** The real `lookupProperty`, with providers injected. */
const lookup = (providers: PropertyProvider[], unavailable = new Set<string>()) =>
  lookupProperty(
    { state: "AR", fips: "05143", countyName: "Washington" },
    unavailable,
    providers,
  );

async function main() {
  const record: PropertyRecord = { source: "good", assessedValue: 1000 };

  const good = (name = "good"): PropertyProvider => ({
    name,
    configured: () => true,
    lookup: async () => ({ ...record, source: name }),
  });
  const empty = (name = "empty"): PropertyProvider => ({
    name,
    configured: () => true,
    lookup: async () => null,
  });
  const dead = (name = "dead"): PropertyProvider => ({
    name,
    configured: () => true,
    lookup: async () => {
      throw new ProviderUnavailableError(name, 401, "out-of-quota API key");
    },
  });

  // --- the bug this was written for -------------------------------------------

  // A 401 from ATTOM aborted a 250-lot run before RentCast was asked anything.
  // A dead provider is now skipped, and the next one still gets its turn.
  const afterDead = await lookup([dead("attom"), good("rentcast")]);
  assert(afterDead?.source === "rentcast", `a live provider still answers, got ${afterDead?.source}`);

  // The set is shared, so the dead one is remembered rather than retried.
  const seen = new Set<string>();
  await lookup([dead("attom"), good("rentcast")], seen);
  assert(seen.has("attom"), "the dead provider is recorded");
  let attomCalls = 0;
  const counting: PropertyProvider = {
    name: "attom",
    configured: () => true,
    lookup: async () => {
      attomCalls++;
      throw new ProviderUnavailableError("attom", 401, "dead");
    },
  };
  await lookup([counting, good("rentcast")], seen);
  assert(attomCalls === 0, `a remembered-dead provider is not called again, got ${attomCalls}`);

  // --- the guarantee that must not regress -------------------------------------

  // If nobody could answer, this is not a miss and must not look like one.
  let threw = false;
  try {
    await lookup([dead("attom"), dead("rentcast")]);
  } catch (e) {
    threw = true;
    assert(e instanceof ProviderUnavailableError, "all-dead throws ProviderUnavailableError");
    assert(/every configured provider is unavailable/.test(String(e)), `message names the cause: ${e}`);
  }
  assert(threw, "all providers dead must throw, never return null");

  // A genuine no-match is still a null, because somebody actually answered.
  assert((await lookup([empty("attom"), empty("rentcast")])) === null, "real miss returns null");

  // Mixed: one dead, one that genuinely has nothing. Somebody answered, so null.
  assert(
    (await lookup([dead("attom"), empty("rentcast")])) === null,
    "a real answer of 'nothing' is conclusive even when another provider died",
  );

  // Nothing configured is not an outage.
  assert(
    (await lookup([{ name: "x", configured: () => false, lookup: async () => null }])) === null,
    "no configured providers returns null rather than throwing",
  );

  // First live provider wins; later ones are never consulted.
  let secondCalled = false;
  await lookup([
    good("first"),
    { name: "second", configured: () => true, lookup: async () => { secondCalled = true; return null; } },
  ]);
  assert(!secondCalled, "search stops at the first record");

  /*
   * Parcel-only ordering. The hoist in `lookupProperty` reorders providers when
   * the lot has no address, which is most auction lots — so a provider missing
   * from that list silently loses to one that is in it, whatever the
   * registration order says. This pins the case that regressed: ATTOM has been
   * returning 401 for weeks, and hoisting it ahead of the working APN leg
   * spends a failed request on every parcel-only lot before falling through.
   */
  const calls: string[] = [];
  const recorder = (name: string): PropertyProvider => ({
    name,
    configured: () => true,
    lookup: async () => {
      calls.push(name);
      return null;
    },
  });
  await lookup([recorder("rentcast"), recorder("attom"), recorder("realestateapi"), recorder("cadastre")]);
  assert(
    calls.indexOf("cadastre") < calls.indexOf("realestateapi"),
    `the free assessor layer goes first — got ${calls.join(" -> ")}`,
  );
  assert(
    calls.indexOf("realestateapi") < calls.indexOf("attom"),
    `realestateapi must precede attom on parcel-only lookups — got ${calls.join(" -> ")}`,
  );

  console.log("enrich fallthrough: all assertions passed");

}

main();
