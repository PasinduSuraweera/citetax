"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { GUEST_COOKIE, GUEST_MAX_AGE, safeNext } from "@/lib/guest";

async function rememberGuest() {
  (await cookies()).set(GUEST_COOKIE, "1", {
    maxAge: GUEST_MAX_AGE, path: "/", sameSite: "lax", httpOnly: true,
  });
}

/** "Continue without an account": remembered, so the choice is asked once. */
export async function continueAsGuest(formData: FormData) {
  await rememberGuest();
  redirect(safeNext(formData.get("next") as string | null) ?? "/chat");
}

/** The homepage question box. Asks straight away, as a guest unless the
 *  person is already signed in (the cookie is harmless then). */
export async function askFromHome(formData: FormData) {
  const question = String(formData.get("question") ?? "").trim().slice(0, 600);
  await rememberGuest();
  redirect(question ? `/chat?q=${encodeURIComponent(question)}` : "/chat");
}
