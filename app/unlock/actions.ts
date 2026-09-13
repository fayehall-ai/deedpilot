"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  SITE_COOKIE,
  SITE_COOKIE_OPTIONS,
  UNLOCK_PATH,
  sitePasswordMatches,
} from "@/lib/site-gate/token";
import { safeNext } from "@/lib/safe-next";

/**
 * Exchange the site password for a cookie.
 *
 * A Server Function rather than a `?password=` query parameter, for the reason
 * `app/admin/actions.ts` gives: the secret arrives in a POST body, so it never
 * reaches browser history, a Referer header, or the edge access log.
 *
 * The password is re-checked here rather than assumed. `/unlock` is excluded
 * from the proxy matcher so the gate page can render, and Next routes a Server
 * Function as a POST to the page it lives on — so this call arrives ungated by
 * construction. It is the only thing standing between a POST and a valid
 * cookie.
 */
export async function unlock(formData: FormData): Promise<void> {
  const password = formData.get("password");
  const next = safeNext(typeof formData.get("next") === "string" ? String(formData.get("next")) : null);

  if (typeof password !== "string" || !sitePasswordMatches(password)) {
    const back = new URLSearchParams({ e: "1" });
    if (next !== "/") back.set("next", next);
    redirect(`${UNLOCK_PATH}?${back.toString()}`);
  }

  (await cookies()).set(SITE_COOKIE, password, SITE_COOKIE_OPTIONS);
  redirect(next);
}

export async function lockAgain(): Promise<void> {
  (await cookies()).delete(SITE_COOKIE);
  redirect(UNLOCK_PATH);
}
