"use client";

/**
 * Every answer this account has been given, each with the rules it was worked
 * out from. Selecting one shows it exactly as it was released; nothing is
 * worked out again.
 */

import { History as HistoryIcon, RotateCcw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ComputationTable } from "@/components/ComputationTable";
import { PageBody, Shell, type YA } from "@/components/Shell";
import { INTENT_LABEL } from "@/components/TurnSummary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, formatDate, money } from "@/lib/api";

type Run = Awaited<ReturnType<typeof api.history>>["runs"][number];
type Detail = Awaited<ReturnType<typeof api.historyDetail>>;

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function HistoryPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
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
    try {
      setOpen(await api.historyDetail(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That answer could not be loaded.");
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

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Shell ya={ya} onYaChange={setYa} />
      <PageBody wide>
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-8">
          <div>
            <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900">History</h1>
            <p className="mt-2 max-w-[64ch] text-[15px] leading-[1.6] text-ink-500">
              Every answer is kept with the rules it was worked out from, so it
              can be shown exactly as the law stood that day. Only the question
              with your details removed is stored.
            </p>
          </div>
          {runs.length > 0 && !confirmClear && (
            <Button variant="outline" onClick={() => setConfirmClear(true)} className="h-9 flex-none">
              <Trash2 />
              Clear history
            </Button>
          )}
        </div>

        {confirmClear && (
          <div role="alertdialog" aria-label="Clear history" className="fade-up mt-6 flex flex-wrap items-center gap-3 rounded-lg bg-warn-100 px-4 py-3">
            <p className="flex-1 text-[14px] leading-[1.5] text-warn-700">
              Clear all {runs.length} {runs.length === 1 ? "answer" : "answers"} from your history? Your chats stay as they are.
            </p>
            <Button variant="destructive" onClick={() => void clearAll()} disabled={clearing} className="h-9 bg-warn-600 text-white hover:bg-warn-700">
              {clearing ? "Clearing" : "Clear history"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmClear(false)} className="h-9">
              Cancel
            </Button>
          </div>
        )}

        {!ready && (
          <div className="mt-8 flex flex-col gap-2" aria-label="Loading history">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        )}

        {needsAuth && (
          <div className="mt-8 rounded-xl bg-muted px-6 py-6">
            <h2 className="text-[16px] font-semibold text-ink-900">Sign in to see your history</h2>
            <p className="mt-1 max-w-[56ch] text-[14.5px] leading-[1.6] text-ink-500">
              Answers are kept against your account so only you can see them.
              Questions asked without an account still work, they are just not kept.
            </p>
            <Button nativeButton={false} render={<Link href="/signin?next=%2Fhistory" />} className="mt-4 h-10 px-4">Sign in with Google</Button>
          </div>
        )}

        {error && (
          <div role="alert" className="mt-8 rounded-lg bg-warn-100 px-5 py-4 text-[14px] text-warn-700">{error}</div>
        )}

        {ready && !needsAuth && runs.length === 0 && !error && (
          <div className="mt-8 flex flex-col items-start rounded-xl border border-dashed border-line-strong px-6 py-10">
            <HistoryIcon className="size-5 text-ink-300" />
            <h2 className="mt-3 text-[16px] font-semibold text-ink-900">No answers yet</h2>
            <p className="mt-1 max-w-[52ch] text-[14.5px] leading-[1.6] text-ink-500">
              Ask a question and it will be listed here with the rules it used.
            </p>
            <Button nativeButton={false} render={<Link href="/chat" />} className="mt-4 h-10 px-4">Ask a question</Button>
          </div>
        )}

        {runs.length > 0 && (
          <div className="mt-8 grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_420px]">
            {/* Laid out by its own width: beside the detail pane on a wide
                screen, full width on a phone. */}
            <div className="@container overflow-hidden rounded-xl border border-line bg-white">
              <div className="hidden items-center border-b border-line bg-panel px-5 py-2.5 text-[12.5px] font-medium text-ink-400 @2xl:flex">
                <span className="w-[130px] flex-none">When</span>
                <span className="w-[150px] flex-none">Kind</span>
                <span className="flex-1">Question</span>
                <span className="w-[130px] flex-none text-right">Result</span>
              </div>
              <ul>
                {runs.map((r) => {
                  const selected = open?.id === r.id;
                  return (
                    <li key={r.id} className="group relative flex items-center border-b border-line-faint last:border-0">
                      <button
                        type="button"
                        onClick={() => show(r.id)}
                        aria-current={selected ? "true" : undefined}
                        className={`flex min-w-0 flex-1 flex-wrap items-center gap-y-1 py-3 pl-5 pr-12 text-left transition-colors hover:bg-panel @2xl:flex-nowrap @2xl:gap-y-0 ${
                          selected ? "bg-brand-050" : ""
                        }`}
                      >
                        <span className="order-1 min-w-0 basis-full pr-3 @2xl:order-none @2xl:hidden">
                          <span className="block truncate text-[14.5px] text-ink-900">{r.question ?? "Question not recorded"}</span>
                        </span>
                        <span className="tnum order-2 flex-none text-[13px] text-ink-400 @2xl:order-none @2xl:w-[130px]">{when(r.created_at)}</span>
                        <span className="order-3 ml-3 flex-none @2xl:order-none @2xl:ml-0 @2xl:w-[150px]">
                          <span className="rounded-md bg-brand-050 px-2 py-0.5 text-[12.5px] font-medium text-brand-700">
                            {INTENT_LABEL[r.intent ?? ""] ?? r.intent ?? "Answer"}
                          </span>
                        </span>
                        <span className="hidden min-w-0 flex-1 pr-3 @2xl:block">
                          <span className="block truncate text-[14.5px] text-ink-900">{r.question ?? "Question not recorded"}</span>
                          <span className="block truncate text-[12.5px] text-ink-400">
                            {r.ya}{r.snapshot_label ? `, rules as of ${r.snapshot_label}` : ""}
                            {r.badge && r.badge !== "all_cited" ? `, ${r.badge === "partial" ? "explanation withheld" : "declined"}` : ""}
                          </span>
                        </span>
                        <span className="tnum order-4 ml-auto flex-none text-right text-[14px] font-medium text-ink-900 @2xl:order-none @2xl:ml-0 @2xl:w-[130px]">
                          {r.balance_payable ? `LKR ${money(r.balance_payable)}` : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(r.id)}
                        aria-label="Remove from history"
                        title="Remove from history"
                        className="absolute right-3 flex size-8 items-center justify-center rounded-md text-ink-300 transition-opacity hover:bg-warn-100 hover:text-warn-600 focus-visible:opacity-100 @2xl:opacity-0 @2xl:group-hover:opacity-100"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="xl:sticky xl:top-0">
              {open ? (
                <div className="fade-up flex flex-col gap-3">
                  <div className="rounded-xl border border-line bg-white px-5 py-5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="rounded-md bg-brand-050 px-2 py-0.5 text-[12.5px] font-medium text-brand-700">
                        {INTENT_LABEL[open.intent ?? ""] ?? "Answer"}
                      </span>
                      <Button variant="ghost" size="icon-sm" onClick={() => setOpen(null)} aria-label="Close">
                        <X />
                      </Button>
                    </div>
                    {open.question && (
                      <p className="mt-3 text-[16px] font-medium leading-[1.45] text-ink-900">{open.question}</p>
                    )}
                    <dl className="tnum mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                      <div><dt className="text-ink-400">Year</dt><dd className="text-ink-900">{open.ya}</dd></div>
                      <div><dt className="text-ink-400">Asked</dt><dd className="text-ink-900">{open.created_at ? formatDate(open.created_at.slice(0, 10)) : ""}</dd></div>
                      <div><dt className="text-ink-400">Rules as of</dt><dd className="text-ink-900">{open.snapshot.label ?? open.snapshot.id?.slice(0, 8)}</dd></div>
                      {open.latency_ms != null && (
                        <div><dt className="text-ink-400">Took</dt><dd className="text-ink-900">{(open.latency_ms / 1000).toFixed(1)} seconds</dd></div>
                      )}
                    </dl>
                  </div>

                  {open.answer_text && (
                    <div className="rounded-xl border border-line bg-white px-5 py-4">
                      <h3 className="text-[13px] font-medium text-ink-400">Explanation</h3>
                      <p className="mt-1.5 text-[14.5px] leading-[1.65] text-ink-700">{open.answer_text}</p>
                    </div>
                  )}

                  {open.ledger?.steps && (
                    <ComputationTable
                      steps={open.ledger.steps}
                      balance={open.ledger.balance_payable}
                      isRefund={open.ledger.is_refund}
                    />
                  )}

                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<Link href={`/chat?q=${encodeURIComponent(open.question ?? "")}`} />}
                    className="h-10"
                  >
                    <RotateCcw />
                    Ask again with the current rules
                  </Button>
                  <Button variant="ghost" onClick={() => void remove(open.id)} className="h-10 text-warn-600 hover:bg-warn-100 hover:text-warn-700">
                    <Trash2 />
                    Remove from history
                  </Button>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-line-strong px-6 py-10 text-[14px] leading-[1.6] text-ink-400">
                  Select an answer to see it exactly as it was given, with its
                  ledger and explanation.
                </div>
              )}
            </div>
          </div>
        )}
      </PageBody>
    </div>
  );
}
