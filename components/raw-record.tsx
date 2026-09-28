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

export function RawRecord({
  title,
  note,
  raw,
}: {
  title: string;
  note?: string;
  raw: Record<string, unknown> | null;
}) {
  if (!raw || Object.keys(raw).length === 0) return null;
  const sections = sectionsOf(raw as Obj);
  if (sections.length === 0) return null;
  const count = sections.reduce(
    (n, s) => n + (s.fields?.length ?? 0) + (s.entries?.reduce((m, e) => m + e.length, 0) ?? 0),
    0,
  );

  return (
    <section className="rounded-xl border-2 border-dashed border-border bg-surface p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted">
          {note ? `${note} · ` : ""}Every populated field, as returned · {num(count)} values
        </p>
      </div>
      <div className="space-y-4">
        {sections.map((s) => (
          <details key={s.title} className="group/sec" open>
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs uppercase tracking-wide text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="transition-transform group-open/sec:rotate-90">
                ›
              </span>
              {s.title}
              <span className="tnum lowercase tracking-normal opacity-60">
                ({s.fields ? s.fields.length : `${s.entries?.length} entries`})
              </span>
            </summary>
            <div className="mt-2 overflow-x-auto rounded-lg border border-border">
              {s.fields ? <FieldTable values={s.fields} /> : null}
              {s.entries ? <EntryTable entries={s.entries} /> : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

/** Label | value, one row per field. */
function FieldTable({ values }: { values: { label: string; value: string }[] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {values.map((v) => (
          <tr key={v.label} className="border-b border-border/60 last:border-0">
            <th className="w-1/3 bg-surface-2/50 px-3 py-1.5 text-left text-xs font-medium text-muted">
              {v.label}
            </th>
            <td className="break-words px-3 py-1.5">{v.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One row per entry, one column per field any entry carries — so two sales or
 * four schools read across as a history rather than as stacked cards.
 */
function EntryTable({ entries }: { entries: { label: string; value: string }[][] }) {
  const columns = [...new Set(entries.flatMap((e) => e.map((f) => f.label)))];
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2/50 text-left text-xs text-muted">
        <tr>
          {columns.map((c) => (
            <th key={c} className="whitespace-nowrap px-3 py-1.5 font-medium">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => {
          const byLabel = new Map(e.map((f) => [f.label, f.value]));
          return (
            <tr key={i} className="border-t border-border/60">
              {columns.map((c) => (
                <td key={c} className="whitespace-nowrap px-3 py-1.5">
                  {byLabel.get(c) ?? ""}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
