"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, ADMIN_COOKIE_OPTIONS, tokenMatches } from "@/lib/admin/auth";
import { safeNext } from "@/lib/safe-next";

/**
 * Exchange the token for a session cookie.
 *
 * A Server Function rather than a `?token=` query parameter: the secret
 * arrives in a POST body, so it never reaches browser history, a Referer
 * header, or the edge access log. On failure it redirects back with a flag
 * rather than echoing what was typed.
 */
/*
 * `next` exists because this gate now guards two surfaces.
 *
 * `/cape` is an operations surface in everything but name — it reports which
 * packages are blocked and on what, and its PropStream export carries owner
 * names and computed max bids — so it takes the same token. Signing in there
 * must return you to the board rather than to the console, which is the whole
 * job of this field. It is validated through `safeNext` because it reaches us
 * from the URL: an unchecked value would make the sign-in form a redirector
 * for anyone who can get a link clicked.
 */
export async function signIn(formData: FormData): Promise<void> {
  const raw = formData.get("next");
  const next = safeNext(typeof raw === "string" ? raw : null);
  const back = next === "/" ? "/admin" : next;

  const token = formData.get("token");
  if (typeof token !== "string" || !tokenMatches(token)) {
    redirect(`${back}?e=1`);
  }
  (await cookies()).set(ADMIN_COOKIE, token, ADMIN_COOKIE_OPTIONS);
  redirect(back);
}

export async function signOut(formData?: FormData): Promise<void> {
  const raw = formData?.get("next");
  const next = safeNext(typeof raw === "string" ? raw : null);
  (await cookies()).delete(ADMIN_COOKIE);
  redirect(next === "/" ? "/admin" : next);
}
