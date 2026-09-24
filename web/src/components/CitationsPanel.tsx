"use client";

/**
 * The rules an answer used, each with the window it was in force.
 *
 * The bar is the August 2026 story rendered as UI (spec section 6.2 addition 2):
 * you can see the window a rule was in force, and the dashed overlay is the
 * year of assessment being asked about. A rule that supersedes an earlier
 * version says so.
 */

import { ChevronDown } from "lucide-react";
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

  if (citations.length === 0) {
    return <p className="px-1 text-[14px] text-ink-400">No rules were needed for this answer.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {citations.map((c, i) => {
        const isOpen = open === c.rule_version_id;
        const highlighted = highlightRuleKey === c.rule_key;
        const left = pct(c.effective_from, 0);
        const right = pct(c.effective_to, 100);

        return (
          <article
            key={c.rule_version_id}
            id={`cite-${c.rule_key}`}
            className={`scroll-mt-6 rounded-xl border bg-white px-4 py-3.5 transition-colors ${
              highlighted ? "border-brand-600 ring-3 ring-brand-600/10" : "border-line"
            }`}
          >
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : c.rule_version_id)}
              aria-expanded={isOpen}
              className="flex w-full items-start gap-3 text-left"
            >
              <span className="tnum mt-[2px] flex h-5 min-w-5 flex-none items-center justify-center rounded bg-brand-100 px-1 text-[11px] font-semibold text-brand-700">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="statute block text-[15px] font-semibold not-italic text-ink-900">{c.label ?? c.rule_key}</span>
                <span className="mt-0.5 block text-[13px] text-ink-400">
                  {c.revision_no > 1
                    ? `Revision ${c.revision_no}, replacing an earlier version`
                    : `In force from ${formatDate(c.effective_from)}`}
                </span>
              </span>
              <ChevronDown className={`mt-1 size-4 flex-none text-ink-300 transition-transform ${isOpen ? "rotate-180" : ""}`} />
            </button>

            {/* The in-force window against a fixed four-year track. */}
            <div className="mt-3 pl-8">
              <div className="relative h-1.5 rounded-full bg-canvas">
                <div
                  className="absolute inset-y-0 rounded-full bg-brand-600"
                  style={{ left: `${left}%`, width: `${Math.max(right - left, 1)}%` }}
                />
                {window && (
                  <div
                    className="absolute -inset-y-[3px] rounded-sm border border-dashed border-good-600"
                    style={{ left: `${window.left}%`, width: `${window.width}%` }}
                  />
                )}
              </div>
              <div className="tnum mt-1.5 flex justify-between text-[12px] text-ink-400">
                <span>{formatDate(c.effective_from)}</span>
                <span>{c.effective_to ? formatDate(c.effective_to) : "No end date"}</span>
              </div>
            </div>

            {isOpen && c.quoted_text && (
              <blockquote className="statute fade-up ml-8 mt-3 rounded-lg bg-panel px-3.5 py-3 text-[14px] italic text-ink-700">
                &ldquo;{c.quoted_text}&rdquo;
              </blockquote>
            )}
          </article>
        );
      })}

      <p className="flex items-center gap-2 px-1 pt-1 text-[12.5px] text-ink-400">
        <span className="h-1.5 w-3 flex-none rounded-sm border border-dashed border-good-600" />
        The dashed box marks the year of assessment {ya ?? "you asked about"}.
      </p>
    </div>
  );
}
