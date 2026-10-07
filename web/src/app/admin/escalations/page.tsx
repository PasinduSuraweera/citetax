"use client";

/** User escalations (spec section 5.1 G): flags on a figure, closed with a note. */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminBody, AdminFrame, refreshAdminSummary } from "@/components/admin/AdminShell";
import { Code, Confirm, EmptyState, ErrorNote, PageHeader, Pill, errorText, relTime, when } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { admin, type Escalation } from "@/lib/admin";

export default function EscalationsPage() {
  return <AdminFrame>{() => <Escalations />}</AdminFrame>;
}

type Filter = "open" | "closed";

function Escalations() {
  const [rows, setRows] = useState<Escalation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [closing, setClosing] = useState<{ row: Escalation; status: "resolved" | "dismissed" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await admin.escalations()).escalations);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Could not load escalations"));
    }
  }, []);

  useEffect(() => {
    // load() only sets state once its request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const close = async () => {
    if (!closing) return;
    setBusy(true);
    try {
      await admin.closeEscalation(closing.row.id, closing.status, note.trim());
      toast.success(closing.status === "resolved" ? "Marked resolved" : "Dismissed");
      setClosing(null);
      setNote("");
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Could not update the flag"));
    } finally {
      setBusy(false);
    }
  };

  const reopen = async (row: Escalation) => {
    try {
      await admin.closeEscalation(row.id, "open", "");
      toast.success("Reopened");
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Could not reopen"));
    }
  };

  const open = rows?.filter((r) => r.status === "open") ?? [];
  const closed = rows?.filter((r) => r.status !== "open") ?? [];
  const shown = filter === "open" ? open : closed;

  return (
    <AdminBody>
      <PageHeader
        title="Escalations"
        description="Figures users have flagged. Each flag carries the rule version and inputs that produced the figure, so the answer can be reproduced as it stood."
      />

      <div className="mt-6 inline-flex rounded-lg bg-canvas p-[3px]" role="tablist">
        {(["open", "closed"] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1.5 text-[13.5px] transition-colors ${
              filter === f ? "bg-white font-medium text-ink-900 shadow-sm" : "text-ink-500 hover:text-ink-900"
            }`}
          >
            {f === "open" ? "Open" : "Closed"} <span className="tnum text-ink-400">{f === "open" ? open.length : closed.length}</span>
          </button>
        ))}
      </div>

      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      {!rows && !error && <div className="mt-4 space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}

      {rows && shown.length === 0 && (
        <div className="mt-4">
          <EmptyState title={filter === "open" ? "Nothing flagged" : "Nothing closed yet"}>
            {filter === "open"
              ? "No user has disputed a figure. Flags appear here with the rule version and run that produced them."
              : "Resolved and dismissed flags are kept here with the note that closed them."}
          </EmptyState>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {shown.map((r) => (
          <article key={r.id} className="rounded-xl border border-line bg-white px-5 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink-900">Step {r.step_no ?? "?"}</span>
                  {r.rule_key && <Code>{r.rule_key}</Code>}
                  {r.citation_label && <span className="text-[13px] text-ink-500">{r.citation_label}</span>}
                  {r.ya && <Pill>{r.ya}</Pill>}
                  {r.status !== "open" && <Pill tone={r.status === "resolved" ? "good" : "neutral"}>{r.status === "resolved" ? "Resolved" : "Dismissed"}</Pill>}
                </div>
                <div className="mt-1 text-[13px] text-ink-400">
                  Flagged {relTime(r.created_at)} by {r.flagged_by ?? "a guest"}
                </div>
                {r.note ? (
                  <p className="mt-3 max-w-[70ch] text-[14.5px] leading-[1.6] text-ink-700">&ldquo;{r.note}&rdquo;</p>
                ) : (
                  <p className="mt-3 text-[14px] text-ink-400">No note left.</p>
                )}
                {r.facts_redacted_json && Object.keys(r.facts_redacted_json).length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[13px] text-ink-400 hover:text-ink-700">Inputs used</summary>
                    <pre className="mt-2 overflow-x-auto rounded-lg bg-panel px-3 py-2 font-mono text-[12px] text-ink-500">
                      {JSON.stringify(r.facts_redacted_json, null, 2)}
                    </pre>
                  </details>
                )}
                {r.status !== "open" && r.resolution && (
                  <div className="mt-3 rounded-lg bg-panel px-4 py-3 text-[14px] leading-[1.55] text-ink-700">
                    <span className="text-ink-400">{r.resolved_by} on {when(r.resolved_at)}: </span>
                    {r.resolution}
                  </div>
                )}
              </div>
              <div className="flex flex-none gap-2">
                {r.status === "open" ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setClosing({ row: r, status: "dismissed" })}>
                      Dismiss
                    </Button>
                    <Button size="sm" onClick={() => setClosing({ row: r, status: "resolved" })}>
                      Resolve
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => reopen(r)}>
                    Reopen
                  </Button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>

      <Confirm
        open={closing !== null}
        onOpenChange={(o) => !o && setClosing(null)}
        title={closing?.status === "resolved" ? "Resolve this flag" : "Dismiss this flag"}
        description={
          closing?.status === "resolved"
            ? "Say what was wrong and what was done, for example the proposal that corrects the rule."
            : "Say why the figure stands, so the next reviewer does not reopen it."
        }
        confirmLabel={closing?.status === "resolved" ? "Resolve" : "Dismiss"}
        busy={busy}
        disabled={!note.trim()}
        onConfirm={close}
      >
        <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What you found" className="text-[14px]" />
      </Confirm>
    </AdminBody>
  );
}
