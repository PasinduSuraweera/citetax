"use client";

/**
 * The verdict above the answer.
 *
 * Three states, because the verify node can fail and the UI must depict that
 * (spec section 6.2 addition 3). Green means every figure traced to a rule.
 * Amber means the figures are still verified but the prose was withheld.
 * Grey means no rule in force was found and nothing was computed.
 */

import { Ban, Check, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Badge, VerifyResult } from "@/lib/api";

interface Props {
  badge: Badge;
  ya: string | null;
  stepCount?: number;
  verify?: VerifyResult | null;
  /** Short statements of what was checked, shown when there is room. */
  checks?: string[];
  /** Why the answer was refused, so the banner states the real reason rather
      than defaulting to "no rule in force". */
  refusalKind?: "out_of_scope" | "no_rule";
}

export function GuardrailBanner({ badge, ya, stepCount, verify, checks, refusalKind }: Props) {
  if (badge === "all_cited") {
    return (
      <div role="status" className="@container fade-up rounded-lg bg-good-100 px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5 text-[14px] leading-[1.5]">
            <ShieldCheck className="mt-[2px] size-4 flex-none text-good-600" />
            <p className="text-good-700">
              <span className="font-semibold">Verified.</span>{" "}
              {stepCount != null
                ? `All ${stepCount} lines of the ledger cite a rule in force for ${ya ?? "this year"}.`
                : `Every figure traces to a rule in force for ${ya ?? "this year"}.`}
            </p>
          </div>
          {/* Reassurance, not information: the first thing to drop when the
              banner is narrow. */}
          {checks && checks.length > 0 && (
            <ul className="hidden flex-none gap-4 @3xl:flex">
              {checks.map((c) => (
                <li key={c} className="flex items-center gap-1 text-[12.5px] text-good-500">
                  <Check className="size-3.5" />
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (badge === "partial") {
    const why = verify?.pii_classes?.length
      ? "a personal detail was found in it"
      : verify?.unmatched_numbers?.length
        ? `these figures could not be traced: ${verify.unmatched_numbers.join(", ")}`
        : "a figure in it could not be traced to a rule";

    return (
      <div role="status" className="fade-up flex items-start gap-2.5 rounded-lg bg-[#fdf4e0] px-4 py-3 text-[14px] leading-[1.5]">
        <TriangleAlert className="mt-[2px] size-4 flex-none text-[#a26b0e]" />
        <p className="text-[#6b4a0b]">
          <span className="font-semibold">Explanation withheld.</span> The figures
          are verified, but {why}, so the written explanation was not released.
        </p>
      </div>
    );
  }

  return (
    <div role="status" className="fade-up flex items-start gap-2.5 rounded-lg bg-muted px-4 py-3 text-[14px] leading-[1.5]">
      <Ban className="mt-[2px] size-4 flex-none text-ink-400" />
      <p className="text-ink-700">
        <span className="font-semibold text-ink-900">
          {refusalKind === "out_of_scope" ? "Outside what Citetax covers." : "No rule found."}
        </span>{" "}
        {refusalKind === "out_of_scope"
          ? "This is not personal income tax for a supported year, so Citetax declines rather than guessing."
          : "No rule in force answers this question, and Citetax does not guess."}
      </p>
    </div>
  );
}
