"use client";

/**
 * My account: who you are signed in as, what your role allows, what is stored,
 * and the way out. The privacy explainer stays because this is where a user
 * comes to check the promise.
 */

import { Check, LogOut, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageBody, Shell, SUPPORTED_YAS, type YA } from "@/components/Shell";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, type Me } from "@/lib/admin";
import { useSession } from "@/lib/session";

const NEVER_SENT = [
  { what: "Your NIC or TIN", how: "Removed by pattern before anything is sent" },
  { what: "Your name", how: "Replaced with a placeholder when the question arrives" },
  { what: "Your employer", how: "Masked; it never affects a computation" },
  { what: "Payslip text and images", how: "Only the three figures you confirm are kept" },
];

const KEPT = [
  "Your question, with personal details already replaced",
  "The figures needed to work the answer out again",
  "The ledger, the rules it cited and the date of those rules",
];

const ROLE_MEANING: Record<string, string> = {
  free: "Filing checks and deadlines.",
  individual: "Unlimited computations, history, and year on year comparison.",
  practice: "Everything in Individual, plus an exportable audit trail.",
  reviewer: "Can review and correct extracted rules in the admin area.",
  approver: "Can give the second signature on a rate, band or threshold change.",
  admin: "Full access, including roles, sources and rollback.",
  auditor: "Read only access to the audit log and the history of the rules.",
};

export default function AccountPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [me, setMe] = useState<Me | null>(null);
  const { user, loading, signOut } = useSession();

  useEffect(() => {
    if (!user) return;
    admin.me().then(setMe).catch(() => setMe(null));
  }, [user]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Shell ya={ya} onYaChange={setYa} />
      <PageBody>
        <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900">Account</h1>
        <p className="mt-2 max-w-[60ch] text-[15px] leading-[1.6] text-ink-500">
          Who you are signed in as, what is kept, and what is never sent.
        </p>

        {loading ? (
          <div className="mt-8 flex items-center gap-4">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-56" />
            </div>
          </div>
        ) : user ? (
          <section className="mt-8 rounded-xl border border-line bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <UserAvatar user={user} size={56} tone="brand" />
                <div className="min-w-0">
                  <div className="truncate text-[18px] font-semibold text-ink-900">{user.name ?? "Signed in"}</div>
                  <div className="truncate text-[14px] text-ink-500">{user.email}</div>
                </div>
              </div>
              <div className="flex flex-none flex-wrap gap-2">
                {me?.is_reviewer && (
                  <Button variant="outline" nativeButton={false} render={<Link href="/admin" />} className="h-9">Open admin</Button>
                )}
                <Button variant="outline" onClick={() => void signOut()} className="h-9 text-warn-600 hover:bg-warn-100 hover:text-warn-700">
                  <LogOut />
                  Sign out
                </Button>
              </div>
            </div>
            {me && (
              <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line pt-4 text-[14px]">
                <span className="rounded-md bg-brand-050 px-2 py-0.5 font-medium text-brand-700">
                  {me.role[0].toUpperCase()}{me.role.slice(1)}
                </span>
                <span className="text-ink-500">
                  {ROLE_MEANING[me.role] ?? "Standard access."}
                  {me.can_approve && " You cannot countersign a change you signed first."}
                </span>
              </div>
            )}
          </section>
        ) : (
          <section className="mt-8 rounded-xl bg-muted p-6">
            <h2 className="text-[16px] font-semibold text-ink-900">You are not signed in</h2>
            <p className="mt-1 max-w-[56ch] text-[14.5px] leading-[1.6] text-ink-500">
              You can ask anything without an account. Signing in keeps your
              answers, each with the rules it used, so you can check one again later.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button nativeButton={false} render={<Link href="/signin?mode=signup&next=/welcome" />} className="h-10 px-4">Create an account</Button>
              <Button variant="outline" nativeButton={false} render={<Link href="/signin" />} className="h-10 px-4">Sign in</Button>
            </div>
          </section>
        )}

        <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
          <section>
            <h2 className="flex items-center gap-2 text-[17px] font-semibold text-ink-900">
              <ShieldCheck className="size-4 text-good-600" />
              Never sent to a language model
            </h2>
            <ul className="mt-4 flex flex-col gap-3.5">
              {NEVER_SENT.map((n) => (
                <li key={n.what} className="flex items-start gap-3">
                  <span className="mt-[3px] flex size-5 flex-none items-center justify-center rounded-full bg-warn-100 text-warn-600">
                    <X className="size-3" />
                  </span>
                  <div>
                    <div className="text-[15px] font-medium text-ink-900">{n.what}</div>
                    <div className="text-[13.5px] leading-[1.5] text-ink-500">{n.how}</div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.6] text-ink-400">
              Personal details are removed on the server before any outside
              service is called. The figures a computation needs are kept,
              which is the harder half of the job.
            </p>
          </section>

          <section>
            <h2 className="text-[17px] font-semibold text-ink-900">What is kept</h2>
            <ul className="mt-4 flex flex-col gap-3">
              {KEPT.map((k) => (
                <li key={k} className="flex items-start gap-3 text-[15px] leading-[1.5] text-ink-700">
                  <span className="mt-[3px] flex size-5 flex-none items-center justify-center rounded-full bg-good-100 text-good-600">
                    <Check className="size-3" />
                  </span>
                  {k}
                </li>
              ))}
            </ul>
            {user && (
              <Link href="/history" className="mt-4 inline-block text-[14px] font-medium text-brand-600 underline-offset-4 hover:underline">
                See your history
              </Link>
            )}

            <h2 className="mt-8 text-[17px] font-semibold text-ink-900">What Citetax covers</h2>
            <p className="mt-2 max-w-[56ch] text-[15px] leading-[1.6] text-ink-700">
              Personal income tax for the years of assessment {SUPPORTED_YAS.join(" and ")}.
              Anything else is declined with the reason, never guessed.
            </p>
            <p className="mt-2 text-[13.5px] text-ink-400">Citetax helps you work tax out. It is not a tax agent.</p>
          </section>
        </div>
      </PageBody>
    </div>
  );
}
