"use client";

/**
 * Left rail on desktop, slide-in drawer under lg.
 *
 * Ported from UI/Shell.dc.html. Most Sri Lankan filers open this on a phone
 * (spec section 6.2 addition 11), so the rail collapses behind a header bar
 * rather than eating half the viewport.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import type { Snapshot } from "@/lib/api";
import { admin, type Me } from "@/lib/admin";
import { requestNewQuestion } from "@/lib/ask-store";
import { initials, useSession } from "@/lib/session";
import { ConversationList } from "./ConversationList";

const NAV = [
  { label: "Ask", href: "/" },
  { label: "History", href: "/history" },
  { label: "Comparison", href: "/compare" },
  { label: "Deadlines", href: "/deadlines" },
  { label: "My account", href: "/profile" },
];

export const SUPPORTED_YAS = ["2026/2027", "2025/2026"] as const;
export type YA = (typeof SUPPORTED_YAS)[number];

interface Props {
  ya: YA;
  onYaChange: (ya: YA) => void;
  snapshot: Snapshot | null;
  ruleCount?: number | null;
  onSnapshotClick?: () => void;
}

// One fetch of the API role per page load, shared by every Shell instance.
let meCache: Me | null | undefined;

export function Shell(props: Props) {
  const [open, setOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const pathname = usePathname();

  // aria-hidden must not apply at lg, where the same element is the rail and
  // is genuinely on screen. Tailwind cannot express that, so it is measured.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Any navigation closes the drawer, otherwise it hangs over the new page.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    // Lock the body so the page behind the drawer does not scroll with it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      {/* Mobile header. Hidden from lg up, where the rail is always visible. */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-ink-900 px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 text-white/80 transition-colors hover:bg-white/10"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1 3h14M1 8h14M1 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <Link href="/" className="text-[17px] font-bold tracking-[-0.025em] text-white">
          Citetax
        </Link>
        <span className="font-mono text-[10.5px] text-white/50">
          {props.ya.replace("/", " / ")}
        </span>
      </header>

      {/* Scrim */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink-900/50 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* A drawer translated off screen still takes focus and still reads to a
          screen reader, so it is made inert below lg when closed. `invisible`
          also stops it being a tab stop, and lifts at lg where it is the rail. */}
      <aside
        aria-hidden={!open && !isDesktop}
        className={`fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col overflow-y-auto bg-ink-900 px-[18px] py-6 transition-transform duration-200 lg:visible lg:static lg:z-auto lg:w-[252px] lg:flex-none lg:translate-x-0 lg:overflow-hidden ${
          open ? "translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <RailContent {...props} onNavigate={() => setOpen(false)} />
      </aside>
    </>
  );
}

function RailContent({
  ya, onYaChange, snapshot, ruleCount, onSnapshotClick, onNavigate,
}: Props & { onNavigate: () => void }) {
  const pathname = usePathname();
  const { user, loading, signOut } = useSession();
  const [me, setMe] = useState<Me | null>(meCache ?? null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!user) {
      meCache = null;
      setMe(null);
      return;
    }
    if (meCache !== undefined) return;
    admin.me()
      .then((m) => { meCache = m; setMe(m); })
      .catch(() => { meCache = null; });
  }, [user]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const newQuestion = useCallback(() => {
    onNavigate();
    // On "/" this starts a fresh draft; elsewhere the Link navigation does.
    // Either way no conversation is created, and none is cleared, until the
    // first question of the new chat is sent.
    requestNewQuestion();
  }, [onNavigate]);

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <Link href="/" className="block min-w-0" onClick={onNavigate}>
          <div className="text-2xl font-bold leading-none tracking-[-0.025em] text-white">
            Citetax
          </div>
          <div className="mt-[5px] text-xs leading-[1.4] tracking-[0.01em] text-white/45">
            Every number, cited.
          </div>
        </Link>
        <button
          type="button"
          onClick={onNavigate}
          aria-label="Close menu"
          className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white lg:hidden"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <Link
        href="/"
        onClick={newQuestion}
        className="mt-6 flex items-center justify-between rounded-[9px] bg-brand-600 px-3 py-[10px] transition-colors hover:bg-brand-700"
      >
        <span className="text-[13.5px] font-semibold text-white">+ New chat</span>
        <span className="hidden font-mono text-[10.5px] font-medium text-white/55 lg:inline">⌘K</span>
      </Link>

      <nav className="mt-[18px] flex flex-col gap-px">
        {NAV.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.label}
              href={item.href}
              onClick={item.href === "/" ? newQuestion : onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-[9px] rounded-lg px-[11px] py-2 transition-colors ${
                active ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
              }`}
            >
              <span
                className={`h-1 w-1 flex-none rounded-full ${
                  active ? "bg-good-mint" : "bg-white/[0.18]"
                }`}
              />
              <span
                className={`text-[13.5px] font-medium ${
                  active ? "text-white" : "text-white/50"
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}

        {me?.is_reviewer && (
          <Link
            href="/admin"
            onClick={onNavigate}
            className="mt-1 flex items-center justify-between rounded-lg border border-white/10 px-[11px] py-2 transition-colors hover:border-white/25 hover:bg-white/[0.04]"
          >
            <span className="flex items-center gap-[9px]">
              <span className="h-1 w-1 flex-none rounded-full bg-good-mintsoft" />
              <span className="text-[13.5px] font-medium text-white/70">Admin panel</span>
            </span>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-good-mintsoft">
              {me.role}
            </span>
          </Link>
        )}
      </nav>

      {/* The year of assessment is the axis every rule resolves against, so it
          is always visible and never implicit (spec section 6.1). */}
      <div className="mb-[9px] mt-[26px] font-mono text-[10px] font-medium tracking-[0.16em] text-white/[0.32]">
        YEAR OF ASSESSMENT
      </div>
      <div className="flex flex-col gap-1">
        {SUPPORTED_YAS.map((year) => {
          const selected = year === ya;
          return (
            <button
              key={year}
              type="button"
              onClick={() => onYaChange(year)}
              aria-pressed={selected}
              className={`flex items-baseline justify-between rounded-lg px-[11px] py-[9px] text-left transition-colors ${
                selected
                  ? "border border-white/[0.13] bg-white/[0.09]"
                  : "border border-transparent hover:bg-white/[0.05]"
              }`}
            >
              <span
                className={`font-mono text-[13.5px] tracking-[-0.01em] ${
                  selected ? "font-semibold text-white" : "font-medium text-white/[0.42]"
                }`}
              >
                {year.replace("/", " / ")}
              </span>
              <span
                className={`font-mono text-[9.5px] font-medium tracking-[0.08em] ${
                  selected ? "text-good-mintsoft" : "text-white/[0.28]"
                }`}
              >
                {selected ? "SELECTED" : "SWITCH"}
              </span>
            </button>
          );
        })}
      </div>

      {/* Signed in, Recent takes the free height and scrolls on its own.
          Signed out there is nothing to list and the spacer keeps the account
          block at the bottom. The list reads the ?c= param, which needs a
          Suspense boundary on pages that are prerendered. */}
      {user ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ConversationList onNavigate={onNavigate} />
        </Suspense>
      ) : (
        <div className="flex-1" />
      )}

      {/* Account */}
      <div className="relative mb-3 mt-6">
        {loading ? (
          <div className="h-[46px] animate-pulse rounded-lg bg-white/[0.04]" />
        ) : user ? (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex w-full items-center gap-[10px] rounded-lg border border-white/10 px-[10px] py-2 text-left transition-colors hover:border-white/25 hover:bg-white/[0.04]"
            >
              <Avatar user={user} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-white/85">
                  {user.name ?? user.email}
                </span>
                <span className="block truncate font-mono text-[10px] text-white/40">
                  {me?.role ?? user.email}
                </span>
              </span>
              <span className="font-mono text-[10px] text-white/40">▾</span>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="fade-up absolute bottom-[calc(100%+6px)] left-0 right-0 overflow-hidden rounded-lg border border-white/10 bg-[#141B3A] shadow-[0_18px_40px_-20px_rgba(0,0,0,0.7)]"
                onClick={(e) => e.stopPropagation()}
              >
                <Link href="/profile" role="menuitem" onClick={onNavigate}
                  className="block px-3 py-[9px] text-[12.5px] text-white/75 hover:bg-white/[0.06] hover:text-white">
                  My account
                </Link>
                <Link href="/history" role="menuitem" onClick={onNavigate}
                  className="block px-3 py-[9px] text-[12.5px] text-white/75 hover:bg-white/[0.06] hover:text-white">
                  My history
                </Link>
                {me?.is_reviewer && (
                  <Link href="/admin" role="menuitem" onClick={onNavigate}
                    className="block px-3 py-[9px] text-[12.5px] text-white/75 hover:bg-white/[0.06] hover:text-white">
                    Admin panel
                  </Link>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={signOut}
                  className="block w-full border-t border-white/10 px-3 py-[9px] text-left text-[12.5px] text-[#F5A9A2] hover:bg-white/[0.06]"
                >
                  Sign out
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <Link
              href="/signin"
              onClick={onNavigate}
              className="rounded-lg bg-white/[0.09] px-3 py-[9px] text-center text-[12.5px] font-semibold text-white transition-colors hover:bg-white/[0.14]"
            >
              Sign in
            </Link>
            <Link
              href="/signin?mode=signup"
              onClick={onNavigate}
              className="text-center font-mono text-[10.5px] text-white/40 transition-colors hover:text-white/70"
            >
              or create an account
            </Link>
          </div>
        )}
      </div>

      {/* Spec section 6.2 addition 1: the snapshot is clickable, not a passive date. */}
      <button
        type="button"
        onClick={onSnapshotClick}
        disabled={!snapshot}
        className="border-t border-white/10 pt-[14px] text-left disabled:cursor-default"
      >
        <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-white/30">
          CORPUS SNAPSHOT
        </div>
        <div className="mt-[6px] text-[13px] font-medium text-white/80">
          {snapshot?.label ?? "not published"}
        </div>
        <div className="mt-[9px] flex items-center gap-[6px]">
          <span
            className={`h-[5px] w-[5px] flex-none rounded-full ${
              snapshot ? "bg-good-mint" : "bg-warn-600"
            }`}
          />
          <span className="text-[11.5px] text-white/45">
            {ruleCount != null
              ? `${ruleCount} rule versions indexed`
              : snapshot
                ? "what changed"
                : "run the seed script"}
          </span>
        </div>
      </button>
    </>
  );
}

function Avatar({ user }: { user: { image: string | null; name: string | null; email: string } }) {
  if (user.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        className="h-[26px] w-[26px] flex-none rounded-full"
      />
    );
  }
  return (
    <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-brand-600 text-[10.5px] font-semibold text-white">
      {initials(user)}
    </span>
  );
}

/** Every page wraps its main content in this so the mobile header does not
 *  overlap it and the padding scales down on a phone. */
export function PageBody({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="flex-1 overflow-y-auto px-4 pb-10 pt-[72px] sm:px-6 lg:px-11 lg:pb-9 lg:pt-9">
      <div className={wide ? "mx-auto w-full max-w-[1400px]" : "mx-auto w-full max-w-[1000px]"}>
        {children}
      </div>
    </main>
  );
}
