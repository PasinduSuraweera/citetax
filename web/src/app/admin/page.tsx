"use client";

/** Review inbox (spec section 5.1 A). Sorted by risk then age. */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, PRIORITY_LABEL, type Me, type ProposalRow } from "@/lib/admin";

export default function ReviewInboxPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<ProposalRow[]>([]);
  const [onlyRevisions, setOnlyRevisions] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await admin.me();
      setMe(who);
      if (!who.is_reviewer) return;
      const [queue, health] = await Promise.all([
        admin.proposals({ onlyRevisions }),
        admin.health().catch(() => null),
      ]);
      setRows(queue.proposals);
      setSnapshot(health?.snapshot?.label ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the queue");
    } finally {
      setReady(true);
    }
  }, [onlyRevisions]);

  useEffect(() => {
    load();
  }, [load]);

  if (!ready) return <Loading />;
  if (!me?.is_reviewer) return <NoAccess me={me} />;

  const urgent = rows.filter((r) => r.priority === 1).length;

  return (
    <AdminShell me={me} snapshotLabel={snapshot} urgentCount={urgent}>
      <div className="px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">
              Review inbox
            </h1>
            <p className="mt-2 max-w-[640px] text-[14.5px] leading-[1.6] text-ink-500">
              No machine extracted rule reaches a user until a qualified
              reviewer approves it. Sorted by risk, then by age.
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-white px-3 py-2">
            <input
              type="checkbox"
              checked={onlyRevisions}
              onChange={(e) => setOnlyRevisions(e.target.checked)}
              className="accent-[var(--color-brand-600)]"
            />
            <span className="text-[13px] text-ink-700">
              Revisions of published rules only
            </span>
          </label>
        </div>

        {error && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4 text-[14px] text-warn-500">
            {error}
          </div>
        )}

        {urgent > 0 && (
          <div className="mt-5 flex items-center gap-3 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4">
            <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-warn-600 text-xs font-bold text-white">
              !
            </span>
            <div className="text-[14px] text-warn-500">
              <strong className="font-semibold text-warn-700">
                {urgent} {urgent === 1 ? "revision" : "revisions"} of a
                published rule
              </strong>
              . A rule already serving users may now be wrong. Target response
              is four hours.
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-line-strong bg-white px-6 py-12 text-center">
            <div className="eyebrow">QUEUE IS EMPTY</div>
            <p className="mx-auto mt-3 max-w-[420px] text-[14px] leading-[1.6] text-ink-400">
              Nothing is waiting for review. Run a crawl from the Sources screen
              or upload a document to put something in the queue.
            </p>
            <Link
              href="/admin/sources"
              className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700"
            >
              Go to sources
            </Link>
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
            <div className="flex min-w-[820px] items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
              <span className="w-[150px] flex-none">PRIORITY</span>
              <span className="flex-1">DOCUMENT</span>
              <span className="w-[150px] flex-none">RULE KEY</span>
              <span className="w-[110px] flex-none">CONFIDENCE</span>
              <span className="w-[110px] flex-none">AGE</span>
              <span className="w-[90px] flex-none text-right">SLA</span>
            </div>

            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/admin/proposals/${r.id}`}
                className="flex min-w-[820px] items-center border-b border-line-faint px-5 py-[13px] transition-colors last:border-b-0 hover:bg-panel"
              >
                <span className="w-[150px] flex-none">
                  <PriorityBadge priority={r.priority} />
                </span>

                <span className="flex-1 pr-4">
                  <span className="block truncate text-[14px] font-medium text-ink-900">
                    {r.document_title ?? "Untitled document"}
                  </span>
                  <span className="mt-[2px] block truncate font-mono text-[11px] text-ink-300">
                    {r.revision_no && r.revision_no > 1
                      ? `revision ${r.revision_no}, supersedes revision ${r.revision_no - 1}`
                      : r.document_url ?? r.status}
                  </span>
                </span>

                <span className="w-[150px] flex-none pr-2">
                  {r.rule_key ? (
                    <span className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-[11.5px] text-ink-700">
                      {r.rule_key}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-ink-200">
                      not extracted
                    </span>
                  )}
                </span>

                <span className="w-[110px] flex-none pr-3">
                  <ConfidenceBar value={r.confidence} />
                </span>

                <span className="tnum w-[110px] flex-none font-mono text-[12px] text-ink-500">
                  {formatAge(r.age_hours)}
                </span>

                <span className="w-[90px] flex-none text-right">
                  {r.sla_breached ? (
                    <span className="rounded-full bg-warn-100 px-2 py-[3px] font-mono text-[10px] font-semibold text-warn-600">
                      BREACHED
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] text-ink-300">
                      {r.sla_hours}h
                    </span>
                  )}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function PriorityBadge({ priority }: { priority: number }) {
  const styles: Record<number, string> = {
    1: "bg-warn-100 text-warn-600 border-warn-300",
    2: "bg-[#FDF4E0] text-[#7E5D1B] border-[#EBD6A8]",
    3: "bg-brand-050 text-brand-600 border-[#CBD6F5]",
    4: "bg-panel text-ink-500 border-line-strong",
    5: "bg-panel text-ink-300 border-line",
  };
  return (
    <span
      className={`inline-block rounded-full border px-[8px] py-[3px] text-[10.5px] font-semibold ${
        styles[priority] ?? styles[5]
      }`}
      title={PRIORITY_LABEL[priority]}
    >
      P{priority}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="font-mono text-[11px] text-ink-200">not scored</span>;
  }
  const pct = Math.round(value * 100);
  const tone = pct >= 85 ? "bg-good-mint" : pct >= 60 ? "bg-[#E0B252]" : "bg-warn-600";
  return (
    <span className="flex items-center gap-2">
      <span className="h-[5px] w-[52px] overflow-hidden rounded-sm bg-[#EFF2F9]">
        <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="tnum font-mono text-[11px] text-ink-500">{pct}</span>
    </span>
  );
}

function formatAge(hours?: number): string {
  if (hours == null) return "-";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
