"use client";

/**
 * The answer, whatever path the planner took.
 *
 * A computation gets the headline figure and the ledger. A deadline gets the
 * date and a countdown. A comparison gets the diff. A rule lookup gets the
 * value and its citation. A general question gets the grounded prose with the
 * passages it drew on. Refusal and clarify share the same chrome.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import type { AnswerResponse, CompareChange, LedgerStep, RuleSide } from "@/lib/api";
import { api, formatDate, money, percent } from "@/lib/api";
import { AgentTrace } from "./AgentTrace";
import { CitationsPanel } from "./CitationsPanel";
import { ComputationTable } from "./ComputationTable";
import { GuardrailBanner } from "./GuardrailBanner";

type Tab = "computation" | "comparison" | "sources" | "citations" | "trace" | "explanation";

interface Props {
  question: string;
  answer: AnswerResponse;
  onClarifyAnswer?: (text: string) => void;
}

export function AnswerView({ question, answer, onClarifyAnswer }: Props) {
  const hasComputation = Boolean(answer.computation);
  const hasCompare = Boolean(answer.compare);
  const hasPassages = Boolean(answer.passages && answer.passages.length);
  // For a general question the prose IS the answer and sits in the headline,
  // so repeating it in an Explanation tab would show the same paragraph twice.
  const proseInHeadline = answer.intent === "general" && !(answer.lookup && answer.lookup.length);

  const defaultTab: Tab = hasComputation
    ? "computation"
    : hasCompare
      ? "comparison"
      : proseInHeadline
        ? hasPassages ? "sources" : "citations"
        : answer.explanation
          ? "explanation"
          : "citations";

  const [tab, setTab] = useState<Tab>(defaultTab);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<Set<number>>(new Set());

  const citationIndex = useMemo(() => {
    const m = new Map<string, number>();
    answer.citations?.forEach((c, i) => m.set(c.rule_version_id, i + 1));
    return m;
  }, [answer.citations]);

  /* ---------- refusal ---------- */
  if (answer.kind === "refusal") {
    const category = answer.refusal?.category;
    return (
      <div className="fade-up flex flex-col gap-[14px]">
        <QuestionCard question={question} />
        <GuardrailBanner
          badge="cannot_answer"
          ya={answer.ya}
          refusalKind={category === "no_rule" ? "no_rule" : "out_of_scope"}
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
              {answer.refusal.pointer.replace(" | ", " · ")} ↗
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
  const c = answer.computation;

  const handleRuleClick = (ruleKey: string) => {
    setTab("citations");
    setHighlight(ruleKey);
    requestAnimationFrame(() => {
      document.getElementById(`cite-${ruleKey}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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

  const tabs: Array<[Tab, string]> = [];
  if (hasComputation) tabs.push(["computation", "Computation"]);
  if (hasCompare) tabs.push(["comparison", "Comparison"]);
  if (!proseInHeadline) tabs.push(["explanation", "Explanation"]);
  if (hasPassages) tabs.push(["sources", `Sources (${answer.passages!.length})`]);
  tabs.push(["citations", "Citations"]);
  tabs.push(["trace", "Agent trace"]);

  const checks = ["NO MODEL IN ARITHMETIC", "YEAR FILTER ON", "PII STRIPPED"];
  if (answer.verify?.checked_numbers) {
    checks.unshift(`${answer.verify.checked_numbers} FIGURES TRACED`);
  }

  // Citations already have their own tab. Duplicating them in a rail is only
  // worth the width when the main column is a table the reader cross-checks
  // against, which is the computation and comparison cases.
  const showRail = hasComputation || hasCompare;

  return (
    <div className="fade-up flex flex-col gap-[14px]">
      <QuestionCard question={question} facts={factChips(answer)} intent={answer.intent} />

      <GuardrailBanner
        badge={answer.badge}
        ya={answer.ya}
        stepCount={c?.step_count}
        verify={answer.verify}
        checks={checks}
      />

      {/* The right rail earns its place only when there is a ledger or a
          filing card to sit beside. A prose answer gets the full width, so an
          explanation is not squeezed into two thirds of the column. */}
      <div className={`flex flex-1 flex-col gap-[14px] ${showRail ? "xl:flex-row" : ""}`}>
        <div className="flex min-w-0 flex-1 flex-col gap-[14px]">
          <Headline answer={answer} />

          {/* Tabs. Six of these will not fit a phone, so the strip scrolls
              horizontally instead of shrinking each label to nothing. */}
          <div
            role="tablist"
            className="@container flex flex-none gap-[3px] overflow-x-auto rounded-[10px] border border-line bg-[#EDF1F9] p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabs.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex-none whitespace-nowrap rounded-[7px] px-4 py-[9px] text-center text-[13.5px] transition-all @2xl:flex-1 @2xl:px-2 ${
                  tab === key
                    ? "bg-white font-semibold text-ink-900 shadow-[0_1px_2px_rgba(14,20,48,0.08)]"
                    : "font-medium text-ink-400 hover:text-ink-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "computation" && c && (
            <ComputationTable
              steps={c.steps}
              balance={c.balance_payable}
              isRefund={c.is_refund}
              onRuleClick={handleRuleClick}
              onFlag={handleFlag}
              citationIndex={citationIndex}
            />
          )}

          {tab === "comparison" && answer.compare && (
            <CompareTable compare={answer.compare} />
          )}

          {tab === "explanation" && (
            <div className="rounded-xl border border-line bg-white px-5 py-6 sm:px-6">
              {answer.explanation ? (
                <>
                  <div className="eyebrow">EXPLANATION</div>
                  {/* A measure cap keeps long prose readable, but 75ch is the
                      readable maximum, not 720px, so the paragraph uses the
                      width the layout gives it. */}
                  <p className="mt-3 max-w-[75ch] text-[15.5px] leading-[1.75] text-ink-700">
                    {answer.explanation}
                  </p>
                  <p className="mt-5 border-t border-line pt-4 text-[12px] leading-[1.55] text-ink-400">
                    Every figure and date in this paragraph was checked against the
                    law text and the ledger before it was shown to you.
                    {answer.verify?.checked_numbers
                      ? ` ${answer.verify.checked_numbers} checked, ${answer.verify.checked_numbers} traced.`
                      : ""}
                  </p>
                </>
              ) : (
                <>
                  <div className="eyebrow">EXPLANATION WITHHELD</div>
                  <p className="mt-3 max-w-[620px] text-[15px] leading-[1.65] text-ink-700">
                    {answer.verify?.note ?? "The written explanation was not released."}
                  </p>
                  {answer.verify?.unmatched_numbers?.length ? (
                    <p className="mt-3 font-mono text-[12px] text-[#7E5D1B]">
                      could not trace: {answer.verify.unmatched_numbers.join(", ")}
                    </p>
                  ) : null}
                  <p className="mt-4 max-w-[620px] text-[13px] leading-[1.55] text-ink-400">
                    The figures shown are unaffected. They come from the rules
                    table, not from a language model, so they stand on their own.
                  </p>
                </>
              )}
            </div>
          )}

          {tab === "sources" && answer.passages && (
            <div className="flex flex-col gap-2">
              {answer.passages.map((p, i) => (
                <div key={p.chunk_id} className="rounded-xl border border-line bg-white px-5 py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="rounded-[3px] bg-brand-100 px-1 py-[2px] font-mono text-[10px] font-semibold text-brand-600">
                        {i + 1}
                      </span>
                      <span className="text-[13px] font-semibold text-ink-900">
                        {p.title ?? p.rule_key ?? "Corpus passage"}
                      </span>
                    </div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-300">
                      {p.matched_by === "both" ? "keyword + semantic" : p.matched_by === "dense" ? "semantic" : "keyword"}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-[1.6] text-ink-700">{p.text}</p>
                  {p.url && (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-block font-mono text-[11px] text-brand-600 hover:underline"
                    >
                      open source ↗
                    </a>
                  )}
                </div>
              ))}
              <p className="px-1 text-[12px] leading-[1.5] text-ink-400">
                Retrieved for the explanation only. No figure in any answer comes
                from a passage; figures come from the rules table.
              </p>
            </div>
          )}

          {tab === "citations" && (
            <div className="min-h-[420px]">
              <CitationsPanel citations={answer.citations ?? []} ya={answer.ya} highlightRuleKey={highlight} />
            </div>
          )}

          {tab === "trace" && (
            <AgentTrace
              trace={answer.trace}
              plan={answer.plan}
              intent={answer.intent}
              routeSource={answer.route_source}
              latencyMs={answer.latency_ms}
              tokens={answer.llm?.total_tokens}
            />
          )}

          {flagged.size > 0 && (
            <div className="rounded-lg border border-line bg-panel px-4 py-3 text-[12.5px] text-ink-500">
              Flagged {flagged.size === 1 ? "one step" : `${flagged.size} steps`} for review. A
              reviewer sees the rule version and the inputs that produced the figure.
            </div>
          )}
        </div>

        {/* Right rail. Below xl it stacks under the main column. */}
        {showRail && (
          <div className="flex w-full flex-col gap-3 xl:w-[318px] xl:flex-none">
            <CitationsPanel citations={answer.citations ?? []} ya={answer.ya} highlightRuleKey={highlight} />
            {answer.compliance && answer.intent !== "deadline" && (
              <FilingCard compliance={answer.compliance} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- headline, one per intent ---------- */

function Headline({ answer }: { answer: AnswerResponse }) {
  const { intent, computation: c, compliance, compare, lookup, ya } = answer;

  if ((intent === "compute" || (intent === "obligation" && c)) && c) {
    const balance = c.balance_payable;
    const negative = balance.startsWith("-");
    return (
      <div className="@container rounded-xl border border-line bg-white px-5 py-[22px] sm:px-6">
        <div className="flex flex-col items-start justify-between gap-5 @2xl:flex-row @2xl:gap-6">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">
              {intent === "obligation"
                ? "FILING OBLIGATION"
                : negative ? "REFUND DUE" : "BALANCE PAYABLE"}{" "}
              · YEAR OF ASSESSMENT {ya}
            </div>
            {intent === "obligation" && compliance ? (
              <>
                <div aria-live="polite" className="mt-[9px] text-[23px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 @sm:text-[29px] @2xl:text-[40px] @2xl:leading-[1.1] @2xl:tracking-[-0.035em]">
                  {compliance.must_file ? "You must file a return" : "No return required"}
                </div>
                <p className="mt-3 max-w-[560px] text-[14.5px] leading-[1.6] text-ink-500">
                  {compliance.reason}
                  {compliance.return_due && compliance.must_file && (
                    <> Return due <strong className="font-semibold text-ink-900">{formatDate(compliance.return_due)}</strong>.</>
                  )}
                </p>
              </>
            ) : (
              <>
                {/* A figure must never break mid-number: "57,6 / 00" reads as
                    a different amount. The unit sits on its own line when the
                    space is tight, and the figure scales with the container. */}
                <div
                  aria-live="polite"
                  className="mt-[9px] flex flex-wrap items-baseline gap-x-2 font-mono font-semibold leading-none tracking-[-0.04em] text-ink-900"
                >
                  <span className="text-[20px] text-ink-300 @sm:text-[24px] @2xl:text-[30px]">LKR</span>
                  <span className="tnum whitespace-nowrap text-[30px] @sm:text-[38px] @2xl:text-[50px] @2xl:tracking-[-0.045em]">
                    {money(negative ? balance.slice(1) : balance)}
                  </span>
                </div>
                <p className="mt-3 max-w-[520px] text-[14.5px] leading-[1.6] text-ink-500">
                  {c.step_count} steps, each traced to a rule in force for {ya}.
                  {compliance?.return_due && (
                    <> Return due <strong className="font-semibold text-ink-900">{formatDate(compliance.return_due)}</strong>.</>
                  )}
                </p>
              </>
            )}
          </div>

          <div className="w-full flex-none rounded-[10px] border border-line bg-panel p-[14px] @2xl:w-[236px]">
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
    );
  }

  if (intent === "deadline" && compliance) {
    const days = compliance.days_remaining;
    return (
      <div className="@container rounded-xl border border-line bg-white px-5 py-[22px] sm:px-6">
        <div className="flex flex-col items-start justify-between gap-5 @2xl:flex-row @2xl:gap-6">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">RETURN DUE · YEAR OF ASSESSMENT {ya}</div>
            <div aria-live="polite" className="tnum mt-[9px] whitespace-nowrap font-mono text-[26px] font-semibold leading-none tracking-[-0.035em] text-ink-900 @sm:text-[34px] @2xl:text-[46px] @2xl:tracking-[-0.04em]">
              {formatDate(compliance.return_due)}
            </div>
            <p className="mt-3 max-w-[520px] text-[14.5px] leading-[1.6] text-ink-500">
              {days != null && days >= 0
                ? <><strong className="font-semibold text-ink-900">{days} days</strong> from today.</>
                : days != null
                  ? <>This date passed <strong className="font-semibold text-ink-900">{Math.abs(days)} days</strong> ago.</>
                  : null}{" "}
              Set by {compliance.citation_label}.
            </p>
          </div>
          {compliance.instalments.length > 0 && (
            <div className="w-[260px] flex-none rounded-[10px] border border-line bg-panel p-[14px]">
              <div className="eyebrow">QUARTERLY INSTALMENTS</div>
              <ol className="mt-3 flex flex-col gap-2">
                {compliance.instalments.map((d, i) => {
                  const past = new Date(`${d}T00:00:00`) < new Date();
                  return (
                    <li key={d} className="flex items-center justify-between">
                      <span className={`font-mono text-[10px] ${past ? "text-ink-200" : "text-brand-600"}`}>Q{i + 1}</span>
                      <span className={`tnum font-mono text-[13px] ${past ? "text-ink-300 line-through" : "font-medium text-ink-900"}`}>
                        {formatDate(d)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (intent === "compare" && compare) {
    return (
      <div className="@container rounded-xl border border-line bg-white px-5 py-[22px] sm:px-6">
        <div className="eyebrow">WHAT CHANGED · {compare.from_ya} TO {compare.to_ya}</div>
        <div aria-live="polite" className="mt-[9px] text-[23px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 @sm:text-[29px] @2xl:text-[40px] @2xl:leading-[1.1] @2xl:tracking-[-0.035em]">
          {compare.changed_count === 0
            ? "Nothing changed"
            : `${compare.changed_count} of ${compare.changes.length} rules changed`}
        </div>
        <p className="mt-3 max-w-[600px] text-[14.5px] leading-[1.6] text-ink-500">
          Compared rule by rule as the corpus stands at snapshot {answer.snapshot?.label}.
          {compare.changed_count > 0 && (
            <> Changed: {compare.changes.filter((x) => x.changed).map((x) => x.title ?? x.rule_key).join(", ")}.</>
          )}
          {compare.changed_count === 1 && compare.changes.some((x) => x.changed && x.rule_key.startsWith("deadline.")) && (
            <> The rates, bands and relief are one version serving both years; only the filing calendar moves.</>
          )}
        </p>
      </div>
    );
  }

  if ((intent === "rule_lookup" || intent === "general") && lookup && lookup.length) {
    const first = lookup[0];
    return (
      <div className="@container rounded-xl border border-line bg-white px-5 py-[22px] sm:px-6">
        <div className="eyebrow">{first.label ?? first.rule_key} · IN FORCE FOR {ya}</div>
        <div aria-live="polite" className="tnum mt-[9px] font-mono text-[23px] font-semibold leading-tight tracking-[-0.035em] text-ink-900 @sm:text-[29px] @2xl:text-[40px] @2xl:leading-none @2xl:tracking-[-0.04em]">
          {describeValue(first.value ?? {}, "headline")}
        </div>
        <p className="mt-3 max-w-[600px] text-[14.5px] leading-[1.6] text-ink-500">
          In force from <strong className="font-semibold text-ink-900">{formatDate(first.effective_from)}</strong>
          {first.effective_to ? <> to <strong className="font-semibold text-ink-900">{formatDate(first.effective_to)}</strong></> : ", no end date"}.
          {first.revision_no > 1 && <> Revision {first.revision_no}.</>}
        </p>
        {first.quoted_text && (
          <blockquote className="mt-4 max-w-[680px] border-l-2 border-brand-600 pl-4 text-[13.5px] leading-[1.6] text-ink-700">
            “{first.quoted_text}”
          </blockquote>
        )}
      </div>
    );
  }

  // general with no lookup: the prose is the headline.
  return (
    <div className="rounded-xl border border-line bg-white px-6 py-[22px]">
      <div className="eyebrow">GROUNDED ANSWER · YEAR OF ASSESSMENT {ya}</div>
      <p className="mt-3 max-w-[75ch] text-[16px] leading-[1.7] text-ink-900 sm:text-[17px] sm:leading-[1.65]">
        {answer.explanation ?? answer.verify?.note ?? "The explanation was withheld."}
      </p>
      <p className="mt-4 border-t border-line pt-3 text-[12px] leading-[1.55] text-ink-400">
        Written from the law text and the passages under Sources, and checked
        figure by figure before release.
        {answer.verify?.checked_numbers ? ` ${answer.verify.checked_numbers} checked, ${answer.verify.checked_numbers} traced.` : ""}
      </p>
    </div>
  );
}

/* ---------- comparison table ---------- */

export function CompareTable({ compare }: { compare: NonNullable<AnswerResponse["compare"]> }) {
  const changed = compare.changes.filter((c) => c.changed);
  const same = compare.changes.filter((c) => !c.changed);
  return (
    <div className="flex flex-col gap-3">
      {changed.map((ch) => <CompareRow key={ch.rule_key} change={ch} from={compare.from_ya} to={compare.to_ya} />)}
      {same.length > 0 && (
        <div className="rounded-xl border border-line bg-white px-5 py-4">
          <div className="eyebrow">UNCHANGED · {same.length} RULES</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {same.map((ch) => (
              <span key={ch.rule_key} className="rounded-full border border-line bg-panel px-[10px] py-1 font-mono text-[11.5px] text-ink-700" title={ch.to.citation_label ?? ""}>
                {ch.title ?? ch.rule_key}
              </span>
            ))}
          </div>
          <p className="mt-3 text-[12.5px] leading-[1.5] text-ink-400">
            Same rule version in force for both years. Not duplicated, not re-enacted.
          </p>
        </div>
      )}
    </div>
  );
}

function CompareRow({ change, from, to }: { change: CompareChange; from: string; to: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-brand-600/40 bg-white">
      <div className="flex items-center justify-between border-b border-line bg-brand-050 px-5 py-3">
        <span className="text-[14px] font-semibold text-ink-900">{change.title ?? change.rule_key}</span>
        <span className="rounded-full bg-brand-600 px-2 py-[3px] font-mono text-[10px] font-semibold text-white">CHANGED</span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <Side ya={from} side={change.from} tone="old" />
        <Side ya={to} side={change.to} tone="new" />
      </div>
    </div>
  );
}

function Side({ ya, side, tone }: { ya: string; side: RuleSide; tone: "old" | "new" }) {
  return (
    <div className={`px-5 py-4 ${tone === "new" ? "bg-white" : "bg-panel/60"}`}>
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] tracking-[0.1em] text-ink-300">{ya.replace("/", " / ")}</span>
        <span className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-[11px] text-ink-700">{side.citation_label}</span>
      </div>
      <div className={`tnum mt-2 font-mono text-[15px] leading-[1.5] ${tone === "new" ? "font-semibold text-ink-900" : "text-ink-500"}`}>
        {describeValue(side.value, "full")}
      </div>
      {side.effective_from && (
        <div className="mt-2 font-mono text-[10.5px] text-ink-300">
          from {formatDate(side.effective_from)}{side.effective_to ? ` to ${formatDate(side.effective_to)}` : ""}
        </div>
      )}
    </div>
  );
}

/* ---------- helpers ---------- */

export function describeValue(value: Record<string, unknown>, mode: "headline" | "full"): string {
  if (Array.isArray(value.bands)) {
    const bands = value.bands as Array<{ upto: number | null; rate: string }>;
    if (mode === "headline") return `${percent(bands[0].rate)} to ${percent(bands[bands.length - 1].rate)}`;
    return bands
      .map((b) => `${b.upto == null ? "above" : `to ${Number(b.upto).toLocaleString()}`} at ${percent(b.rate)}`)
      .join("\n");
  }
  if (typeof value.amount === "string") return `LKR ${money(value.amount)}`;
  if (typeof value.due === "string") {
    const s = `due ${formatDate(value.due)}`;
    if (mode === "full" && Array.isArray(value.instalments)) {
      return `${s}\ninstalments ${(value.instalments as string[]).map(formatDate).join(", ")}`;
    }
    return s;
  }
  if (typeof value.employee_rate === "string") return percent(value.employee_rate);
  if ("annual_cap" in value) return value.annual_cap == null ? "no cap" : `cap LKR ${money(String(value.annual_cap))}`;
  if ("allowed" in value) return value.allowed ? "credit allowed" : "no credit";
  if (Array.isArray(value.includes)) return (value.includes as string[]).join(", ");
  if (typeof value.formula === "string") return value.formula;
  return Object.entries(value).filter(([k]) => k !== "citation_label").map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

function FilingCard({ compliance }: { compliance: NonNullable<AnswerResponse["compliance"]> }) {
  return (
    <div className="flex-none rounded-xl border border-line bg-white px-4 py-4">
      <div className="eyebrow">FILING</div>
      <div className="mt-[10px] text-[13px] font-semibold text-ink-900">
        {compliance.must_file ? "You must file a return" : "No filing obligation"}
      </div>
      <p className="mt-[5px] text-[11.5px] leading-[1.45] text-ink-400">{compliance.reason}</p>
      {compliance.return_due && (
        <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
          <span className="font-mono text-[10px] tracking-[0.14em] text-ink-300">DUE</span>
          <span className="tnum font-mono text-[12.5px] font-medium text-ink-900">{formatDate(compliance.return_due)}</span>
        </div>
      )}
      {compliance.days_remaining != null && compliance.days_remaining >= 0 && (
        <div className="mt-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-[0.14em] text-ink-300">IN</span>
          <span className="tnum font-mono text-[12.5px] text-ink-700">{compliance.days_remaining} days</span>
        </div>
      )}
      {compliance.instalments.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">INSTALMENTS</div>
          <div className="mt-2 flex flex-col gap-1">
            {compliance.instalments.map((d) => (
              <span key={d} className="tnum font-mono text-[11.5px] text-ink-700">{formatDate(d)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ question, facts, intent }: { question: string; facts?: string[]; intent?: string }) {
  return (
    <div className="flex items-start gap-[14px] rounded-xl border border-line bg-white px-[18px] py-4">
      <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-ink-900 text-[11px] font-semibold text-white">
        You
      </span>
      <div className="flex-1">
        <p className="text-[16px] leading-[1.5] text-ink-900">{question}</p>
        {(facts?.length || intent) && (
          <div className="mt-[11px] flex flex-wrap gap-[7px]">
            {intent && (
              <span className="rounded-full bg-brand-100 px-[10px] py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-brand-600">
                {intent.replace("_", " ")}
              </span>
            )}
            {facts?.map((f) => (
              <span key={f} className="rounded-full border border-[#DFE5F2] bg-panel px-[10px] py-1 font-mono text-[11.5px] font-medium text-ink-700">
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
        autoFocus
        className="flex-1 rounded-lg border border-line-strong bg-white px-3 py-[10px] text-[14.5px] text-ink-900 outline-none focus:border-brand-600"
      />
      <button type="submit" className="rounded-lg bg-brand-600 px-5 py-[10px] text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-700">
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
  if (assessable && !assessable.is_zero) chips.push(`assessable ${money(assessable.value)}`);
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

export { Link };
