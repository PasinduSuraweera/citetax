"use client";

/**
 * The corpus agent: what it does on its own, when it last ran, what it found.
 *
 * This is the screen that proves the currency claim. A changed source shows up
 * here as the agent's own report before a reviewer has opened anything.
 */

import { Play } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminBody, AdminFrame, refreshAdminSummary } from "@/components/admin/AdminShell";
import { Confirm, ErrorNote, PageHeader, Pill, Stat, TableHead, errorText, relTime, when } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, type AgentStatus, type Me } from "@/lib/admin";

export default function AgentPage() {
  return <AdminFrame>{(me) => <Agent me={me} />}</AdminFrame>;
}

const COLS = "140px 90px 60px 80px 90px 80px 90px minmax(0,1fr)";

function Agent({ me }: { me: Me }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await admin.agentStatus());
      setError(null);
    } catch (e) {
      setError(errorText(e, "Could not load the agent's status"));
    }
  }, []);

  useEffect(() => {
    // load() only sets state once its request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // Live enough to watch a cycle finish without pressing refresh.
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const runNow = async () => {
    setBusy("run");
    try {
      const r = await admin.agentRun();
      toast.success("Cycle finished", { description: r.summary || undefined });
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "The cycle failed"));
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    setBusy("index");
    try {
      const r = await admin.rebuildIndex();
      toast.success(`Index rebuilt: ${r.chunks_written} passages`, {
        description: `${r.embedded} embedded${r.errors.length ? `, ${r.errors.length} errors` : ""}.`,
      });
      setConfirmRebuild(false);
      await load();
    } catch (e) {
      toast.error(errorText(e, "Rebuild failed"));
    } finally {
      setBusy(null);
    }
  };

  const last = status?.cycles[0];

  return (
    <AdminBody>
      <PageHeader
        title="Corpus agent"
        description="Runs on its own: crawls every source, reads new documents, asks the model to pre-fill proposals, and indexes new passages. It stops where a person has to decide. It never approves and never publishes."
        actions={
          <>
            {me.role === "admin" && (
              <Button variant="outline" onClick={() => setConfirmRebuild(true)} disabled={busy !== null}>
                Rebuild index
              </Button>
            )}
            <Button onClick={runNow} disabled={busy !== null || status?.running_now}>
              <Play />
              {busy === "run" || status?.running_now ? "Running..." : "Run a cycle now"}
            </Button>
          </>
        }
      />

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!status && !error && <Skeleton className="mt-6 h-80 w-full" />}

      {status && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Schedule"
              value={status.enabled ? `Every ${status.interval_minutes} min` : "Off"}
              sub={status.next_run_at ? `Next ${relTime(status.next_run_at)}` : "Runs only when asked"}
              tone={status.enabled ? undefined : "warn"}
            />
            <Stat
              label="Passages indexed"
              value={status.index.chunks.toLocaleString()}
              sub={`${status.index.embedded.toLocaleString()} embedded, ${status.index.rule_chunks} from rules`}
            />
            <Stat
              label="Waiting to be read"
              value={status.awaiting_extraction}
              sub="Documents not yet extracted"
              tone={status.awaiting_extraction ? "brand" : undefined}
            />
            <Stat label="Last cycle" value={last ? relTime(last.finished_at ?? last.started_at) : "Never"} sub={last?.summary ?? "No cycle yet"} />
          </div>

          <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
            <div className="min-w-[900px]">
              <TableHead cols={COLS}>
                <span>Started</span>
                <span>Trigger</span>
                <span className="text-right">New</span>
                <span className="text-right">Changed</span>
                <span className="text-right">Proposals</span>
                <span className="text-right">Indexed</span>
                <span className="text-right">Tokens</span>
                <span>Summary</span>
              </TableHead>
              {status.cycles.length === 0 && (
                <p className="px-5 py-8 text-center text-[14px] text-ink-400">No cycle has run yet. Run one now, or wait for the schedule.</p>
              )}
              {status.cycles.map((c) => (
                <div key={c.id} className="tnum grid items-start gap-4 border-b border-line-faint px-5 py-3 text-[13.5px] last:border-b-0" style={{ gridTemplateColumns: COLS }}>
                  <span className="text-ink-500">{when(c.started_at)}</span>
                  <span><Pill tone={c.trigger === "scheduler" ? "good" : "neutral"}>{c.trigger === "scheduler" ? "Schedule" : "Manual"}</Pill></span>
                  <span className="text-right text-ink-700">{c.new_documents}</span>
                  <span className={`text-right ${c.revisions ? "font-medium text-warn-600" : "text-ink-700"}`}>{c.revisions}</span>
                  <span className={`text-right ${c.proposals_created ? "font-medium text-brand-600" : "text-ink-700"}`}>{c.proposals_created}</span>
                  <span className="text-right text-ink-700">{c.chunks_indexed}</span>
                  <span className="text-right text-ink-400">{c.llm_tokens.toLocaleString()}</span>
                  <span className="min-w-0 leading-[1.5] text-ink-500">
                    {c.summary}
                    {c.errors && c.errors.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[13px] text-warn-600">
                          {c.errors.length} error{c.errors.length === 1 ? "" : "s"}
                        </summary>
                        <ul className="mt-1 flex flex-col gap-0.5 text-[12.5px] text-warn-600">
                          {c.errors.slice(0, 5).map((e, i) => <li key={i} className="break-words">{e}</li>)}
                        </ul>
                      </details>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <p className="mt-4 text-[14px] leading-[1.6] text-ink-500">
            Pre-filled proposals land in the{" "}
            <Link href="/admin" className="font-medium text-brand-600 hover:underline">review inbox</Link> with the
            extractor&apos;s confidence and reasoning. Reviewer corrections are counted on{" "}
            <Link href="/admin/health" className="font-medium text-brand-600 hover:underline">corpus health</Link>.
          </p>
        </>
      )}

      <Confirm
        open={confirmRebuild}
        onOpenChange={setConfirmRebuild}
        title="Rebuild the search index?"
        description="Every passage is dropped and embedded again. It takes about a minute and uses embedding quota, and answers cite fewer passages until it finishes."
        confirmLabel="Rebuild"
        busy={busy === "index"}
        onConfirm={rebuild}
      />
    </AdminBody>
  );
}
