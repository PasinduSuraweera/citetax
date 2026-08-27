"use client";

/** Spec section 6.2 addition 7: what changed this year, and the rule responsible. */

import { useEffect, useState } from "react";
import { Shell, type YA } from "@/components/Shell";
import { api, type CompareResponse, type Snapshot } from "@/lib/api";

function describe(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.bands)) {
      return (v.bands as Array<{ upto: number | null; rate: string }>)
        .map(
          (b) =>
            `${b.upto == null ? "above" : `to ${Number(b.upto).toLocaleString()}`} at ${
              Number(b.rate) * 100
            }%`,
        )
        .join(", ");
    }
    if (typeof v.amount === "string") return Number(v.amount).toLocaleString();
    if (typeof v.due === "string") return v.due;
    if (typeof v.employee_rate === "string")
      return `${Number(v.employee_rate) * 100}%`;
    return JSON.stringify(value);
  }
  return String(value);
}

export default function ComparePage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
    api
      .compare("2025/2026", "2026/2027")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} snapshot={snapshot} />
      <main className="flex-1 overflow-y-auto px-11 py-9">
        <div className="max-w-[1000px]">
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900">
            What changed between the two years
          </h1>
          <p className="mt-[10px] max-w-[640px] text-[15px] leading-[1.6] text-ink-500">
            Comparing 2025/2026 with 2026/2027, rule by rule, as the corpus
            stands at the current snapshot.
          </p>

          {error && (
            <div className="mt-6 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4 text-[14px] text-warn-500">
              {error}
            </div>
          )}

          {data && (
            <>
              <div className="mt-6 rounded-xl border border-line bg-white px-6 py-5">
                <div className="text-[15px] text-ink-700">
                  <strong className="font-semibold text-ink-900">
                    {data.changed_count} of {data.changes.length}
                  </strong>{" "}
                  rules differ between the two years.
                  {data.changed_count === 1 && (
                    <span className="text-ink-400">
                      {" "}
                      The Amendment Act of 2025 set the rates and relief from 1
                      April 2025 and has not been amended since, so only the
                      filing dates move.
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-line bg-white">
                <div className="flex items-center border-b border-line px-6 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
                  <span className="flex-1">RULE</span>
                  <span className="w-[240px] flex-none">2025 / 2026</span>
                  <span className="w-[240px] flex-none">2026 / 2027</span>
                  <span className="w-[90px] flex-none text-right">CHANGED</span>
                </div>
                {data.changes.map((c) => (
                  <div
                    key={c.rule_key}
                    className={`flex items-center border-b border-line-faint px-6 py-[13px] last:border-b-0 ${
                      c.changed ? "bg-brand-050/40" : ""
                    }`}
                  >
                    <span className="flex-1 pr-4 font-mono text-[12.5px] text-ink-700">
                      {c.rule_key}
                    </span>
                    <span className="tnum w-[240px] flex-none pr-3 font-mono text-[12px] text-ink-500">
                      {describe(c.from.value)}
                    </span>
                    <span className="tnum w-[240px] flex-none pr-3 font-mono text-[12px] text-ink-900">
                      {describe(c.to.value)}
                    </span>
                    <span className="w-[90px] flex-none text-right">
                      {c.changed ? (
                        <span className="rounded-full bg-brand-100 px-2 py-[3px] font-mono text-[10px] font-semibold text-brand-600">
                          CHANGED
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] text-ink-200">
                          same
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
