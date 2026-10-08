/** Set when someone chooses "Continue without an account", so the sign-in
 *  screen is not shown to them again on every visit. */
export const GUEST_COOKIE = "citetax_guest";
export const GUEST_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// NextAuth's session cookie: "__Secure-" on https, ".0", ".1" when chunked.
const SESSION = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

/** Signed in, or chose to carry on as a guest. A cookie check only: it picks
 *  which screen or button to show, not who may do what. */
export function isKnownVisitor(names: string[]): boolean {
  return names.some((n) => SESSION.test(n) || n === GUEST_COOKIE);
}

/** A "next" that stays on this site: a path, never "//host" or a full URL. */
export function safeNext(next: string | undefined | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return null;
  }
  return next;
}
