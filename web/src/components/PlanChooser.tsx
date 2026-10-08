"use client";

/**
 * The button on a pricing card. There is no checkout yet: a paid plan is
 * requested, and an admin switches it on (see app.routers.plans).
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError, type MyPlan, type PlanKey } from "@/lib/api";
import { useSession } from "@/lib/session";

// One fetch of the account's plan for all three cards on the page.
let shared: Promise<MyPlan | null> | null = null;
const listeners = new Set<(p: MyPlan | null) => void>();

function loadMine(force = false): Promise<MyPlan | null> {
  if (!shared || force) {
    shared = api.myPlan().catch(() => null);
    void shared.then((p) => listeners.forEach((fn) => fn(p)));
  }
  return shared;
}

export function PlanChooser({ plan, featured }: { plan: PlanKey; featured: boolean }) {
  const { user, loading } = useSession();
  const [mine, setMine] = useState<MyPlan | null | undefined>(undefined);
  const [seats, setSeats] = useState(3);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    listeners.add(setMine);
    void loadMine().then(setMine);
    return () => {
      listeners.delete(setMine);
    };
  }, [user]);

  const ask = useCallback(async () => {
    if (plan === "free") return;
    setBusy(true);
    try {
      await api.requestPlan(plan, plan === "team" ? seats : 1);
      toast.success("Requested. We will confirm it with you and switch it on.");
      await loadMine(true);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not send the request");
    } finally {
      setBusy(false);
    }
  }, [plan, seats]);

  const withdraw = useCallback(async () => {
    setBusy(true);
    try {
      await api.withdrawPlanRequest();
      await loadMine(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const variant = featured ? "default" : "outline";
  const cls = "h-10 w-full text-[14.5px]";

  if (loading || (user && mine === undefined)) {
    return <Button variant={variant} className={cls} disabled><Loader2 className="animate-spin" /></Button>;
  }

  if (!user) {
    if (plan === "free") {
      return (
        <Link href="/chat" className={`${buttonLike(variant)} ${cls}`}>Start asking</Link>
      );
    }
    return (
      <Link href={`/signin?next=${encodeURIComponent("/pricing")}`} className={`${buttonLike(variant)} ${cls}`}>
        Sign in to request
      </Link>
    );
  }

  if (mine?.plan === plan) {
    return <Button variant="outline" className={cls} disabled>Your plan</Button>;
  }
  if (plan === "free") {
    return <Link href="/chat" className={`${buttonLike("outline")} ${cls}`}>Open chat</Link>;
  }
  if (mine?.request?.plan === plan) {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="outline" className={cls} disabled>
          Requested{plan === "team" ? `, ${mine.request.seats} seats` : ""}
        </Button>
        <button type="button" onClick={withdraw} disabled={busy} className="text-[13px] text-ink-400 hover:text-ink-700">
          Withdraw the request
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {plan === "team" && (
        <label className="flex items-center justify-between gap-3 text-[14px] text-ink-700">
          Seats
          <input
            type="number"
            min={1}
            max={500}
            value={seats}
            onChange={(e) => setSeats(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            className="tnum h-9 w-20 rounded-md border border-input px-2 text-right text-[14px] outline-none focus-visible:border-brand-600"
          />
        </label>
      )}
      <Button variant={variant} className={cls} onClick={ask} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : `Request ${plan === "team" ? "Team" : "Individual"}`}
      </Button>
    </div>
  );
}

function buttonLike(variant: "default" | "outline"): string {
  const base = "inline-flex items-center justify-center rounded-lg font-medium transition-colors";
  return variant === "default"
    ? `${base} bg-primary text-primary-foreground hover:bg-primary/80`
    : `${base} border border-border bg-background text-ink-900 hover:bg-muted`;
}
