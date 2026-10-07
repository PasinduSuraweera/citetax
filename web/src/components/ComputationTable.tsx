"use client";

/**
 * The computation ledger.
 *
 * Zero-value steps render greyed rather than being dropped, so the step count
 * in the headline always matches the visible table (spec section 6.2 addition 4).
 * Rule tags are clickable and each row can be flagged (additions 5 and 6).
 *
 * Laid out with container queries, not viewport breakpoints. The same table
 * appears full width under an answer and inside a narrow detail pane on the
 * history page; `@md` asks how wide THIS table is.
 */

import { ChevronDown, Flag } from "lucide-react";
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
    <div className="@container flex flex-col rounded-xl border border-line bg-white px-4 pb-4 pt-1 sm:px-5">
      {/* Column headers only make sense once the rows are in columns. */}
      <div className="hidden items-center border-b border-line py-3 text-[12.5px] font-medium text-ink-400 @md:flex">
        <span className="w-10 flex-none">Step</span>
        <span className="flex-1">What it does</span>
        <span className="w-[190px] flex-none">Rule</span>
        <span className="w-[120px] flex-none text-right">LKR</span>
        {onFlag && <span className="w-7 flex-none" />}
      </div>

      {steps.map((step) => {
        const bands = (step.detail?.bands as BandRow[] | undefined) ?? null;
        const canExpand = Boolean(bands?.length);
        const isOpen = expanded === step.step_no;
        const citeNo = step.rule_version_id ? citationIndex?.get(step.rule_version_id) : undefined;

        return (
          <div key={step.step_no} className="border-b border-line-faint last:border-0">
            <div className="group flex flex-wrap items-center py-3 @md:flex-nowrap">
              <span className="tnum w-8 flex-none text-[13px] text-ink-300 @md:w-10">{step.step_no}</span>

              <div className="min-w-0 flex-1 pr-3">
                <span className={`text-[14.5px] ${step.is_zero ? "text-ink-300" : "font-medium text-ink-900"}`}>
                  {step.label}
                </span>
                {canExpand && (
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : step.step_no)}
                    aria-expanded={isOpen}
                    className="ml-2 inline-flex items-center gap-0.5 rounded px-1 text-[12.5px] text-brand-600 hover:bg-brand-050"
                  >
                    {isOpen ? "Hide bands" : "Show bands"}
                    <ChevronDown className={`size-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                )}
                {/* A zero step is still cited, which is the point of showing it
                    rather than dropping it (spec section 6.2 addition 4). */}
                {step.detail?.deductible === false ? (
                  <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-400">
                    {step.detail.contribution
                      ? `Your contribution of LKR ${Number(step.detail.contribution).toLocaleString("en-GB")} is considered, but the law allows no deduction from employment income`
                      : "The law allows no deduction from employment income for your own EPF contribution"}
                  </div>
                ) : step.is_zero ? (
                  <div className="mt-0.5 text-[12px] text-ink-300">Nothing to apply here, still traced to a rule</div>
                ) : step.detail?.assumed === true ? (
                  // A figure the user never gave is said to be assumed (#47).
                  <div className="mt-0.5 text-[12px] text-[#7e5d1b]">
                    {step.rule_key === "credit.apit"
                      ? "Assumed: what your employer deducts from your salary over the year. Give the APIT on your payslips to change it"
                      : "Assumed at the statutory rate. Give your actual figure to change it"}
                  </div>
                ) : null}
              </div>

              {/* Narrow, the rule tag and the value share a row below the
                  label, so a long citation never squeezes the figure. */}
              <div className="order-3 mt-2 flex w-full items-center gap-1.5 pl-8 @md:order-none @md:mt-0 @md:w-[190px] @md:flex-none @md:pl-0">
                <button
                  type="button"
                  onClick={() => onRuleClick?.(step.rule_key)}
                  className="statute max-w-full truncate rounded-md bg-muted px-2 py-0.5 text-[13px] italic text-ink-700 transition-colors hover:bg-brand-100 hover:text-brand-700"
                  title="Open the citation"
                >
                  {step.citation_label ?? step.rule_key}
                </button>
                {citeNo != null && (
                  <span className="tnum flex-none rounded bg-brand-100 px-1 text-[11px] font-semibold text-brand-700">
                    {citeNo}
                  </span>
                )}
              </div>

              <span
                className={`tnum ml-auto flex-none text-right text-[15px] @md:ml-0 @md:w-[120px] ${
                  step.is_zero ? "text-ink-300" : "font-medium text-ink-900"
                }`}
              >
                {money(step.value)}
              </span>

              {onFlag && (
                <button
                  type="button"
                  onClick={() => onFlag(step)}
                  aria-label={`Flag step ${step.step_no}, ${step.label}`}
                  title="This figure looks wrong"
                  className="ml-1 flex size-7 flex-none items-center justify-center rounded-md text-ink-300 opacity-100 transition-opacity hover:bg-warn-100 hover:text-warn-600 focus-visible:opacity-100 @md:opacity-0 @md:group-hover:opacity-100"
                >
                  <Flag className="size-3.5" />
                </button>
              )}
            </div>

            {isOpen && bands && (
              <div className="fade-up mb-3 rounded-lg bg-panel px-4 py-3.5">
                <div className="text-[13px] font-medium text-ink-900">How the tax falls across the bands</div>
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 @lg:flex @lg:gap-0">
                  {bands.map((b, i) => (
                    <div key={i} className="@lg:min-w-[110px] @lg:flex-1 @lg:border-r @lg:border-line @lg:px-3 @lg:first:pl-0 @lg:last:border-r-0">
                      <div className="tnum text-[12px] text-ink-400">
                        {money(b.from)} to {b.to === "and above" ? "above" : money(b.to)}
                      </div>
                      <div className="tnum mt-1 text-[15px] font-semibold text-ink-900">{percent(b.rate)}</div>
                      <div className="tnum mt-0.5 text-[13px] text-ink-700">{money(b.tax)}</div>
                      <div className="mt-2 h-[3px] rounded-full bg-brand-600" style={{ opacity: 0.3 + i * 0.16 }} />
                    </div>
                  ))}
                  <div className="col-span-2 border-t border-line pt-3 @lg:col-span-1 @lg:w-[120px] @lg:flex-none @lg:border-t-0 @lg:pl-4 @lg:pt-0">
                    <div className="text-[12px] text-ink-400">Gross tax</div>
                    <div className="tnum mt-1 text-[15px] font-semibold text-ink-900">{money(step.value)}</div>
                    <div className="mt-0.5 text-[12px] text-ink-400">worked out in code</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* The balance is derived from the lines above, so it has no step
          number and no rule of its own. */}
      <div className="mt-2 flex items-center rounded-lg bg-ink-900 px-4 py-3.5 text-white">
        <span className="flex-1 text-[15px] font-semibold">{isRefund ? "Refund due" : "Balance payable"}</span>
        <span className="tnum text-right text-[19px] font-semibold tracking-[-0.01em]">
          LKR {money(isRefund ? balance.replace("-", "") : balance)}
        </span>
      </div>
    </div>
  );
}
