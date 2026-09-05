"use client";

/** Publish and rollback (spec section 5.1 E and I). */

import { useCallback, useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, type Me, type ProposalRow, type SnapshotRow } from "@/lib/admin";

export default function SnapshotsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [approved, setApproved] = useState<ProposalRow[]>([]);
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await admin.me();
      setMe(who);
      if (!who.is_reviewer) return;
      const [s, p] = await Promise.all([
        admin.snapshots(),
        admin.proposals({ status: "approved" }),
      ]);
      setSnapshots(s.snapshots);
      setApproved(p.proposals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load snapshots");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!ready) return <Loading />;
  if (!me?.is_reviewer) return <NoAccess me={me} />;

  const current = snapshots.find((s) => s.is_current);

  const publish = async () => {
    if (!changelog.trim()) {
      setError("A changelog line is required. It is what users see.");
      return;
    }
    setBusy("publish");
    setError(null);
    try {
      const r = await admin.publish(changelog.trim());
      setMessage(
        `Published snapshot ${r.label} with ${r.published.length} rule version(s). New answers resolve against it immediately.`,
      );
      setChangelog("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (id: string, label: string) => {
    if (
      !window.confirm(
        `Roll back to ${label}? New answers will resolve against it. Existing answers keep the snapshot they were computed on, so history is not rewritten.`,
      )
    ) {
      return;
    }
    setBusy(id);
    try {
      const r = await admin.rollback(id);
      setMessage(
        `Rolled back to ${r.label}. Affected rule keys: ${r.affected_rule_keys.join(", ")}`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rollback failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell me={me} snapshotLabel={current?.label}>
      <div className="px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
        <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">
          Snapshots
        </h1>
        <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
          Publishing is not a row update. It creates a new snapshot, and every
          answer records the snapshot it used, so rollback never rewrites
          history.
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

        <div className="mt-6 rounded-xl border border-line bg-white px-5 py-5">
          <div className="eyebrow">PUBLISH</div>
          {approved.length === 0 ? (
            <p className="mt-3 text-[13.5px] text-ink-400">
              Nothing is approved and waiting. Approve a proposal in the review
              inbox first.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[13.5px] text-ink-700">
                {approved.length} approved proposal
                {approved.length === 1 ? "" : "s"} ready:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {approved.map((p) => (
                  <span
                    key={p.id}
                    className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-[11.5px] text-ink-700"
                  >
                    {p.rule_key}
                  </span>
                ))}
              </div>
              <label className="mt-4 block">
                <span className="mb-[6px] block text-[11.5px] font-medium text-ink-500">
                  Changelog line, shown to users in what changed
                </span>
                <input
                  value={changelog}
                  onChange={(e) => setChangelog(e.target.value)}
                  placeholder="Personal relief raised to 1,800,000 from 1 April 2026"
                  className="w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-[13.5px] outline-none focus:border-brand-600"
                />
              </label>
              <button
                type="button"
                onClick={publish}
                disabled={busy !== null || !me.can_approve}
                className="mt-4 rounded-lg bg-brand-600 px-5 py-[10px] text-[13.5px] font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
              >
                {busy === "publish" ? "Publishing..." : "Publish snapshot"}
              </button>
              {!me.can_approve && (
                <p className="mt-2 text-[12.5px] text-warn-500">
                  Publishing needs the approver role. Your account is {me.role}.
                </p>
              )}
            </>
          )}
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-white">
          <div className="flex min-w-[820px] items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
            <span className="flex-1">SNAPSHOT</span>
            <span className="w-[110px] flex-none">RULES</span>
            <span className="w-[170px] flex-none">CREATED BY</span>
            <span className="w-[130px] flex-none text-right">ACTION</span>
          </div>
          {snapshots.map((s) => (
            <div
              key={s.id}
              className={`flex min-w-[820px] items-center border-b border-line-faint px-5 py-[13px] last:border-b-0 ${
                s.is_current ? "bg-brand-050" : ""
              }`}
            >
              <div className="min-w-0 flex-1 pr-4">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium text-ink-900">
                    {s.label}
                  </span>
                  {s.is_current && (
                    <span className="rounded-full bg-good-600 px-2 py-[2px] font-mono text-[9.5px] font-semibold text-white">
                      CURRENT
                    </span>
                  )}
                </div>
                {s.changelog && (
                  <div className="mt-[3px] truncate text-[12px] text-ink-400">
                    {s.changelog}
                  </div>
                )}
              </div>
              <span className="tnum w-[110px] flex-none font-mono text-[13px] text-ink-700">
                {s.rule_count}
              </span>
              <span className="w-[170px] flex-none truncate font-mono text-[11.5px] text-ink-500">
                {s.created_by ?? "-"}
              </span>
              <span className="w-[130px] flex-none text-right">
                {!s.is_current && me.role === "admin" && (
                  <button
                    type="button"
                    onClick={() => rollback(s.id, s.label)}
                    disabled={busy !== null}
                    className="rounded-lg border border-line-strong bg-white px-3 py-[6px] text-[12.5px] font-medium text-ink-700 hover:border-warn-600 hover:text-warn-600 disabled:opacity-40"
                  >
                    {busy === s.id ? "..." : "Roll back"}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </AdminShell>
  );
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
