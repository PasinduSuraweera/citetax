"use client";

/**
 * An earlier turn of a conversation, collapsed to one line, and the note that
 * stamps every stored answer with the snapshot it ran against.
 *
 * A collapsed turn shows what was asked and the headline of what came back.
 * Expanding it shows the stored answer in the same AnswerView as a fresh one;
 * nothing is computed again to do that.
 */

import type { AnswerResponse, ConversationTurn } from "@/lib/api";
import { formatDate, money } from "@/lib/api";

const INTENT_LABEL: Record<string, string> = {
  compute: "Computation",
  obligation: "Obligation",
  deadline: "Deadline",
  compare: "Comparison",
  rule_lookup: "Rule lookup",
  general: "Explanation",
  out_of_scope: "Refused",
};

function headline(answer: AnswerResponse | undefined): string | null {
  if (!answer) return null;
  if (answer.kind === "refusal") return "Refused";
  if (answer.kind === "clarify") return "Asked for detail";
  if (answer.computation) {
    const c = answer.computation;
    return c.is_refund
      ? `Refund LKR ${money(c.balance_payable.replace(/^-/, ""))}`
      : `LKR ${money(c.balance_payable)}`;
  }
  if (answer.compare) return `${answer.compare.changed_count} changed`;
  if (answer.intent === "deadline" && answer.compliance?.return_due) {
    return `Due ${formatDate(answer.compliance.return_due)}`;
  }
  return null;
}

export function TurnSummary({ turn, onExpand }: { turn: ConversationTurn; onExpand: () => void }) {
  const answer = turn.reply?.answer;
  const figure = headline(answer);
  const meta = [
    answer ? INTENT_LABEL[answer.intent] ?? answer.intent : "no reply saved",
    answer?.ya ? `Y/A ${answer.ya}` : null,
    answer?.snapshot?.label ? `snapshot ${answer.snapshot.label}` : null,
    answer?.snapshot_is_current === false ? "law since changed" : null,
  ].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      className="group flex w-full items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-left transition-colors hover:border-brand-600/40 hover:bg-panel"
    >
      <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-ink-900 text-[9.5px] font-semibold text-white">
        You
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-ink-900">{turn.question.content}</span>
        <span className="mt-[2px] block truncate font-mono text-[10.5px] text-ink-300">{meta}</span>
      </span>
      {figure && (
        <span className="tnum hidden flex-none font-mono text-[13px] font-medium text-ink-900 sm:inline">
          {figure}
        </span>
      )}
      <span className="flex-none font-mono text-[10.5px] text-ink-300 transition-colors group-hover:text-brand-600">
        Show ▾
      </span>
    </button>
  );
}

/**
 * Which snapshot an answer ran against, and, when the law has moved on, a way
 * to ask again. Asking again adds a new turn with a new run; this one stays.
 */
export function SnapshotNote({
  answer, answeredAt, onReask, busy, onCollapse,
}: {
  answer: AnswerResponse;
  answeredAt: string | null;
  onReask?: () => void;
  busy?: boolean;
  onCollapse?: () => void;
}) {
  const stale = answer.snapshot_is_current === false;
  const when = answeredAt
    ? new Date(answeredAt).toLocaleString("en-GB", {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : null;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 text-[12px] ${
        stale ? "border border-[#E9D3A6] bg-[#FBF4E4] text-[#6B4A0E]" : "text-ink-400"
      }`}
    >
      <span className="font-mono text-[11px]">
        {answer.snapshot?.label ? `Answered at snapshot ${answer.snapshot.label}` : "Answered"}
        {when ? ` · ${when}` : ""}
      </span>
      {stale && <span>The law has changed since. This answer is kept as it was given.</span>}
      {stale && answer.reaskable && onReask && (
        <button
          type="button"
          onClick={onReask}
          disabled={busy}
          className="rounded-md border border-[#B07A16]/40 bg-white px-[10px] py-[5px] text-[12px] font-semibold text-[#6B4A0E] transition-colors hover:border-[#B07A16] disabled:opacity-50"
        >
          Ask again using the current tax rules
        </button>
      )}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          className="ml-auto font-mono text-[10.5px] text-ink-300 hover:text-brand-600"
        >
          Collapse ▴
        </button>
      )}
    </div>
  );
}
