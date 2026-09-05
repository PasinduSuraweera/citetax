"use client";

/** Source registry, crawl now, manual upload (spec section 5.1 I). */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, type AgentStatus, type CrawlResult, type Me, type SourceRow } from "@/lib/admin";

export default function SourcesPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [families, setFamilies] = useState<
    Awaited<ReturnType<typeof admin.documents>>["families"]
  >([]);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const who = await admin.me();
      setMe(who);
      if (!who.is_reviewer) return;
      const [s, d, a] = await Promise.all([
        admin.sources(),
        admin.documents(),
        admin.agentStatus().catch(() => null),
      ]);
      setSources(s.sources);
      setFamilies(d.families);
      setAgent(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sources");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!ready) return <Loading />;
  if (!me?.is_reviewer) return <NoAccess me={me} />;

  const crawl = async (sourceId: string) => {
    setBusy(sourceId);
    setError(null);
    setResult(null);
    try {
      const r = await admin.crawl(sourceId);
      setResult(r);
      setMessage(
        r.revisions > 0
          ? `${r.revisions} silent revision(s) detected. They are in the inbox as priority 1.`
          : `${r.new_documents} new document(s), ${r.unchanged} unchanged.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Crawl failed");
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File) => {
    setBusy("upload");
    setError(null);
    try {
      const r = await admin.upload(file, "circular", file.name);
      setMessage(
        r.is_revision
          ? "Uploaded as a revision of a document already in the corpus. It is in the inbox as priority 1."
          : "Uploaded. It is in the review inbox awaiting extraction.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <AdminShell me={me}>
      <div className="px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
        <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">
          Sources
        </h1>
        <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
          Each watched source is a row, never hardcoded. A URL that is already
          known but whose content changed is a silent revision, and it goes
          straight to the top of the review queue.
        </p>

        {message && (
          <div className="mt-5 rounded-xl border border-good-300 bg-good-100 px-5 py-3 text-[13.5px] text-good-500">
            {message}
          </div>
        )}
        {error && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] text-warn-500">
            {error}
          </div>
        )}

        {agent && (
          <div className={`mt-5 flex items-center justify-between rounded-xl border px-5 py-3 ${agent.enabled ? "border-good-300 bg-good-100" : "border-line bg-panel"}`}>
            <div className="flex items-center gap-3">
              <span className={`h-[8px] w-[8px] flex-none rounded-full ${agent.enabled ? "bg-good-mint" : "bg-ink-300"} ${agent.running_now ? "pulse-dot" : ""}`} />
              <span className="text-[13.5px] text-ink-700">
                {agent.running_now ? (
                  <strong className="font-semibold text-ink-900">The corpus agent is crawling now.</strong>
                ) : agent.enabled ? (
                  <>
                    <strong className="font-semibold text-ink-900">The corpus agent crawls every {agent.interval_minutes} minutes</strong>
                    {agent.next_run_at ? <>, next {relTime(agent.next_run_at)}</> : null}.
                    {agent.cycles[0]?.summary ? <> Last time: {agent.cycles[0].summary}.</> : null}
                  </>
                ) : (
                  <>Automatic crawling is off. Sources are crawled only when you press the button.</>
                )}
              </span>
            </div>
            <Link href="/admin/agent" className="flex-none font-mono text-[11px] text-brand-600 hover:underline">
              agent log
            </Link>
          </div>
        )}

        <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
          <div className="flex min-w-[820px] items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
            <span className="flex-1">SOURCE</span>
            <span className="w-[90px] flex-none">PRIORITY</span>
            <span className="w-[90px] flex-none">DOCS</span>
            <span className="w-[150px] flex-none">LAST CHANGE</span>
            <span className="w-[120px] flex-none text-right">ACTION</span>
          </div>

          {sources.map((s) => (
            <div
              key={s.source_id}
              className="flex min-w-[820px] items-center border-b border-line-faint px-5 py-[13px] last:border-b-0"
            >
              <div className="min-w-0 flex-1 pr-4">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium text-ink-900">
                    {s.name}
                  </span>
                  {!s.enabled && (
                    <span className="rounded-full bg-panel px-2 py-[2px] font-mono text-[10px] text-ink-300">
                      disabled
                    </span>
                  )}
                  {s.stale && (
                    <span className="rounded-full bg-warn-100 px-2 py-[2px] font-mono text-[10px] font-semibold text-warn-600">
                      stale
                    </span>
                  )}
                </div>
                <div className="mt-[2px] truncate font-mono text-[11px] text-ink-300">
                  {s.index_url}
                </div>
                {s.last_error && (
                  <div className="mt-[3px] text-[11.5px] leading-[1.45] text-warn-500">
                    {s.last_error}
                  </div>
                )}
              </div>

              <span className="w-[90px] flex-none">
                <span
                  className={`rounded-full px-2 py-[3px] font-mono text-[10px] font-semibold ${
                    s.priority === "high"
                      ? "bg-warn-100 text-warn-600"
                      : "bg-panel text-ink-500"
                  }`}
                >
                  {s.priority}
                </span>
              </span>

              <span className="tnum w-[90px] flex-none font-mono text-[13px] text-ink-700">
                {s.document_count}
              </span>

              <span className="w-[150px] flex-none font-mono text-[11.5px] text-ink-500">
                {s.days_since_change == null
                  ? "never"
                  : s.days_since_change === 0
                    ? "today"
                    : `${s.days_since_change}d ago`}
              </span>

              <span className="w-[120px] flex-none text-right">
                {s.discovery === "manual_upload" ? (
                  <span className="font-mono text-[11px] text-ink-200">upload</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => crawl(s.source_id)}
                    disabled={busy !== null || !s.enabled}
                    className="rounded-lg border border-line-strong bg-white px-3 py-[6px] text-[12.5px] font-medium text-ink-700 hover:border-brand-600 disabled:opacity-40"
                  >
                    {busy === s.source_id ? "..." : "Crawl now"}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>

        {result && (
          <div className="mt-4 rounded-xl border border-line bg-white px-5 py-4">
            <div className="eyebrow">LAST CRAWL</div>
            <div className="mt-3 flex gap-6 font-mono text-[12.5px] text-ink-700">
              <span>links {result.links_found}</span>
              <span>new {result.new_documents}</span>
              <span className={result.revisions ? "font-semibold text-warn-600" : ""}>
                revisions {result.revisions}
              </span>
              <span>unchanged {result.unchanged}</span>
            </div>
            {result.documents.length > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                {result.documents.map((d) => (
                  <div key={d.id} className="font-mono text-[11.5px] text-ink-500">
                    {d.is_revision && (
                      <span className="mr-2 font-semibold text-warn-600">
                        REVISION {d.revision_no}
                      </span>
                    )}
                    {d.url}
                  </div>
                ))}
              </div>
            )}
            {result.errors.length > 0 && (
              <div className="mt-3 text-[11.5px] leading-[1.5] text-warn-500">
                {result.errors.slice(0, 3).map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Manual upload */}
        <div className="mt-4 rounded-xl border border-line bg-white px-5 py-5">
          <div className="eyebrow">MANUAL UPLOAD</div>
          <p className="mt-2 max-w-[600px] text-[13px] leading-[1.55] text-ink-400">
            A document that arrives by other means enters the same pipeline and
            gets the same lineage and audit treatment as a crawled one. Upload a
            changed copy of something already here and it is recorded as a
            revision.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.html,.htm,.doc,.docx"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
            disabled={busy !== null}
            className="mt-4 block text-[13px] text-ink-700 file:mr-4 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-[13px] file:font-semibold file:text-white hover:file:bg-brand-700"
          />
        </div>

        {/* Document lineage */}
        <div className="mt-4 rounded-xl border border-line bg-white px-5 py-5">
          <div className="eyebrow">DOCUMENT FAMILIES</div>
          <p className="mt-2 text-[13px] leading-[1.55] text-ink-400">
            Three copies of one circular are three revisions in one family,
            never three competing documents.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {families.filter((f) => f.has_revisions).length === 0 && (
              <p className="text-[13px] text-ink-300">
                No document has been revised yet. Crawl a source twice after its
                content changes to see a lineage build up.
              </p>
            )}
            {families
              .filter((f) => f.has_revisions)
              .map((f) => (
                <div
                  key={f.family_id}
                  className="rounded-lg border border-warn-300 bg-warn-100 px-4 py-3"
                >
                  <div className="font-mono text-[11px] font-semibold text-warn-600">
                    {f.latest_revision} REVISIONS IN ONE FAMILY
                  </div>
                  {f.revisions.map((r) => (
                    <div
                      key={r.id}
                      className="mt-2 flex items-baseline gap-3 font-mono text-[11.5px] text-ink-700"
                    >
                      <span className="w-12 flex-none font-semibold">
                        rev {r.revision_no}
                      </span>
                      <span className="w-24 flex-none text-ink-400">
                        {r.sha256}
                      </span>
                      <span className="truncate">{r.title ?? r.url}</span>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}

function relTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const label = mins < 1 ? "under a minute" : mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  return diff > 0 ? `in ${label}` : `${label} ago`;
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
