/**
 * The pipeline recommends one action, and recommends them in cost order.
 * Run: npx tsx lib/property/pipeline.test.ts
 *
 * The ordering is the whole value of this module. Getting it wrong does not
 * produce a wrong answer — it produces the right answer bought expensively, which
 * is harder to notice: a searched call at ~20s and a paid request, for a parcel a
 * county publishes free in 110ms.
 */
import { nextAction, type CountyShape } from "./pipeline";

function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const base: CountyShape = {
  fips: "99999", state: "ZZ", name: "Nowhere",
  lots: 100, valued: 0, withParcel: 0, withNumberedAddress: 0, withCity: 0,
};

// A registered county with parcel numbers takes the free layer, always.
const cobb = nextAction({ ...base, fips: "13067", state: "GA", withParcel: 100 });
assert(cobb.stage === "cadastre", `Cobb should use the cadastre, got ${cobb.stage}`);
assert(/--fips 13067/.test(cobb.command!), "a county-keyed entry gets a county command");

// Arkansas is registered statewide, so the command must be too — otherwise the
// board prints forty-five identical rows.
const ar = nextAction({ ...base, fips: "05045", state: "AR", withParcel: 100 });
assert(/--state AR/.test(ar.command!), `statewide entry gets a statewide command, got ${ar.command}`);

// Free geocoding comes before metered lookups, even though both could "work".
const needsCity = nextAction({ ...base, withNumberedAddress: 80, withCity: 0 });
assert(needsCity.stage === "geocode", `address without city geocodes first, got ${needsCity.stage}`);

// Only once a city exists is the metered provider the right call.
const hasCity = nextAction({ ...base, withNumberedAddress: 80, withCity: 80 });
assert(hasCity.stage === "address-provider", `full address uses RentCast, got ${hasCity.stage}`);

// Parcel numbers with no layer and no address: hunt for a layer, do not spend.
const hunt = nextAction({ ...base, withParcel: 100 });
assert(hunt.stage === "needs-layer", `parcel-only with no entry hunts, got ${hunt.stage}`);
assert(hunt.command !== null, "hunting is free and should be recommended, not merely described");

// Nothing to match on at all is an honest dead end, not a suggestion to spend.
const dead = nextAction({ ...base });
assert(dead.stage === "search-or-nothing", `no identifiers is a dead end, got ${dead.stage}`);
assert(dead.command === null, "a dead end must not hand over a command to run blindly");

// A finished county proposes nothing.
const done = nextAction({ ...base, valued: 100 });
assert(done.stage === "already-valued" && done.command === null, "finished county is quiet");

console.log("pipeline tests ok");
