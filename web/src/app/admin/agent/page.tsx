"use client";

/**
 * The corpus agent: what it does on its own, when it last ran, what it found.
 *
 * This is the screen that proves the currency claim. A silent revision at a
 * watched source appears here as the agent's own report before a reviewer has
 * opened anything.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, type AgentStatus, type Me } from "@/lib/admin";

export default function AgentPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await admin.me();
      setMe(who);
      if (who.is_reviewer) setStatus(await admin.agentStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load agent status");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    // load() only sets state once its requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // Live enough to watch a cycle finish without pressing refresh.
    const t = setInterval(() => {
      admin.agentStatus().then(setStatus).catch(() => undefined);
    }, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (!ready) return <Loading />;
  if (!me?.is_reviewer) return <NoAccess me={me} />;

  const runNow = async () => {
    setBusy("run");
    setError(null);
    setMessage(null);
    try {
      const r = await admin.agentRun();
      setMessage(r.summary || "Cycle complete.");
      setStatus(await admin.agentStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cycle failed");
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    if (!window.confirm("Drop and rebuild every retrieval passage? This takes a minute and uses embedding quota.")) return;
    setBusy("index");
    try {
      const r = await admin.rebuildIndex();
      setMessage(`Index rebuilt: ${r.chunks_written} passages, ${r.embedded} embedded${r.errors.length ? `, ${r.errors.length} errors` : ""}.`);
      setStatus(await admin.agentStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rebuild failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell me={me}>
      <div className="px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">Corpus agent</h1>
            <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
              Runs on its own. Crawls every source, extracts text, asks the model to
              pre-fill proposals, and indexes new passages. It stops at the point a
              human has to decide: it never approves, never publishes.
            </p>
          </div>
          <div className="flex flex-none gap-2">
            <button
              type="button"
              onClick={runNow}
              disabled={busy !== null || status?.running_now}
              className="rounded-lg bg-brand-600 px-4 py-[9px] text-[13px] font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
            >
              {busy === "run" || status?.running_now ? "Running..." : "Run a cycle now"}
            </button>
            {me.role === "admin" && (
              <button
                type="button"
                onClick={rebuild}
                disabled={busy !== null}
                className="rounded-lg border border-line-strong bg-white px-4 py-[9px] text-[13px] font-medium text-ink-700 hover:border-brand-600 disabled:opacity-40"
              >
                {busy === "index" ? "Rebuilding..." : "Rebuild index"}
              </button>
            )}
          </div>
        </div>

        {message && (
          <div className="mt-5 rounded-xl border border-good-300 bg-good-100 px-5 py-3 text-[13.5px] text-good-500">{message}</div>
        )}
        {error && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] text-warn-500">{error}</div>
        )}

        {status && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="SCHEDULE"
                value={status.enabled ? `every ${status.interval_minutes} min` : "off"}
                sub={status.next_run_at ? `next ${relTime(status.next_run_at)}` : "manual only"}
                tone={status.enabled ? "good" : "warn"}
              />
              <Stat
                label="PASSAGES INDEXED"
                value={String(status.index.chunks)}
                sub={`${status.index.embedded} with embeddings Â· ${status.index.rule_chunks} from rules`}
              />
              <Stat
                label="AWAITING EXTRACTION"
                value={String(status.awaiting_extraction)}
                sub="documents with a blank proposal"
                tone={status.awaiting_extraction ? "brand" : undefined}
              />
              <Stat
                label="LAST CYCLE"
                value={status.cycles[0] ? relTime(status.cycles[0].finished_at ?? status.cycles[0].started_at) : "never"}
                sub={status.cycles[0]?.summary ?? "no cycle recorded yet"}
              />
            </div>

            <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
              <div className="flex min-w-[820px] items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
                <span className="w-[150px] flex-none">WHEN</span>
                <span className="w-[110px] flex-none">TRIGGER</span>
                <span className="w-[80px] flex-none text-right">NEW</span>
                <span className="w-[90px] flex-none text-right">REVISIONS</span>
                <span className="w-[100px] flex-none text-right">PROPOSALS</span>
                <span className="w-[90px] flex-none text-right">INDEXED</span>
                <span className="w-[90px] flex-none text-right">TOKENS</span>
                <span className="flex-1 pl-5">SUMMARY</span>
              </div>
              {status.cycles.length === 0 && (
                <div className="px-5 py-8 text-center text-[13px] text-ink-400">
                  No cycle has run yet. Press run a cycle now, or wait for the schedule.
                </div>
              )}
              {status.cycles.map((c) => (
                <div key={c.id} className="flex min-w-[820px] items-start border-b border-line-faint px-5 py-[11px] last:border-b-0">
                  <span className="w-[150px] flex-none font-mono text-[11.5px] text-ink-500">
                    {c.started_at ? new Date(c.started_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}
                  </span>
                  <span className="w-[110px] flex-none">
                    <span className={`rounded-full px-2 py-[2px] font-mono text-[10px] ${c.trigger === "scheduler" ? "bg-good-100 text-good-600" : "bg-panel text-ink-500"}`}>
                      {c.trigger.startsWith("manual") ? "manual" : c.trigger}
                    </span>
                  </span>
                  <span className="tnum w-[80px] flex-none text-right font-mono text-[12.5px] text-ink-700">{c.new_documents}</span>
                  <span className={`tnum w-[90px] flex-none text-right font-mono text-[12.5px] ${c.revisions ? "font-semibold text-warn-600" : "text-ink-700"}`}>{c.revisions}</span>
                  <span className={`tnum w-[100px] flex-none text-right font-mono text-[12.5px] ${c.proposals_created ? "font-semibold text-brand-600" : "text-ink-700"}`}>{c.proposals_created}</span>
                  <span className="tnum w-[90px] flex-none text-right font-mono text-[12.5px] text-ink-700">{c.chunks_indexed}</span>
                  <span className="tnum w-[90px] flex-none text-right font-mono text-[12.5px] text-ink-500">{c.llm_tokens.toLocaleString()}</span>
                  <span className="min-w-0 flex-1 pl-5 text-[12.5px] leading-[1.5] text-ink-500">
                    {c.summary}
                    {c.errors && c.errors.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer font-mono text-[10.5px] text-warn-600">{c.errors.length} error{c.errors.length === 1 ? "" : "s"}</summary>
                        <ul className="mt-1 flex flex-col gap-[2px] font-mono text-[10.5px] text-warn-500">
                          {c.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      </details>
                    )}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-line bg-panel px-5 py-4 text-[13px] leading-[1.6] text-ink-500">
              Pre-filled proposals land in the{" "}
              <Link href="/admin" className="font-medium text-brand-600 hover:underline">review inbox</Link>{" "}
              with the extractor&apos;s confidence and rationale beside each field. The
              reviewer compares, corrects and signs. Corrections are recorded against
              the extractor and shown on{" "}
              <Link href="/admin/health" className="font-medium text-brand-600 hover:underline">corpus health</Link>.
            </div>
          </>
        )}
      </div>
    </AdminShell>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "brand" }) {
  const border = tone === "good" ? "border-good-300 bg-good-100" : tone === "warn" ? "border-warn-300 bg-warn-100" : tone === "brand" ? "border-brand-600 bg-brand-050" : "border-line bg-white";
  return (
    <div className={`rounded-xl border px-4 py-3 ${border}`}>
      <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">{label}</div>
      <div className="tnum mt-1 truncate font-mono text-[18px] font-semibold text-ink-900">{value}</div>
      {sub && <div className="mt-[3px] truncate text-[11.5px] text-ink-400" title={sub}>{sub}</div>}
    </div>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return "-";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const label = mins < 1 ? "under a minute" : mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  return diff > 0 ? `in ${label}` : `${label} ago`;
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
