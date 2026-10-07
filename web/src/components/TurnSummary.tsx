"use client";

/**
 * An earlier turn of a conversation, collapsed to one line, and the note that
 * stamps every stored answer with the snapshot it ran against.
 *
 * A collapsed turn shows what was asked and the headline of what came back.
 * Expanding it shows the stored answer in the same AnswerView as a fresh one;
 * nothing is computed again to do that.
 */

import { ChevronDown, ChevronUp, History } from "lucide-react";
import type { AnswerResponse, ConversationTurn } from "@/lib/api";
import { formatDate, money } from "@/lib/api";
import { UserAvatar } from "./UserAvatar";

export const INTENT_LABEL: Record<string, string> = {
  compute: "Tax worked out",
  obligation: "Filing obligation",
  deadline: "Deadline",
  compare: "Comparison",
  rule_lookup: "Rule",
  general: "Explanation",
  out_of_scope: "Declined",
  // A greeting or thanks needs no label; an empty one is filtered out.
  conversation: "",
};

function headline(answer: AnswerResponse | undefined): string | null {
  if (!answer) return null;
  if (answer.kind === "refusal") return "Declined";
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
    answer ? (INTENT_LABEL[answer.intent] ?? answer.intent) : "No reply saved",
    answer?.ya ?? null,
    answer?.snapshot_is_current === false ? "The law has changed since" : null,
  ].filter(Boolean) as string[];

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      className="group flex w-full items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-panel"
    >
      <UserAvatar size={24} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] text-ink-900">{turn.question.content}</span>
        <span className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-ink-400">
          {meta.map((m) => <span key={m}>{m}</span>)}
        </span>
      </span>
      {figure && (
        <span className="tnum hidden flex-none text-[14px] font-medium text-ink-900 sm:inline">{figure}</span>
      )}
      <ChevronDown className="size-4 flex-none text-ink-300 transition-colors group-hover:text-ink-700" aria-label="Show answer" />
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
        day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : null;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] ${
        stale ? "rounded-lg bg-[#fdf4e0] px-3.5 py-2.5 text-[#6b4a0b]" : "px-1 text-ink-400"
      }`}
    >
      <span className="flex items-center gap-1.5">
        <History className="size-3.5" />
        {answer.snapshot?.label ? `Rules as of ${answer.snapshot.label}` : "Answered"}
        {when ? `, answered ${when}` : ""}
      </span>
      {stale && <span>The law has changed since. This answer is kept as it was given.</span>}
      {stale && answer.reaskable && onReask && (
        <button
          type="button"
          onClick={onReask}
          disabled={busy}
          className="rounded-md bg-white px-2.5 py-1 text-[13px] font-medium text-[#6b4a0b] ring-1 ring-[#a26b0e]/30 transition-colors hover:ring-[#a26b0e] disabled:opacity-50"
        >
          Ask again with the current rules
        </button>
      )}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          className="ml-auto flex items-center gap-1 rounded px-1 text-[13px] text-ink-400 hover:text-ink-900"
        >
          Collapse
          <ChevronUp className="size-3.5" />
        </button>
      )}
    </div>
  );
}
