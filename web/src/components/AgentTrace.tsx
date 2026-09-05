"use client";

/**
 * The plan the agent chose, and what happened when it ran it.
 *
 * Shown, not summarised (spec section 9, "Nothing hidden"). The node list comes
 * from the response, because the planner picks a different path for a deadline
 * question than for a computation. While a question is running, the timeline
 * shows the generic full path filling in.
 */

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
  const nextIndex = trace.length;

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

      <ol className="mt-[13px] flex flex-col">
        {nodes.map((node, i) => {
          const entry = byNode.get(node);
          const isNext = running && i === nextIndex;
          const pending = !entry && !isNext;

          return (
            <li key={`${node}-${i}`} className="flex gap-[10px]">
              <div className="flex w-[9px] flex-none flex-col items-center">
                <span
                  className={`mt-[5px] h-[7px] w-[7px] flex-none rounded-full ${
                    entry ? DOT[entry.status] : isNext ? "bg-brand-600 pulse-dot" : "bg-[#DFE5F2]"
                  }`}
                />
                {i < nodes.length - 1 && (
                  <span className={`w-px flex-1 ${entry ? "bg-[#CFD8EE]" : "bg-[#EEF1F8]"}`} />
                )}
              </div>

              <div className={`pb-[11px] ${pending ? "opacity-40" : ""}`}>
                <div className="flex items-baseline gap-2">
                  <span className={`text-[13px] ${entry ? "font-medium text-ink-900" : "text-ink-400"}`}>
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
