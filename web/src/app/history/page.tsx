"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Shell, type YA } from "@/components/Shell";
import { api, ApiError, money, type Snapshot } from "@/lib/api";

interface RunRow {
  id: string;
  ya: string;
  balance_payable: string | null;
  taxable_income: string | null;
  step_count: number | null;
  is_refund: boolean | null;
  latency_ms: number | null;
  created_at: string | null;
  snapshot_label: string | null;
  badge: string | null;
}

export default function HistoryPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
    (async () => {
      try {
        const res = await api.history();
        setRuns(res.runs);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
        else setError(e instanceof Error ? e.message : "Could not load history");
      } finally {
        setReady(true);
      }
    })();
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} snapshot={snapshot} />
      <main className="flex-1 overflow-y-auto px-11 py-9">
        <div className="max-w-[1000px]">
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900">
            History
          </h1>
          <p className="mt-[10px] max-w-[620px] text-[15px] leading-[1.6] text-ink-500">
            Every computation is stored with the corpus snapshot it ran against,
            so an answer can be re-derived exactly as the law stood that day.
          </p>

          {!ready && (
            <p className="mt-6 font-mono text-[12px] text-ink-300">Loading...</p>
          )}

          {needsAuth && (
            <div className="mt-7 rounded-xl border border-line bg-white px-6 py-8">
              <div className="eyebrow">SIGN IN TO SEE YOUR HISTORY</div>
              <p className="mt-3 max-w-[460px] text-[14px] leading-[1.6] text-ink-500">
                Computations are attached to your account so only you can see
                them. Anonymous questions still work, they are just not kept
                against a name.
              </p>
              <Link
                href="/signin"
                className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700"
              >
                Sign in with Google
              </Link>
            </div>
          )}

          {error && (
            <div className="mt-6 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4 text-[14px] text-warn-500">
              {error}
            </div>
          )}

          {ready && !needsAuth && runs.length === 0 && !error && (
            <div className="mt-7 rounded-xl border border-dashed border-line-strong bg-white px-6 py-10 text-center">
              <div className="eyebrow">NOTHING YET</div>
              <p className="mx-auto mt-3 max-w-[400px] text-[14px] leading-[1.6] text-ink-400">
                Ask a question and it will appear here, stamped with the
                snapshot it was computed against.
              </p>
              <Link
                href="/"
                className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700"
              >
                Ask a question
              </Link>
            </div>
          )}

          {runs.length > 0 && (
            <div className="mt-7 overflow-hidden rounded-xl border border-line bg-white">
              <div className="flex items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
                <span className="w-[150px] flex-none">WHEN</span>
                <span className="w-[110px] flex-none">YEAR</span>
                <span className="flex-1">SNAPSHOT</span>
                <span className="w-[110px] flex-none">STEPS</span>
                <span className="w-[150px] flex-none text-right">BALANCE, LKR</span>
              </div>
              {runs.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center border-b border-line-faint px-5 py-[13px] last:border-b-0"
                >
                  <span className="w-[150px] flex-none font-mono text-[11.5px] text-ink-500">
                    {r.created_at
                      ? new Date(r.created_at).toLocaleString("en-GB", {
                          day: "2-digit", month: "short",
                          hour: "2-digit", minute: "2-digit",
                        })
                      : "-"}
                  </span>
                  <span className="w-[110px] flex-none font-mono text-[12.5px] text-ink-700">
                    {r.ya}
                  </span>
                  <span className="min-w-0 flex-1 pr-3">
                    <span className="block truncate text-[13px] text-ink-700">
                      {r.snapshot_label ?? "unknown snapshot"}
                    </span>
                    {r.badge && r.badge !== "all_cited" && (
                      <span className="font-mono text-[10.5px] text-[#7E5D1B]">
                        {r.badge.replace("_", " ")}
                      </span>
                    )}
                  </span>
                  <span className="tnum w-[110px] flex-none font-mono text-[12.5px] text-ink-500">
                    {r.step_count ?? "-"}
                  </span>
                  <span className="tnum w-[150px] flex-none text-right font-mono text-[14px] font-medium text-ink-900">
                    {r.balance_payable ? money(r.balance_payable) : "-"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
