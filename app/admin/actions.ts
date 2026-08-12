"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, ADMIN_COOKIE_OPTIONS, tokenMatches } from "@/lib/admin/auth";

/**
 * Exchange the token for a session cookie.
 *
 * A Server Function rather than a `?token=` query parameter: the secret
 * arrives in a POST body, so it never reaches browser history, a Referer
 * header, or the edge access log. On failure it redirects back with a flag
 * rather than echoing what was typed.
 */
export async function signIn(formData: FormData): Promise<void> {
  const token = formData.get("token");
  if (typeof token !== "string" || !tokenMatches(token)) {
    redirect("/admin?e=1");
  }
  (await cookies()).set(ADMIN_COOKIE, token, ADMIN_COOKIE_OPTIONS);
  redirect("/admin");
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(ADMIN_COOKIE);
  redirect("/admin");
}
