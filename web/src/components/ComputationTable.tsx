"use client";

/**
 * The computation ledger.
 *
 * Zero-value steps render greyed rather than being dropped, so the step count
 * in the headline always matches the visible table (spec section 6.2 addition 4).
 * Rule chips are clickable and each row can be flagged (additions 5 and 6).
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
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-white px-6 pb-5 pt-1">
      <div className="flex items-center border-b border-[#EEF1F8] pb-[10px] pt-[14px] font-mono text-[10px] font-medium tracking-[0.14em] text-ink-300">
        <span className="w-11 flex-none">STEP</span>
        <span className="flex-1">WHAT IT DOES</span>
        <span className="w-[190px] flex-none">RULE APPLIED</span>
        <span className="w-[150px] flex-none text-right">VALUE, LKR</span>
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
              className={`group flex items-center border-b border-line-faint py-[11px] ${
                canExpand ? "cursor-pointer" : ""
              }`}
              onClick={canExpand ? () => setExpanded(isOpen ? null : step.step_no) : undefined}
            >
              <span className="tnum w-11 flex-none font-mono text-[13px] font-medium text-ink-200">
                {step.step_no}
              </span>

              <div className="flex-1 pr-3">
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

              <div className="flex w-[190px] flex-none items-center gap-[6px]">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRuleClick?.(step.rule_key);
                  }}
                  className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-xs font-medium text-ink-700 transition-colors hover:bg-brand-100 hover:text-brand-600"
                  title={`${step.rule_key}, open citation`}
                >
                  {step.citation_label ?? step.rule_key}
                </button>
                {citeNo != null && (
                  <span className="rounded-[3px] bg-brand-100 px-1 py-[2px] font-mono text-[10px] font-semibold text-brand-600">
                    {citeNo}
                  </span>
                )}
              </div>

              <span
                className={`tnum w-[150px] flex-none text-right font-mono text-[15px] tracking-[-0.015em] ${
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
                <div className="mt-3 flex flex-wrap gap-0">
                  {bands.map((b, i) => (
                    <div
                      key={i}
                      className="min-w-[120px] flex-1 border-r border-line px-3 last:border-r-0"
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
                  <div className="w-[130px] flex-none pl-[14px]">
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
        <span className="w-11 flex-none font-mono text-[13px] font-medium text-white/30">
          =
        </span>
        <span className="flex-1 text-[15.5px] font-semibold text-white">
          {isRefund ? "Refund due" : "Balance payable"}
        </span>
        <span className="w-[190px] flex-none font-mono text-xs font-medium text-white/55">
          derived
        </span>
        <span className="tnum w-[150px] flex-none text-right font-mono text-[19px] font-semibold tracking-[-0.02em] text-white">
          {money(isRefund ? balance.replace("-", "") : balance)}
        </span>
      </div>
    </div>
  );
}
