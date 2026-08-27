"use client";

/** The answer, refusal and clarify states. All three share the card chrome. */

import { useMemo, useState } from "react";
import type { AnswerResponse, LedgerStep } from "@/lib/api";
import { api, formatDate, money } from "@/lib/api";
import { AgentTrace } from "./AgentTrace";
import { CitationsPanel } from "./CitationsPanel";
import { ComputationTable } from "./ComputationTable";
import { GuardrailBanner } from "./GuardrailBanner";

type Tab = "computation" | "citations" | "trace" | "explanation";

interface Props {
  question: string;
  answer: AnswerResponse;
  onClarifyAnswer?: (text: string) => void;
}

export function AnswerView({ question, answer, onClarifyAnswer }: Props) {
  const [tab, setTab] = useState<Tab>("computation");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<Set<number>>(new Set());

  const citationIndex = useMemo(() => {
    const m = new Map<string, number>();
    answer.citations?.forEach((c, i) => m.set(c.rule_version_id, i + 1));
    return m;
  }, [answer.citations]);

  /* ---------- refusal ---------- */
  if (answer.kind === "refusal") {
    return (
      <div className="fade-up flex flex-col gap-[14px]">
        <QuestionCard question={question} />
        <GuardrailBanner
          badge="cannot_answer"
          ya={answer.ya}
          // "No rule in force" is only accurate when resolution failed. A scope
          // refusal never reached the rules table at all.
          refusalKind={
            answer.refusal?.reason?.includes("no rule in force")
              ? "no_rule"
              : "out_of_scope"
          }
        />
        <div className="rounded-xl border border-line bg-white px-6 py-6">
          <div className="eyebrow">REFUSED</div>
          <p className="mt-3 max-w-[620px] text-[15px] leading-[1.6] text-ink-700">
            {answer.refusal?.reason}
          </p>
          {answer.refusal?.pointer && (
            <a
              href={answer.refusal.pointer.split(" | ")[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-line-strong bg-panel px-3 py-2 text-[13px] font-medium text-brand-600 transition-colors hover:border-brand-600"
            >
              {answer.refusal.pointer} ↗
            </a>
          )}
          <p className="mt-5 max-w-[620px] text-[13px] leading-[1.55] text-ink-400">
            A refusal is a designed answer, not an error. Citetax covers personal
            income tax for the two supported years of assessment and will not
            guess outside that.
          </p>
        </div>
      </div>
    );
  }

  /* ---------- clarify ---------- */
  if (answer.kind === "clarify") {
    return (
      <div className="fade-up flex flex-col gap-[14px]">
        <QuestionCard question={question} />
        <div className="rounded-xl border border-brand-600 bg-white px-6 py-6 shadow-[0_0_0_4px_rgba(43,68,199,0.09)]">
          <div className="eyebrow text-brand-600">ONE MORE THING</div>
          <p className="mt-3 max-w-[560px] text-[17px] leading-[1.5] text-ink-900">
            {answer.clarify?.question}
          </p>
          <p className="mt-3 text-[13px] text-ink-400">
            Citetax asks rather than assuming your income, filing status or year.
          </p>
          <ClarifyReply onSubmit={onClarifyAnswer} />
        </div>
      </div>
    );
  }

  /* ---------- answer ---------- */
  const c = answer.computation!;
  const balance = c.balance_payable;
  const negative = balance.startsWith("-");

  const handleRuleClick = (ruleKey: string) => {
    setTab("citations");
    setHighlight(ruleKey);
    requestAnimationFrame(() => {
      document
        .getElementById(`cite-${ruleKey}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const handleFlag = async (step: LedgerStep) => {
    setFlagged((prev) => new Set(prev).add(step.step_no));
    if (!answer.run_id) return;
    try {
      await api.flag(answer.run_id, {
        step_no: step.step_no,
        rule_version_id: step.rule_version_id,
        note: `User flagged step ${step.step_no}: ${step.label}`,
      });
    } catch {
      /* The flag is a courtesy; failing to record it must not break the view. */
    }
  };

  return (
    <div className="fade-up flex flex-col gap-[14px]">
      <QuestionCard question={question} facts={factChips(answer)} />

      <GuardrailBanner
        badge={answer.badge}
        ya={answer.ya}
        stepCount={c.step_count}
        verify={answer.verify}
        checks={["NO MODEL IN ARITHMETIC", "YEAR FILTER ON", "PII STRIPPED"]}
      />

      <div className="flex flex-1 gap-[14px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[14px]">
          {/* Headline figure */}
          <div className="rounded-xl border border-line bg-white px-6 py-[22px]">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0 flex-1">
                <div className="eyebrow">
                  {negative ? "REFUND DUE" : "BALANCE PAYABLE"} · YEAR OF
                  ASSESSMENT {answer.ya}
                </div>
                <div
                  aria-live="polite"
                  className="tnum mt-[9px] font-mono text-[54px] font-semibold leading-none tracking-[-0.045em] text-ink-900"
                >
                  LKR {money(negative ? balance.slice(1) : balance)}
                </div>
                <p className="mt-3 max-w-[520px] text-[14.5px] leading-[1.6] text-ink-500">
                  {c.step_count} steps, each traced to a rule in force for{" "}
                  {answer.ya}.
                  {answer.compliance?.return_due && (
                    <>
                      {" "}
                      Return due{" "}
                      <strong className="font-semibold text-ink-900">
                        {formatDate(answer.compliance.return_due)}
                      </strong>
                      .
                    </>
                  )}
                </p>
              </div>

              <div className="w-[236px] flex-none rounded-[10px] border border-line bg-panel p-[14px]">
                <div className="eyebrow">EFFECTIVE RATE</div>
                <div className="tnum mt-[6px] font-mono text-[26px] font-semibold tracking-[-0.03em] text-ink-900">
                  {rate(c.gross_tax, c.steps[0]?.value)}
                </div>
                <p className="mt-[5px] text-xs leading-[1.45] text-ink-400">
                  of LKR {money(c.steps[0]?.value ?? "0")} assessable income.
                </p>
                <div className="my-3 h-px bg-line" />
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-ink-400">On taxable income</span>
                  <span className="tnum font-mono text-[13px] font-medium text-ink-900">
                    {rate(c.gross_tax, c.taxable_income)}
                  </span>
                </div>
                <p className="mt-[6px] text-xs leading-[1.45] text-ink-400">
                  LKR {money(c.taxable_income)} after relief and deductions.
                </p>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div
            role="tablist"
            className="flex flex-none gap-[3px] rounded-[10px] border border-line bg-[#EDF1F9] p-[3px]"
          >
            {(
              [
                ["computation", "Computation"],
                ["citations", "Citations"],
                ["trace", "Agent trace"],
                ["explanation", "Explain this rule"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-[7px] py-[9px] text-center text-[13.5px] transition-all ${
                  tab === key
                    ? "bg-white font-semibold text-ink-900 shadow-[0_1px_2px_rgba(14,20,48,0.08)]"
                    : "font-medium text-ink-400 hover:text-ink-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "computation" && (
            <ComputationTable
              steps={c.steps}
              balance={balance}
              isRefund={c.is_refund}
              onRuleClick={handleRuleClick}
              onFlag={handleFlag}
              citationIndex={citationIndex}
            />
          )}

          {tab === "citations" && (
            <div className="min-h-[420px]">
              <CitationsPanel
                citations={answer.citations ?? []}
                ya={answer.ya}
                highlightRuleKey={highlight}
              />
            </div>
          )}

          {tab === "trace" && (
            <AgentTrace trace={answer.trace} latencyMs={answer.latency_ms} />
          )}

          {tab === "explanation" && (
            <div className="rounded-xl border border-line bg-white px-6 py-6">
              {answer.explanation ? (
                <>
                  <div className="eyebrow">EXPLANATION</div>
                  <p className="mt-3 max-w-[680px] text-[15px] leading-[1.7] text-ink-700">
                    {answer.explanation}
                  </p>
                  <p className="mt-5 border-t border-line pt-4 text-[12px] leading-[1.55] text-ink-400">
                    Every figure in this paragraph was checked against the
                    ledger before it was shown to you.
                  </p>
                </>
              ) : (
                <>
                  <div className="eyebrow">EXPLANATION WITHHELD</div>
                  <p className="mt-3 max-w-[620px] text-[15px] leading-[1.65] text-ink-700">
                    {answer.verify?.note ??
                      "The written explanation was not released."}
                  </p>
                  <p className="mt-4 max-w-[620px] text-[13px] leading-[1.55] text-ink-400">
                    The figures in the computation tab are unaffected. They come
                    from the rules table, not from a language model, so they
                    stand on their own.
                  </p>
                </>
              )}
            </div>
          )}

          {flagged.size > 0 && (
            <div className="rounded-lg border border-line bg-panel px-4 py-3 text-[12.5px] text-ink-500">
              Flagged {flagged.size === 1 ? "one step" : `${flagged.size} steps`}{" "}
              for review. A reviewer sees the rule version and the inputs that
              produced the figure.
            </div>
          )}
        </div>

        {/* Right rail */}
        <div className="flex w-[318px] flex-none flex-col gap-3">
          <CitationsPanel
            citations={answer.citations ?? []}
            ya={answer.ya}
            highlightRuleKey={highlight}
          />
          {answer.compliance && (
            <div className="flex-none rounded-xl border border-line bg-white px-4 py-4">
              <div className="eyebrow">FILING</div>
              <div className="mt-[10px] text-[13px] font-semibold text-ink-900">
                {answer.compliance.must_file
                  ? "You must file a return"
                  : "No filing obligation"}
              </div>
              <p className="mt-[5px] text-[11.5px] leading-[1.45] text-ink-400">
                {answer.compliance.reason}
              </p>
              {answer.compliance.instalments.length > 0 && (
                <div className="mt-3 border-t border-line pt-3">
                  <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">
                    INSTALMENTS
                  </div>
                  <div className="mt-2 flex flex-col gap-1">
                    {answer.compliance.instalments.map((d) => (
                      <span
                        key={d}
                        className="tnum font-mono text-[11.5px] text-ink-700"
                      >
                        {formatDate(d)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function QuestionCard({
  question,
  facts,
}: {
  question: string;
  facts?: string[];
}) {
  return (
    <div className="flex items-start gap-[14px] rounded-xl border border-line bg-white px-[18px] py-4">
      <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-ink-900 text-[11px] font-semibold text-white">
        You
      </span>
      <div className="flex-1">
        <p className="text-[16px] leading-[1.5] text-ink-900">{question}</p>
        {facts && facts.length > 0 && (
          <div className="mt-[11px] flex flex-wrap gap-[7px]">
            {facts.map((f) => (
              <span
                key={f}
                className="rounded-full border border-[#DFE5F2] bg-panel px-[10px] py-1 font-mono text-[11.5px] font-medium text-ink-700"
              >
                {f}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ClarifyReply({ onSubmit }: { onSubmit?: (text: string) => void }) {
  const [value, setValue] = useState("");
  if (!onSubmit) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
      className="mt-4 flex gap-2"
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Your answer"
        className="flex-1 rounded-lg border border-line-strong bg-white px-3 py-[10px] text-[14.5px] text-ink-900 outline-none focus:border-brand-600"
      />
      <button
        type="submit"
        className="rounded-lg bg-brand-600 px-5 py-[10px] text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-700"
      >
        Send
      </button>
    </form>
  );
}

function factChips(answer: AnswerResponse): string[] {
  const chips: string[] = [];
  if (answer.ya) chips.push(`Y/A ${answer.ya}`);
  const steps = answer.computation?.steps ?? [];
  const assessable = steps.find((s) => s.rule_key === "income.assessable");
  if (assessable) chips.push(`assessable ${money(assessable.value)}`);
  const epf = steps.find((s) => s.rule_key === "deduction.epf_employee");
  if (epf && !epf.is_zero) chips.push(`EPF ${money(epf.value)}`);
  const apit = steps.find((s) => s.rule_key === "credit.apit");
  if (apit && !apit.is_zero) chips.push(`APIT ${money(apit.value)}`);
  return chips;
}

/** A display-only ratio. Never feeds a computation, so float is fine here. */
function rate(numerator: string, denominator: string | undefined): string {
  if (!denominator) return "-";
  const d = Number(denominator);
  const n = Number(numerator);
  if (!d || Number.isNaN(d) || Number.isNaN(n)) return "0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}
