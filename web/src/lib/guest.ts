/** Set when someone chooses "Continue without an account", so the sign-in
 *  screen is not shown to them again on every visit. */
export const GUEST_COOKIE = "citetax_guest";
export const GUEST_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** A "next" that stays on this site: a path, never "//host" or a full URL. */
export function safeNext(next: string | undefined | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return null;
  }
  return next;
}
