"use client";

/** User and role management. Dual control needs two distinct named people. */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminBody, AdminFrame } from "@/components/admin/AdminShell";
import { Confirm, ErrorNote, PageHeader, Pill, TableHead, errorText, relTime } from "@/components/admin/kit";
import { UserAvatar } from "@/components/UserAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, type Me, type Role } from "@/lib/admin";

export default function UsersPage() {
  return <AdminFrame need="admin">{(me) => <UsersList me={me} />}</AdminFrame>;
}

const ROLES: Array<{ role: Role; label: string; can: string }> = [
  { role: "free", label: "Free", can: "asks questions" },
  { role: "individual", label: "Individual", can: "asks questions and keeps history" },
  { role: "practice", label: "Practice", can: "works for clients" },
  { role: "reviewer", label: "Reviewer", can: "reviews proposals and gives a first signature" },
  { role: "approver", label: "Approver", can: "gives second signatures and publishes snapshots" },
  { role: "admin", label: "Admin", can: "does everything, including managing roles and rolling back" },
  { role: "auditor", label: "Auditor", can: "reads the audit log and nothing else" },
];

type Row = Awaited<ReturnType<typeof admin.users>>["users"][number];

const COLS = "minmax(0,1fr) 130px 190px";

function UsersList({ me }: { me: Me }) {
  const [users, setUsers] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ user: Row; role: Role } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers((await admin.users()).users);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Could not load users"));
    }
  }, []);

  useEffect(() => {
    // load() only sets state once its request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await admin.setRole(pending.user.id, pending.role);
      toast.success(`${pending.user.name ?? r.email} is now ${label(r.role).toLowerCase()}`);
      setPending(null);
      await load();
    } catch (e) {
      toast.error(errorText(e, "Could not change the role"));
    } finally {
      setBusy(false);
    }
  };

  const approvers = users?.filter((u) => u.role === "approver" || u.role === "admin").length ?? 2;
  const target = pending ? ROLES.find((r) => r.role === pending.role) : null;
  const losingSignOff = pending && ["approver", "admin"].includes(pending.user.role) && !["approver", "admin"].includes(pending.role);

  return (
    <AdminBody>
      <PageHeader
        title="Users"
        description="Reviewers check extracted rules. Approvers give the second signature on anything that changes a computed figure."
      />

      {approvers < 2 && (
        <div className="mt-6 rounded-xl border border-[#ebd6a8] bg-[#fdf4e0] px-5 py-4 text-[14px] leading-[1.55] text-[#7e5d1b]">
          <strong className="font-semibold">Dual control cannot be met yet.</strong>{" "}
          {approvers === 1 ? "Only one account" : "No account"} can give a second signature, and a change to a figure needs
          two different people. Make a second person an approver before publishing rate, band or threshold changes.
        </div>
      )}

      {error && <div className="mt-6"><ErrorNote>{error}</ErrorNote></div>}
      {!users && !error && <Skeleton className="mt-6 h-72 w-full" />}

      {users && (
        <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white">
          <div className="min-w-[640px]">
            <TableHead cols={COLS}>
              <span>Account</span>
              <span>Last seen</span>
              <span>Role</span>
            </TableHead>
            {users.map((u) => (
              <div key={u.id} className="grid items-center gap-4 border-b border-line-faint px-5 py-3 last:border-b-0" style={{ gridTemplateColumns: COLS }}>
                <div className="flex min-w-0 items-center gap-3">
                  <UserAvatar user={{ email: u.email, name: u.name, image: u.picture }} size={32} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate text-[14.5px] font-medium text-ink-900">
                      {u.name ?? u.email}
                      {u.id === me.id && <Pill>You</Pill>}
                    </div>
                    <div className="truncate text-[13px] text-ink-400">{u.email}</div>
                  </div>
                </div>
                <span className="text-[13.5px] text-ink-500">{relTime(u.last_seen_at)}</span>
                <select
                  value={u.role}
                  onChange={(e) => setPending({ user: u, role: e.target.value as Role })}
                  disabled={u.id === me.id || busy}
                  title={u.id === me.id ? "Another admin has to change your own role" : undefined}
                  aria-label={`Role for ${u.email}`}
                  className="h-9 rounded-lg border border-input bg-white px-2.5 text-[14px] text-ink-700 disabled:opacity-50"
                >
                  {ROLES.map((r) => (
                    <option key={r.role} value={r.role}>{r.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <Confirm
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Make ${pending?.user.name ?? pending?.user.email ?? ""} ${target ? `${/^[aeiou]/i.test(target.label) ? "an" : "a"} ${target.label.toLowerCase()}` : ""}?`}
        description={
          <>
            A {target?.label.toLowerCase()} {target?.can}.
            {losingSignOff && " They will no longer be able to sign off changes to figures."}
          </>
        }
        confirmLabel="Change role"
        destructive={Boolean(losingSignOff)}
        busy={busy}
        onConfirm={apply}
      />
    </AdminBody>
  );
}

function label(role: Role): string {
  return ROLES.find((r) => r.role === role)?.label ?? role;
}
