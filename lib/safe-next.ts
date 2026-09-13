/**
 * A redirect target that cannot leave the site.
 *
 * Both gates carry the reader's destination through sign-in so they are not
 * dumped on the homepage afterwards, and in both cases that value arrives from
 * the URL — which means from whoever crafted the link. Validated rather than
 * trusted: a value beginning `//` or `https://` would turn either gate into an
 * open redirect that borrows this domain's credibility to send people
 * somewhere else.
 *
 * Shared by `lib/site-gate` and the admin console so the two can never drift
 * into disagreeing about what a safe destination is.
 */
export function safeNext(next: string | undefined | null): string {
  const v = (next ?? "").trim();
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return "/";
  return v;
}
