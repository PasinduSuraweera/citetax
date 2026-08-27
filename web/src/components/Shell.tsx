"use client";

/** Left rail. Ported from UI/Shell.dc.html. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Snapshot } from "@/lib/api";

const NAV = [
  { label: "Ask", href: "/" },
  { label: "History", href: "/history" },
  { label: "Comparison", href: "/compare" },
  { label: "Deadlines", href: "/deadlines" },
  { label: "My profile", href: "/profile" },
];

export const SUPPORTED_YAS = ["2026/2027", "2025/2026"] as const;
export type YA = (typeof SUPPORTED_YAS)[number];

interface Props {
  ya: YA;
  onYaChange: (ya: YA) => void;
  snapshot: Snapshot | null;
  ruleCount?: number | null;
  onSnapshotClick?: () => void;
}

export function Shell({ ya, onYaChange, snapshot, ruleCount, onSnapshotClick }: Props) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-[252px] flex-none flex-col overflow-hidden bg-ink-900 px-[18px] py-6">
      <Link href="/" className="block">
        <div className="text-2xl font-bold leading-none tracking-[-0.025em] text-white">
          Citetax
        </div>
        <div className="mt-[5px] text-xs leading-[1.4] tracking-[0.01em] text-white/45">
          Every number, cited.
        </div>
      </Link>

      <Link
        href="/"
        className="mt-6 flex items-center justify-between rounded-[9px] bg-brand-600 px-3 py-[10px] transition-colors hover:bg-brand-700"
      >
        <span className="text-[13.5px] font-semibold text-white">New question</span>
        <span className="font-mono text-[10.5px] font-medium text-white/55">⌘K</span>
      </Link>

      <nav className="mt-[18px] flex flex-col gap-px">
        {NAV.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-[9px] rounded-lg px-[11px] py-2 transition-colors ${
                active ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
              }`}
            >
              <span
                className={`h-1 w-1 flex-none rounded-full ${
                  active ? "bg-good-mint" : "bg-white/[0.18]"
                }`}
              />
              <span
                className={`text-[13.5px] font-medium ${
                  active ? "text-white" : "text-white/50"
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* The year of assessment is the axis every rule resolves against, so it
          is always visible and never implicit (spec section 6.1). */}
      <div className="mb-[9px] mt-[26px] font-mono text-[10px] font-medium tracking-[0.16em] text-white/[0.32]">
        YEAR OF ASSESSMENT
      </div>
      <div className="flex flex-col gap-1">
        {SUPPORTED_YAS.map((year) => {
          const selected = year === ya;
          return (
            <button
              key={year}
              type="button"
              onClick={() => onYaChange(year)}
              aria-pressed={selected}
              className={`flex items-baseline justify-between rounded-lg px-[11px] py-[9px] text-left transition-colors ${
                selected
                  ? "border border-white/[0.13] bg-white/[0.09]"
                  : "border border-transparent hover:bg-white/[0.05]"
              }`}
            >
              <span
                className={`font-mono text-[13.5px] tracking-[-0.01em] ${
                  selected ? "font-semibold text-white" : "font-medium text-white/[0.42]"
                }`}
              >
                {year.replace("/", " / ")}
              </span>
              <span
                className={`font-mono text-[9.5px] font-medium tracking-[0.08em] ${
                  selected ? "text-good-mintsoft" : "text-white/[0.28]"
                }`}
              >
                {selected ? "SELECTED" : "SWITCH"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* Spec section 6.2 addition 1: the snapshot is clickable, not a passive date. */}
      <button
        type="button"
        onClick={onSnapshotClick}
        disabled={!snapshot}
        className="mt-3 border-t border-white/10 pt-[14px] text-left disabled:cursor-default"
      >
        <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-white/30">
          CORPUS SNAPSHOT
        </div>
        <div className="mt-[6px] text-[13px] font-medium text-white/80">
          {snapshot?.label ?? "not published"}
        </div>
        <div className="mt-[9px] flex items-center gap-[6px]">
          <span
            className={`h-[5px] w-[5px] flex-none rounded-full ${
              snapshot ? "bg-good-mint" : "bg-warn-600"
            }`}
          />
          <span className="text-[11.5px] text-white/45">
            {ruleCount != null
              ? `${ruleCount} rule versions indexed`
              : snapshot
                ? "what changed"
                : "run the seed script"}
          </span>
        </div>
      </button>
    </aside>
  );
}
