"use client";

/**
 * The computation ledger.
 *
 * Zero-value steps render greyed rather than being dropped, so the step count
 * in the headline always matches the visible table (spec section 6.2 addition 4).
 * Rule chips are clickable and each row can be flagged (additions 5 and 6).
 *
 * Laid out with container queries, not viewport breakpoints. The same table
 * appears full width under an answer and inside a 440px detail pane on the
 * history page; a `md:` rule would keep four columns in that pane on a desktop
 * and crush the labels into vertical text. `@md` asks how wide THIS table is.
 */

import { useState } from "react";
import type { BandRow, LedgerStep } from "@/lib/api";
import { money, percent } from "@/lib/api";

interface Props {
  steps: LedgerStep[];
  balance: string;
  isRefund: boolean;
  onRuleClick?: (ruleKey: string) => void;
  onFlag?: (step: LedgerStep) => void;
  citationIndex?: Map<string, number>;
}

export function ComputationTable({
  steps,
  balance,
  isRefund,
  onRuleClick,
  onFlag,
  citationIndex,
}: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="@container flex flex-col overflow-hidden rounded-xl border border-line bg-white px-4 pb-5 pt-1 sm:px-6">
      {/* Column headers only make sense once the rows are in columns, which is
          @md up. Narrower than that each step becomes a stacked card. */}
      <div className="hidden items-center border-b border-[#EEF1F8] pb-[10px] pt-[14px] font-mono text-[10px] font-medium tracking-[0.14em] text-ink-300 @md:flex">
        <span className="w-11 flex-none">STEP</span>
        <span className="flex-1">WHAT IT DOES</span>
        <span className="w-[180px] flex-none">RULE APPLIED</span>
        <span className="w-[130px] flex-none text-right">VALUE, LKR</span>
      </div>

      {steps.map((step) => {
        const bands = (step.detail?.bands as BandRow[] | undefined) ?? null;
        const canExpand = Boolean(bands?.length);
        const isOpen = expanded === step.step_no;
        const citeNo = step.rule_version_id
          ? citationIndex?.get(step.rule_version_id)
          : undefined;

        return (
          <div key={step.step_no}>
            <div
              className={`group flex flex-wrap items-center border-b border-line-faint py-[11px] @md:flex-nowrap ${
                canExpand ? "cursor-pointer" : ""
              }`}
              onClick={canExpand ? () => setExpanded(isOpen ? null : step.step_no) : undefined}
            >
              <span className="tnum w-8 flex-none font-mono text-[13px] font-medium text-ink-200 @md:w-11">
                {step.step_no}
              </span>

              <div className="min-w-0 flex-1 pr-3">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-[14.5px] ${
                      step.is_zero ? "text-ink-300" : "font-medium text-ink-900"
                    }`}
                  >
                    {step.label}
                  </span>
                  {canExpand && (
                    <span className="font-mono text-[10.5px] text-brand-600">
                      {isOpen ? "collapse ▴" : "band walk ▾"}
                    </span>
                  )}
                </div>
                {/* A zero step is still cited, which is the point of showing it
                    rather than dropping it (spec section 6.2 addition 4). */}
                {step.is_zero && (
                  <div className="mt-[2px] text-[11.5px] text-ink-200">
                    Nil for this computation, still traced to a rule
                  </div>
                )}
              </div>

              {/* When the table is narrow the rule chip and the value share a
                  row below the label, so a long citation never squeezes the
                  figure. */}
              <div className="order-3 mt-2 flex w-full items-center gap-[6px] pl-8 @md:order-none @md:mt-0 @md:w-[180px] @md:flex-none @md:pl-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRuleClick?.(step.rule_key);
                  }}
                  className="max-w-full truncate rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-xs font-medium text-ink-700 transition-colors hover:bg-brand-100 hover:text-brand-600"
                  title={`${step.rule_key}, open citation`}
                >
                  {step.citation_label ?? step.rule_key}
                </button>
                {citeNo != null && (
                  <span className="flex-none rounded-[3px] bg-brand-100 px-1 py-[2px] font-mono text-[10px] font-semibold text-brand-600">
                    {citeNo}
                  </span>
                )}
              </div>

              <span
                className={`tnum ml-auto flex-none text-right font-mono text-[15px] tracking-[-0.015em] @md:ml-0 @md:w-[130px] ${
                  step.is_zero ? "text-ink-200" : "font-medium text-ink-900"
                }`}
              >
                {money(step.value)}
              </span>

              {onFlag && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFlag(step);
                  }}
                  aria-label={`Flag step ${step.step_no}, ${step.label}`}
                  title="This number looks wrong"
                  className="ml-2 w-5 flex-none text-center font-mono text-xs text-ink-200 opacity-0 transition-opacity hover:text-warn-600 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  ⚑
                </button>
              )}
            </div>

            {isOpen && bands && (
              <div className="fade-up mb-2 mt-3 rounded-[10px] border border-line-strong bg-panel px-4 py-[14px]">
                <div className="text-[12.5px] font-semibold text-ink-900">
                  Step {step.step_no} expanded, band walk
                </div>
                {/* Five bands side by side need about 700px. Narrower than
                    that they wrap into a grid rather than being crushed. */}
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 @lg:flex @lg:gap-0">
                  {bands.map((b, i) => (
                    <div
                      key={i}
                      className="border-line px-0 @lg:min-w-[110px] @lg:flex-1 @lg:border-r @lg:px-3 @lg:last:border-r-0"
                    >
                      <div className="font-mono text-[10.5px] font-medium text-ink-300">
                        {money(b.from)} to {b.to === "and above" ? "above" : money(b.to)}
                      </div>
                      <div className="tnum mt-1 font-mono text-[15px] font-semibold tracking-[-0.02em] text-ink-900">
                        {percent(b.rate)}
                      </div>
                      <div className="tnum mt-[3px] font-mono text-[13px] font-medium text-ink-700">
                        {money(b.tax)}
                      </div>
                      <div
                        className="mt-2 h-[3px] rounded-sm bg-brand-600"
                        style={{ opacity: 0.35 + i * 0.16 }}
                      />
                    </div>
                  ))}
                  <div className="col-span-2 border-t border-line pt-3 @lg:col-span-1 @lg:w-[120px] @lg:flex-none @lg:border-t-0 @lg:pl-[14px] @lg:pt-0">
                    <div className="font-mono text-[10.5px] font-medium text-ink-300">
                      GROSS TAX
                    </div>
                    <div className="tnum mt-1 font-mono text-[15px] font-semibold tracking-[-0.02em] text-ink-900">
                      {money(step.value)}
                    </div>
                    <div className="mt-[3px] text-[11px] text-ink-300">
                      plain Python
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* The balance is derived, not a ninth step, so it carries no number. */}
      <div className="mt-3 flex items-center rounded-[9px] bg-ink-900 px-[18px] py-[14px]">
        <span className="w-8 flex-none font-mono text-[13px] font-medium text-white/30 @md:w-11">
          =
        </span>
        <span className="flex-1 text-[15.5px] font-semibold text-white">
          {isRefund ? "Refund due" : "Balance payable"}
        </span>
        <span className="hidden font-mono text-xs font-medium text-white/55 @md:block @md:w-[180px] @md:flex-none">
          derived
        </span>
        <span className="tnum flex-none text-right font-mono text-[19px] font-semibold tracking-[-0.02em] text-white @md:w-[130px]">
          {money(isRefund ? balance.replace("-", "") : balance)}
        </span>
      </div>
    </div>
  );
}
