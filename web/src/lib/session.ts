"use client";

/**
 * Who is signed in, for the client.
 *
 * NextAuth serves the session at /api/auth/session. This hook reads it once,
 * caches it module wide so every Shell on every page does not refetch, and
 * exposes sign out. The API role is fetched separately through /admin/me and
 * only when a component needs it, because the session cookie carries identity
 * and never a role.
 */

import { useCallback, useEffect, useState } from "react";
import { signOut as nextSignOut } from "next-auth/react";
import { clearToken } from "./api";

export interface SessionUser {
  email: string;
  name: string | null;
  image: string | null;
}

interface SessionState {
  user: SessionUser | null;
  loading: boolean;
}

let cache: SessionUser | null | undefined; // undefined = not fetched yet
let inflight: Promise<SessionUser | null> | null = null;
const listeners = new Set<(u: SessionUser | null) => void>();

async function fetchSession(): Promise<SessionUser | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/auth/session", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        user?: { email?: string | null; name?: string | null; image?: string | null };
      };
      if (!body?.user?.email) return null;
      return {
        email: body.user.email,
        name: body.user.name ?? null,
        image: body.user.image ?? null,
      };
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  const user = await inflight;
  cache = user;
  listeners.forEach((fn) => fn(user));
  return user;
}

export function useSession(): SessionState & { signOut: () => Promise<void>; refresh: () => Promise<void> } {
  const [user, setUser] = useState<SessionUser | null>(cache ?? null);
  const [loading, setLoading] = useState(cache === undefined);

  useEffect(() => {
    listeners.add(setUser);
    if (cache === undefined) {
      fetchSession().finally(() => setLoading(false));
    }
    return () => {
      listeners.delete(setUser);
    };
  }, []);

  const signOut = useCallback(async () => {
    clearToken();
    cache = null;
    listeners.forEach((fn) => fn(null));
    await nextSignOut({ redirectTo: "/" });
  }, []);

  const refresh = useCallback(async () => {
    cache = undefined;
    setLoading(true);
    await fetchSession();
    setLoading(false);
  }, []);

  return { user, loading, signOut, refresh };
}

/** Initials for the avatar chip when Google gave no picture. */
export function initials(user: SessionUser): string {
  const src = user.name?.trim() || user.email;
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}
