"use client";

/**
 * Citation cards with an in-force date bar per rule.
 *
 * The bar is the August 2026 story rendered as UI (spec section 6.2 addition 2):
 * you can see the window a rule was in force, and the dashed overlay is the
 * year of assessment being asked about. A rule that supersedes an earlier
 * version says so.
 */

import { useState } from "react";
import type { Citation } from "@/lib/api";
import { formatDate } from "@/lib/api";

interface Props {
  citations: Citation[];
  ya: string | null;
  highlightRuleKey?: string | null;
}

/** Map a date onto a fixed 2024-04-01 to 2028-03-31 track. */
const TRACK_START = new Date("2024-04-01").getTime();
const TRACK_END = new Date("2028-03-31").getTime();

function pct(iso: string | null, fallback: number): number {
  if (!iso) return fallback;
  const t = new Date(`${iso}T00:00:00`).getTime();
  if (Number.isNaN(t)) return fallback;
  return Math.min(100, Math.max(0, ((t - TRACK_START) / (TRACK_END - TRACK_START)) * 100));
}

function yaWindow(ya: string | null): { left: number; width: number } | null {
  if (!ya) return null;
  const startYear = Number(ya.split("/")[0]);
  if (Number.isNaN(startYear)) return null;
  const left = pct(`${startYear}-04-01`, 0);
  const right = pct(`${startYear + 1}-03-31`, 100);
  return { left, width: Math.max(right - left, 1) };
}

export function CitationsPanel({ citations, ya, highlightRuleKey }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const window = yaWindow(ya);

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-line bg-white px-4 pb-2 pt-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">CITATIONS · {citations.length} USED</span>
      </div>

      <div className="mt-[13px] flex flex-col gap-2 overflow-y-auto pr-1">
        {citations.map((c, i) => {
          const isOpen = open === c.rule_version_id;
          const highlighted = highlightRuleKey === c.rule_key;
          const left = pct(c.effective_from, 0);
          const right = pct(c.effective_to, 100);

          return (
            <div
              key={c.rule_version_id}
              id={`cite-${c.rule_key}`}
              className={`rounded-[9px] border px-3 py-[11px] transition-colors ${
                highlighted
                  ? "border-brand-600 bg-brand-050"
                  : "border-[#E9EDF7] bg-white"
              }`}
            >
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : c.rule_version_id)}
                className="flex w-full items-start gap-2 text-left"
              >
                <span className="mt-[1px] flex-none rounded-[3px] bg-brand-100 px-1 py-[2px] font-mono text-[10px] font-semibold text-brand-600">
                  {i + 1}
                </span>
                <div className="flex-1">
                  <div className="text-[13px] font-semibold leading-[1.35] text-ink-900">
                    {c.label ?? c.rule_key}
                  </div>
                  <div className="mt-[3px] text-[11.5px] leading-[1.4] text-ink-400">
                    {c.revision_no > 1
                      ? `Revision ${c.revision_no} · supersedes an earlier version`
                      : `In force from ${formatDate(c.effective_from)}`}
                  </div>
                </div>
                <span className="font-mono text-[10px] text-ink-200">
                  {isOpen ? "▴" : "▾"}
                </span>
              </button>

              {/* In-force window against a fixed four-year track. */}
              <div className="mt-[10px]">
                <div className="relative h-[5px] rounded-sm bg-[#EFF2F9]">
                  <div
                    className="absolute bottom-0 top-0 rounded-sm bg-brand-600"
                    style={{ left: `${left}%`, width: `${Math.max(right - left, 1)}%` }}
                  />
                  {window && (
                    <div
                      className="absolute -bottom-[3px] -top-[3px] rounded-sm border border-dashed border-good-600"
                      style={{ left: `${window.left}%`, width: `${window.width}%` }}
                    />
                  )}
                </div>
                <div className="mt-[5px] flex justify-between font-mono text-[10px] text-ink-300">
                  <span>{formatDate(c.effective_from)}</span>
                  <span>{c.effective_to ? formatDate(c.effective_to) : "no end date"}</span>
                </div>
              </div>

              {isOpen && c.quoted_text && (
                <div className="fade-up mt-[10px] rounded-lg bg-panel px-3 py-[10px] text-[12px] leading-[1.55] text-ink-700">
                  <span className="text-ink-300">“</span>
                  {c.quoted_text}
                  <span className="text-ink-300">”</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-[#EEF1F8] pb-2 pt-[11px]">
        <span className="h-[5px] w-[9px] flex-none rounded-sm border border-dashed border-good-600" />
        <span className="font-mono text-[10.5px] leading-[1.4] text-ink-400">
          dashed window = Y/A {ya ?? "selected"}
        </span>
      </div>
    </div>
  );
}
