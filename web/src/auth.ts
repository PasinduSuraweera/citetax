/**
 * NextAuth v5 with Google.
 *
 * The session JWT is signed with AUTH_SECRET, which the API also holds, so the
 * API can verify the token without a round trip back here. The role is NOT put
 * in the token: it is read from the app_user row on every request, because a
 * token is a claim the client controls the lifetime of, and a role change must
 * take effect immediately rather than at the next sign-in.
 */

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, profile }) {
      if (profile) {
        token.email = profile.email;
        token.name = profile.name;
        token.picture = profile.picture as string | undefined;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email ?? session.user.email;
        session.user.name = token.name ?? session.user.name;
      }
      return session;
    },
  },
  pages: { signIn: "/signin" },
});

/**
 * Mint the bearer token the API expects.
 *
 * NextAuth encrypts its own session cookie (JWE), which the Python side cannot
 * read, so this signs a small HS256 token carrying only identity claims. The
 * API decides the role.
 */
export async function apiToken(): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.email) return null;

  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");

  const { SignJWT } = await import("jose");
  const key = new TextEncoder().encode(secret);
  return new SignJWT({
    email: session.user.email,
    name: session.user.name ?? undefined,
    picture: session.user.image ?? undefined,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}
