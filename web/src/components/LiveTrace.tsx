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
import { PHASE_DOT, PHASE_GLOW, PHASE_RING } from "./AgentTrace";

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
      <div className="inline-flex items-center gap-[7px] rounded-full bg-brand-050 py-[5px] pl-[9px] pr-3 shadow-[0_0_14px_rgba(43,68,199,0.18)]">
        <span className="relative flex h-[6px] w-[6px] flex-none">
          <span className="absolute inset-0 rounded-full bg-brand-600/40 pulse-dot" />
          <span className="absolute inset-[1.5px] rounded-full bg-brand-600 shadow-[0_0_6px_var(--color-brand-600)]" />
        </span>
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-brand-600">
          Working
        </span>
        <span className="tnum font-mono text-[10.5px] text-brand-600/70">
          {((now - started) / 1000).toFixed(1)}s
          {plan ? ` · step ${Math.min(finished.length + 1, plan.length)} of ${plan.length}` : ""}
        </span>
      </div>

      <ol className="mt-[10px] flex flex-col">
        {finished.map((node, i) => {
          const s = done.get(node)!;
          const isLast = i === finished.length - 1 && !current;
          return (
            <li key={node} className="fade-up flex gap-[9px]">
              <div className="flex w-[9px] flex-none flex-col items-center">
                <span
                  className={`relative mt-[3px] h-[9px] w-[9px] flex-none rounded-full ${
                    STATUS_DOT[s.status] ?? PHASE_DOT[node] ?? "bg-good-mint"
                  } ${STATUS_DOT[s.status] ? "" : (PHASE_GLOW[node] ?? PHASE_GLOW.Intake)}`}
                />
                {!isLast && (
                  <span
                    className="w-px flex-1 rounded-full bg-brand-600/25 shadow-[0_0_4px_var(--color-brand-600)]"
                    style={{ minHeight: "10px" }}
                  />
                )}
              </div>
              <div className="flex min-w-0 flex-1 items-baseline gap-[9px] pb-[9px] text-[12.5px] leading-[1.45]">
                <span className="flex-none font-medium text-ink-700">{node}</span>
                {s.detail && <span className="min-w-0 truncate text-ink-400">{s.detail}</span>}
                {s.ms > 0 && (
                  <span className="tnum ml-auto flex-none font-mono text-[10px] text-ink-200">
                    {s.ms < 1000 ? `${s.ms}ms` : `${(s.ms / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>
            </li>
          );
        })}

        {current && (
          <li key={`${current}-now`} className="flex gap-[9px]">
            <div className="flex w-[9px] flex-none flex-col items-center">
              <span
                className={`relative mt-[3px] h-[9px] w-[9px] flex-none rounded-full ${PHASE_DOT[current] ?? "bg-brand-600"} ${
                  PHASE_GLOW[current] ?? PHASE_GLOW.Intake
                }`}
              >
                <span
                  className={`absolute -inset-[4px] rounded-full pulse-dot ${PHASE_RING[current] ?? "bg-brand-600/30"}`}
                />
              </span>
            </div>
            <div className="flex items-baseline gap-[3px] pb-[9px] text-[12.5px] leading-[1.45]">
              <span className="font-medium text-brand-600">{DOING[current] ?? current}</span>
              <span className="flex items-center gap-[2px]" aria-hidden="true">
                <span className="thinking-dot h-[3px] w-[3px] rounded-full bg-brand-600" style={{ animationDelay: "0ms" }} />
                <span className="thinking-dot h-[3px] w-[3px] rounded-full bg-brand-600" style={{ animationDelay: "180ms" }} />
                <span className="thinking-dot h-[3px] w-[3px] rounded-full bg-brand-600" style={{ animationDelay: "360ms" }} />
              </span>
            </div>
          </li>
        )}
      </ol>
    </div>
  );
}
