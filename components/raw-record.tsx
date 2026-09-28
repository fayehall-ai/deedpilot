/**
 * Every field of a provider payload, drawn as it came back.
 *
 * An experiment view, not a curated one: `PropertyDetail` chooses and orders
 * the fields a bidder reads; this shows all of them, so what a paid call
 * actually returns can be judged before deciding what earns a curated slot.
 *
 * Top-level scalars go under "Summary"; each nested object is a section, with
 * deeper objects flattened into "Mail address · city" labels; arrays of
 * objects (mortgage history, sale history, schools) get one block per entry.
 * Null, empty and false fields are left out, as in `PropertyDetail`.
 */
import { money, num } from "@/lib/format";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

function isObj(v: Json): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** "mlsListingPricePerSquareFoot" → "Mls listing price per square foot". */
function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/*
 * Dollar fields, told apart by name: the payload does not mark money, and half
 * of it arrives as strings ("totalValue": "323644000"). Percentages, counts,
 * ids and codes that happen to contain one of these words are excluded.
 */
const MONEY_KEY = /(amount|value|price|equity|balance|rent|income|payment|^fmr)/i;
const NOT_MONEY = /(percent|count|id$|code|per ?square|date|type|rate|rating|year)/i;

function scalar(v: Json, key = ""): string | null {
  if (v === null || v === "" || v === false) return null;
  if (v === true) return "Yes";
  if (MONEY_KEY.test(key) && !NOT_MONEY.test(key)) {
    const n = Number(v);
    if (typeof v !== "boolean" && Number.isFinite(n)) return n === 0 ? null : money(n);
  }
  if (typeof v === "number") return Number.isInteger(v) ? num(v) : String(v);
  if (typeof v === "string") {
    // Midnight-UTC timestamps are dates wearing a clock.
    return /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(v) ? v.slice(0, 10) : v;
  }
  return null;
}

/** Flatten an object into label/value pairs, one level of prefix per nesting. */
function flatten(o: Obj, prefix = ""): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(o)) {
    const label = prefix ? `${prefix} · ${humanize(k).toLowerCase()}` : humanize(k);
    if (isObj(v)) out.push(...flatten(v, label));
    else if (Array.isArray(v)) {
      const items = v.map((x) => (isObj(x) ? null : scalar(x))).filter(Boolean);
      if (items.length) {
        const shown = items.slice(0, 12).join(", ");
        out.push({ label, value: items.length > 12 ? `${shown} … (${items.length})` : shown });
      } else if (v.some(isObj)) {
        out.push({ label, value: `${v.length} entries` });
      }
    } else {
      const s = scalar(v, k);
      if (s !== null) out.push({ label, value: s });
    }
  }
  return out;
}

interface Section {
  title: string;
  fields?: { label: string; value: string }[];
  entries?: { label: string; value: string }[][];
}

function sectionsOf(raw: Obj): Section[] {
  const summary: Obj = {};
  const sections: Section[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (isObj(v)) {
      const fields = flatten(v);
      if (fields.length) sections.push({ title: humanize(k), fields });
    } else if (Array.isArray(v) && v.some(isObj)) {
      const entries = v.filter(isObj).map((x) => flatten(x)).filter((e) => e.length);
      if (entries.length) sections.push({ title: humanize(k), entries });
    } else {
      summary[k] = v;
    }
  }
  const top = flatten(summary);
  return top.length ? [{ title: "Summary", fields: top }, ...sections] : sections;
}

export function RawRecord({ title, raw }: { title: string; raw: Record<string, unknown> | null }) {
  if (!raw || Object.keys(raw).length === 0) return null;
  const sections = sectionsOf(raw as Obj);
  if (sections.length === 0) return null;
  const count = sections.reduce(
    (n, s) => n + (s.fields?.length ?? 0) + (s.entries?.reduce((m, e) => m + e.length, 0) ?? 0),
    0,
  );

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-muted">Every populated field, as returned · {num(count)} values</p>
      </div>
      <div className="space-y-3">
        {sections.map((s) => (
          <details key={s.title} className="group/sec" open={s.title === "Summary"}>
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs uppercase tracking-wide text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="transition-transform group-open/sec:rotate-90">
                ›
              </span>
              {s.title}
              <span className="tnum lowercase tracking-normal opacity-60">
                ({s.fields ? s.fields.length : `${s.entries?.length} entries`})
              </span>
            </summary>
            <div className="mt-2 space-y-3">
              {s.fields ? <Grid values={s.fields} /> : null}
              {s.entries?.map((e, i) => (
                <div key={i} className="rounded-lg border border-border/60 p-3">
                  <p className="mb-2 text-xs text-muted">
                    {s.title} · {i + 1} of {s.entries?.length}
                  </p>
                  <Grid values={e} />
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function Grid({ values }: { values: { label: string; value: string }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {values.map((v) => (
        <div key={v.label}>
          <dt className="text-xs uppercase tracking-wide text-muted">{v.label}</dt>
          <dd className="mt-0.5 break-words">{v.value}</dd>
        </div>
      ))}
    </dl>
  );
}
