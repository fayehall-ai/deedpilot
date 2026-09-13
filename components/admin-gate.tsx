import { Callout, Card } from "@/components/ui";
import { adminConfigured } from "@/lib/admin/auth";
import { signIn } from "@/app/admin/actions";

/**
 * The operations token gate, shared by `/admin` and `/cape`.
 *
 * One component rather than one per page, because the two must not drift: a
 * second hand-rolled copy of this form is how one surface ends up fail-open
 * after a refactor while the other stays closed, and nobody notices until the
 * wrong person sees a parcel list.
 *
 * The caller is responsible for pinning itself to request time with
 * `connection()` before rendering this — see the long note in
 * `app/admin/page.tsx`, where a prerendered copy of this very form was served
 * from the CDN to operators who held a valid cookie.
 */
export function AdminGate({ next, failed }: { next: string; failed?: boolean }) {
  if (!adminConfigured()) {
    return (
      <Callout tone="warn" title="No admin token configured">
        Set <code className="font-mono text-xs">DEEDPILOT_ADMIN_TOKEN</code> in the environment to
        open this console. Until it is set, access is denied rather than granted — a missing
        variable must not become an open door.
      </Callout>
    );
  }

  return (
    <Card>
      <form action={signIn} className="max-w-sm space-y-3">
        <label htmlFor="token" className="block text-sm font-medium">
          Operations token
        </label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="current-password"
          autoFocus
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm"
        />
        <input type="hidden" name="next" value={next} />
        {failed ? <p className="text-sm text-danger">That token was not accepted.</p> : null}
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
