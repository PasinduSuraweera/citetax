"use client";

/** Source registry, crawl now, manual upload (spec section 5.1 I). */

import { FileUp, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AdminBody, AdminFrame, refreshAdminSummary } from "@/components/admin/AdminShell";
import { ErrorNote, PageHeader, Panel, Pill, TableHead, errorText, relTime, when } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, type AgentStatus, type CrawlResult, type SourceRow } from "@/lib/admin";

export default function SourcesPage() {
  return <AdminFrame>{() => <Sources />}</AdminFrame>;
}

type Families = Awaited<ReturnType<typeof admin.documents>>["families"];

const SKIP_LABEL: Record<string, string> = {
  robots: "not allowed by the site's robots.txt",
  gone: "links that no longer exist",
  listing: "listings or pages whose content loads by script",
};

const COLS = "minmax(0,1fr) 90px 150px 150px 110px";

function Sources() {
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [families, setFamilies] = useState<Families>([]);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [s, d, a] = await Promise.all([admin.sources(), admin.documents(), admin.agentStatus().catch(() => null)]);
      setSources(s.sources);
      setFamilies(d.families);
      setAgent(a);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Could not load sources"));
    }
  }, []);

  useEffect(() => {
    // load() only sets state once its requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const crawl = async (s: SourceRow) => {
    setBusy(s.source_id);
    setResult(null);
    try {
      const r = await admin.crawl(s.source_id);
      setResult(r);
      const found = r.new_documents + r.revisions;
      if (r.errors.length) toast.warning(`${s.name}: crawled with ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}`);
      else if (found) toast.success(`${s.name}: ${found} new or changed document${found === 1 ? "" : "s"} in the inbox`);
      else toast.success(`${s.name}: nothing has changed`);
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Crawl failed"));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File) => {
    setBusy("upload");
    try {
      const r = await admin.upload(file, "circular", file.name);
      toast.success(r.is_revision ? "Uploaded as a new revision of a known document" : "Uploaded", {
        description: `Read ${r.characters.toLocaleString()} characters${r.pages ? ` from ${r.pages} page${r.pages === 1 ? "" : "s"}` : ""}. The agent pre-fills a proposal on its next cycle.`,
      });
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Upload failed"));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const revised = families.filter((f) => f.has_revisions && !f.listing);

  return (
    <AdminBody>
      <PageHeader
        title="Sources"
        description="The sites the corpus agent watches. When a known page changes what it says, the new version goes to the review inbox."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.html,.htm,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
              <FileUp />
              {busy === "upload" ? "Uploading..." : "Upload a document"}
            </Button>
          </>
        }
      />

      {agent && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-panel px-5 py-3.5">
          <div className="flex items-center gap-3 text-[14px] text-ink-700">
            <span className={`size-2 flex-none rounded-full ${agent.enabled ? "bg-good-mint" : "bg-ink-300"} ${agent.running_now ? "pulse-dot" : ""}`} />
            {agent.running_now
              ? "The corpus agent is crawling now."
              : agent.enabled
                ? <>The corpus agent crawls every {agent.interval_minutes} minutes{agent.next_run_at ? <>, next {relTime(agent.next_run_at)}</> : null}.</>
                : "Scheduled crawling is off. Sources are crawled only when you ask."}
          </div>
          <Link href="/admin/agent" className="text-[13.5px] font-medium text-brand-600 hover:underline">Agent log</Link>
        </div>
      )}

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!sources && !error && <Skeleton className="mt-6 h-64 w-full" />}

      {sources && (
        <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
          <div className="min-w-[780px]">
            <TableHead cols={COLS}>
              <span>Source</span>
              <span className="text-right">Documents</span>
              <span>Last crawled</span>
              <span>Last change</span>
              <span />
            </TableHead>
            {sources.map((s) => (
              <div key={s.source_id} className="grid items-center gap-4 border-b border-line-faint px-5 py-3.5 last:border-b-0" style={{ gridTemplateColumns: COLS }}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14.5px] font-medium text-ink-900">{s.name}</span>
                    {!s.enabled && <Pill>Off</Pill>}
                    {s.stale && <Pill tone="warn">Stale</Pill>}
                    {s.last_status === "failed" && <Pill tone="warn">Last crawl failed</Pill>}
                  </div>
                  {s.discovery !== "manual_upload" && (
                    <a href={s.index_url} target="_blank" rel="noopener noreferrer" className="mt-0.5 block truncate text-[13px] text-ink-400 hover:text-brand-600">
                      {s.index_url}
                    </a>
                  )}
                  {s.last_status === "failed" && s.last_error && (
                    <div className="mt-1 line-clamp-2 text-[12.5px] leading-[1.45] text-warn-600">{s.last_error}</div>
                  )}
                </div>
                <span className="tnum text-right text-[14px] text-ink-700">{s.document_count}</span>
                <span className="text-[13.5px] text-ink-500">{s.discovery === "manual_upload" ? "-" : relTime(s.last_run_at)}</span>
                <span className="text-[13.5px] text-ink-500" title={s.last_change_at ? when(s.last_change_at) : undefined}>
                  {s.days_since_change == null ? "Never" : s.days_since_change === 0 ? "Today" : `${s.days_since_change} days ago`}
                </span>
                <span className="text-right">
                  {s.discovery === "manual_upload" ? (
                    <span className="text-[13px] text-ink-300">Uploads</span>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => crawl(s)} disabled={busy !== null || !s.enabled}>
                      <RefreshCw className={busy === s.source_id ? "animate-spin" : ""} />
                      {busy === s.source_id ? "Crawling" : "Crawl"}
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <Panel className="mt-4" title="Last crawl">
          <div className="tnum flex flex-wrap gap-x-6 gap-y-1 text-[14px] text-ink-700">
            <span>{result.links_found} links</span>
            <span>{result.new_documents} new</span>
            <span className={result.revisions ? "font-medium text-warn-600" : ""}>{result.revisions} changed</span>
            <span>{result.unchanged} unchanged</span>
            {(result.skipped?.length ?? 0) > 0 && <span className="text-ink-400">{result.skipped!.length} skipped</span>}
          </div>
          {result.documents.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-[13px] text-ink-500">
              {result.documents.map((d) => (
                <li key={d.id} className="truncate">
                  {d.is_revision && <span className="mr-2 font-medium text-warn-600">Revision {d.revision_no}</span>}
                  {d.url}
                </li>
              ))}
            </ul>
          )}
          {result.errors.length > 0 && (
            <div className="mt-3"><ErrorNote>{result.errors.slice(0, 3).map((e) => <div key={e} className="truncate">{e}</div>)}</ErrorNote></div>
          )}
          {(result.skipped?.length ?? 0) > 0 && (
            <ul className="mt-3 flex flex-col gap-1 text-[13px] leading-[1.5] text-ink-400">
              {Object.entries(result.skip_reasons ?? {}).map(([reason, urls]) => (
                <li key={reason}>
                  <span className="font-medium text-ink-500">{urls.length} {SKIP_LABEL[reason] ?? reason}</span>
                  {reason === "robots" && <>: {urls.slice(0, 3).join(", ")}</>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <Panel
        className="mt-4"
        title="Revised documents"
        description="Each changed copy of a page is a new revision in the same family, never a competing document."
      >
        {revised.length === 0 ? (
          <p className="text-[14px] text-ink-400">No document has changed since it was first seen.</p>
        ) : (
          <div className="flex flex-col divide-y divide-line-faint">
            {revised.map((f) => {
              const latest = f.revisions[0];
              return (
                <details key={f.family_id} className="py-2.5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[14px] text-ink-900">{latest?.title ?? latest?.url}</span>
                    <Pill>{f.latest_revision} revisions</Pill>
                  </summary>
                  <ol className="mt-2 flex flex-col gap-1 pl-1">
                    {f.revisions.map((r) => (
                      <li key={r.id} className="tnum flex gap-3 text-[13px] text-ink-500">
                        <span className="w-24 flex-none">Revision {r.revision_no}</span>
                        <span>{when(r.fetched_at)}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              );
            })}
          </div>
        )}
      </Panel>
    </AdminBody>
  );
}
