/**
 * The front door. Someone arriving at the chat who has neither signed in nor
 * chosen to carry on as a guest sees the sign-in screen first, and is sent
 * back to what they asked for (a ?c= chat, a ?q= question) either way.
 *
 * This is an optimistic check on cookies only, as Next recommends for proxy:
 * it decides which screen to show, not who may do what. The API checks the
 * token on every request that needs an account.
 */

import { NextResponse, type NextRequest } from "next/server";
import { GUEST_COOKIE } from "@/lib/guest";

// NextAuth's session cookie: "__Secure-" on https, ".0", ".1" when chunked.
const SESSION = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

export function proxy(request: NextRequest) {
  const cookies = request.cookies.getAll();
  const signedIn = cookies.some((c) => SESSION.test(c.name));
  const guest = cookies.some((c) => c.name === GUEST_COOKIE);
  if (signedIn || guest) return NextResponse.next();

  const url = request.nextUrl.clone();
  const next = `${url.pathname}${url.search}`;
  url.pathname = "/signin";
  url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Only the chat. Comparison, deadlines and history have their own public
  // or signed-in behaviour and stay reachable by link.
  matcher: "/",
};
