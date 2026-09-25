"use client";

/** Audit log (spec section 5.1 H). Append only, never editable. */

import { useEffect, useState } from "react";
import { AdminBody, AdminFrame } from "@/components/admin/AdminShell";
import { EmptyState, ErrorNote, PageHeader, TableHead, errorText, when } from "@/components/admin/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, type AuditEvent } from "@/lib/admin";

export default function AuditPage() {
  return <AdminFrame>{() => <Audit />}</AdminFrame>;
}

/** Plain words for each action the API records. */
const ACTIONS: Record<string, string> = {
  "proposal.edit": "Edited a proposal",
  "proposal.approve": "Approved a proposal",
  "proposal.approve.first": "Gave the first signature",
  "proposal.approve.second": "Gave the second signature",
  "proposal.reject": "Rejected a proposal",
  "proposal.bulk_reject": "Cleared stale proposals",
  "snapshot.publish": "Published a snapshot",
  "snapshot.rollback": "Rolled back a snapshot",
  "escalation.resolved": "Resolved a flag",
  "escalation.dismissed": "Dismissed a flag",
  "escalation.open": "Reopened a flag",
  "user.role": "Changed a role",
  "agent.run": "Ran the corpus agent",
  "document.upload": "Uploaded a document",
  "proposal.reextract": "Re-ran the extractor",
  "index.rebuild": "Rebuilt the search index",
  "history.remove": "Removed an answer from history",
  "history.clear": "Cleared their history",
};

const FILTERS: Array<[string, string]> = [
  ["", "Everything"],
  ["proposal.approve.first", "First signatures"],
  ["proposal.approve.second", "Second signatures"],
  ["proposal.reject", "Rejections"],
  ["snapshot.publish", "Publishes"],
  ["user.role", "Role changes"],
];

const COLS = "150px 220px minmax(0,1fr)";

function Audit() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    admin
      .audit(200, action || undefined)
      .then((r) => live && (setEvents(r.events), setError(null)))
      .catch((e) => live && setError(errorText(e, "Could not load the audit log")));
    return () => {
      live = false;
    };
  }, [action]);

  return (
    <AdminBody>
      <PageHeader
        title="Audit log"
        description="Who did what, and when, with the before and after. Nothing here can be edited or deleted."
        actions={
          <select
            value={action}
            onChange={(e) => {
              setEvents(null);
              setAction(e.target.value);
            }}
            aria-label="Show"
            className="h-9 rounded-lg border border-input bg-white px-3 text-[14px] text-ink-700"
          >
            {FILTERS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        }
      />

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!events && !error && <Skeleton className="mt-6 h-80 w-full" />}
      {events && events.length === 0 && <div className="mt-6"><EmptyState title="No events recorded" /></div>}

      {events && events.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
          <div className="min-w-[760px]">
            <TableHead cols={COLS}>
              <span>When</span>
              <span>Who</span>
              <span>What</span>
            </TableHead>
            {events.map((e) => (
              <details key={e.id} className="group border-b border-line-faint last:border-b-0">
                <summary className="grid cursor-pointer list-none items-start gap-4 px-5 py-3 hover:bg-panel" style={{ gridTemplateColumns: COLS }}>
                  <span className="tnum text-[13.5px] text-ink-500">{when(e.at)}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] text-ink-900">{actorName(e)}</span>
                    {e.actor_email && e.actor_name !== e.actor_email && (
                      <span className="block truncate text-[12.5px] text-ink-400">{e.actor_email}</span>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] text-ink-900">{ACTIONS[e.action] ?? e.action}</span>
                    <span className="block truncate text-[13px] text-ink-400">{summarise(e)}</span>
                  </span>
                </summary>
                <div className="grid gap-3 px-5 pb-4 md:grid-cols-2">
                  <Json label="Before" value={e.before_json} />
                  <Json label="After" value={e.after_json} />
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </AdminBody>
  );
}

function actorName(e: AuditEvent): string {
  if (e.actor_name) return e.actor_name;
  if (!e.actor) return "System";
  if (e.actor === "extractor" || e.actor === "corpus-cleanup") return "Corpus agent";
  // An id with no account left behind it: the account was deleted.
  if (/^[0-9a-f]{8}-/.test(e.actor)) return "Deleted account";
  return e.actor;
}

function summarise(e: AuditEvent): string {
  const after = (e.after_json ?? {}) as Record<string, unknown>;
  if (typeof after.label === "string") return `${after.label}${after.changelog ? `: ${after.changelog}` : ""}`;
  if (typeof after.reason === "string") return after.reason;
  if (typeof after.note === "string" && after.note) return after.note;
  if (typeof after.role === "string") return `${after.email ?? ""} is now ${after.role}`.trim();
  if (after.signatures_cleared === true) return "Changed what was signed, so the signature was cleared";
  if (typeof after.count === "number") return `${after.count} proposals`;
  if (typeof after.filename === "string") return after.filename;
  const keys = Object.keys(after).filter((k) => k !== "signatures_cleared");
  return keys.length ? `Changed ${keys.join(", ").replaceAll("_", " ")}` : "";
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[12.5px] font-medium text-ink-400">{label}</div>
      <pre className="max-h-64 overflow-auto rounded-lg bg-panel px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-ink-500">
        {value == null ? "Nothing recorded" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
