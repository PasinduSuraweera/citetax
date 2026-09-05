"use client";

/** User and role management. Dual control needs two distinct named humans. */

import { useCallback, useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, type Me, type Role } from "@/lib/admin";

const ROLES: Role[] = [
  "free", "individual", "practice", "reviewer", "approver", "admin", "auditor",
];

interface Row {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: string;
  last_seen_at: string | null;
}

export default function UsersPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [users, setUsers] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await admin.me();
      setMe(who);
      if (who.role === "admin") setUsers((await admin.users()).users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load users");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!ready) return <Loading />;
  if (me?.role !== "admin") return <NoAccess me={me} />;

  const change = async (id: string, role: Role) => {
    setBusy(id);
    setError(null);
    try {
      const r = await admin.setRole(id, role);
      setMessage(`${r.email} is now ${r.role}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the role");
    } finally {
      setBusy(null);
    }
  };

  const approvers = users.filter((u) => u.role === "approver" || u.role === "admin");

  return (
    <AdminShell me={me}>
      <div className="px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
        <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">
          Users
        </h1>
        <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
          Reviewers approve extracted rules. Approvers give the second signature
          on anything that changes a computed figure.
        </p>

        {approvers.length < 2 && (
          <div className="mt-5 rounded-xl border border-[#EBD6A8] bg-[#FDF4E0] px-5 py-4 text-[13.5px] leading-[1.55] text-[#7E5D1B]">
            <strong className="font-semibold">
              Dual control is not satisfiable yet.
            </strong>{" "}
            There {approvers.length === 1 ? "is one account" : "are no accounts"}{" "}
            that can approve, and a value bearing change needs two distinct
            people. Promote a second person to approver before publishing rate,
            band or threshold changes.
          </div>
        )}

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

        <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
          <div className="flex min-w-[820px] items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
            <span className="flex-1">ACCOUNT</span>
            <span className="w-[150px] flex-none">LAST SEEN</span>
            <span className="w-[190px] flex-none text-right">ROLE</span>
          </div>
          {users.map((u) => (
            <div
              key={u.id}
              className="flex min-w-[820px] items-center border-b border-line-faint px-5 py-[13px] last:border-b-0"
            >
              <div className="min-w-0 flex-1 pr-4">
                <div className="truncate text-[14px] font-medium text-ink-900">
                  {u.name ?? u.email}
                  {u.id === me.id && (
                    <span className="ml-2 font-mono text-[10.5px] text-ink-300">
                      you
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11.5px] text-ink-300">
                  {u.email}
                </div>
              </div>
              <span className="w-[150px] flex-none font-mono text-[11.5px] text-ink-500">
                {u.last_seen_at
                  ? new Date(u.last_seen_at).toLocaleDateString("en-GB", {
                      day: "numeric", month: "short",
                    })
                  : "never"}
              </span>
              <span className="w-[190px] flex-none text-right">
                <select
                  value={u.role}
                  onChange={(e) => change(u.id, e.target.value as Role)}
                  disabled={busy !== null || u.id === me.id}
                  className="rounded-lg border border-line-strong bg-white px-3 py-[6px] font-mono text-[12px] text-ink-700 outline-none focus:border-brand-600 disabled:opacity-50"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
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
