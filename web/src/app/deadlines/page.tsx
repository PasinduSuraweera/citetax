"use client";

/**
 * The filing calendar for the selected year: when the return is due, and the
 * quarterly instalments, each from the rule that sets it.
 */

import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageBody, Shell, SUPPORTED_YAS, type YA } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, formatDate, type DeadlinesResponse } from "@/lib/api";

export default function DeadlinesPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [data, setData] = useState<Record<string, DeadlinesResponse | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all(
      SUPPORTED_YAS.map((y) => api.deadlines(y).then((d) => [y, d] as const).catch(() => [y, null] as const)),
    )
      .then((pairs) => setData(Object.fromEntries(pairs)))
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);

  const selected = data[ya];
  const other = SUPPORTED_YAS.find((y) => y !== ya)!;
  const today = new Date();

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Shell ya={ya} onYaChange={setYa} />
      <PageBody>
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-8">
          <div>
            <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900">
              Deadlines for {ya}
            </h1>
            <p className="mt-2 max-w-[60ch] text-[15px] leading-[1.6] text-ink-500">
              Every date comes from the rules, with the section that sets it.
            </p>
          </div>
          <Button
            nativeButton={false}
            render={<Link href={`/chat?q=${encodeURIComponent(`When is my return due for ${ya}?`)}`} />}
            variant="outline"
            className="h-10 flex-none"
          >
            <MessageSquare />
            Ask about deadlines
          </Button>
        </div>

        {error && (
          <div role="alert" className="mt-8 rounded-lg bg-warn-100 px-5 py-4 text-[14px] text-warn-700">{error}</div>
        )}

        {!loaded && (
          <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_280px]" aria-label="Loading deadlines">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        )}

        {loaded && !selected && !error && (
          <p className="mt-8 text-[15px] text-ink-500">No deadlines are recorded for {ya} yet.</p>
        )}

        {selected && (
          <>
            <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
              <div className="rounded-xl border border-line bg-white p-6">
                <div className="text-[13px] font-medium text-ink-400">Return due</div>
                <div className="tnum mt-2 text-[44px] font-semibold leading-none tracking-[-0.03em] text-ink-900">
                  {formatDate(selected.return_due)}
                </div>
                {selected.days_remaining != null && (
                  <p className="mt-3 text-[15px] text-ink-500">
                    {selected.days_remaining > 0 ? (
                      <><strong className="font-semibold text-ink-900">{selected.days_remaining} days</strong> from today.</>
                    ) : selected.days_remaining === 0 ? (
                      <strong className="font-semibold text-warn-600">Due today.</strong>
                    ) : (
                      <>This date passed <strong className="font-semibold text-ink-900">{Math.abs(selected.days_remaining)} days</strong> ago.</>
                    )}
                  </p>
                )}
                <Countdown days={selected.days_remaining} />
                <div className="mt-6 border-t border-line pt-4">
                  <p className="text-[13.5px] text-ink-500">
                    Set by <span className="statute font-semibold italic text-ink-900">{selected.citation.label}</span>, in
                    force from {formatDate(selected.citation.effective_from)}.
                  </p>
                  {selected.citation.quoted_text && (
                    <blockquote className="statute mt-3 max-w-[68ch] rounded-lg bg-panel px-4 py-3 text-[15px] italic text-ink-700">
                      &ldquo;{selected.citation.quoted_text}&rdquo;
                    </blockquote>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-line bg-white p-5">
                <h2 className="text-[15px] font-semibold text-ink-900">Quarterly instalments</h2>
                <p className="mt-1 text-[13px] leading-[1.5] text-ink-400">
                  Payments of tax through the year. Past dates are struck through.
                </p>
                <ol className="mt-4 flex flex-col">
                  {selected.instalments.map((d, i) => {
                    const past = new Date(`${d}T00:00:00`) < today;
                    const isNext = !past && selected.instalments.slice(0, i).every((p) => new Date(`${p}T00:00:00`) < today);
                    return (
                      <li key={d} className="flex gap-3">
                        <div className="flex w-2 flex-none flex-col items-center">
                          <span className={`mt-[7px] size-2 rounded-full ${past ? "bg-line-strong" : isNext ? "bg-brand-600" : "bg-canvas ring-1 ring-line-strong"}`} />
                          {i < selected.instalments.length - 1 && <span className="w-px flex-1 bg-line" />}
                        </div>
                        <div className="flex flex-1 items-baseline justify-between gap-2 pb-4">
                          <span className={`text-[14px] ${isNext ? "font-medium text-brand-700" : "text-ink-400"}`}>
                            Quarter {i + 1}{isNext ? ", next" : ""}
                          </span>
                          <span className={`tnum text-[14.5px] ${past ? "text-ink-300 line-through" : "font-medium text-ink-900"}`}>
                            {formatDate(d)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>

            {data[other] && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-panel px-5 py-4">
                <div className="tnum text-[14px] text-ink-500">
                  <span className="font-medium text-ink-900">{other}</span>: return due{" "}
                  <span className="font-medium text-ink-900">{formatDate(data[other]!.return_due)}</span>, instalments{" "}
                  {data[other]!.instalments.map(formatDate).join(", ")}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setYa(other)}>
                  Show {other}
                </Button>
              </div>
            )}
          </>
        )}
      </PageBody>
    </div>
  );
}

function Countdown({ days }: { days: number | null }) {
  if (days == null || days < 0) return null;
  // The year of assessment plus the eight months to the filing deadline is
  // roughly 610 days end to end; the bar shows how much of that remains.
  const span = 610;
  const pct = Math.max(2, Math.min(100, (days / span) * 100));
  return (
    <div className="mt-5 max-w-[520px]">
      <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
        <div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[12px] text-ink-400">
        <span>Today</span>
        <span>Filing deadline</span>
      </div>
    </div>
  );
}
