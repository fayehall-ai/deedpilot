"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that admits it is working.
 *
 * A plain `<form action={serverAction}>` gives no pending state. The browser
 * shows nothing, the button stays clickable, and an action that takes tens of
 * seconds is indistinguishable from one that did nothing — which is how "Run
 * Crawl Scout now" got pressed four times in twenty seconds.
 *
 * That matters more here than on a typical form because these actions are slow
 * by nature, not by accident: building the plan resolves the calendar across
 * 3,142 counties and asks every adapter what it serves, some of which fetch.
 * Draining the queue deliberately spends up to 25 seconds crawling.
 *
 * `useFormStatus` must be read from a component *inside* the form — that is the
 * whole reason this is its own client component rather than a prop on the
 * server-rendered panel.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className,
}: {
  children: React.ReactNode;
  /** What to say while the action is in flight. Say what is happening, not "Loading". */
  pendingLabel: string;
  variant?: "primary" | "ghost";
  className?: string;
}) {
  const { pending } = useFormStatus();

  const base =
    variant === "primary"
      ? "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
      : "rounded-lg border border-border px-2.5 py-1.5 text-sm text-muted";

  return (
    <button
      type="submit"
      /*
       * Disabled while pending is the point: a second press would queue a second
       * action against the same request budget, and the actions are not free —
       * one of them spends money.
       */
      disabled={pending}
      aria-busy={pending}
      className={`${base} inline-flex items-center gap-2 transition-opacity ${
        pending ? "cursor-wait opacity-70" : "hover:opacity-90"
      } ${className ?? ""}`}
    >
      {pending && (
        <span
          className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          aria-hidden
        />
      )}
      {pending ? pendingLabel : children}
    </button>
  );
}
