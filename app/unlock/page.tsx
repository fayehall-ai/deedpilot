import type { Metadata } from "next";
import { Suspense } from "react";
import { Card } from "@/components/ui";
import { safeNext, siteGateConfigured } from "@/lib/site-gate/token";
import { unlock } from "./actions";

export const metadata: Metadata = {
  title: "Private site",
  robots: { index: false, follow: false },
};

/**
 * The gate page.
 *
 * Deliberately says almost nothing. A lock screen that names the product, its
 * coverage or its customers hands a stranger the reconnaissance the gate was
 * put up to withhold — and this one is reachable by anyone, since it is the
 * single path the proxy lets through unauthenticated.
 *
 * Same split as `/admin`: the shell is static, and the part that reads request
 * data sits inside a Suspense boundary so the page paints before it resolves.
 */
export default function UnlockPage(props: PageProps<"/unlock">) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
      <Suspense fallback={null}>
        <Form searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

async function Form({ searchParams }: { searchParams: PageProps<"/unlock">["searchParams"] }) {
  const params = await searchParams;
  const failed = params.e === "1";
  const next = safeNext(typeof params.next === "string" ? params.next : null);

  /*
   * With no password configured the proxy lets everything through, so landing
   * here means someone typed the URL. Say so plainly rather than presenting a
   * password box that would reject every value including the right one.
   */
  if (!siteGateConfigured()) {
    return (
      <Card>
        <p className="text-sm text-muted">
          This site is not password protected. Nothing to unlock.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <form action={unlock} className="space-y-3">
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm"
        />
        <input type="hidden" name="next" value={next} />
        {failed ? <p className="text-sm text-danger">That password was not accepted.</p> : null}
        <button
          type="submit"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Unlock
        </button>
      </form>
    </Card>
  );
}
