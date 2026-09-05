"use client";

/**
 * What changed between the two years, and the amendment responsible
 * (spec section 6.2 addition 7).
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { CompareTable } from "@/components/AnswerView";
import { Shell, type YA } from "@/components/Shell";
import { api, formatDate, type CompareResponse, type Snapshot } from "@/lib/api";

export default function ComparePage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
    api.compare("2025/2026", "2026/2027").then(setData).catch((e) => setError(e.message));
  }, []);

  const question = "What changed between 2025/2026 and 2026/2027?";

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} snapshot={snapshot} />
      <main className="flex-1 overflow-y-auto px-11 py-9">
        <div className="max-w-[1060px]">
          <div className="flex items-start justify-between gap-6">
            <div>
              <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900">
                What changed between the two years
              </h1>
              <p className="mt-[10px] max-w-[640px] text-[15px] leading-[1.6] text-ink-500">
                2025/2026 against 2026/2027, rule by rule, as the corpus stands at
                the current snapshot. A rule that did not change is one version
                serving both years, not a copy.
              </p>
            </div>
            <Link
              href={`/?q=${encodeURIComponent(question)}`}
              className="flex-none rounded-lg bg-brand-600 px-4 py-[9px] text-[13px] font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Ask the agent to explain
            </Link>
          </div>

          {error && (
            <div className="mt-6 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4 text-[14px] text-warn-500">
              {error}
            </div>
          )}

          {data && (
            <>
              <div className="mt-6 grid grid-cols-3 gap-3">
                <Stat label="RULES COMPARED" value={String(data.changes.length)} />
                <Stat label="CHANGED" value={String(data.changed_count)} tone={data.changed_count ? "brand" : undefined} />
                <Stat label="SNAPSHOT" value={snapshot?.label ?? "-"} small />
              </div>

              <div className="mt-4">
                <CompareTable compare={data} />
              </div>

              {data.changed_count === 1 && data.changes.some((c) => c.changed && c.rule_key.startsWith("deadline.")) && (
                <div className="mt-4 rounded-xl border border-line bg-white px-5 py-4 text-[13.5px] leading-[1.6] text-ink-500">
                  The Inland Revenue (Amendment) Act No. 2 of 2025 set the rates,
                  bands and relief from 1 April 2025 and has not been amended since,
                  so the only movement between these two years is the filing
                  calendar. When a circular changes a rate mid year, the corpus
                  agent will file it for review and this page will show the split.
                </div>
              )}

              {/* The approvers' own words about what moved, snapshot by snapshot. */}
              <div className="mt-6 rounded-xl border border-line bg-white px-5 py-5">
                <div className="eyebrow">CORPUS CHANGELOG</div>
                <p className="mt-1 text-[12.5px] text-ink-400">
                  Every publish creates a snapshot with a one line changelog written
                  by the approver. Newest first.
                </p>
                <ol className="mt-4 flex flex-col">
                  {data.snapshot_history.map((s, i) => (
                    <li key={`${s.label}-${i}`} className="flex gap-4">
                      <div className="flex w-[9px] flex-none flex-col items-center">
                        <span className={`mt-[6px] h-[7px] w-[7px] rounded-full ${i === 0 ? "bg-good-mint" : "bg-[#CFD8EE]"}`} />
                        {i < data.snapshot_history.length - 1 && <span className="w-px flex-1 bg-[#EEF1F8]" />}
                      </div>
                      <div className="pb-4">
                        <div className="flex items-baseline gap-3">
                          <span className="text-[13.5px] font-semibold text-ink-900">{s.label}</span>
                          {i === 0 && (
                            <span className="rounded-full bg-good-100 px-2 py-[2px] font-mono text-[9.5px] font-semibold text-good-600">CURRENT</span>
                          )}
                          {s.created_at && (
                            <span className="font-mono text-[10.5px] text-ink-300">{formatDate(s.created_at.slice(0, 10))}</span>
                          )}
                        </div>
                        <p className="mt-1 max-w-[680px] text-[13px] leading-[1.55] text-ink-500">
                          {s.changelog ?? "No changelog recorded."}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value, tone, small }: { label: string; value: string; tone?: "brand"; small?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${tone === "brand" ? "border-brand-600 bg-brand-050" : "border-line bg-white"}`}>
      <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">{label}</div>
      <div className={`tnum mt-1 font-mono font-semibold text-ink-900 ${small ? "text-[15px]" : "text-[24px]"}`}>{value}</div>
    </div>
  );
}
