"use client";

/** Publish and rollback (spec section 5.1 E and I). */

import { Check, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminBody, AdminFrame, refreshAdminSummary } from "@/components/admin/AdminShell";
import { Code, Confirm, ErrorNote, PageHeader, Panel, Pill, TableHead, day, errorText, when } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, type Me, type ProposalRow, type SnapshotRow } from "@/lib/admin";

export default function SnapshotsPage() {
  return <AdminFrame>{(me) => <Snapshots me={me} />}</AdminFrame>;
}

const VALUE_BEARING = ["band.", "relief.", "credit.", "deduction.", "charge.", "deadline.", "apit.", "income.", "filing."];

function Snapshots({ me }: { me: Me }) {
  const [snapshots, setSnapshots] = useState<SnapshotRow[] | null>(null);
  const [approved, setApproved] = useState<ProposalRow[]>([]);
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [rollbackTo, setRollbackTo] = useState<SnapshotRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([admin.snapshots(), admin.proposals({ status: "approved" })]);
      setSnapshots(s.snapshots);
      setApproved(p.proposals);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Could not load snapshots"));
    }
  }, []);

  useEffect(() => {
    // load() only sets state once its requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const unsigned = approved.filter((p) => {
    const s = p.corrected_json ?? {};
    const dual = VALUE_BEARING.some((pre) => (p.rule_key ?? "").startsWith(pre));
    return dual && !(s.approved_by && s.second_approved_by);
  });

  const publish = async () => {
    setBusy("publish");
    try {
      const r = await admin.publish(changelog.trim());
      toast.success(`Published ${r.label}`, {
        description: `${r.published.length} rule version${r.published.length === 1 ? "" : "s"}. New answers use it now.`,
      });
      setChangelog("");
      setConfirmPublish(false);
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Publish failed"));
    } finally {
      setBusy(null);
    }
  };

  const rollback = async () => {
    if (!rollbackTo) return;
    setBusy("rollback");
    try {
      const r = await admin.rollback(rollbackTo.id);
      toast.success(`Rolled back to ${r.label}`, {
        description: r.affected_rule_keys.length ? `Changed: ${r.affected_rule_keys.join(", ")}` : undefined,
      });
      setRollbackTo(null);
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Rollback failed"));
    } finally {
      setBusy(null);
    }
  };

  const current = snapshots?.find((s) => s.is_current);

  return (
    <AdminBody>
      <PageHeader
        title="Snapshots"
        description="Publishing creates a new snapshot rather than editing rules in place. Every answer records the snapshot it used, so a rollback never rewrites history."
      />

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}

      <Panel
        className="mt-6"
        title="Ready to publish"
        description={
          approved.length === 0
            ? undefined
            : "These approved changes go live together. Check each one before you publish."
        }
      >
        {!snapshots ? (
          <Skeleton className="h-24 w-full" />
        ) : approved.length === 0 ? (
          <p className="text-[14px] text-ink-400">
            Nothing is approved and waiting. Approve proposals in the{" "}
            <Link href="/admin" className="font-medium text-brand-600 hover:underline">review inbox</Link> first.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-line-faint overflow-hidden rounded-lg border border-line">
              {approved.map((p) => (
                <ApprovedRow key={p.id} p={p} />
              ))}
            </ul>

            {unsigned.length > 0 && (
              <div className="mt-4">
                <ErrorNote>
                  {unsigned.length === 1 ? "One change is" : `${unsigned.length} changes are`} missing a second signature
                  and would block publishing.
                </ErrorNote>
              </div>
            )}

            <label className="mt-5 block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink-500">
                Changelog line, shown to users under what changed
              </span>
              <Input
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder="Describe the change in one sentence"
                className="h-10 text-[14px]"
              />
            </label>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                className="h-9 px-4"
                onClick={() => setConfirmPublish(true)}
                disabled={busy !== null || !me.can_approve || !changelog.trim() || unsigned.length > 0}
              >
                Publish snapshot
              </Button>
              {!me.can_approve ? (
                <span className="text-[13.5px] text-ink-400">Publishing needs the approver role. Your role is {me.role}.</span>
              ) : !changelog.trim() ? (
                <span className="text-[13.5px] text-ink-400">Add a changelog line first.</span>
              ) : null}
            </div>
          </>
        )}
      </Panel>

      <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
        <div className="min-w-[720px]">
          <TableHead cols="minmax(0,1fr) 80px 200px 120px">
            <span>Snapshot</span>
            <span className="text-right">Rules</span>
            <span>Published by</span>
            <span />
          </TableHead>
          {!snapshots && <div className="p-5"><Skeleton className="h-10 w-full" /></div>}
          {snapshots?.map((s) => (
            <div
              key={s.id}
              className={`grid items-center gap-4 border-b border-line-faint px-5 py-3.5 last:border-b-0 ${s.is_current ? "bg-brand-050/60" : ""}`}
              style={{ gridTemplateColumns: "minmax(0,1fr) 80px 200px 120px" }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14.5px] font-medium text-ink-900">{s.label}</span>
                  {s.is_current && <Pill tone="good">Live</Pill>}
                </div>
                <div className="mt-0.5 truncate text-[13px] text-ink-400">
                  {s.changelog ?? "No changelog"} · {when(s.created_at)}
                </div>
              </div>
              <span className="tnum text-right text-[14px] text-ink-700">{s.rule_count}</span>
              <span className="truncate text-[13.5px] text-ink-500">{s.created_by ?? "-"}</span>
              <span className="text-right">
                {!s.is_current && me.role === "admin" && (
                  <Button variant="outline" size="sm" onClick={() => setRollbackTo(s)} disabled={busy !== null}>
                    Roll back
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Confirm
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={`Publish ${approved.length} change${approved.length === 1 ? "" : "s"}?`}
        description={
          <>
            New answers will use them immediately
            {current ? <>, replacing <strong className="font-medium text-ink-900">{current.label}</strong> as the live snapshot</> : null}.
            If any required rule would be left without a value for a supported year, nothing is published.
          </>
        }
        confirmLabel="Publish"
        busy={busy === "publish"}
        onConfirm={publish}
      />

      <Confirm
        open={rollbackTo !== null}
        onOpenChange={(o) => !o && setRollbackTo(null)}
        title={`Roll back to ${rollbackTo?.label ?? ""}?`}
        description="New answers will use this snapshot. Answers already given keep the snapshot they were computed on."
        confirmLabel="Roll back"
        destructive
        busy={busy === "rollback"}
        onConfirm={rollback}
      />
    </AdminBody>
  );
}

function ApprovedRow({ p }: { p: ProposalRow }) {
  const s = p.corrected_json ?? {};
  const dual = VALUE_BEARING.some((pre) => (p.rule_key ?? "").startsWith(pre));
  const complete = dual ? Boolean(s.approved_by && s.second_approved_by) : Boolean(s.approved_by);
  const value = Object.entries(p.value_json ?? {})
    .filter(([k]) => k !== "citation_label")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/admin/proposals/${p.id}`} className="hover:underline"><Code>{p.rule_key}</Code></Link>
          <span className="tnum text-[13px] text-ink-500">
            {p.effective_from ? day(p.effective_from) : "No start date"} to {p.effective_to ? day(p.effective_to) : "open ended"}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[12.5px] text-ink-700" title={value}>{value || "No value"}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-400">{p.document_title}</div>
      </div>
      <div className="flex items-center gap-2 text-[13px]">
        {complete ? <Check className="size-4 text-good-600" /> : <CircleAlert className="size-4 text-warn-600" />}
        <span className={complete ? "text-ink-500" : "text-warn-600"}>
          {[s.approved_by, s.second_approved_by].filter(Boolean).join(" and ") || "Unsigned"}
          {!complete && dual && s.approved_by ? ", needs a second" : ""}
        </span>
      </div>
    </li>
  );
}
