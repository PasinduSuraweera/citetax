"use client";

/**
 * Every answer this account has been given, each with the rules it was worked
 * out from. Answers are listed by day; opening one shows it exactly as it was
 * released, in a panel over the list. Nothing is worked out again.
 */

import {
  BookOpenText, Calculator, CalendarClock, FileCheck2, GitCompareArrows, History as HistoryIcon,
  Landmark, MessageSquare, RotateCcw, Search, Trash2, type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ComputationTable } from "@/components/ComputationTable";
import { PageBody, Shell } from "@/components/Shell";
import { useYa } from "@/lib/years";
import { INTENT_LABEL } from "@/components/TurnSummary";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, formatDate, money } from "@/lib/api";

type Run = Awaited<ReturnType<typeof api.history>>["runs"][number];
type Detail = Awaited<ReturnType<typeof api.historyDetail>>;

const INTENT_ICON: Record<string, LucideIcon> = {
  compute: Calculator,
  obligation: FileCheck2,
  deadline: CalendarClock,
  compare: GitCompareArrows,
  rule_lookup: BookOpenText,
  general: Landmark,
};

const DAY = 24 * 60 * 60 * 1000;

function dayGroup(iso: string | null, today: number): string {
  if (!iso) return "Earlier";
  const age = today - new Date(iso).setHours(0, 0, 0, 0);
  if (age <= 0) return "Today";
  if (age <= DAY) return "Yesterday";
  if (age <= 7 * DAY) return "Previous 7 days";
  if (age <= 30 * DAY) return "Previous 30 days";
  return "Earlier";
}

function timeOf(iso: string | null, group: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return group === "Today" || group === "Yesterday"
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default function HistoryPage() {
  const [ya, setYa] = useYa();
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setRuns((await api.history()).runs);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
        else setError(e instanceof Error ? e.message : "History could not be loaded.");
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const show = useCallback(async (id: string) => {
    setOpening(id);
    try {
      setOpen(await api.historyDetail(id));
    } catch {
      toast.error("That answer could not be opened. Try again.");
    } finally {
      setOpening(null);
    }
  }, []);

  // Removing an answer takes it off this account. The computation itself is
  // kept, with no link to anyone, as the audit record (see the API).
  const remove = useCallback(async (id: string) => {
    try {
      await api.removeFromHistory(id);
      setRuns((rs) => rs.filter((r) => r.id !== id));
      setOpen((o) => (o?.id === id ? null : o));
      toast.success("Removed from your history", {
        description: "The calculation is kept without your name, for audit.",
      });
    } catch {
      toast.error("That answer could not be removed. Try again.");
    }
  }, []);

  const clearAll = async () => {
    setClearing(true);
    try {
      const { removed } = await api.clearHistory();
      setRuns([]);
      setOpen(null);
      setConfirmClear(false);
      toast.success(removed === 1 ? "1 answer cleared" : `${removed} answers cleared`, {
        description: "Your chats are separate and have not changed.",
      });
    } catch {
      toast.error("History could not be cleared. Try again.");
    } finally {
      setClearing(false);
    }
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = new Date().setHours(0, 0, 0, 0);
    const out: Array<[string, Run[]]> = [];
    for (const r of runs) {
      if (q && !(r.question ?? "").toLowerCase().includes(q)) continue;
      const g = dayGroup(r.created_at, today);
      const last = out[out.length - 1];
      if (last && last[0] === g) last[1].push(r);
      else out.push([g, [r]]);
    }
    return out;
  }, [runs, query]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Shell ya={ya} onYaChange={setYa} />
      <PageBody>
        <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900">History</h1>
        <p className="mt-2 max-w-[60ch] text-[15px] leading-[1.6] text-ink-500">
          Your answers, each kept with the rules it was worked out from.
        </p>

        {runs.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-300" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your questions"
                aria-label="Search your questions"
                className="h-10 w-full rounded-lg border border-input bg-white pl-9 pr-3 text-[14.5px] text-ink-900 outline-none placeholder:text-ink-300 focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-600/15"
              />
            </div>
            {!confirmClear && (
              <Button variant="ghost" onClick={() => setConfirmClear(true)} className="h-10 text-ink-500">
                <Trash2 />
                Clear history
              </Button>
            )}
          </div>
        )}

        {confirmClear && (
          <div role="alertdialog" aria-label="Clear history" className="fade-up mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-warn-100 px-4 py-3">
            <p className="min-w-0 flex-1 text-[14px] leading-[1.5] text-warn-700">
              Clear all {runs.length} {runs.length === 1 ? "answer" : "answers"}? Your chats stay as they are.
            </p>
            <Button onClick={() => void clearAll()} disabled={clearing} className="h-9 bg-warn-600 text-white hover:bg-warn-700">
              {clearing ? "Clearing" : "Clear history"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmClear(false)} className="h-9">
              Cancel
            </Button>
          </div>
        )}

        {!ready && (
          <div className="mt-8 flex flex-col gap-3" aria-label="Loading history">
            <Skeleton className="h-3 w-20" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        )}

        {needsAuth && (
          <div className="mt-8 rounded-xl bg-muted px-6 py-6">
            <h2 className="text-[16px] font-semibold text-ink-900">Sign in to see your history</h2>
            <p className="mt-1 max-w-[56ch] text-[14.5px] leading-[1.6] text-ink-500">
              Answers are kept against your account so only you can see them.
              Questions asked without an account still work, they are just not kept.
            </p>
            <Button nativeButton={false} render={<Link href="/signin?next=%2Fhistory" />} className="mt-4 h-10 px-4">
              Sign in with Google
            </Button>
          </div>
        )}

        {error && (
          <div role="alert" className="mt-8 rounded-lg bg-warn-100 px-5 py-4 text-[14px] text-warn-700">{error}</div>
        )}

        {ready && !needsAuth && runs.length === 0 && !error && (
          <div className="mt-10 flex flex-col items-start">
            <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-ink-400">
              <HistoryIcon className="size-5" />
            </span>
            <h2 className="mt-4 text-[16px] font-semibold text-ink-900">No answers yet</h2>
            <p className="mt-1 max-w-[52ch] text-[14.5px] leading-[1.6] text-ink-500">
              Ask a question and it will be listed here with the rules it used.
            </p>
            <Button nativeButton={false} render={<Link href="/chat" />} className="mt-4 h-10 px-4">
              <MessageSquare />
              Ask a question
            </Button>
          </div>
        )}

        {runs.length > 0 && groups.length === 0 && (
          <p className="mt-10 text-[14.5px] text-ink-500">No questions match &ldquo;{query}&rdquo;.</p>
        )}

        {groups.map(([label, items]) => (
          <section key={label} className="mt-8">
            <h2 className="px-1 text-[13px] font-medium text-ink-400">{label}</h2>
            <ul className="mt-2 flex flex-col">
              {items.map((r) => {
                const Icon = INTENT_ICON[r.intent ?? ""] ?? MessageSquare;
                const notes = [
                  INTENT_LABEL[r.intent ?? ""] ?? "Answer",
                  r.ya,
                  r.badge === "partial" ? "Explanation withheld" : r.badge === "cannot_answer" ? "Declined" : null,
                ].filter(Boolean) as string[];
                return (
                  <li key={r.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => void show(r.id)}
                      className={`-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-lg px-3 py-3 text-left sm:pr-12 transition-colors hover:bg-panel ${
                        open?.id === r.id || opening === r.id ? "bg-panel" : ""
                      }`}
                    >
                      <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-brand-050 text-brand-600">
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] text-ink-900">{r.question ?? "Question not recorded"}</span>
                        <span className="mt-0.5 flex gap-3 text-[13px] text-ink-400">
                          {notes.map((n, i) => (
                            <span key={n} className={`truncate ${i > 0 ? "hidden sm:inline" : ""}`}>{n}</span>
                          ))}
                        </span>
                      </span>
                      <span className="flex flex-none flex-col items-end">
                        {/* A figure only for a tax computation: on a filing
                            question a balance of 0 would read as the answer. */}
                        {r.intent === "compute" && r.balance_payable && (
                          <span className="tnum text-[14.5px] font-medium text-ink-900">LKR {money(r.balance_payable)}</span>
                        )}
                        <span className="tnum text-[12.5px] text-ink-400">{timeOf(r.created_at, label)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(r.id)}
                      aria-label="Remove from history"
                      title="Remove from history"
                      className="absolute -right-2 top-1/2 hidden size-8 -translate-y-1/2 items-center justify-center rounded-md text-ink-300 opacity-0 transition-opacity hover:bg-warn-100 hover:text-warn-600 focus-visible:opacity-100 group-hover:opacity-100 sm:flex"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </PageBody>

      <Sheet open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
          {open && (
            <>
              <SheetHeader className="border-b border-line px-6 pb-5 pt-6">
                <span className="self-start rounded-md bg-brand-050 px-2 py-0.5 text-[12.5px] font-medium text-brand-700">
                  {INTENT_LABEL[open.intent ?? ""] ?? "Answer"}
                </span>
                <SheetTitle className="mt-2 pr-8 text-[18px] font-semibold leading-[1.4] text-ink-900">
                  {open.question ?? "Question not recorded"}
                </SheetTitle>
                <SheetDescription className="tnum text-[13.5px] text-ink-500">
                  {[
                    open.ya,
                    open.created_at ? `asked ${formatDate(open.created_at.slice(0, 10))}` : null,
                    open.snapshot.label ? `rules as of ${open.snapshot.label}` : null,
                  ].filter(Boolean).join(", ")}
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-4 px-6 py-5">
                {open.ledger?.balance_payable && (
                  <div>
                    <div className="text-[13px] font-medium text-ink-400">
                      {open.ledger.is_refund ? "Refund due" : "Balance payable"}
                    </div>
                    <div className="mt-1 flex items-baseline gap-2 text-ink-900">
                      <span className="text-[18px] font-medium text-ink-300">LKR</span>
                      <span className="tnum text-[34px] font-semibold tracking-[-0.03em]">
                        {money(String(open.ledger.balance_payable).replace(/^-/, ""))}
                      </span>
                    </div>
                  </div>
                )}

                {open.answer_text && (
                  <p className="text-[15px] leading-[1.7] text-ink-700">{open.answer_text}</p>
                )}

                {open.ledger?.steps && (
                  <ComputationTable
                    steps={open.ledger.steps}
                    balance={open.ledger.balance_payable}
                    isRefund={open.ledger.is_refund}
                  />
                )}
              </div>

              <div className="mt-auto flex flex-wrap gap-2 border-t border-line px-6 py-4">
                <Button
                  nativeButton={false}
                  render={<Link href={`/chat?q=${encodeURIComponent(open.question ?? "")}`} />}
                  className="h-10 px-4"
                >
                  <RotateCcw />
                  Ask again with the current rules
                </Button>
                <Button variant="ghost" onClick={() => void remove(open.id)} className="h-10 text-warn-600 hover:bg-warn-100 hover:text-warn-700">
                  <Trash2 />
                  Remove
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
