/**
 * The worked example shown on the homepage and the sign-in screen.
 *
 * Computed by the engine when the page renders, never typed in, so what it
 * shows is exactly what the chat would answer. Null when the API cannot be
 * reached, and the pages then leave the example out.
 */

import { API_BASE, API_HEADERS, type ComputeResponse, type Snapshot } from "./api";
import STARTERS_SAVED from "./starter-answers.json";

export const SAMPLE_MONTHLY = "250000";
export const SAMPLE_YA = "2026/2027";

export async function sampleLedger(): Promise<ComputeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/compute`, {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ ya: SAMPLE_YA, employment_income: String(Number(SAMPLE_MONTHLY) * 12) }),
      next: { revalidate: 3600 },
    });
    return res.ok ? ((await res.json()) as ComputeResponse) : null;
  } catch {
    return null;
  }
}

export async function currentSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/snapshot/current`, { headers: API_HEADERS, next: { revalidate: 3600 } });
    return res.ok ? ((await res.json()) as Snapshot) : null;
  } catch {
    return null;
  }
}

/**
 * The starter questions with the answer the engine gives each one now. The
 * facts are the ones the question states, so the figure beside a question is
 * what asking it returns. When the API cannot be reached, the engine's saved
 * answer to the same facts is used, never a figure typed in.
 */
export interface Starter {
  key: StarterKey;
  question: string;
  facts: Record<string, string>;
  /** "LKR 396,000 to pay", "No return required"; null when not computed. */
  answer: string | null;
  detail: string | null;
  /** The engine's own result, for the page to show lines from. */
  computation: ComputeResponse | null;
}

// One scenario each, so no figure is reused across the page. Each question
// is worded so the chat reads it as these facts (checked live).
export type StarterKey = "salary" | "abroad" | "side";

const STARTERS: Array<Pick<Starter, "question" | "facts"> & { key: StarterKey }> = [
  {
    key: "salary",
    question: "I work at a bank on a salary of LKR 275,000 a month. Do I need to file a return for 2026/2027?",
    facts: { employment_income: "3300000" },
  },
  {
    key: "abroad",
    question: "I design for clients abroad and earn LKR 4,800,000 a year, paid in USD. What is my tax for 2026/2027?",
    facts: { foreign_service_income: "4800000" },
  },
  {
    key: "side",
    question: "I lecture on LKR 180,000 a month and earn LKR 900,000 a year from private tuition. What do I owe for 2026/2027?",
    facts: { employment_income: "2160000", business_income: "900000" },
  },
];

async function liveStarter(facts: Record<string, string>): Promise<ComputeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/compute`, {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ ya: SAMPLE_YA, ...facts }),
      next: { revalidate: 3600 },
    });
    return res.ok ? ((await res.json()) as ComputeResponse) : null;
  } catch {
    return null;
  }
}

export async function starterAnswers(): Promise<Starter[]> {
  return Promise.all(
    STARTERS.map(async ({ key, question, facts }) => {
      // Live when the API answers; otherwise the engine's own answer to the
      // same facts, saved in starter-answers.json on the date it carries.
      const c = (await liveStarter(facts)) ?? (STARTERS_SAVED.answers[key] as unknown as ComputeResponse);
      const balance = Number(c.balance_payable);
      if (c.compliance && !c.compliance.must_file) {
        return { key, question, facts, answer: "No return required", detail: "Your employer's APIT covers the tax", computation: c };
      }
      const apit = c.steps.find((s) => s.rule_key === "credit.apit" && !s.is_zero);
      return {
        key,
        question,
        facts,
        answer: balance > 0 ? `LKR ${Math.round(balance).toLocaleString("en-GB")} to pay` : "Nothing to pay",
        detail: apit
          ? `After LKR ${Math.round(Number(apit.value)).toLocaleString("en-GB")} of APIT from the salary`
          : `Tax for the year, worked out in ${c.steps.length} steps`,
        computation: c,
      };
    }),
  );
}

export async function planSummary(): Promise<Array<{ key: string; name: string; price_lkr: number; price_unit: string; monthly_questions: number | null }> | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/plans`, { headers: API_HEADERS, next: { revalidate: 300 } });
    return res.ok ? ((await res.json()).plans as never) : null;
  } catch {
    return null;
  }
}

/** The hero's scenario, used nowhere else: a doctor with a hospital salary
 *  and private channelling fees. Computed by the engine at render, so the
 *  animation always shows the answer the chat would give today. When the API
 *  cannot be reached, the page uses hero-answer.json: the engine's output for
 *  the same question, saved on the date it carries. */
export const HERO_QUESTION =
  "Hospital salary of LKR 350,000 a month, plus LKR 2,400,000 a year from private channelling. What do I owe for 2026/2027?";

export async function heroAnswer(): Promise<ComputeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/compute`, {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ ya: SAMPLE_YA, employment_income: "4200000", business_income: "2400000" }),
      next: { revalidate: 3600 },
    });
    return res.ok ? ((await res.json()) as ComputeResponse) : null;
  } catch {
    return null;
  }
}
