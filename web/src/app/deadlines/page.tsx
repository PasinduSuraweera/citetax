"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Shell, SUPPORTED_YAS, type YA } from "@/components/Shell";
import { api, formatDate, type DeadlinesResponse, type Snapshot } from "@/lib/api";

export default function DeadlinesPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [data, setData] = useState<Record<string, DeadlinesResponse | null>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
    Promise.all(
      SUPPORTED_YAS.map((y) => api.deadlines(y).then((d) => [y, d] as const).catch(() => [y, null] as const)),
    )
      .then((pairs) => setData(Object.fromEntries(pairs)))
      .catch((e) => setError(e.message));
  }, []);

  const selected = data[ya];
  const other = SUPPORTED_YAS.find((y) => y !== ya)!;
  const today = new Date();

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} snapshot={snapshot} />
      <main className="flex-1 overflow-y-auto px-4 pb-10 pt-[72px] sm:px-6 lg:px-11 lg:pb-9 lg:pt-9">
        <div className="max-w-[1000px]">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-6">
            <div>
              <h1 className="text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[32px]">
                Deadlines for {ya}
              </h1>
              <p className="mt-[10px] max-w-[600px] text-[15px] leading-[1.6] text-ink-500">
                Every date comes from the rules table, with the section that sets it.
                Switch the year in the sidebar to see the other calendar.
              </p>
            </div>
            <Link
              href={`/?q=${encodeURIComponent(`When is my return due for ${ya}?`)}`}
              className="flex-none rounded-lg border border-line-strong bg-white px-4 py-[9px] text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
            >
              Ask the agent
            </Link>
          </div>

          {error && (
            <div className="mt-6 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4 text-[14px] text-warn-500">{error}</div>
          )}

          {selected && (
            <>
              <div className="mt-7 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
                <div className="rounded-xl border border-line bg-white px-6 py-6">
                  <div className="eyebrow">RETURN DUE</div>
                  <div className="tnum mt-2 font-mono text-[44px] font-semibold tracking-[-0.04em] text-ink-900">
                    {formatDate(selected.return_due)}
                  </div>
                  {selected.days_remaining != null && (
                    <p className="mt-2 text-[14.5px] text-ink-500">
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
                  <div className="mt-5 border-t border-line pt-4">
                    <span className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-xs font-medium text-ink-700">
                      {selected.citation.label}
                    </span>
                    <span className="ml-2 font-mono text-[10.5px] text-ink-300">
                      in force from {formatDate(selected.citation.effective_from)}
                    </span>
                    {selected.citation.quoted_text && (
                      <blockquote className="mt-3 max-w-[620px] border-l-2 border-brand-600 pl-4 text-[13px] leading-[1.6] text-ink-500">
                        “{selected.citation.quoted_text}”
                      </blockquote>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-line bg-white px-5 py-5">
                  <div className="eyebrow">QUARTERLY INSTALMENTS</div>
                  <p className="mt-1 text-[12px] leading-[1.5] text-ink-400">
                    Self assessment payments through the year. Past dates are struck.
                  </p>
                  <ol className="mt-4 flex flex-col">
                    {selected.instalments.map((d, i) => {
                      const date = new Date(`${d}T00:00:00`);
                      const past = date < today;
                      const isNext = !past && selected.instalments.slice(0, i).every((p) => new Date(`${p}T00:00:00`) < today);
                      return (
                        <li key={d} className="flex gap-3">
                          <div className="flex w-[9px] flex-none flex-col items-center">
                            <span className={`mt-[6px] h-[7px] w-[7px] rounded-full ${past ? "bg-[#CFD8EE]" : isNext ? "bg-brand-600" : "bg-[#DFE5F2]"}`} />
                            {i < selected.instalments.length - 1 && <span className="w-px flex-1 bg-[#EEF1F8]" />}
                          </div>
                          <div className="pb-4">
                            <div className="flex items-baseline gap-2">
                              <span className={`font-mono text-[10px] ${isNext ? "text-brand-600" : "text-ink-300"}`}>Q{i + 1}</span>
                              <span className={`tnum font-mono text-[14px] ${past ? "text-ink-300 line-through" : "font-medium text-ink-900"}`}>
                                {formatDate(d)}
                              </span>
                              {isNext && (
                                <span className="rounded-full bg-brand-100 px-2 py-[2px] font-mono text-[9.5px] font-semibold text-brand-600">NEXT</span>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </div>

              {data[other] && (
                <div className="mt-4 rounded-xl border border-line bg-white px-6 py-5">
                  <div className="flex items-center justify-between">
                    <div className="eyebrow">THE OTHER YEAR · {other}</div>
                    <button
                      type="button"
                      onClick={() => setYa(other)}
                      className="font-mono text-[11px] text-brand-600 hover:underline"
                    >
                      switch
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-2">
                    <div>
                      <span className="font-mono text-[10px] tracking-[0.14em] text-ink-300">RETURN DUE </span>
                      <span className="tnum ml-2 font-mono text-[15px] font-medium text-ink-900">{formatDate(data[other]!.return_due)}</span>
                    </div>
                    <div>
                      <span className="font-mono text-[10px] tracking-[0.14em] text-ink-300">INSTALMENTS </span>
                      <span className="tnum ml-2 font-mono text-[13px] text-ink-700">
                        {data[other]!.instalments.map(formatDate).join(" · ")}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
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
    <div className="mt-4 max-w-[520px]">
      <div className="h-[6px] overflow-hidden rounded-sm bg-[#EFF2F9]">
        <div className="h-full rounded-sm bg-brand-600" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-300">
        <span>today</span>
        <span>filing deadline</span>
      </div>
    </div>
  );
}
