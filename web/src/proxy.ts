/**
 * The front door.
 *
 *   /       The homepage, for someone who has not used Citetax yet. Anyone
 *           signed in, or who chose to carry on as a guest, goes to the chat.
 *   /chat   Needs one of those two. Otherwise the sign-in screen, which sends
 *           them back to what they asked for (a ?c= chat, a ?q= question).
 *
 * Links from before the chat moved ("/?c=...", "/?q=...", "/?draft=...") are
 * forwarded to /chat with their query intact.
 *
 * This is an optimistic check on cookies only, as Next recommends for proxy:
 * it picks which screen to show, not who may do what. The API checks the
 * token on every request that needs an account.
 */

import { NextResponse, type NextRequest } from "next/server";
import { GUEST_COOKIE } from "@/lib/guest";

// NextAuth's session cookie: "__Secure-" on https, ".0", ".1" when chunked.
const SESSION = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;
const CHAT_PARAMS = ["c", "q", "draft"];

export function proxy(request: NextRequest) {
  const cookies = request.cookies.getAll();
  const known =
    cookies.some((c) => SESSION.test(c.name)) || cookies.some((c) => c.name === GUEST_COOKIE);
  const url = request.nextUrl.clone();

  if (url.pathname === "/") {
    const oldChatLink = CHAT_PARAMS.some((p) => url.searchParams.has(p));
    if (!oldChatLink && !known) return NextResponse.next();
    url.pathname = "/chat";
    return NextResponse.redirect(url);
  }

  if (known) return NextResponse.next();
  const next = `${url.pathname}${url.search}`;
  url.pathname = "/signin";
  url.search = `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/", "/chat"],
};
