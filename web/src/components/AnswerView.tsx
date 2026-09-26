"use client";

/**
 * The answer, whatever path the planner took.
 *
 * A computation gets the headline figure and the ledger. A deadline gets the
 * date and a countdown. A comparison gets the diff. A rule lookup gets the
 * value and its citation. A general question gets the grounded prose with the
 * passages it drew on. Refusal and clarify share the same question header.
 */

import { ArrowUpRight, Ban, MessageCircleQuestion } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { AnswerResponse, CompareChange, LedgerStep, RuleSide } from "@/lib/api";
import { api, formatDate, money, percent } from "@/lib/api";
import { spokenAnswer } from "@/lib/speech-text";
import { Button } from "@/components/ui/button";
import { AgentTrace } from "./AgentTrace";
import { CitationsPanel } from "./CitationsPanel";
import { ComputationTable } from "./ComputationTable";
import { GuardrailBanner } from "./GuardrailBanner";
import { ReadAloudButton } from "./ReadAloudButton";
import { SavingsPanel } from "./SavingsPanel";
import { ProseWithSources, SourcesList } from "./Sources";
import { INTENT_LABEL } from "./TurnSummary";
import { UserAvatar } from "./UserAvatar";

type Tab = "computation" | "savings" | "comparison" | "sources" | "citations" | "trace" | "explanation";

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
  const [sourceHighlight, setSourceHighlight] = useState<number | null>(null);
  const [flagged, setFlagged] = useState<Set<number>>(new Set());

  const citationIndex = useMemo(() => {
    const m = new Map<string, number>();
    answer.citations?.forEach((c, i) => m.set(c.rule_version_id, i + 1));
    return m;
  }, [answer.citations]);

  /* ---------- refusal ---------- */
  if (answer.kind === "refusal") {
    const category = answer.refusal?.category;
    const [href, label] = (answer.refusal?.pointer ?? "").split(" | ");
    return (
      <div className="fade-up flex flex-col gap-4">
        <QuestionHeader question={question} />
        <div className="rounded-xl border border-line bg-white px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-900">
            <Ban className="size-4 text-ink-400" />
            {category === "no_rule" ? "No rule answers this" : "Outside what Citetax covers"}
          </div>
          <p className="mt-2 max-w-[62ch] text-[15px] leading-[1.6] text-ink-700">{answer.refusal?.reason}</p>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1 text-[14px] font-medium text-brand-600 underline-offset-4 hover:underline"
            >
              {label ?? href}
              <ArrowUpRight className="size-3.5" />
            </a>
          )}
          <p className="mt-4 max-w-[62ch] text-[13px] leading-[1.55] text-ink-400">
            Citetax covers personal income tax for two years of assessment and
            declines anything outside that rather than guessing.
          </p>
        </div>
      </div>
    );
  }

  /* ---------- clarify ---------- */
  if (answer.kind === "clarify") {
    return (
      <div className="fade-up flex flex-col gap-4">
        <QuestionHeader question={question} />
        <div className="rounded-xl border border-brand-600/40 bg-brand-050 px-5 py-5 sm:px-6">
          <div className="flex items-center gap-2 text-[13px] font-medium text-brand-700">
            <MessageCircleQuestion className="size-4" />
            One more detail
          </div>
          <p className="mt-2 max-w-[62ch] text-[17px] leading-[1.5] text-ink-900">{answer.clarify?.question}</p>
          <p className="mt-2 text-[13px] text-ink-500">
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

  const passageCount = answer.passages?.length ?? 0;
  const goToSource = (n: number) => {
    setTab("sources");
    setSourceHighlight(n);
    requestAnimationFrame(() => {
      document.getElementById(`source-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const handleFlag = async (step: LedgerStep) => {
    if (flagged.has(step.step_no)) return;
    setFlagged((prev) => new Set(prev).add(step.step_no));
    toast.success(`Step ${step.step_no} flagged for review`, {
      description: "A reviewer sees the rule version and the inputs behind the figure.",
    });
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
  if (hasComputation) tabs.push(["computation", "Ledger"]);
  if (answer.savings) tabs.push(["savings", "Ways to save"]);
  if (hasCompare) tabs.push(["comparison", "Comparison"]);
  if (!proseInHeadline) tabs.push(["explanation", "Explanation"]);
  if (hasPassages) tabs.push(["sources", `Sources ${answer.passages!.length}`]);
  tabs.push(["citations", `Rules ${answer.citations?.length ?? 0}`]);
  tabs.push(["trace", "How it was answered"]);

  const checks = ["No model in the arithmetic", "Year matched", "Personal details removed"];
  if (answer.verify?.checked_numbers) checks.unshift(`${answer.verify.checked_numbers} figures traced`);

  return (
    <div className="fade-up flex flex-col gap-4">
      <QuestionHeader question={question} tags={tagsFor(answer)} />

      <GuardrailBanner
        badge={answer.badge}
        ya={answer.ya}
        stepCount={c?.step_count}
        verify={answer.verify}
        checks={checks}
      />

      <Headline answer={answer} onSource={passageCount ? goToSource : undefined} />

      <div className="-mt-1 flex justify-end">
        <ReadAloudButton text={spokenAnswer(answer)} />
      </div>

      {/* Tabs. Six will not fit a phone, so the strip scrolls sideways rather
          than squeezing each label. */}
      <div
        role="tablist"
        aria-label="Answer details"
        className="-mx-1 mt-2 flex gap-1 overflow-x-auto border-b border-line px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px flex-none whitespace-nowrap border-b-2 px-3 py-2.5 text-[14px] transition-colors ${
              tab === key
                ? "border-ink-900 font-medium text-ink-900"
                : "border-transparent text-ink-400 hover:text-ink-900"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
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

        {tab === "savings" && answer.savings && (
          <SavingsPanel savings={answer.savings} onRuleClick={handleRuleClick} />
        )}

        {tab === "comparison" && answer.compare && <CompareTable compare={answer.compare} />}

        {tab === "explanation" && (
          <div className="px-1">
            {answer.explanation ? (
              <>
                <p className="text-[16px] leading-[1.75] text-ink-700">
                  <ProseWithSources
                    text={answer.explanation}
                    passages={answer.passages ?? []}
                    onSource={passageCount ? goToSource : undefined}
                  />
                </p>
                <p className="mt-4 text-[13px] leading-[1.55] text-ink-400">
                  Every figure and date here was checked against the law text
                  and the ledger before it was shown.
                  {answer.verify?.checked_numbers ? ` ${answer.verify.checked_numbers} checked, all traced.` : ""}
                </p>
              </>
            ) : (
              <>
                <p className="max-w-[62ch] text-[15px] leading-[1.65] text-ink-700">
                  {answer.verify?.note ?? "The written explanation was not released."}
                </p>
                {answer.verify?.unmatched_numbers?.length ? (
                  <p className="tnum mt-2 text-[13px] text-[#6b4a0b]">
                    Could not trace: {answer.verify.unmatched_numbers.join(", ")}
                  </p>
                ) : null}
                <p className="mt-3 max-w-[62ch] text-[13px] leading-[1.55] text-ink-400">
                  The figures are unaffected. They come from the rules table, not
                  from a language model, so they stand on their own.
                </p>
              </>
            )}
          </div>
        )}

        {tab === "sources" && answer.passages && (
          <SourcesList passages={answer.passages} highlight={sourceHighlight} />
        )}

        {tab === "citations" && (
          <CitationsPanel citations={answer.citations ?? []} ya={answer.ya} highlightRuleKey={highlight} />
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
      </div>
    </div>
  );
}

/* ---------- headline, one per intent ---------- */

/** A small label above a headline figure, in sentence case. */
function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] font-medium text-ink-400">{children}</div>;
}

/** The quiet panel beside a headline: a few facts, one per row. */
function SidePanel({ rows }: { rows: Array<[string, React.ReactNode, string?]> }) {
  return (
    <dl className="w-full flex-none divide-y divide-line rounded-lg bg-panel px-4 @2xl:w-[250px]">
      {rows.map(([k, v, note]) => (
        <div key={k} className="py-3">
          <dt className="text-[12.5px] text-ink-400">{k}</dt>
          <dd className="tnum mt-0.5 text-[16px] font-semibold text-ink-900">{v}</dd>
          {note && <dd className="mt-0.5 text-[12.5px] leading-[1.45] text-ink-400">{note}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Headline({ answer, onSource }: { answer: AnswerResponse; onSource?: (n: number) => void }) {
  const { intent, computation: c, compliance, compare, lookup, ya } = answer;

  if ((intent === "compute" || (intent === "obligation" && c)) && c) {
    const balance = c.balance_payable;
    const negative = balance.startsWith("-");
    const rows: Array<[string, React.ReactNode, string?]> = [
      ["Effective rate", rate(c.gross_tax, c.steps[0]?.value), `of LKR ${money(c.steps[0]?.value ?? "0")} assessable income`],
      ["Rate on taxable income", rate(c.gross_tax, c.taxable_income), `LKR ${money(c.taxable_income)} after relief`],
    ];
    if (compliance?.return_due) {
      rows.push([
        compliance.must_file ? "Return due" : "Filing",
        compliance.must_file ? formatDate(compliance.return_due) : "Not required",
        compliance.days_remaining != null && compliance.days_remaining >= 0 && compliance.must_file
          ? `${compliance.days_remaining} days from today`
          : undefined,
      ]);
    }
    return (
      <div className="@container rounded-xl border border-line bg-white p-5 sm:p-6">
        <div className="flex flex-col items-start justify-between gap-5 @2xl:flex-row @2xl:gap-8">
          <div className="min-w-0 flex-1">
            <Label>
              {intent === "obligation" ? "Filing obligation" : negative ? "Refund due" : "Balance payable"}, year of assessment {ya}
            </Label>
            {intent === "obligation" && compliance ? (
              <>
                <div aria-live="polite" className="mt-2 text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900 @2xl:text-[38px]">
                  {compliance.must_file ? "You must file a return" : "No return required"}
                </div>
                <p className="mt-3 max-w-[56ch] text-[15px] leading-[1.6] text-ink-500">{compliance.reason}</p>
              </>
            ) : (
              <>
                {/* A figure must never break mid-number: "57,6 / 00" reads as
                    a different amount. */}
                <div aria-live="polite" className="mt-2 flex flex-wrap items-baseline gap-x-2 leading-none text-ink-900">
                  <span className="text-[22px] font-medium text-ink-300 @2xl:text-[28px]">LKR</span>
                  <span className="tnum whitespace-nowrap text-[40px] font-semibold tracking-[-0.03em] @2xl:text-[54px]">
                    {money(negative ? balance.slice(1) : balance)}
                  </span>
                </div>
                <p className="mt-4 max-w-[56ch] text-[15px] leading-[1.6] text-ink-500">
                  Worked out in {c.step_count} steps, each traced to a rule in force for {ya}.
                </p>
              </>
            )}
          </div>
          <SidePanel rows={rows} />
        </div>
        {compliance && compliance.instalments.length > 0 && (
          <p className="tnum mt-5 border-t border-line pt-4 text-[13.5px] text-ink-500">
            Quarterly instalments: {compliance.instalments.map(formatDate).join(", ")}
          </p>
        )}
      </div>
    );
  }

  if (intent === "deadline" && compliance) {
    const days = compliance.days_remaining;
    return (
      <div className="@container rounded-xl border border-line bg-white p-5 sm:p-6">
        <div className="flex flex-col items-start justify-between gap-5 @2xl:flex-row @2xl:gap-8">
          <div className="min-w-0 flex-1">
            <Label>Return due, year of assessment {ya}</Label>
            <div aria-live="polite" className="tnum mt-2 whitespace-nowrap text-[36px] font-semibold leading-none tracking-[-0.03em] text-ink-900 @2xl:text-[50px]">
              {formatDate(compliance.return_due)}
            </div>
            <p className="mt-4 max-w-[56ch] text-[15px] leading-[1.6] text-ink-500">
              {days != null && days >= 0
                ? <><strong className="font-semibold text-ink-900">{days} days</strong> from today.</>
                : days != null
                  ? <>This date passed <strong className="font-semibold text-ink-900">{Math.abs(days)} days</strong> ago.</>
                  : null}{" "}
              Set by <span className="statute italic">{compliance.citation_label}</span>.
            </p>
          </div>
          {compliance.instalments.length > 0 && (
            <div className="w-full flex-none rounded-lg bg-panel px-4 py-3 @2xl:w-[250px]">
              <div className="text-[12.5px] text-ink-400">Quarterly instalments</div>
              <ol className="mt-2 flex flex-col gap-1.5">
                {compliance.instalments.map((d, i) => {
                  const past = new Date(`${d}T00:00:00`) < new Date();
                  return (
                    <li key={d} className="tnum flex items-center justify-between text-[14px]">
                      <span className={past ? "text-ink-300" : "text-ink-500"}>Quarter {i + 1}</span>
                      <span className={past ? "text-ink-300 line-through" : "font-medium text-ink-900"}>{formatDate(d)}</span>
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
      <div className="rounded-xl border border-line bg-white p-5 sm:p-6">
        <Label>What changed from {compare.from_ya} to {compare.to_ya}</Label>
        <div aria-live="polite" className="mt-2 text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900 sm:text-[38px]">
          {compare.changed_count === 0 ? "Nothing changed" : `${compare.changed_count} of ${compare.changes.length} rules changed`}
        </div>
        <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.6] text-ink-500">
          Compared rule by rule, using the rules as of {answer.snapshot?.label}.
          {compare.changed_count > 0 && (
            <> Changed: {compare.changes.filter((x) => x.changed).map((x) => x.title ?? x.rule_key).join(", ")}.</>
          )}
          {compare.changed_count === 1 && compare.changes.some((x) => x.changed && x.rule_key.startsWith("deadline.")) && (
            <> Rates, bands and relief are one version serving both years; only the filing dates move.</>
          )}
        </p>
      </div>
    );
  }

  if ((intent === "rule_lookup" || intent === "general") && lookup && lookup.length) {
    const first = lookup[0];
    return (
      <div className="rounded-xl border border-line bg-white p-5 sm:p-6">
        <Label>{first.label ?? first.rule_key}, in force for {ya}</Label>
        <div aria-live="polite" className="tnum mt-2 text-[32px] font-semibold leading-tight tracking-[-0.03em] text-ink-900 sm:text-[42px]">
          {describeValue(first.value ?? {}, "headline")}
        </div>
        <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.6] text-ink-500">
          In force from <strong className="font-semibold text-ink-900">{formatDate(first.effective_from)}</strong>
          {first.effective_to ? <> to <strong className="font-semibold text-ink-900">{formatDate(first.effective_to)}</strong></> : ", with no end date"}.
          {first.revision_no > 1 && <> Revision {first.revision_no}.</>}
        </p>
        {first.quoted_text && (
          <blockquote className="statute mt-4 max-w-[68ch] rounded-lg bg-panel px-4 py-3 text-[15px] italic text-ink-700">
            &ldquo;{first.quoted_text}&rdquo;
          </blockquote>
        )}
      </div>
    );
  }

  // General with no lookup: the prose is the headline.
  return (
    <div className="px-1">
      <p className="text-[17px] leading-[1.7] text-ink-900">
        {answer.explanation ? (
          <ProseWithSources text={answer.explanation} passages={answer.passages ?? []} onSource={onSource} />
        ) : (
          answer.verify?.note ?? "The explanation was withheld."
        )}
      </p>
      <p className="mt-3 text-[13px] leading-[1.55] text-ink-400">
        Written from the law text and the sources below, and checked figure by
        figure before it was shown.
      </p>
    </div>
  );
}

/* ---------- comparison ---------- */

export function CompareTable({ compare }: { compare: NonNullable<AnswerResponse["compare"]> }) {
  const changed = compare.changes.filter((c) => c.changed);
  const same = compare.changes.filter((c) => !c.changed);
  return (
    <div className="flex flex-col gap-3">
      {changed.map((ch) => <CompareRow key={ch.rule_key} change={ch} from={compare.from_ya} to={compare.to_ya} />)}
      {same.length > 0 && (
        <div className="rounded-xl border border-line bg-white px-5 py-4">
          <div className="text-[14px] font-medium text-ink-900">
            Unchanged <span className="font-normal text-ink-400">{same.length} rules</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {same.map((ch) => (
              <span key={ch.rule_key} className="rounded-md bg-muted px-2 py-1 text-[13px] text-ink-700" title={ch.to.citation_label ?? ""}>
                {ch.title ?? ch.rule_key}
              </span>
            ))}
          </div>
          <p className="mt-3 text-[13px] leading-[1.5] text-ink-400">
            The same version of each of these is in force for both years.
          </p>
        </div>
      )}
    </div>
  );
}

function CompareRow({ change, from, to }: { change: CompareChange; from: string; to: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <span className="text-[15px] font-semibold text-ink-900">{change.title ?? change.rule_key}</span>
        <span className="rounded-md bg-brand-100 px-2 py-0.5 text-[12.5px] font-medium text-brand-700">Changed</span>
      </div>
      <div className="grid sm:grid-cols-2 sm:divide-x sm:divide-line">
        <Side ya={from} side={change.from} tone="old" />
        <Side ya={to} side={change.to} tone="new" />
      </div>
    </div>
  );
}

function Side({ ya, side, tone }: { ya: string; side: RuleSide; tone: "old" | "new" }) {
  return (
    <div className={`px-5 py-4 ${tone === "old" ? "bg-panel" : "bg-white"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-[13px] font-medium text-ink-400">{ya}</span>
        <span className="statute text-[13px] italic text-ink-500">{side.citation_label}</span>
      </div>
      <div className={`tnum mt-2 whitespace-pre-line text-[15px] leading-[1.55] ${tone === "new" ? "font-semibold text-ink-900" : "text-ink-500"}`}>
        {describeValue(side.value, "full")}
      </div>
      {side.effective_from && (
        <div className="tnum mt-2 text-[12.5px] text-ink-400">
          From {formatDate(side.effective_from)}{side.effective_to ? ` to ${formatDate(side.effective_to)}` : ""}
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
      .map((b) => `${b.upto == null ? "Above" : `Up to ${Number(b.upto).toLocaleString()}`} at ${percent(b.rate)}`)
      .join("\n");
  }
  if (typeof value.amount === "string") return `LKR ${money(value.amount)}`;
  if (typeof value.due === "string") {
    const s = `Due ${formatDate(value.due)}`;
    if (mode === "full" && Array.isArray(value.instalments)) {
      return `${s}\nInstalments ${(value.instalments as string[]).map(formatDate).join(", ")}`;
    }
    return s;
  }
  if (typeof value.employee_rate === "string") return percent(value.employee_rate);
  if ("annual_cap" in value) return value.annual_cap == null ? "No cap" : `Capped at LKR ${money(String(value.annual_cap))}`;
  if ("allowed" in value) return value.allowed ? "Credit allowed" : "No credit";
  if (Array.isArray(value.includes)) return (value.includes as string[]).join(", ");
  if (typeof value.formula === "string") return value.formula;
  return Object.entries(value).filter(([k]) => k !== "citation_label").map(([k, v]) => `${k}: ${String(v)}`).join(", ");
}

/** The question, as asked, with what Citetax took from it. */
function QuestionHeader({ question, tags }: { question: string; tags?: string[] }) {
  return (
    <div className="flex items-start gap-3">
      <UserAvatar size={28} />
      <div className="min-w-0 flex-1 pt-[2px]">
        <p className="text-[19px] font-medium leading-[1.4] tracking-[-0.01em] text-ink-900">{question}</p>
        {tags && tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((t, i) => (
              <span
                key={t}
                className={`tnum rounded-md px-2 py-0.5 text-[12.5px] ${
                  i === 0 ? "bg-brand-050 font-medium text-brand-700" : "bg-muted text-ink-500"
                }`}
              >
                {t}
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
        aria-label="Your answer"
        autoFocus
        className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-white px-3 text-[15px] text-ink-900 outline-none focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-600/15"
      />
      <Button type="submit" className="h-10 px-4" disabled={!value.trim()}>
        Send
      </Button>
    </form>
  );
}

function tagsFor(answer: AnswerResponse): string[] {
  const tags: string[] = [INTENT_LABEL[answer.intent] ?? answer.intent];
  if (answer.ya) tags.push(answer.ya);
  const steps = answer.computation?.steps ?? [];
  const assessable = steps.find((s) => s.rule_key === "income.assessable");
  if (assessable && !assessable.is_zero) tags.push(`Income LKR ${money(assessable.value)}`);
  const epf = steps.find((s) => s.rule_key === "deduction.epf_employee");
  if (epf && !epf.is_zero) tags.push(`EPF LKR ${money(epf.value)}`);
  const apit = steps.find((s) => s.rule_key === "credit.apit");
  if (apit && !apit.is_zero) tags.push(`APIT LKR ${money(apit.value)}`);
  return tags;
}

/** A display-only ratio. Never feeds a computation, so float is fine here. */
function rate(numerator: string, denominator: string | undefined): string {
  if (!denominator) return "-";
  const d = Number(denominator);
  const n = Number(numerator);
  if (!d || Number.isNaN(d) || Number.isNaN(n)) return "0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}
