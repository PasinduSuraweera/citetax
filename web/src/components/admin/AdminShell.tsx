"use client";

/**
 * The admin frame: who may see it, the navy sidebar, and the page area.
 *
 * Every admin page renders <AdminFrame>{(me) => ...}</AdminFrame>. The frame
 * loads the account once, shows the no access screen when the role is short,
 * and keeps the sidebar's snapshot and queue counts current on every page.
 */

import {
  ArrowLeft, Bot, ChevronsUpDown, Flag, Globe, HeartPulse, Inbox, Layers, Menu, ScrollText,
  Users, X, type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Logo } from "@/components/Logo";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { admin, type AdminSummary, type Me } from "@/lib/admin";
import { useSession } from "@/lib/session";

/* ---------- the sidebar's counts, shared by every page ---------- */

let summary: AdminSummary | null = null;
const listeners = new Set<() => void>();

/** Call after anything that changes a count or the live snapshot. */
export function refreshAdminSummary(): void {
  admin.summary()
    .then((s) => {
      summary = s;
      listeners.forEach((l) => l());
    })
    .catch(() => undefined);
}

function useAdminSummary(): AdminSummary | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => summary,
    () => null,
  );
}

/* ---------- the account, loaded once per page load ---------- */

let meCache: Promise<Me> | null = null;

type Gate =
  | { state: "loading" }
  | { state: "ready"; me: Me }
  | { state: "denied"; me: Me | null }
  | { state: "offline"; message: string };

export function AdminFrame({
  need = "reviewer",
  children,
}: {
  need?: "reviewer" | "admin";
  children: (me: Me) => React.ReactNode;
}) {
  const [gate, setGate] = useState<Gate>({ state: "loading" });

  const load = useCallback(() => {
    meCache ??= admin.me();
    meCache
      .then((me) => {
        const allowed = need === "admin" ? me.role === "admin" : me.is_reviewer;
        setGate(allowed ? { state: "ready", me } : { state: "denied", me });
        if (allowed && !summary) refreshAdminSummary();
      })
      .catch((e: unknown) => {
        meCache = null;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setGate({ state: "denied", me: null });
        } else {
          setGate({ state: "offline", message: e instanceof Error ? e.message : "The API did not answer." });
        }
      });
  }, [need]);

  useEffect(load, [load]);

  if (gate.state === "denied") return <NoAccess me={gate.me} need={need} />;
  if (gate.state === "offline") {
    return (
      <AdminShell me={null}>
        <AdminBody>
          <div role="alert" className="rounded-xl border border-line bg-white px-6 py-8">
            <h1 className="text-[20px] font-semibold text-ink-900">The admin API is not answering</h1>
            <p className="mt-2 text-[14px] leading-[1.6] text-ink-500">{gate.message}</p>
            <Button
              className="mt-5"
              onClick={() => {
                setGate({ state: "loading" });
                load();
              }}
            >
              Try again
            </Button>
          </div>
        </AdminBody>
      </AdminShell>
    );
  }
  return (
    <AdminShell me={gate.state === "ready" ? gate.me : null}>
      {gate.state === "ready" ? children(gate.me) : <PageSkeleton />}
    </AdminShell>
  );
}

/* ---------- layout ---------- */

type NavKey = "open_proposals" | "open_escalations" | "approved_waiting";

const NAV: Array<{ label: string; href: string; icon: LucideIcon; exact?: boolean; adminOnly?: boolean; count?: NavKey }> = [
  { label: "Review inbox", href: "/admin", icon: Inbox, exact: true, count: "open_proposals" },
  { label: "Snapshots", href: "/admin/snapshots", icon: Layers, count: "approved_waiting" },
  { label: "Escalations", href: "/admin/escalations", icon: Flag, count: "open_escalations" },
  { label: "Corpus agent", href: "/admin/agent", icon: Bot },
  { label: "Sources", href: "/admin/sources", icon: Globe },
  { label: "Corpus health", href: "/admin/health", icon: HeartPulse },
  { label: "Audit log", href: "/admin/audit", icon: ScrollText },
  { label: "Users", href: "/admin/users", icon: Users, adminOnly: true },
];

function AdminShell({ me, children }: { me: Me | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

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
    <div className="flex h-dvh overflow-hidden bg-surface">
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-background/95 px-3 backdrop-blur-sm lg:hidden">
        <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          <Menu />
        </Button>
        <Link href="/admin" aria-label="Citetax admin" className="flex items-center gap-2">
          <Logo height={24} />
          <span className="text-[13px] font-medium text-ink-400">Admin</span>
        </Link>
        <span className="w-9" />
      </header>

      {open && <div className="fixed inset-0 z-40 bg-ink-900/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}

      <aside
        aria-hidden={!open && !isDesktop}
        className={`fixed inset-y-0 left-0 z-50 flex w-[272px] flex-col bg-sidebar px-3 pb-3 pt-4 transition-transform duration-200 lg:visible lg:static lg:z-auto lg:w-[248px] lg:flex-none lg:translate-x-0 ${
          open ? "translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <Sidebar me={me} pathname={pathname} onClose={() => setOpen(false)} />
      </aside>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

function Sidebar({ me, pathname, onClose }: { me: Me | null; pathname: string; onClose: () => void }) {
  const counts = useAdminSummary();
  const { user, signOut } = useSession();

  return (
    <>
      <div className="flex items-center justify-between px-2">
        <Link href="/admin" aria-label="Citetax admin">
          <Logo height={36} tone="dark" priority />
        </Link>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close menu" className="text-white/70 hover:bg-white/10 hover:text-white lg:hidden">
          <X />
        </Button>
      </div>
      <div className="mt-1 px-2 text-[12.5px] font-medium text-white/45">Corpus admin</div>

      <nav className="mt-5 flex flex-col gap-px" aria-label="Admin">
        {NAV.filter((i) => !i.adminOnly || me?.role === "admin").map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          const n = item.count && counts ? counts[item.count] : 0;
          const urgent = item.count === "open_proposals" && (counts?.urgent ?? 0) > 0;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              aria-current={active ? "page" : undefined}
              className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-[14px] transition-colors ${
                active ? "bg-white/10 font-medium text-white" : "text-white/65 hover:bg-white/[0.05] hover:text-white"
              }`}
            >
              <Icon className={`size-4 ${active ? "text-sidebar-primary" : "text-white/45"}`} />
              {item.label}
              {n > 0 && (
                <span
                  className={`tnum ml-auto rounded-full px-1.5 text-[11.5px] font-medium leading-[18px] ${
                    urgent ? "bg-[#f28b82] text-ink-900" : "bg-white/10 text-white/75"
                  }`}
                  title={urgent ? `${counts?.urgent} need a reply within four hours` : undefined}
                >
                  {n}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <Link
        href="/admin/snapshots"
        onClick={onClose}
        className="mx-1 mb-3 rounded-lg bg-white/[0.06] px-3 py-2.5 transition-colors hover:bg-white/10"
      >
        <div className="text-[12px] text-white/50">Live snapshot</div>
        <div className="mt-0.5 truncate text-[14px] font-medium text-white">
          {counts ? counts.snapshot?.label ?? "None published" : <Skeleton className="mt-1 h-4 w-28 bg-white/10" />}
        </div>
      </Link>

      <div className="border-t border-sidebar-border pt-3">
        {me && user ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-[7px] text-left transition-colors hover:bg-white/[0.08] data-popup-open:bg-white/[0.08]">
              <UserAvatar user={user} size={32} tone="brand" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-white">{user.name ?? me.email}</span>
                <span className="block truncate text-[12.5px] text-white/50">
                  {me.role[0].toUpperCase()}
                  {me.role.slice(1)}
                </span>
              </span>
              <ChevronsUpDown className="size-4 flex-none text-white/40" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-(--anchor-width)">
              <DropdownMenuItem render={<Link href="/chat" />}>
                <ArrowLeft />
                Back to the app
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void signOut()}>
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="flex items-center gap-3 px-2 py-1">
            <Skeleton className="size-8 rounded-full bg-white/10" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24 bg-white/10" />
              <Skeleton className="h-3 w-16 bg-white/10" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** The padded, width-limited page area under the mobile header. */
export function AdminBody({ children, wide = true }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="px-5 pb-14 pt-[76px] sm:px-8 lg:px-10 lg:pt-9">
      <div className={wide ? "mx-auto w-full max-w-[1180px]" : "mx-auto w-full max-w-[880px]"}>{children}</div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <AdminBody>
      <div aria-label="Loading" className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="mt-8 h-72 w-full" />
      </div>
    </AdminBody>
  );
}

/** Shown when a signed in account lacks the role a page needs. */
function NoAccess({ me, need }: { me: Me | null; need: "reviewer" | "admin" }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-surface px-5">
      <div className="w-full max-w-[520px] rounded-xl border border-line bg-white px-7 py-8">
        <Logo height={30} />
        <h1 className="mt-6 text-[22px] font-semibold tracking-[-0.02em] text-ink-900">
          {me ? `This needs the ${need} role` : "Sign in to use the admin"}
        </h1>
        <p className="mt-3 text-[14.5px] leading-[1.6] text-ink-500">
          {me
            ? `You are signed in as ${me.email}, whose role is ${me.role}. ${
                need === "admin"
                  ? "Managing users is for admins."
                  : "Reviewing and approving tax rules needs the reviewer role or higher."
              }`
            : "The admin is for reviewers. Sign in with an account that has the reviewer role."}
        </p>
        {me && (
          <p className="mt-3 text-[13.5px] leading-[1.55] text-ink-400">
            An admin can change your role from the Users page. If there is no admin yet, add your email to
            BOOTSTRAP_ADMINS in api/.env and sign in again.
          </p>
        )}
        <div className="mt-6 flex gap-2">
          <Button nativeButton={false} render={<Link href={me && need === "admin" ? "/admin" : "/chat"} />} variant="outline">
            {me && need === "admin" ? "Back to the admin" : "Back to the app"}
          </Button>
          {!me && <Button nativeButton={false} render={<Link href="/signin?next=/admin" />}>Sign in</Button>}
        </div>
      </div>
    </div>
  );
}
