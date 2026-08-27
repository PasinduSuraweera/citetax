"use client";

import { useEffect, useState } from "react";
import { Shell, type YA } from "@/components/Shell";
import { api, formatDate, type DeadlinesResponse, type Snapshot } from "@/lib/api";

export default function DeadlinesPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [data, setData] = useState<DeadlinesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .deadlines(ya)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [ya]);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} snapshot={snapshot} />
      <main className="flex-1 overflow-y-auto px-11 py-9">
        <div className="max-w-[900px]">
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900">
            Deadlines for {ya}
          </h1>
          <p className="mt-[10px] text-[15px] leading-[1.6] text-ink-500">
            Dates come from the rules table, with the section that sets them.
          </p>

          {error && (
            <div className="mt-6 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4 text-[14px] text-warn-500">
              {error}
            </div>
          )}

          {data && (
            <>
              <div className="mt-7 rounded-xl border border-line bg-white px-6 py-6">
                <div className="eyebrow">RETURN DUE</div>
                <div className="tnum mt-2 font-mono text-[40px] font-semibold tracking-[-0.04em] text-ink-900">
                  {formatDate(data.return_due)}
                </div>
                {data.days_remaining != null && (
                  <p className="mt-2 text-[14px] text-ink-500">
                    {data.days_remaining > 0
                      ? `${data.days_remaining} days from today.`
                      : "This date has passed."}
                  </p>
                )}
                <div className="mt-5 border-t border-line pt-4">
                  <span className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-xs font-medium text-ink-700">
                    {data.citation.label}
                  </span>
                  {data.citation.quoted_text && (
                    <p className="mt-3 max-w-[620px] text-[13px] leading-[1.6] text-ink-400">
                      “{data.citation.quoted_text}”
                    </p>
                  )}
                </div>
              </div>

              {data.instalments.length > 0 && (
                <div className="mt-4 rounded-xl border border-line bg-white px-6 py-6">
                  <div className="eyebrow">QUARTERLY INSTALMENTS</div>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {data.instalments.map((d, i) => (
                      <div
                        key={d}
                        className="rounded-[10px] border border-line bg-panel px-4 py-3"
                      >
                        <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">
                          Q{i + 1}
                        </div>
                        <div className="tnum mt-1 font-mono text-[14px] font-medium text-ink-900">
                          {formatDate(d)}
                        </div>
                      </div>
                    ))}
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
