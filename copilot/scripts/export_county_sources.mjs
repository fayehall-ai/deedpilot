/**
 * Export auction / authority URLs from tax-deed-map COUNTY_DATA into
 * copilot/data/county_sources.json for multi-state past-auction import.
 *
 * Usage (from deedpilot repo root or copilot/):
 *   node copilot/scripts/export_county_sources.mjs
 *   node copilot/scripts/export_county_sources.mjs --map /path/to/tax-deed-map
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mapFlag = args.indexOf("--map");
const mapRoot =
  (mapFlag >= 0 && args[mapFlag + 1]) ||
  process.env.TAX_DEED_MAP_ROOT ||
  path.resolve(__dirname, "../../../tax-deed-map");

const countyPath = path.join(mapRoot, "data/county-data.js");
const statePath = path.join(mapRoot, "data/state-data.js");
const popPath = path.join(mapRoot, "data/county-population.js");
const outPath = path.resolve(__dirname, "../data/county_sources.json");

const STATE_FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
  "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
  "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY",
};

function loadJsConst(file, name) {
  const code = fs.readFileSync(file, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${code}\n;globalThis.__OUT = ${name};`, sandbox);
  return sandbox.__OUT;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

if (!fs.existsSync(countyPath)) {
  console.error(`Missing ${countyPath}. Pass --map /path/to/tax-deed-map`);
  process.exit(1);
}

const COUNTY_DATA = loadJsConst(countyPath, "COUNTY_DATA");
const STATE_DATA = fs.existsSync(statePath) ? loadJsConst(statePath, "STATE_DATA") : {};
const POP = fs.existsSync(popPath) ? loadJsConst(popPath, "COUNTY_POPULATION") : {};

const counties = [];
const hostIndex = {};

for (const [fips, c] of Object.entries(COUNTY_DATA)) {
  const state = STATE_FIPS[fips.slice(0, 2)] || null;
  const saleType = state && STATE_DATA[state] ? STATE_DATA[state].type : null;
  const links = [];
  const push = (role, obj) => {
    if (!obj) return;
    if (typeof obj === "string" && obj.startsWith("http")) {
      links.push({ role, label: null, url: obj, host: hostOf(obj) });
      return;
    }
    if (obj.url && String(obj.url).startsWith("http")) {
      links.push({
        role,
        label: obj.label || null,
        url: obj.url,
        host: hostOf(obj.url),
      });
    }
  };

  push("auctionPlatform", c.auctionPlatform);
  push("taxCollector", c.taxCollector);
  push("clerkOfCourt", c.clerkOfCourt);
  push("propertyAppraiser", c.propertyAppraiser);
  push("gisMap", c.gisMap);
  for (const s of c.sources || []) {
    if (typeof s === "string" && s.startsWith("http")) {
      links.push({ role: "source", label: null, url: s, host: hostOf(s) });
    }
  }

  for (const l of links) {
    if (!l.host) continue;
    hostIndex[l.host] = hostIndex[l.host] || { n: 0, roles: {}, sampleUrls: [] };
    hostIndex[l.host].n += 1;
    hostIndex[l.host].roles[l.role] = (hostIndex[l.host].roles[l.role] || 0) + 1;
    if (hostIndex[l.host].sampleUrls.length < 5) {
      hostIndex[l.host].sampleUrls.push(l.url);
    }
  }

  counties.push({
    fips,
    state,
    population: POP[fips] ?? null,
    saleType,
    auctionFormat: c.auctionFormat || null,
    auctionFrequency: c.auctionFrequency || null,
    auctionPlatformLabel: c.auctionPlatform?.label || null,
    auctionPlatformUrl: c.auctionPlatform?.url || null,
    taxCollectorUrl: c.taxCollector?.url || null,
    clerkOfCourtUrl: c.clerkOfCourt?.url || null,
    sources: (c.sources || []).filter((s) => typeof s === "string"),
    links,
    asOf: c.asOf || null,
  });
}

const payload = {
  exportedAt: new Date().toISOString(),
  mapRoot,
  nCounties: counties.length,
  nUniqueHosts: Object.keys(hostIndex).length,
  note:
    "Researched counties from tax-deed-map COUNTY_DATA (typically pop 50k+ with LA-depth research). " +
    "Unlisted US counties fall back to state defaults without per-county auction URLs.",
  hostIndex,
  counties,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(
  JSON.stringify(
    {
      outPath,
      nCounties: counties.length,
      nHosts: Object.keys(hostIndex).length,
      withPlatformUrl: counties.filter((c) => c.auctionPlatformUrl).length,
    },
    null,
    2,
  ),
);
