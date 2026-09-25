import type { AnswerResponse } from "./api";
import { formatDate, money } from "./api";

/** Prose as it is spoken: no citation markers, no markdown, money as rupees. */
export function toSpeech(text: string): string {
  return text
    .replace(/\s?\(?\[(?:\d{1,2}|[a-z_]+(?:\.[a-z_]+)+)\]\)?/gi, "")
    .replace(/[*_`#>]/g, "")
    .replace(/LKR\s*([\d,]+(?:\.\d+)?)/gi, "$1 rupees")
    .replace(/\s+/g, " ")
    .trim();
}

/** What to read for an answer: the headline figure first, then the explanation. */
export function spokenAnswer(answer: AnswerResponse): string {
  if (answer.kind === "refusal") return toSpeech(answer.refusal?.reason ?? "");
  if (answer.kind === "clarify") return toSpeech(answer.clarify?.question ?? "");

  const parts: string[] = [];
  const c = answer.computation;
  if (c && answer.intent === "compute") {
    const bal = c.balance_payable;
    const refund = bal.startsWith("-");
    parts.push(
      `For the year of assessment ${answer.ya}, your ${refund ? "refund due" : "balance payable"} is ` +
        `${money(refund ? bal.slice(1) : bal)} rupees.`,
    );
  } else if (answer.intent === "deadline" && answer.compliance?.return_due) {
    parts.push(`Your return for ${answer.ya} is due on ${formatDate(answer.compliance.return_due)}.`);
  }
  if (answer.explanation) parts.push(toSpeech(answer.explanation));
  return parts.join(" ");
}
