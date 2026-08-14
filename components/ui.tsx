import Link from "next/link";
import { saleTypeColor } from "@/lib/format";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  /*
   * Elevation carries the card, not an outline.
   *
   * Every surface used to wear the same 1px border at full strength — a card, a
   * panel and a table row were visually the same object, so the page read as a
   * grid of boxes rather than as anything with a foreground. The border is now
   * half-strength and does the job of a seam, while a very soft shadow does the
   * job of separation.
   *
   * Corners go to 2xl and padding to 6: at 5 and xl the proportions read as a
   * component library default. Larger radii need more inset to look intentional.
   */
  return (
    <div
      className={`rounded-2xl border border-border/60 bg-surface p-6 shadow-[var(--shadow-sm)] ${className}`}
    >
      {children}
    </div>
  );
}

export function SaleTypeBadge({ type }: { type: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium"
      style={{ borderColor: saleTypeColor(type), color: saleTypeColor(type) }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: saleTypeColor(type) }}
      />
      {type}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  scheduled: "text-ok border-ok",
  live: "text-danger border-danger",
  closed: "text-muted border-border",
  cancelled: "text-muted border-border line-through",
  postponed: "text-warn border-warn",
  pending: "text-ok border-ok",
  sold: "text-muted border-border",
  redeemed: "text-warn border-warn",
  struck: "text-warn border-warn",
  withdrawn: "text-muted border-border",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs capitalize ${
        STATUS_STYLES[status] ?? "text-muted border-border"
      }`}
    >
      {status}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="tnum mt-1 text-2xl font-semibold">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

/**
 * Marks a figure the system inferred or assumed rather than read from a
 * source. Used everywhere a number could be mistaken for verified fact.
 */
export function AssumedTag({ children = "assumed" }: { children?: React.ReactNode }) {
  return (
    <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
      {children}
    </span>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "danger";
  title?: string;
  children: React.ReactNode;
}) {
  const color =
    tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--muted)";
  return (
    <div
      className="rounded-lg border-l-2 bg-surface-2/60 px-4 py-3 text-sm"
      style={{ borderLeftColor: color }}
    >
      {title ? (
        <div className="mb-1 font-medium" style={{ color }}>
          {title}
        </div>
      ) : null}
      <div className="text-muted leading-relaxed [&_a]:underline">{children}</div>
    </div>
  );
}

export function Breadcrumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-muted">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          {it.href ? (
            <Link href={it.href} className="hover:text-foreground hover:underline">
              {it.label}
            </Link>
          ) : (
            <span className="text-foreground">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-prose text-sm text-muted">{children}</div> : null}
    </div>
  );
}
