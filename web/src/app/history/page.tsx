"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ComputationTable } from "@/components/ComputationTable";
import { Shell, type YA } from "@/components/Shell";
import { api, ApiError, formatDate, money } from "@/lib/api";

type Run = Awaited<ReturnType<typeof api.history>>["runs"][number];
type Detail = Awaited<ReturnType<typeof api.historyDetail>>;

const INTENT_LABEL: Record<string, string> = {
  compute: "Computation",
  obligation: "Obligation",
  deadline: "Deadline",
  compare: "Comparison",
  rule_lookup: "Rule lookup",
  general: "Explanation",
};

export default function HistoryPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setRuns((await api.history()).runs);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
        else setError(e instanceof Error ? e.message : "Could not load history");
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const show = useCallback(async (id: string) => {
    try {
      setOpen(await api.historyDetail(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load that run");
    }
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} />
      <main className="flex-1 overflow-y-auto px-4 pb-10 pt-[72px] sm:px-6 lg:px-11 lg:pb-9 lg:pt-9">
        <div className="max-w-[1100px]">
          <h1 className="text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[32px]">History</h1>
          <p className="mt-[10px] max-w-[620px] text-[15px] leading-[1.6] text-ink-500">
            Every question is stored with the corpus snapshot it ran against, so an
            answer can be re-derived exactly as the law stood that day. Only the
            redacted question is kept.
          </p>

          {!ready && <p className="mt-6 font-mono text-[12px] text-ink-300">Loading...</p>}

          {needsAuth && (
            <div className="mt-7 rounded-xl border border-line bg-white px-6 py-8">
              <div className="eyebrow">SIGN IN TO SEE YOUR HISTORY</div>
              <p className="mt-3 max-w-[460px] text-[14px] leading-[1.6] text-ink-500">
                Computations are attached to your account so only you can see them.
                Anonymous questions still work, they are just not kept against a name.
              </p>
              <Link href="/signin" className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700">
                Sign in with Google
              </Link>
            </div>
          )}

          {error && (
            <div className="mt-6 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4 text-[14px] text-warn-500">{error}</div>
          )}

          {ready && !needsAuth && runs.length === 0 && !error && (
            <div className="mt-7 rounded-xl border border-dashed border-line-strong bg-white px-6 py-10 text-center">
              <div className="eyebrow">NOTHING YET</div>
              <p className="mx-auto mt-3 max-w-[400px] text-[14px] leading-[1.6] text-ink-400">
                Ask a question and it will appear here, stamped with the snapshot it was computed against.
              </p>
              <Link href="/chat" className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700">
                Ask a question
              </Link>
            </div>
          )}

          {runs.length > 0 && (
            <div className="mt-7 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_440px]">
              {/* Container queries, not viewport ones: this list sits beside a
                  440px detail pane on a wide screen and full width on a phone,
                  so it has to lay out by its own width. */}
              <div className="@container overflow-hidden rounded-xl border border-line bg-white">
                <div className="hidden items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300 @2xl:flex">
                  <span className="w-[120px] flex-none">WHEN</span>
                  <span className="w-[110px] flex-none">KIND</span>
                  <span className="flex-1">QUESTION</span>
                  <span className="w-[130px] flex-none text-right">RESULT</span>
                </div>
                {runs.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => show(r.id)}
                    className={`flex w-full flex-wrap items-center gap-y-1 border-b border-line-faint px-5 py-[12px] text-left transition-colors last:border-b-0 hover:bg-panel @2xl:flex-nowrap @2xl:gap-y-0 ${open?.id === r.id ? "bg-brand-050" : ""}`}
                  >
                    <span className="order-2 flex-none font-mono text-[11px] text-ink-500 @2xl:order-none @2xl:w-[120px]">
                      {r.created_at ? new Date(r.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}
                    </span>
                    <span className="order-3 ml-2 flex-none @2xl:order-none @2xl:ml-0 @2xl:w-[110px]">
                      <span className="rounded-full bg-brand-100 px-2 py-[2px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-brand-600">
                        {INTENT_LABEL[r.intent ?? ""] ?? r.intent ?? "answer"}
                      </span>
                    </span>
                    <span className="order-1 min-w-0 basis-full pr-3 @2xl:order-none @2xl:basis-auto @2xl:flex-1">
                      <span className="block truncate text-[13px] text-ink-900">{r.question ?? "(question not recorded)"}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-300 @2xl:block">
                        Y/A {r.ya}{r.snapshot_label ? ` · snapshot ${r.snapshot_label}` : ""}
                        {r.badge && r.badge !== "all_cited" ? ` · ${r.badge.replace("_", " ")}` : ""}
                      </span>
                    </span>
                    <span className="tnum order-4 ml-auto flex-none text-right font-mono text-[13.5px] font-medium text-ink-900 @2xl:order-none @2xl:ml-0 @2xl:w-[130px]">
                      {r.balance_payable ? `LKR ${money(r.balance_payable)}` : "-"}
                    </span>
                  </button>
                ))}
              </div>

              <div>
                {open ? (
                  <div className="fade-up sticky top-0 flex flex-col gap-3">
                    <div className="rounded-xl border border-line bg-white px-5 py-5">
                      <div className="flex items-start justify-between">
                        <div className="eyebrow">{INTENT_LABEL[open.intent ?? ""] ?? "ANSWER"} · Y/A {open.ya}</div>
                        <button type="button" onClick={() => setOpen(null)} className="font-mono text-[11px] text-ink-300 hover:text-ink-900">close</button>
                      </div>
                      {open.question && (
                        <p className="mt-2 text-[14.5px] leading-[1.5] text-ink-900">{open.question}</p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-ink-400">
                        <span>{open.created_at ? formatDate(open.created_at.slice(0, 10)) : ""}</span>
                        <span>snapshot {open.snapshot.label ?? open.snapshot.id?.slice(0, 8)}</span>
                        {open.latency_ms != null && <span>{(open.latency_ms / 1000).toFixed(1)}s</span>}
                        {open.llm_usage?.total_tokens ? <span>{open.llm_usage.total_tokens.toLocaleString()} tokens</span> : null}
                      </div>
                      {open.plan && (
                        <div className="mt-3 flex flex-wrap gap-1">
                          {open.plan.map((n) => (
                            <span key={n} className="rounded bg-panel px-[6px] py-[2px] font-mono text-[10px] text-ink-500">{n}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    {open.answer_text && (
                      <div className="rounded-xl border border-line bg-white px-5 py-4">
                        <div className="eyebrow">EXPLANATION</div>
                        <p className="mt-2 text-[13.5px] leading-[1.65] text-ink-700">{open.answer_text}</p>
                      </div>
                    )}

                    {open.ledger?.steps && (
                      <ComputationTable
                        steps={open.ledger.steps}
                        balance={open.ledger.balance_payable}
                        isRefund={open.ledger.is_refund}
                      />
                    )}

                    <Link
                      href={`/chat?q=${encodeURIComponent(open.question ?? "")}`}
                      className="rounded-lg border border-line-strong bg-white px-4 py-2 text-center text-[13px] font-medium text-ink-700 hover:border-brand-600 hover:text-brand-600"
                    >
                      Ask again against the current snapshot
                    </Link>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-line-strong bg-white px-6 py-10 text-center text-[13px] text-ink-400">
                    Select a run to see the ledger and explanation exactly as they were released.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
