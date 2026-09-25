"use client";

/**
 * What changed between the two years, and the amendment responsible
 * (spec section 6.2 addition 7).
 */

import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CompareTable } from "@/components/AnswerView";
import { PageBody, Shell, type YA } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
    <div className="flex h-dvh overflow-hidden bg-background">
      <Shell ya={ya} onYaChange={setYa} />
      <PageBody>
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-8">
          <div>
            <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900">
              What changed between the two years
            </h1>
            <p className="mt-2 max-w-[60ch] text-[15px] leading-[1.6] text-ink-500">
              2025/2026 against 2026/2027, rule by rule. A rule that did not
              change is one version serving both years, not a copy.
            </p>
          </div>
          <Button nativeButton={false} render={<Link href={`/chat?q=${encodeURIComponent(question)}`} />} variant="outline" className="h-10 flex-none">
            <MessageSquare />
            Ask for an explanation
          </Button>
        </div>

        {error && (
          <div role="alert" className="mt-8 rounded-lg bg-warn-100 px-5 py-4 text-[14px] text-warn-700">{error}</div>
        )}

        {!data && !error && (
          <div className="mt-8 flex flex-col gap-3" aria-label="Loading comparison">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {data && (
          <>
            <dl className="mt-8 grid grid-cols-3 divide-x divide-line rounded-xl border border-line">
              <Stat label="Rules compared" value={String(data.changes.length)} />
              <Stat label="Changed" value={String(data.changed_count)} strong={data.changed_count > 0} />
              <Stat label="Rules as of" value={snapshot?.label ?? "-"} small />
            </dl>

            <div className="mt-4">
              <CompareTable compare={data} />
            </div>

            {data.changed_count === 1 && data.changes.some((c) => c.changed && c.rule_key.startsWith("deadline.")) && (
              <p className="mt-4 max-w-[68ch] px-1 text-[14px] leading-[1.6] text-ink-500">
                The Inland Revenue (Amendment) Act No. 2 of 2025 set the rates,
                bands and relief from 1 April 2025 and has not been amended
                since, so the only movement between these two years is the
                filing calendar. When a circular changes a rate part way
                through a year, it is filed for review and this page shows the split.
              </p>
            )}

            {/* The approvers' own words about what moved, update by update. */}
            <section className="mt-12">
              <h2 className="text-[18px] font-semibold text-ink-900">Updates to the rules</h2>
              <p className="mt-1 text-[14px] text-ink-500">
                Each update to the rules comes with a one line note from the
                reviewer who approved it. Newest first.
              </p>
              <ol className="mt-5 flex flex-col">
                {data.snapshot_history.map((s, i) => (
                  <li key={`${s.label}-${i}`} className="flex gap-4">
                    <div className="flex w-2 flex-none flex-col items-center">
                      <span className={`mt-[7px] size-2 rounded-full ${i === 0 ? "bg-good-600" : "bg-line-strong"}`} />
                      {i < data.snapshot_history.length - 1 && <span className="w-px flex-1 bg-line" />}
                    </div>
                    <div className="pb-6">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-[15px] font-semibold text-ink-900">{s.label}</span>
                        {i === 0 && (
                          <span className="rounded-md bg-good-100 px-2 py-0.5 text-[12px] font-medium text-good-700">In use now</span>
                        )}
                        {s.created_at && (
                          <span className="tnum text-[13px] text-ink-400">{formatDate(s.created_at.slice(0, 10))}</span>
                        )}
                      </div>
                      <p className="mt-1 max-w-[68ch] text-[14px] leading-[1.6] text-ink-500">
                        {s.changelog ?? "No note was recorded."}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </PageBody>
    </div>
  );
}

function Stat({ label, value, strong, small }: { label: string; value: string; strong?: boolean; small?: boolean }) {
  return (
    <div className="px-4 py-3.5 sm:px-5">
      <dt className="text-[13px] text-ink-400">{label}</dt>
      <dd className={`tnum mt-1 font-semibold ${strong ? "text-brand-600" : "text-ink-900"} ${small ? "text-[15px]" : "text-[26px] leading-none"}`}>
        {value}
      </dd>
    </div>
  );
}
