"use client";

/**
 * The sidebar on desktop, a drawer under lg.
 *
 * Most Sri Lankan filers open this on a phone (spec section 6.2 addition 11),
 * so the sidebar collapses behind a slim header bar rather than taking half
 * the screen.
 */

import {
  CalendarClock, ChevronsUpDown, GitCompareArrows, History, Menu, MessageSquare, ShieldCheck, SquarePen, X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, type Me } from "@/lib/admin";
import { requestNewQuestion } from "@/lib/ask-store";
import { useSession } from "@/lib/session";
import { ConversationList } from "./ConversationList";
import { Logo } from "./Logo";
import { UserAvatar } from "./UserAvatar";

const NAV: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: "Chat", href: "/chat", icon: MessageSquare },
  { label: "History", href: "/history", icon: History },
  { label: "What changed", href: "/compare", icon: GitCompareArrows },
  { label: "Deadlines", href: "/deadlines", icon: CalendarClock },
];

export const SUPPORTED_YAS = ["2026/2027", "2025/2026"] as const;
export type YA = (typeof SUPPORTED_YAS)[number];

interface Props {
  ya: YA;
  onYaChange: (ya: YA) => void;
}

// One fetch of the API role per page load, shared by every Shell instance.
let meCache: Me | null | undefined;

export function Shell(props: Props) {
  const [open, setOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const pathname = usePathname();

  // aria-hidden must not apply at lg, where the same element is the sidebar
  // and is on screen. Tailwind cannot express that, so it is measured.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Any navigation closes the drawer, otherwise it hangs over the new page.
  const [shownPath, setShownPath] = useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    setOpen(false);
  }

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
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-background/95 px-3 backdrop-blur-sm lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
        >
          <Menu />
        </Button>
        <Link href="/chat" aria-label="Citetax">
          <Logo height={26} />
        </Link>
        <span className="tnum w-9 text-right text-[12px] text-ink-400">{props.ya.slice(2, 4)}/{props.ya.slice(7)}</span>
      </header>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink-900/30 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* A drawer translated off screen still takes focus and still reads to a
          screen reader, so it is made invisible below lg when closed. */}
      <aside
        aria-hidden={!open && !isDesktop}
        className={`fixed inset-y-0 left-0 z-50 flex w-[284px] flex-col border-r border-sidebar-border bg-sidebar px-3 pb-3 pt-4 transition-transform duration-200 lg:visible lg:static lg:z-auto lg:w-[264px] lg:flex-none lg:translate-x-0 ${
          open ? "translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <SidebarContent {...props} onNavigate={() => setOpen(false)} />
      </aside>
    </>
  );
}

function SidebarContent({ ya, onYaChange, onNavigate }: Props & { onNavigate: () => void }) {
  const pathname = usePathname();
  const { user, loading, signOut } = useSession();
  const [fetchedMe, setMe] = useState<Me | null>(meCache ?? null);
  const me = user ? fetchedMe : null;

  useEffect(() => {
    if (!user) {
      meCache = undefined;
      return;
    }
    if (meCache !== undefined) return;
    admin.me()
      .then((m) => { meCache = m; setMe(m); })
      .catch(() => { meCache = null; });
  }, [user]);

  const newQuestion = useCallback(() => {
    onNavigate();
    // On /chat this starts a fresh draft; elsewhere the Link navigation does.
    // No conversation is created, and none is cleared, until the first
    // question of the new chat is sent.
    requestNewQuestion();
  }, [onNavigate]);

  return (
    <>
      <div className="flex items-center justify-between px-2">
        <Link href="/chat" onClick={newQuestion} aria-label="Citetax, new chat">
          <Logo height={40} tone="dark" priority />
        </Link>
        <Button variant="ghost" size="icon-sm" onClick={onNavigate} aria-label="Close menu" className="text-white/70 hover:bg-white/10 hover:text-white lg:hidden">
          <X />
        </Button>
      </div>

      <Link
        href="/chat"
        onClick={newQuestion}
        className="mt-5 flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 text-[14px] font-medium text-white ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/15 active:bg-white/20"
      >
        <SquarePen className="size-4 text-white/70" />
        New chat
        <kbd className="ml-auto hidden text-[11.5px] font-normal text-white/40 lg:inline">Ctrl K</kbd>
      </Link>

      <nav className="mt-4 flex flex-col gap-px">
        {NAV.map((item) => (
          <NavItem
            key={item.href}
            {...item}
            active={pathname.startsWith(item.href)}
            onClick={item.href === "/chat" ? newQuestion : onNavigate}
          />
        ))}
        {me?.is_reviewer && (
          <NavItem label="Admin" href="/admin" icon={ShieldCheck} active={false} onClick={onNavigate} />
        )}
      </nav>

      {/* Every rule resolves against the year of assessment, so the year is
          always visible and never implicit (spec section 6.1). */}
      <div className="mt-5 px-2">
        <div id="ya-label" className="text-[12px] font-medium text-white/50">Year of assessment</div>
        <div role="radiogroup" aria-labelledby="ya-label" className="mt-2 grid grid-cols-2 rounded-lg bg-white/[0.07] p-[3px]">
          {SUPPORTED_YAS.map((year) => {
            const selected = year === ya;
            return (
              <button
                key={year}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onYaChange(year)}
                className={`tnum rounded-md py-[5px] text-[13px] transition-colors ${
                  selected ? "bg-white font-medium text-ink-900" : "text-white/60 hover:text-white"
                }`}
              >
                {year}
              </button>
            );
          })}
        </div>
      </div>

      {/* Signed in, recent chats take the free height and scroll on their
          own. The list reads ?c=, which needs a Suspense boundary on pages
          that are prerendered. */}
      {user ? (
        <Suspense fallback={<div className="flex-1" />}>
          <ConversationList onNavigate={onNavigate} />
        </Suspense>
      ) : (
        <div className="flex-1" />
      )}

      <div className="mt-3 border-t border-sidebar-border pt-3">
        {loading ? (
          <div className="flex items-center gap-3 px-2 py-1">
            <Skeleton className="size-8 rounded-full bg-white/10" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24 bg-white/10" />
              <Skeleton className="h-3 w-32 bg-white/10" />
            </div>
          </div>
        ) : user ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-[7px] text-left transition-colors hover:bg-white/[0.08] data-popup-open:bg-white/[0.08]">
              <UserAvatar user={user} size={32} tone="brand" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-white">
                  {user.name ?? user.email}
                </span>
                <span className="block truncate text-[12.5px] text-white/50">
                  {me?.is_reviewer ? `${me.role[0].toUpperCase()}${me.role.slice(1)}` : user.email}
                </span>
              </span>
              <ChevronsUpDown className="size-4 flex-none text-white/40" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-(--anchor-width)">
              <DropdownMenuItem render={<Link href="/profile" onClick={onNavigate} />}>Account</DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/history" onClick={onNavigate} />}>History</DropdownMenuItem>
              {me?.is_reviewer && (
                <DropdownMenuItem render={<Link href="/admin" onClick={onNavigate} />}>Admin</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => void signOut()}>
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="px-2 py-1">
            <p className="text-[13px] leading-[1.5] text-white/60">
              Sign in to keep your chats and history.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <Link
                href="/signin"
                onClick={onNavigate}
                className="inline-flex h-8 items-center rounded-lg bg-white px-3 text-[13.5px] font-medium text-ink-900 hover:bg-white/90"
              >
                Sign in
              </Link>
              <Link href="/signin?mode=signup" onClick={onNavigate} className="text-[13.5px] text-white/60 hover:text-white">
                Create account
              </Link>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function NavItem({
  label, href, icon: Icon, active, onClick,
}: {
  label: string;
  href: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-[14px] transition-colors ${
        active ? "bg-white/10 font-medium text-white" : "text-white/65 hover:bg-white/[0.05] hover:text-white"
      }`}
    >
      <Icon className={`size-4 ${active ? "text-sidebar-primary" : "text-white/45"}`} />
      {label}
    </Link>
  );
}

/** Every page wraps its main content in this so the mobile header does not
 *  overlap it and the padding scales down on a phone. */
export function PageBody({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="flex-1 overflow-y-auto px-5 pb-12 pt-[76px] sm:px-8 lg:px-12 lg:pb-12 lg:pt-10">
      <div className={wide ? "mx-auto w-full max-w-[1200px]" : "mx-auto w-full max-w-[880px]"}>
        {children}
      </div>
    </main>
  );
}
