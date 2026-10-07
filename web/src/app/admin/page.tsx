"use client";

/** Review inbox (spec section 5.1 A). Sorted by risk, then age. */

import { ChevronRight, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminBody, AdminFrame } from "@/components/admin/AdminShell";
import { Code, EmptyState, ErrorNote, PageHeader, PriorityPill, StatusPill, TableHead } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { admin, type ProposalRow } from "@/lib/admin";

export default function ReviewInboxPage() {
  return <AdminFrame>{() => <Inbox />}</AdminFrame>;
}

const COLS = "minmax(0,1fr) 170px 120px 90px 20px";

function Inbox() {
  const [rows, setRows] = useState<ProposalRow[] | null>(null);
  const [onlyRevisions, setOnlyRevisions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    admin
      .proposals({ onlyRevisions })
      .then((q) => {
        setRows(q.proposals);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the queue"));
  }, [onlyRevisions]);

  useEffect(load, [load]);

  const urgent = rows?.filter((r) => r.priority === 1).length ?? 0;
  const breached = rows?.filter((r) => r.sla_breached).length ?? 0;

  return (
    <AdminBody>
      <PageHeader
        title="Review inbox"
        description="No machine extracted rule reaches a user until a reviewer approves it. Highest risk first, then oldest."
        actions={
          <label className="flex cursor-pointer items-center gap-2.5 text-[14px] text-ink-700">
            <Switch checked={onlyRevisions} onCheckedChange={setOnlyRevisions} />
            Revised documents only
          </label>
        }
      />

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}

      {urgent > 0 && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4">
          <TriangleAlert className="mt-0.5 size-5 flex-none text-warn-600" />
          <p className="text-[14px] leading-[1.55] text-warn-700">
            <strong className="font-semibold">
              {urgent === 1 ? "A document a published rule came from has changed." : `${urgent} documents published rules came from have changed.`}
            </strong>{" "}
            A rule serving answers now may be wrong. Aim to review within four hours.
          </p>
        </div>
      )}

      {!rows && !error && (
        <div className="mt-6 space-y-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      )}

      {rows && rows.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title={onlyRevisions ? "No revised documents waiting" : "Nothing waiting for review"}
            action={
              <Button nativeButton={false} render={<Link href="/admin/sources" />} variant="outline">
                Go to sources
              </Button>
            }
          >
            The corpus agent crawls every source on a schedule. Crawl one now or upload a document to put
            something in the queue.
          </EmptyState>
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="mt-6 flex items-baseline justify-between text-[13.5px] text-ink-400">
            <span>
              {rows.length} waiting{breached > 0 && <>, <span className="font-medium text-warn-600">{breached} past target time</span></>}
            </span>
          </div>
          <div className="mt-2 overflow-hidden rounded-xl border border-line bg-white">
            <div>
              <div className="hidden md:block">
                <TableHead cols={COLS}>
                  <span>Document</span>
                  <span>Rule</span>
                  <span>Confidence</span>
                  <span className="text-right">Waiting</span>
                  <span />
                </TableHead>
              </div>
              {rows.map((r) => (
                <Link
                  key={r.id}
                  href={`/admin/proposals/${r.id}`}
                  className="group flex flex-col gap-2 border-b border-line-faint px-4 py-3.5 transition-colors last:border-b-0 hover:bg-panel md:grid md:items-center md:gap-4 md:px-5 md:[grid-template-columns:var(--cols)]"
                  style={{ "--cols": COLS } as React.CSSProperties}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <PriorityPill priority={r.priority} />
                      {r.status !== "needs_review" && <StatusPill status={r.status} />}
                    </span>
                    <span className="mt-1.5 block text-[14.5px] font-medium text-ink-900 md:truncate">
                      {r.document_title ?? "Untitled document"}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-ink-400">
                      {r.revision_no && r.revision_no > 1 ? `Revision ${r.revision_no} of ${host(r.document_url)}` : host(r.document_url)}
                    </span>
                  </span>
                  <span className="min-w-0">
                    {r.rule_key ? <Code>{r.rule_key}</Code> : <span className="text-[13px] text-ink-300">Not extracted yet</span>}
                  </span>
                  <span className="hidden md:block"><Confidence value={r.confidence} /></span>
                  <span className={`tnum text-[13.5px] md:text-right ${r.sla_breached ? "font-medium text-warn-600" : "text-ink-500"}`}>
                    <span className="md:hidden">Waiting </span>
                    {formatAge(r.age_hours)}
                  </span>
                  <ChevronRight className="hidden size-4 text-ink-200 transition-colors group-hover:text-ink-400 md:block" />
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </AdminBody>
  );
}

function Confidence({ value }: { value: number | null }) {
  if (value == null) return <span className="text-[13px] text-ink-300">-</span>;
  const pct = Math.round(value * 100);
  const tone = pct >= 85 ? "bg-good-mint" : pct >= 60 ? "bg-gold-500" : "bg-warn-600";
  return (
    <span className="flex items-center gap-2" title="Extractor confidence">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-canvas">
        <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="tnum text-[13px] text-ink-500">{pct}%</span>
    </span>
  );
}

function host(url: string | null): string {
  if (!url) return "Uploaded";
  if (url.startsWith("upload://")) return "Uploaded";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatAge(hours?: number): string {
  if (hours == null) return "-";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}
