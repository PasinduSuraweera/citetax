"use client";

/** The pieces every admin page is built from, so they read as one product. */

import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { PRIORITY_LABEL } from "@/lib/admin";

export function PageHeader({
  title, description, actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-8">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900">{title}</h1>
        {description && <p className="mt-2 max-w-[68ch] text-[15px] leading-[1.6] text-ink-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  title, description, actions, children, className = "", flush = false,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** No inner padding, for tables that run edge to edge. */
  flush?: boolean;
}) {
  const head = title || description || actions;
  return (
    <section className={`rounded-xl border border-line bg-white ${className}`}>
      {head && (
        <div className={`flex flex-wrap items-start justify-between gap-3 ${flush ? "border-b border-line px-5 py-4" : "px-5 pt-5"}`}>
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>}
            {description && <p className="mt-1 max-w-[70ch] text-[13.5px] leading-[1.55] text-ink-400">{description}</p>}
          </div>
          {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? "" : head ? "px-5 pb-5 pt-4" : "p-5"}>{children}</div>
    </section>
  );
}

export type Tone = "neutral" | "brand" | "good" | "warn" | "amber";

const PILL: Record<Tone, string> = {
  neutral: "bg-canvas text-ink-500",
  brand: "bg-brand-100 text-brand-700",
  good: "bg-good-100 text-good-700",
  warn: "bg-warn-100 text-warn-700",
  amber: "bg-[#fdf4e0] text-[#7e5d1b]",
};

export function Pill({ tone = "neutral", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-[22px] flex-none items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] font-medium ${PILL[tone]}`}>
      {children}
    </span>
  );
}

/** A rule key or other identifier, shown as code. */
export function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[12px] text-ink-700">{children}</code>;
}

export function Stat({
  label, value, sub, tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "warn" | "good" | "brand";
}) {
  const ring = tone === "warn" ? "border-warn-300" : tone === "good" ? "border-good-300" : tone === "brand" ? "border-brand-600/40" : "border-line";
  return (
    <div className={`rounded-xl border bg-white px-4 py-3.5 ${ring}`}>
      <div className="text-[13px] text-ink-400">{label}</div>
      <div className={`tnum mt-1 truncate text-[22px] font-semibold tracking-[-0.01em] ${tone === "warn" ? "text-warn-600" : "text-ink-900"}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[12.5px] text-ink-400" title={sub}>{sub}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-white px-6 py-12 text-center">
      <h2 className="text-[16px] font-semibold text-ink-900">{title}</h2>
      {children && <p className="mx-auto mt-2 max-w-[52ch] text-[14px] leading-[1.6] text-ink-400">{children}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-warn-300 bg-warn-100 px-4 py-3 text-[14px] leading-[1.55] text-warn-700">
      {children}
    </div>
  );
}

/** A table header row. Columns are set by the caller's grid template. */
export function TableHead({ cols, children }: { cols: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-4 border-b border-line bg-panel px-5 py-2.5 text-[12.5px] font-medium text-ink-400" style={{ gridTemplateColumns: cols }}>
      {children}
    </div>
  );
}

/**
 * A confirmation that says what will happen. Children go between the text and
 * the buttons, for a reason field.
 */
export function Confirm({
  open, onOpenChange, title, description, confirmLabel, destructive = false, busy = false,
  disabled = false, onConfirm, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent className="sm:max-w-[460px]">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[16px] font-semibold text-ink-900">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-[14px] leading-[1.55] text-ink-500">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            onClick={onConfirm}
            disabled={busy || disabled}
            className={destructive ? "bg-destructive text-white hover:bg-warn-700" : undefined}
          >
            {busy ? "Working..." : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const PRIORITY_TONE: Record<number, Tone> = { 1: "warn", 2: "amber", 3: "brand", 4: "neutral", 5: "neutral" };
const PRIORITY_SHORT: Record<number, string> = {
  1: "Published source changed",
  2: "Rate or threshold",
  3: "Deadline",
  4: "New document",
  5: "Editorial",
};

export function PriorityPill({ priority }: { priority: number }) {
  return (
    <Pill tone={PRIORITY_TONE[priority] ?? "neutral"} title={PRIORITY_LABEL[priority]}>
      P{priority} · {PRIORITY_SHORT[priority] ?? "Other"}
    </Pill>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, [Tone, string]> = {
    needs_review: ["neutral", "Needs review"],
    in_review: ["brand", "One signature"],
    changes_requested: ["amber", "Changes requested"],
    approved: ["good", "Approved"],
    published: ["good", "Published"],
    rejected: ["warn", "Rejected"],
    extraction_failed: ["warn", "Extraction failed"],
  };
  const [tone, label] = map[status] ?? ["neutral", status];
  return <Pill tone={tone}>{label}</Pill>;
}

/* ---------- formatting ---------- */

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const label =
    mins < 1 ? "under a minute"
      : mins < 60 ? `${mins} min`
        : mins < 1440 ? `${Math.round(mins / 60)} h`
          : `${Math.round(mins / 1440)} d`;
  return diff > 0 ? `in ${label}` : `${label} ago`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo",
  });
}

export function day(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
