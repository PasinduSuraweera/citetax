"use client";

/**
 * The verdict above the answer.
 *
 * Three states, because the verify node can fail and the UI must depict that
 * (spec section 6.2 addition 3). Green means every figure traced to a rule.
 * Amber means the figures are still verified but the prose was withheld.
 * Grey means no rule in force was found and nothing was computed.
 */

import type { Badge, VerifyResult } from "@/lib/api";

interface Props {
  badge: Badge;
  ya: string | null;
  stepCount?: number;
  verify?: VerifyResult | null;
  checks?: string[];
  /** Why the answer was refused, so the banner states the real reason rather
      than defaulting to "no rule in force". */
  refusalKind?: "out_of_scope" | "no_rule";
}

export function GuardrailBanner({
  badge,
  ya,
  stepCount,
  verify,
  checks,
  refusalKind,
}: Props) {
  if (badge === "all_cited") {
    return (
      <div
        role="status"
        className="fade-up flex items-center justify-between rounded-[11px] border border-good-300 bg-good-100 px-[17px] py-[13px]"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-good-600 text-xs font-bold text-white">
            ✓
          </span>
          <div className="text-sm">
            <span className="font-semibold text-good-700">Released by guardrail</span>
            <span className="text-good-500">
              {stepCount != null
                ? `. ${stepCount} of ${stepCount} figures traced to law in force for ${ya ?? "this year"}.`
                : `. Every figure traced to law in force for ${ya ?? "this year"}.`}
            </span>
          </div>
        </div>
        {checks && checks.length > 0 && (
          <div className="hidden gap-4 lg:flex">
            {checks.map((c) => (
              <span
                key={c}
                className="font-mono text-[11px] font-medium tracking-[0.03em] text-good-500"
              >
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (badge === "partial") {
    const why = verify?.pii_classes?.length
      ? "an identifier was found on the way out"
      : verify?.unmatched_numbers?.length
        ? `these figures could not be traced: ${verify.unmatched_numbers.join(", ")}`
        : "a figure could not be traced to a rule";

    return (
      <div
        role="status"
        className="fade-up flex items-start justify-between gap-4 rounded-[11px] border border-[#EBD6A8] bg-[#FDF4E0] px-[17px] py-[13px]"
      >
        <div className="flex items-start gap-3">
          <span className="mt-[1px] flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-[#B07A16] text-xs font-bold text-white">
            !
          </span>
          <div className="text-sm">
            <span className="font-semibold text-[#6B4A0B]">
              Explanation withheld
            </span>
            <span className="text-[#7E5D1B]">
              . The figures below are verified, but {why}. The written
              explanation was not released.
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="fade-up flex items-start gap-3 rounded-[11px] border border-line-strong bg-panel px-[17px] py-[13px]"
    >
      <span className="mt-[1px] flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-ink-300 text-xs font-bold text-white">
        ×
      </span>
      <div className="text-sm">
        <span className="font-semibold text-ink-900">
          {refusalKind === "out_of_scope" ? "Outside scope" : "Cannot answer"}
        </span>
        <span className="text-ink-500">
          {refusalKind === "out_of_scope"
            ? ". This question is not personal income tax for a supported year, so Citetax refuses rather than guessing."
            : ". No rule in force was found for this question. Citetax does not guess."}
        </span>
      </div>
    </div>
  );
}
