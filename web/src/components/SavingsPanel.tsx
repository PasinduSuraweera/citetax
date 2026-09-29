"use client";

/**
 * Ways to lower the balance. Every figure comes from re-running the compute
 * engine with a larger deduction, so nothing here is estimated by a model.
 * These are scenarios, not advice on what qualifies: that is for the Act.
 */

import { Lightbulb } from "lucide-react";
import type { Savings, SavingsLever } from "@/lib/api";
import { money, percent } from "@/lib/api";

interface Props {
  savings: Savings;
  onRuleClick?: (ruleKey: string) => void;
}

export function SavingsPanel({ savings, onRuleClick }: Props) {
  const base = Number(savings.baseline_balance);
  const best = savings.levers.reduce((m, l) => Math.max(m, Number(l.tax_saved)), 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-xl border border-brand-600/30 bg-brand-050 px-5 py-4">
        <Lightbulb className="mt-0.5 size-5 flex-none text-brand-700" />
        <div className="min-w-0">
          <p className="text-[15px] font-medium leading-[1.5] text-ink-900">
            {savings.marginal_rate
              ? <>Your top slice of income is taxed at {percent(savings.marginal_rate)}, so each rupee deducted there saves about {Math.round(Number(savings.marginal_rate) * 100)} cents.</>
              : <>Extra qualifying payments come off your taxable income before tax is worked out.</>}
          </p>
          <p className="tnum mt-1 text-[13.5px] leading-[1.55] text-ink-500">
            Up to LKR {money(String(best), { decimals: false })} a year could come off your LKR {money(savings.baseline_balance, { decimals: false })} balance.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {savings.levers.map((lever) => (
          <LeverCard key={`${lever.kind}-${lever.extra_deduction}`} lever={lever} base={base} onRuleClick={onRuleClick} />
        ))}
      </div>

      <p className="max-w-[68ch] px-1 text-[13px] leading-[1.55] text-ink-400">
        Each scenario re-runs the same computation with more qualifying payments
        and shows the difference. Which payments actually qualify is set by the
        Act, and Citetax has not checked yours. Confirm with the Inland Revenue
        Department or a tax adviser before relying on a figure.
      </p>
    </div>
  );
}

function LeverCard({
  lever, base, onRuleClick,
}: { lever: SavingsLever; base: number; onRuleClick?: (ruleKey: string) => void }) {
  const isEdge = lever.kind === "band_edge";
  const pct = base > 0 ? Math.min(100, (Number(lever.tax_saved) / base) * 100) : 0;
  return (
    <div className={`flex flex-col rounded-xl border bg-white p-5 ${isEdge ? "border-brand-600/40" : "border-line"}`}>
      {isEdge && (
        <span className="mb-2 w-fit rounded-md bg-brand-100 px-2 py-0.5 text-[12px] font-medium text-brand-700">
          Biggest effect per rupee
        </span>
      )}
      <div className="text-[13px] text-ink-400">
        {isEdge && lever.detail.band_rate
          ? `Clear the ${percent(lever.detail.band_rate)} band`
          : "If you had further qualifying payments of"}
      </div>
      <div className="tnum mt-1 text-[20px] font-semibold tracking-[-0.02em] text-ink-900">
        LKR {money(lever.extra_deduction, { decimals: false })}
      </div>

      <div className="mt-4 text-[13px] text-ink-400">Tax saved</div>
      <div className="tnum text-[28px] font-semibold leading-tight tracking-[-0.03em] text-brand-700">
        LKR {money(lever.tax_saved, { decimals: false })}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
      </div>
      <div className="tnum mt-2 text-[13px] text-ink-500">
        Balance becomes LKR {money(lever.new_balance, { decimals: false })}
      </div>

      {lever.citation_label && (
        <button
          type="button"
          onClick={() => onRuleClick?.(lever.rule_key)}
          className="statute mt-4 w-fit text-left text-[13px] italic text-brand-700 underline-offset-4 hover:underline"
        >
          {lever.citation_label}
        </button>
      )}
    </div>
  );
}
