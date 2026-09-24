"use client";

/** Admin layout. Ported from the panel sketch in spec section 5.2. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Me } from "@/lib/admin";
import { useSession } from "@/lib/session";

function SignOutButton() {
  const { signOut } = useSession();
  return (
    <button
      type="button"
      onClick={signOut}
      title="Sign out"
      className="ml-2 flex-none rounded-md border border-white/10 px-2 py-1 font-mono text-[10px] text-white/50 transition-colors hover:border-[#F5A9A2]/50 hover:text-[#F5A9A2]"
    >
      sign out
    </button>
  );
}

const NAV = [
  { label: "Review inbox", href: "/admin", exact: true },
  { label: "Corpus agent", href: "/admin/agent" },
  { label: "Corpus health", href: "/admin/health" },
  { label: "Snapshots", href: "/admin/snapshots" },
  { label: "Sources", href: "/admin/sources" },
  { label: "Escalations", href: "/admin/escalations" },
  { label: "Audit log", href: "/admin/audit" },
  { label: "Users", href: "/admin/users", adminOnly: true },
];

interface Props {
  me: Me | null;
  snapshotLabel?: string | null;
  urgentCount?: number;
  children: React.ReactNode;
}

export function AdminShell({ me, snapshotLabel, urgentCount, children }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const [shownPath, setShownPath] = useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      {/* Mobile header */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-ink-900 px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-white/15 text-white/80 hover:bg-white/10"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1 3h14M1 8h14M1 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <span className="text-[17px] font-bold tracking-[-0.025em] text-white">Citetax</span>
        <span className="font-mono text-[10px] tracking-[0.16em] text-good-mintsoft">ADMIN</span>
        {urgentCount ? (
          <span className="ml-auto rounded-full bg-warn-600 px-[7px] py-[2px] font-mono text-[10px] font-semibold text-white">
            {urgentCount}
          </span>
        ) : null}
      </header>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink-900/50 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col overflow-y-auto bg-ink-900 px-[18px] py-6 transition-transform duration-200 lg:visible lg:static lg:z-auto lg:w-[236px] lg:flex-none lg:translate-x-0 lg:overflow-hidden ${
          open ? "translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <Link href="/admin">
          <div className="text-[20px] font-bold leading-none tracking-[-0.025em] text-white">
            Citetax
          </div>
          <div className="mt-[5px] font-mono text-[10px] tracking-[0.16em] text-good-mintsoft">
            ADMIN
          </div>
        </Link>

        <nav className="mt-7 flex flex-col gap-px">
          {NAV.filter((i) => !i.adminOnly || me?.role === "admin").map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center justify-between rounded-lg px-[11px] py-2 transition-colors ${
                  active ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
                }`}
              >
                <span
                  className={`text-[13.5px] font-medium ${
                    active ? "text-white" : "text-white/50"
                  }`}
                >
                  {item.label}
                </span>
                {item.exact && urgentCount ? (
                  <span className="rounded-full bg-warn-600 px-[6px] py-[1px] font-mono text-[10px] font-semibold text-white">
                    {urgentCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <Link
          href="/chat"
          className="mb-3 rounded-lg border border-white/10 px-[11px] py-2 text-center text-[12.5px] text-white/60 transition-colors hover:border-white/25 hover:text-white"
        >
          Back to the app
        </Link>

        <div className="border-t border-white/10 pt-[14px]">
          <div className="font-mono text-[10px] tracking-[0.14em] text-white/30">
            CURRENT SNAPSHOT
          </div>
          <div className="mt-[6px] text-[13px] font-medium text-white/80">
            {snapshotLabel ?? "none published"}
          </div>
          {me && (
            <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3">
              <div className="min-w-0">
                <div className="truncate text-[12px] text-white/70">{me.email}</div>
                <div className="mt-1 inline-block rounded bg-white/10 px-[6px] py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-good-mintsoft">
                  {me.role}
                </div>
              </div>
              <SignOutButton />
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto pt-14 lg:pt-0">{children}</main>
    </div>
  );
}

/** Shown when a signed in account lacks the reviewer role. */
export function NoAccess({ me }: { me: Me | null }) {
  return (
    <div className="flex h-screen items-center justify-center bg-surface px-8">
      <div className="max-w-[520px] rounded-xl border border-line bg-white px-8 py-8">
        <div className="eyebrow">ADMIN PANEL</div>
        <h1 className="mt-3 text-[24px] font-semibold tracking-[-0.02em] text-ink-900">
          You do not have reviewer access
        </h1>
        <p className="mt-3 text-[14px] leading-[1.6] text-ink-500">
          {me
            ? `You are signed in as ${me.email} with the ${me.role} role. Reviewing and approving tax rules needs the reviewer role or higher.`
            : "Sign in with an account that has the reviewer role."}
        </p>
        <p className="mt-4 text-[13px] leading-[1.55] text-ink-400">
          An admin can grant it from the Users screen. If no admin exists yet,
          add your email to BOOTSTRAP_ADMINS in api/.env and sign in again.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            href="/chat"
            className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 hover:border-brand-600"
          >
            Back to the app
          </Link>
          {!me && (
            <Link
              href="/signin"
              className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
