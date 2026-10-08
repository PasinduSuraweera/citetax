"use client";

/** The account's plan and this month's questions, on the profile page. */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, formatDate, type MyPlan } from "@/lib/api";

export function PlanCard() {
  const [plan, setPlan] = useState<MyPlan | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api.myPlan().then((p) => live && setPlan(p)).catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, []);

  if (plan === undefined) return <Skeleton className="mt-4 h-[92px] w-full rounded-xl" />;
  if (plan === null) return null;

  const share = plan.limit ? Math.min(100, (plan.used / plan.limit) * 100) : 0;
  return (
    <section className="mt-4 rounded-xl border border-line bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink-400">Plan</div>
          <div className="mt-0.5 text-[18px] font-semibold text-ink-900">{plan.name}</div>
          <p className="tnum mt-1 text-[14px] text-ink-500">
            {plan.limit == null
              ? "No question limit on a staff account."
              : `${plan.used} of ${plan.limit} questions this month. They reset on ${formatDate(plan.resets_on)}.`}
          </p>
          {plan.request && (
            <p className="mt-1 text-[14px] text-brand-700">
              You asked for {plan.request.plan === "team" ? `Team (${plan.request.seats} seats)` : "Individual"}. We will confirm it with you.
            </p>
          )}
        </div>
        {!plan.staff && plan.plan !== "team" && (
          <Button nativeButton={false} render={<Link href="/pricing" />} className="h-9 flex-none px-4">
            {plan.plan === "free" ? "Upgrade" : "See plans"}
          </Button>
        )}
      </div>
      {plan.limit != null && (
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-brand-600" style={{ width: `${share}%` }} />
        </div>
      )}
    </section>
  );
}
