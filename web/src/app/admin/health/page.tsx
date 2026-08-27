"use client";

/** Corpus health (spec section 5.1 F). */

import { useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, type CorpusHealth, type Me } from "@/lib/admin";

export default function HealthPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<CorpusHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const who = await admin.me();
        setMe(who);
        if (who.is_reviewer) setData(await admin.health());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load health");
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) return <Loading />;
  if (!me?.is_reviewer) return <NoAccess me={me} />;

  const years = data?.coverage[0] ? Object.keys(data.coverage[0].years) : [];

  return (
    <AdminShell me={me} snapshotLabel={data?.snapshot?.label}>
      <div className="px-9 py-8">
        <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">
          Corpus health
        </h1>
        <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
          Whether every rule key is covered for every supported year, and
          whether the sources feeding them are still alive.
        </p>

        {error && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] text-warn-500">
            {error}
          </div>
        )}

        {data && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="PUBLISHED VERSIONS" value={data.totals.published_versions} />
              <Stat label="DOCUMENTS" value={data.totals.documents} />
              <Stat label="PROPOSALS" value={data.totals.proposals} />
              <Stat label="REJECTED" value={data.totals.rejected} />
            </div>

            <div className="mt-6 overflow-hidden rounded-xl border border-line bg-white">
              <div className="border-b border-line px-5 py-3">
                <div className="eyebrow">COVERAGE MATRIX</div>
                <p className="mt-1 text-[12px] text-ink-400">
                  Green covers the whole year, amber is partial, red is
                  uncovered. You cannot publish a corpus with a gap.
                </p>
              </div>
              <div className="flex items-center bg-panel px-5 py-2 font-mono text-[10px] tracking-[0.14em] text-ink-300">
                <span className="flex-1">RULE KEY</span>
                {years.map((y) => (
                  <span key={y} className="w-[190px] flex-none">
                    {y}
                  </span>
                ))}
              </div>
              {data.coverage.map((row) => (
                <div
                  key={row.rule_key}
                  className="flex items-center border-t border-line-faint px-5 py-[11px]"
                >
                  <span className="flex-1 font-mono text-[12.5px] text-ink-700">
                    {row.rule_key}
                  </span>
                  {years.map((y) => {
                    const cell = row.years[y];
                    return (
                      <span key={y} className="w-[190px] flex-none">
                        <CoverageCell cell={cell} />
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-line bg-white px-5 py-5">
                <div className="eyebrow">SOURCE STALENESS</div>
                <p className="mt-1 text-[12px] leading-[1.5] text-ink-400">
                  A high priority source silent for 90 days may mean the crawler
                  broke, not that nothing happened.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  {data.sources.map((s) => (
                    <div
                      key={s.source_id}
                      className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 pr-3">
                        <span className="block truncate text-[13px] text-ink-900">
                          {s.name}
                        </span>
                        <span className="font-mono text-[10.5px] text-ink-300">
                          {s.last_status ?? "never run"}
                        </span>
                      </span>
                      <span
                        className={`rounded-full px-2 py-[3px] font-mono text-[10px] font-semibold ${
                          s.stale
                            ? "bg-warn-100 text-warn-600"
                            : s.enabled
                              ? "bg-good-100 text-good-600"
                              : "bg-panel text-ink-300"
                        }`}
                      >
                        {!s.enabled
                          ? "disabled"
                          : s.stale
                            ? "stale"
                            : s.days_since_change == null
                              ? "no change yet"
                              : `${s.days_since_change}d`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-line bg-white px-5 py-5">
                <div className="eyebrow">REVIEWER CORRECTION RATE</div>
                <p className="mt-1 text-[12px] leading-[1.5] text-ink-400">
                  How often reviewers change extractor output, per field. This
                  is the number that tells you whether extraction is improving.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  {data.correction_rate.length === 0 ? (
                    <p className="text-[13px] text-ink-300">
                      No corrections recorded yet.
                    </p>
                  ) : (
                    data.correction_rate.map((c) => (
                      <div
                        key={c.field}
                        className="flex items-center justify-between font-mono text-[12.5px]"
                      >
                        <span className="text-ink-700">{c.field}</span>
                        <span className="tnum text-ink-900">{c.n}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-5 border-t border-line pt-4">
                  <div className="eyebrow">OPEN PROPOSALS BY PRIORITY</div>
                  <div className="mt-3 flex flex-col gap-1">
                    {data.open_proposals.length === 0 ? (
                      <p className="text-[13px] text-ink-300">Queue is empty.</p>
                    ) : (
                      data.open_proposals.map((p) => (
                        <div
                          key={p.priority}
                          className="flex items-center justify-between font-mono text-[12.5px]"
                        >
                          <span className="text-ink-700">P{p.priority}</span>
                          <span className="tnum text-ink-900">{p.n}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </AdminShell>
  );
}

function CoverageCell({
  cell,
}: {
  cell?: { state: string; citation?: string | null; effective_from?: string; error?: string };
}) {
  if (!cell) return <span className="font-mono text-[11px] text-ink-200">-</span>;
  const tone =
    cell.state === "green"
      ? "bg-good-100 text-good-600 border-good-300"
      : cell.state === "amber"
        ? "bg-[#FDF4E0] text-[#7E5D1B] border-[#EBD6A8]"
        : "bg-warn-100 text-warn-600 border-warn-300";
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-[9px] py-[3px] ${tone}`}
      title={cell.error ?? cell.citation ?? ""}
    >
      <span className="font-mono text-[10px] font-semibold uppercase">
        {cell.state}
      </span>
      {cell.citation && (
        <span className="max-w-[110px] truncate font-mono text-[10px] opacity-80">
          {cell.citation}
        </span>
      )}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-3">
      <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-[22px] font-semibold text-ink-900">
        {value}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
