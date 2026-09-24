"use client";

/**
 * The person asking: their Google picture when signed in, their initials if
 * there is no picture, and "You" for a guest.
 */

import { initials, useSession, type SessionUser } from "@/lib/session";

interface Props {
  /** Defaults to whoever is signed in. */
  user?: SessionUser | null;
  size?: number;
  /** Colours for the initials and "You" badges. */
  tone?: "dark" | "brand";
}

export function UserAvatar({ user, size = 26, tone = "dark" }: Props) {
  const session = useSession();
  const who = user === undefined ? session.user : user;
  const box = { width: size, height: size };
  const text = { fontSize: Math.round(size * 0.4) };

  if (who?.image) {
    return (
      // A remote Google avatar; next/image would need its host configured.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={who.image}
        alt={who.name ?? who.email}
        referrerPolicy="no-referrer"
        style={box}
        className="flex-none rounded-full object-cover"
      />
    );
  }
  return (
    <span
      style={{ ...box, ...text }}
      aria-hidden={!who}
      className={`flex flex-none items-center justify-center rounded-full font-semibold text-white ${
        tone === "brand" ? "bg-brand-600" : "bg-ink-900"
      }`}
    >
      {who ? initials(who) : "You"}
    </span>
  );
}
