/**
 * The front door.
 *
 *   /       The homepage, for everyone. It used to send anyone signed in, or
 *           who had chosen to carry on as a guest, straight to the chat, so
 *           once someone had used Citetax they never saw it again. It now
 *           offers them "Open chat" instead.
 *   /chat   Needs a session or the guest choice. Otherwise the sign-in screen, which sends
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
import { isKnownVisitor } from "@/lib/guest";

const CHAT_PARAMS = ["c", "q", "draft"];

export function proxy(request: NextRequest) {
  const known = isKnownVisitor(request.cookies.getAll().map((c) => c.name));
  const url = request.nextUrl.clone();

  if (url.pathname === "/") {
    if (!CHAT_PARAMS.some((p) => url.searchParams.has(p))) return NextResponse.next();
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
