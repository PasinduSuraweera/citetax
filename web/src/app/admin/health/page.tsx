"use client";

/** Corpus health (spec section 5.1 F). */

import { useEffect, useState } from "react";
import { AdminBody, AdminFrame } from "@/components/admin/AdminShell";
import { Code, ErrorNote, PageHeader, Panel, Pill, Stat, day, errorText } from "@/components/admin/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, PRIORITY_LABEL, type CorpusHealth, type CoverageRow } from "@/lib/admin";

export default function HealthPage() {
  return <AdminFrame>{() => <Health />}</AdminFrame>;
}

function Health() {
  const [data, setData] = useState<CorpusHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    admin.health().then(setData).catch((e) => setError(errorText(e, "Could not load corpus health")));
  }, []);

  const years = data?.coverage[0] ? Object.keys(data.coverage[0].years) : [];
  const cells = data?.coverage.flatMap((r) => Object.values(r.years)) ?? [];
  const missing = cells.filter((c) => c.state === "red").length;
  const partial = cells.filter((c) => c.state === "amber").length;

  return (
    <AdminBody>
      <PageHeader
        title="Corpus health"
        description="Whether every rule has a value for every supported year, and whether the sources feeding them are still alive."
      />

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!data && !error && <Skeleton className="mt-6 h-96 w-full" />}

      {data && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Published rule versions" value={data.totals.published_versions} />
            <Stat label="Documents" value={data.totals.documents} />
            <Stat label="Proposals" value={data.totals.proposals} />
            <Stat label="Rejected" value={data.totals.rejected} />
          </div>

          <Panel
            flush
            className="mt-6"
            title="Coverage"
            description={
              missing > 0
                ? `${missing} rule${missing === 1 ? " has" : "s have"} no value for a year. A snapshot like that cannot be published.`
                : partial > 0
                  ? `${partial} rule${partial === 1 ? " is" : "s are"} covered for only part of a year.`
                  : "Every rule is covered for the whole of every supported year."
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left">
                <thead className="bg-panel text-[12.5px] text-ink-400">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Rule</th>
                    {years.map((y) => <th key={y} className="px-5 py-2.5 font-medium">{y}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.coverage.map((row) => (
                    <tr key={row.rule_key} className="border-t border-line-faint">
                      <td className="px-5 py-3"><Code>{row.rule_key}</Code></td>
                      {years.map((y) => <td key={y} className="px-5 py-3"><CoverageCell cell={row.years[y]} /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Sources" description="A source silent for 90 days may mean the crawler broke, not that nothing changed.">
              <ul className="flex flex-col divide-y divide-line-faint">
                {data.sources.map((s) => (
                  <li key={s.source_id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] text-ink-900">{s.name}</span>
                      <span className="text-[13px] text-ink-400">
                        {s.last_status === "failed" ? "Last crawl failed" : s.last_status === "ok" ? "Crawling normally" : "Never crawled"}
                      </span>
                    </span>
                    {!s.enabled ? (
                      <Pill>Off</Pill>
                    ) : s.stale ? (
                      <Pill tone="warn">Stale</Pill>
                    ) : (
                      <Pill tone="good">
                        {s.days_since_change == null ? "No change yet" : s.days_since_change === 0 ? "Changed today" : `Changed ${s.days_since_change} days ago`}
                      </Pill>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>

            <div className="flex flex-col gap-4">
              <Panel title="Open proposals">
                {data.open_proposals.length === 0 ? (
                  <p className="text-[14px] text-ink-400">The queue is empty.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {data.open_proposals.map((p) => (
                      <li key={p.priority} className="flex items-center justify-between text-[14px]">
                        <span className="text-ink-700">P{p.priority}, {PRIORITY_LABEL[p.priority]?.toLowerCase()}</span>
                        <span className="tnum font-medium text-ink-900">{p.n}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Reviewer corrections" description="How often reviewers change what the extractor proposed, by field.">
                {data.correction_rate.length === 0 ? (
                  <p className="text-[14px] text-ink-400">No corrections recorded yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {data.correction_rate.map((c) => (
                      <li key={c.field} className="flex items-center justify-between text-[14px]">
                        <span className="text-ink-700">{c.field.replaceAll("_", " ")}</span>
                        <span className="tnum font-medium text-ink-900">{c.n}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </AdminBody>
  );
}

function CoverageCell({ cell }: { cell?: CoverageRow["years"][string] }) {
  if (!cell) return <span className="text-[13px] text-ink-300">-</span>;
  const tone = cell.state === "green" ? "good" : cell.state === "amber" ? "amber" : "warn";
  const label = cell.state === "green" ? "Covered" : cell.state === "amber" ? "Part of the year" : "Missing";
  return (
    <span className="flex flex-col items-start gap-1" title={cell.error ?? undefined}>
      <Pill tone={tone}>{label}</Pill>
      {cell.citation && (
        <span className="max-w-[220px] truncate text-[12.5px] text-ink-400">
          {cell.citation}
          {cell.effective_from ? `, from ${day(cell.effective_from)}` : ""}
        </span>
      )}
      {cell.later?.map((l) => (
        <span key={l.effective_from} className="max-w-[220px] truncate text-[12.5px] text-ink-400">
          then {l.citation}, from {day(l.effective_from)}
        </span>
      ))}
    </span>
  );
}
