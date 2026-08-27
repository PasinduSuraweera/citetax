"use client";

/**
 * The nine graph nodes as a vertical timeline.
 *
 * Shown, not summarised (spec section 9, "Nothing hidden"). While a question is
 * running the timeline fills in as nodes complete, which turns a six second
 * wait into visible work (spec section 6.2 addition 10).
 */

import type { TraceEntry } from "@/lib/api";

const NODES = [
  "Intake",
  "Scope gate",
  "Clarify",
  "Resolve",
  "Compute",
  "Comply",
  "Retrieve",
  "Explain",
  "Verify",
] as const;

const NODE_BLURB: Record<string, string> = {
  Intake: "Strips identifiers, reads the figures",
  "Scope gate": "Personal income tax, supported year",
  Clarify: "Asks only if a required fact is missing",
  Resolve: "Picks the rule in force, deterministically",
  Compute: "Plain Python, no model in the arithmetic",
  Comply: "Filing obligation, deadlines, instalments",
  Retrieve: "Finds law text for the explanation only",
  Explain: "Writes prose, constrained to the ledger",
  Verify: "Checks every figure against a rule",
};

const DOT: Record<TraceEntry["status"], string> = {
  ok: "bg-good-mint",
  skipped: "bg-ink-200",
  refused: "bg-[#B07A16]",
  failed: "bg-warn-600",
};

interface Props {
  trace: TraceEntry[];
  running?: boolean;
  latencyMs?: number;
}

export function AgentTrace({ trace, running, latencyMs }: Props) {
  const done = new Map(trace.map((t) => [t.node, t]));
  const nextIndex = trace.length;

  return (
    <div className="rounded-xl border border-line bg-white px-4 pb-4 pt-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">AGENT TRACE</span>
        {latencyMs != null && !running && (
          <span className="tnum font-mono text-[10.5px] text-ink-300">
            {(latencyMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      <ol className="mt-[13px] flex flex-col">
        {NODES.map((node, i) => {
          const entry = done.get(node);
          const isNext = running && i === nextIndex;
          const pending = !entry && !isNext;

          return (
            <li key={node} className="flex gap-[10px]">
              <div className="flex w-[9px] flex-none flex-col items-center">
                <span
                  className={`mt-[5px] h-[7px] w-[7px] flex-none rounded-full ${
                    entry
                      ? DOT[entry.status]
                      : isNext
                        ? "bg-brand-600 pulse-dot"
                        : "bg-[#DFE5F2]"
                  }`}
                />
                {i < NODES.length - 1 && (
                  <span
                    className={`w-px flex-1 ${entry ? "bg-[#CFD8EE]" : "bg-[#EEF1F8]"}`}
                  />
                )}
              </div>

              <div className={`pb-[11px] ${pending ? "opacity-40" : ""}`}>
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-[13px] ${
                      entry ? "font-medium text-ink-900" : "text-ink-400"
                    }`}
                  >
                    {node}
                  </span>
                  {entry && entry.status !== "ok" && (
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-300">
                      {entry.status}
                    </span>
                  )}
                </div>
                <div className="mt-[2px] text-[11.5px] leading-[1.45] text-ink-400">
                  {entry?.detail ?? NODE_BLURB[node]}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-1 rounded-lg bg-panel px-3 py-[10px] text-[11.5px] leading-[1.5] text-ink-400">
        Every figure is checked against a rule before release. If one cannot be
        traced, the explanation is withheld and the figures stand alone.
      </div>
    </div>
  );
}
