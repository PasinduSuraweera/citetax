"use client";

/**
 * My account: who you are signed in as, what your role allows, what is stored,
 * and the way out. The privacy explainer stays because this is where a user
 * comes to check the promise.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageBody, Shell, SUPPORTED_YAS, type YA } from "@/components/Shell";
import { admin, type Me } from "@/lib/admin";
import { api, type Snapshot } from "@/lib/api";
import { initials, useSession } from "@/lib/session";

const NEVER_STORED = [
  { what: "Your NIC or TIN", how: "Stripped by pattern match before anything is sent" },
  { what: "Your name", how: "Replaced with a placeholder by the intake node" },
  { what: "Your employer", how: "Tagged and masked, it does not affect a computation" },
  { what: "Payslip text", how: "Only the extracted figures continue past intake" },
];

const ROLE_MEANING: Record<string, string> = {
  free: "Obligation checks and deadlines.",
  individual: "Unlimited computations, history, and year on year comparison.",
  practice: "Everything in Individual, plus the exportable audit trail.",
  reviewer: "Can review and correct extracted rules in the admin panel.",
  approver: "Can give the second signature on a rate, band or threshold change.",
  admin: "Full access, including roles, sources and rollback.",
  auditor: "Read only access to the audit log and corpus history.",
};

export default function AccountPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const { user, loading, signOut } = useSession();

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    admin.me().then(setMe).catch(() => setMe(null));
  }, [user]);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} snapshot={snapshot} />
      <PageBody>
        <h1 className="text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[32px]">
          My account
        </h1>
        <p className="mt-[10px] max-w-[640px] text-[15px] leading-[1.6] text-ink-500">
          Who you are signed in as, what is kept, and what is never sent.
        </p>

        {/* Account card */}
        {loading ? (
          <div className="mt-7 h-[120px] animate-pulse rounded-xl border border-line bg-white" />
        ) : user ? (
          <div className="mt-7 rounded-xl border border-line bg-white px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-center gap-4">
                {user.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.image}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-[52px] w-[52px] flex-none rounded-full"
                  />
                ) : (
                  <span className="flex h-[52px] w-[52px] flex-none items-center justify-center rounded-full bg-brand-600 text-[17px] font-semibold text-white">
                    {initials(user)}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="truncate text-[17px] font-semibold text-ink-900">
                    {user.name ?? "Signed in"}
                  </div>
                  <div className="truncate font-mono text-[12.5px] text-ink-400">
                    {user.email}
                  </div>
                  {me && (
                    <span className="mt-2 inline-block rounded-full bg-brand-100 px-[9px] py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-brand-600">
                      {me.role}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-none flex-wrap gap-2">
                {me?.is_reviewer && (
                  <Link
                    href="/admin"
                    className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
                  >
                    Admin panel
                  </Link>
                )}
                <button
                  type="button"
                  onClick={signOut}
                  className="rounded-lg border border-warn-300 bg-warn-100 px-4 py-2 text-[13px] font-semibold text-warn-600 transition-colors hover:border-warn-600"
                >
                  Sign out
                </button>
              </div>
            </div>

            {me && (
              <p className="mt-5 border-t border-line pt-4 text-[13px] leading-[1.6] text-ink-500">
                {ROLE_MEANING[me.role] ?? "Standard access."}
                {me.can_approve &&
                  " Dual control means you cannot countersign a change you signed first."}
              </p>
            )}
          </div>
        ) : (
          <div className="mt-7 rounded-xl border border-line bg-white px-6 py-8">
            <div className="eyebrow">NOT SIGNED IN</div>
            <p className="mt-3 max-w-[480px] text-[14.5px] leading-[1.6] text-ink-500">
              You can ask anything without an account. Signing in keeps a history
              of your computations, each stamped with the corpus snapshot it ran
              against, so you can re-check an answer later.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/signin?mode=signup&next=/welcome"
                className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-brand-700"
              >
                Create an account
              </Link>
              <Link
                href="/signin"
                className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600"
              >
                Sign in
              </Link>
            </div>
          </div>
        )}

        {/* What is stored */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-ink-900 px-5 py-6 sm:px-6">
            <div className="font-mono text-[10px] tracking-[0.16em] text-white/40">
              WHAT WE NEVER SEND
            </div>
            <div className="mt-4 flex flex-col gap-3">
              {NEVER_STORED.map((n) => (
                <div key={n.what} className="flex items-start gap-[10px]">
                  <span className="mt-[2px] font-mono text-[11px] font-semibold text-[#F5A9A2]">
                    ✕
                  </span>
                  <div>
                    <div className="text-[13.5px] font-semibold text-white">{n.what}</div>
                    <div className="mt-[2px] text-[12px] leading-[1.45] text-white/45">
                      {n.how}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-5 border-t border-white/10 pt-[14px] text-[12px] leading-[1.55] text-white/50">
              Redaction runs on the server before any hosted call, not in the
              browser. The figures a computation needs are deliberately
              preserved, which is the harder half of the job.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-line bg-white px-5 py-5 sm:px-6">
              <div className="eyebrow">WHAT IS KEPT</div>
              <ul className="mt-3 flex flex-col gap-2 text-[13.5px] leading-[1.6] text-ink-500">
                <li>The redacted question, with identifiers already replaced.</li>
                <li>The numeric facts needed to reproduce the computation.</li>
                <li>The ledger, the citations and the snapshot it ran against.</li>
              </ul>
              {user && (
                <Link
                  href="/history"
                  className="mt-4 inline-block font-mono text-[11.5px] text-brand-600 hover:underline"
                >
                  see your history
                </Link>
              )}
            </div>

            <div className="rounded-xl border border-line bg-white px-5 py-5 sm:px-6">
              <div className="eyebrow">SCOPE</div>
              <p className="mt-[11px] text-[13.5px] leading-[1.6] text-ink-700">
                Personal income tax, years of assessment {SUPPORTED_YAS.join(" and ")}.
                Everything else is refused with a reason, not guessed.
              </p>
              <p className="mt-3 text-[12.5px] leading-[1.55] text-ink-400">
                Citetax is a computation aid, not a tax agent.
              </p>
            </div>
          </div>
        </div>
      </PageBody>
    </div>
  );
}
