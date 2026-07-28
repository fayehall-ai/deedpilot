// USPS abbreviation -> full state name, for display and URL slugs.

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** URL-safe slug for a state, e.g. "new-hampshire". */
export function stateSlug(abbr: string): string {
  return (STATE_NAMES[abbr] ?? abbr).toLowerCase().replace(/\s+/g, "-");
}

const SLUG_TO_ABBR: Record<string, string> = Object.fromEntries(
  Object.keys(STATE_NAMES).map((a) => [stateSlug(a), a]),
);

/** Resolve a slug or abbreviation back to a USPS code. Case-insensitive. */
export function stateFromSlug(slug: string): string | null {
  const s = slug.toLowerCase();
  return SLUG_TO_ABBR[s] ?? (STATE_NAMES[s.toUpperCase()] ? s.toUpperCase() : null);
}
