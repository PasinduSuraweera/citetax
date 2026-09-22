"use client";

/**
 * The plan the agent chose, and what happened when it ran it.
 *
 * Shown, not summarised (spec section 9, "Nothing hidden"). The node list comes
 * from the response, because the planner picks a different path for a deadline
 * question than for a computation. While a question is running, the timeline
 * shows the generic full path filling in.
 *
 * The backend answers atomically — there is no real per-step signal while a
 * question is in flight, only the full trace once it lands. Rather than leave
 * the first step lit for the entire wait (which reads as stuck, not working),
 * the loading state walks a synthetic index down the plan on a timer. It is
 * honest about being a guess: a stepped-past node gets a plain filled dot, not
 * the checkmark a real "ok" status gets once the answer actually arrives.
 */

import { useEffect, useState } from "react";
import type { TraceEntry } from "@/lib/api";

const FULL_PATH = [
  "Intake", "Route", "Resolve", "Compute", "Comply", "Retrieve", "Explain", "Verify",
];

const BLURB: Record<string, string> = {
  Intake: "Strips identifiers before anything leaves the machine",
  Route: "The model reads the question, picks the intent and the plan",
  Resolve: "Picks the rule in force, deterministically, by year and date",
  Compute: "Plain Python. No model in the arithmetic",
  Comply: "Filing obligation, deadlines, instalments",
  Compare: "Diffs the two years rule by rule",
  Retrieve: "Finds law text for the explanation only",
  Explain: "Writes prose constrained to the material it was given",
  Verify: "Checks every figure against a rule before release",
};

const DOT: Record<TraceEntry["status"], string> = {
  ok: "bg-good-mint",
  skipped: "bg-ink-200",
  refused: "bg-[#B07A16]",
  failed: "bg-warn-600",
  planned: "bg-[#DFE5F2]",
};

const LINE_LIT = "bg-brand-600";
const LINE_DIM = "bg-line";

interface Props {
  trace: TraceEntry[];
  plan?: string[];
  intent?: string;
  routeSource?: string;
  running?: boolean;
  latencyMs?: number;
  tokens?: number;
}

export function AgentTrace({ trace, plan, intent, routeSource, running, latencyMs, tokens }: Props) {
  const nodes = plan && plan.length ? plan : FULL_PATH;
  // A node may appear more than once (Route can mark twice on clarify); the
  // last entry for a node is the one that stands.
  const byNode = new Map<string, TraceEntry>();
  trace.forEach((t) => byNode.set(t.node, t));
  const hasRealProgress = trace.length > 0;

  // No reset-on-transition needed: the loading trace and the completed trace
  // are different mounted instances in the parent (a "busy" block swaps for
  // an "answer" block), so a fresh mount already starts this at 0.
  const [simIndex, setSimIndex] = useState(0);
  useEffect(() => {
    if (!running || hasRealProgress) return;
    const id = setInterval(() => {
      setSimIndex((i) => (i + 1 < nodes.length ? i + 1 : i));
    }, 850);
    return () => clearInterval(id);
  }, [running, hasRealProgress, nodes.length]);

  return (
    <div className="rounded-xl border border-line bg-white px-4 pb-4 pt-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">AGENT TRACE</span>
        {!running && latencyMs != null && (
          <span className="tnum font-mono text-[10.5px] text-ink-300">
            {(latencyMs / 1000).toFixed(1)}s
            {tokens ? ` · ${tokens.toLocaleString()} tokens` : ""}
          </span>
        )}
      </div>

      {intent && !running && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-brand-100 px-2 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-brand-600">
            {intent.replace("_", " ")}
          </span>
          <span className="font-mono text-[10.5px] text-ink-300">
            {nodes.length} node plan
            {routeSource === "regex" ? ", model unavailable, deterministic route" : ""}
          </span>
        </div>
      )}

      <ol className="mt-[15px] flex flex-col">
        {nodes.map((node, i) => {
          const entry = byNode.get(node);
          const simDone = !hasRealProgress && running && i < simIndex;
          const simActive = !hasRealProgress && running && i === simIndex;
          const done = Boolean(entry) || simDone;
          const active = simActive;
          const pending = !done && !active;

          const dotClass = entry
            ? DOT[entry.status]
            : active
              ? "bg-brand-600"
              : simDone
                ? "bg-ink-700"
                : "bg-line-strong";

          return (
            <li key={`${node}-${i}`} className="flex gap-[11px]">
              <div className="flex w-[11px] flex-none flex-col items-center">
                <span
                  className={`relative mt-[3px] h-[11px] w-[11px] flex-none rounded-full transition-colors duration-300 ${dotClass}`}
                >
                  {entry?.status === "ok" && (
                    <svg
                      className="absolute inset-0 h-full w-full text-white"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 6.2l2 2 4-4.4" />
                    </svg>
                  )}
                  {active && (
                    <span className="absolute -inset-[3px] rounded-full bg-brand-600/30 pulse-dot" />
                  )}
                </span>
                {i < nodes.length - 1 && (
                  <span
                    className={`w-[2px] flex-1 rounded-full transition-colors duration-300 ${
                      done ? LINE_LIT : LINE_DIM
                    }`}
                  />
                )}
              </div>

              <div className={`pb-[13px] transition-opacity duration-300 ${pending ? "opacity-40" : ""}`}>
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-[13px] ${
                      entry ? "font-medium text-ink-900" : active ? "font-medium text-brand-600" : "text-ink-400"
                    }`}
                  >
                    {node}
                  </span>
                  {entry && entry.status !== "ok" && (
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-300">
                      {entry.status}
                    </span>
                  )}
                  {entry && entry.ms > 0 && (
                    <span className="tnum font-mono text-[9.5px] text-ink-200">
                      {entry.ms < 1000 ? `${entry.ms}ms` : `${(entry.ms / 1000).toFixed(1)}s`}
                    </span>
                  )}
                </div>
                <div className="mt-[2px] text-[11.5px] leading-[1.45] text-ink-400">
                  {entry?.detail ?? BLURB[node] ?? ""}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-1 rounded-lg bg-panel px-3 py-[10px] text-[11.5px] leading-[1.5] text-ink-400">
        The plan changes with the question. The two things that do not: numbers
        come from the rules table, never the model, and every figure in the
        prose is checked before release.
      </div>
    </div>
  );
}
