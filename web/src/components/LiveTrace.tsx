"use client";

/**
 * The agent's progress while a question runs, inline under the question.
 *
 * Each line is a step the backend has actually finished, pushed by
 * /v1/ask/stream the moment it happens; the last line is the step running
 * now. Steps that have not started are not drawn, so the block grows as the
 * run does instead of reserving space for a plan that may not happen. The
 * full trace, with every node of the plan, stays in the answer's Agent trace
 * tab.
 */

import { useEffect, useState } from "react";
import type { StreamStep } from "@/lib/api";
import { PHASE_DOT, PHASE_RING } from "./AgentTrace";

// Every plan starts with these two; Route supplies the rest.
const OPENING = ["Intake", "Route"];

const DOING: Record<string, string> = {
  Intake: "Stripping identifiers",
  Route: "Reading the question and choosing a plan",
  Resolve: "Finding the rules in force",
  Compute: "Computing the figures",
  Comply: "Checking filing obligations and deadlines",
  Compare: "Comparing the two years",
  Retrieve: "Searching the law text",
  Explain: "Writing the explanation",
  Verify: "Checking every figure against a rule",
};

const STATUS_DOT: Partial<Record<StreamStep["status"], string>> = {
  skipped: "bg-ink-200",
  refused: "bg-[#B07A16]",
  failed: "bg-warn-600",
};

interface Props {
  steps: StreamStep[];
  plan: string[] | null;
}

export function LiveTrace({ steps, plan }: Props) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  const nodes = plan ?? OPENING;
  // A node can report twice (Route on clarify); the latest report stands.
  const done = new Map<string, StreamStep>();
  steps.forEach((s) => done.set(s.node, s));
  const current = nodes.find((n) => !done.has(n)) ?? null;
  const finished = nodes.filter((n) => done.has(n));

  return (
    <div className="mt-3 px-1" aria-live="polite">
      <div className="flex items-center gap-2 font-mono text-[10.5px] text-ink-300">
        <span className="eyebrow">WORKING</span>
        <span className="tnum">
          {((now - started) / 1000).toFixed(1)}s
          {plan ? ` · step ${Math.min(finished.length + 1, plan.length)} of ${plan.length}` : ""}
        </span>
      </div>

      <ol className="mt-2 flex flex-col gap-[5px]">
        {finished.map((node) => {
          const s = done.get(node)!;
          return (
            <li key={node} className="fade-up flex items-baseline gap-[9px] text-[12.5px] leading-[1.45]">
              <span
                className={`relative top-[1px] h-[9px] w-[9px] flex-none rounded-full ${
                  STATUS_DOT[s.status] ?? PHASE_DOT[node] ?? "bg-good-mint"
                }`}
              />
              <span className="font-medium text-ink-700">{node}</span>
              {s.detail && <span className="min-w-0 truncate text-ink-400">{s.detail}</span>}
              {s.ms > 0 && (
                <span className="tnum ml-auto flex-none font-mono text-[10px] text-ink-200">
                  {s.ms < 1000 ? `${s.ms}ms` : `${(s.ms / 1000).toFixed(1)}s`}
                </span>
              )}
            </li>
          );
        })}

        {current && (
          <li key={`${current}-now`} className="flex items-baseline gap-[9px] text-[12.5px] leading-[1.45]">
            <span
              className={`relative top-[1px] h-[9px] w-[9px] flex-none rounded-full ${PHASE_DOT[current] ?? "bg-brand-600"}`}
            >
              <span
                className={`absolute -inset-[3px] rounded-full pulse-dot ${PHASE_RING[current] ?? "bg-brand-600/30"}`}
              />
            </span>
            <span className="font-medium text-brand-600">{DOING[current] ?? current}...</span>
          </li>
        )}
      </ol>
    </div>
  );
}
