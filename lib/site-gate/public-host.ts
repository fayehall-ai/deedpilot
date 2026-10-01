/**
 * Whether a request came in on the public domain.
 *
 * `DEEDPILOT_PUBLIC_HOSTS` is a comma-separated list ("deedpilot.app,
 * www.deedpilot.app"). Those hosts skip the site password (`proxy.ts`) and are
 * where the paid features carry daily limits (`daily-limit.ts`). Anything else
 * — deedpilot.vercel.app — is behind the password and unlimited.
 *
 * A forged Host header gains nothing: Vercel routes by it, so claiming the
 * public host reaches the public, limited site.
 */
export function isPublicHost(host: string | null | undefined): boolean {
  const hosts = (process.env.DEEDPILOT_PUBLIC_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length === 0) return false;
  return hosts.includes((host ?? "").toLowerCase().replace(/:\d+$/, ""));
}
