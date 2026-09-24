"use client";

/**
 * The plan the agent chose, and what happened when it ran it.
 *
 * Shown, not summarised (spec section 9, "Nothing hidden"). The node list comes
 * from the response, because the planner picks a different path for a deadline
 * question than for a computation.
 *
 * While a question is running, this reflects the real backend, not a guess:
 * `trace` grows one entry at a time as /v1/ask/stream pushes each step the
 * instant it actually finishes (see api.askStream). The step immediately
 * after the last real one pulses as "next up" — that part is the only
 * inference this component makes, and it is a one-step inference, not a
 * timed animation standing in for data that was never there.
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

// Each step's own identity color — what a step IS, shown once it succeeds.
// Status colors below take over instead whenever a step did not simply
// succeed, so a failure or refusal is never hidden behind its phase color.
export const PHASE_DOT: Record<string, string> = {
  Intake: "bg-brand-600",
  Route: "bg-phase-route",
  Resolve: "bg-phase-resolve",
  Compute: "bg-good-mint",
  Comply: "bg-phase-comply",
  Compare: "bg-phase-compare",
  Retrieve: "bg-phase-retrieve",
  Explain: "bg-phase-explain",
  Verify: "bg-phase-verify",
};
export const PHASE_RING: Record<string, string> = {
  Intake: "bg-brand-600/30",
  Route: "bg-phase-route/30",
  Resolve: "bg-phase-resolve/30",
  Compute: "bg-good-mint/30",
  Comply: "bg-phase-comply/30",
  Compare: "bg-phase-compare/30",
  Retrieve: "bg-phase-retrieve/30",
  Explain: "bg-phase-explain/30",
  Verify: "bg-phase-verify/30",
};

// An actual light, not just a color — the step working right now casts a
// soft glow in its own hue. Read via CSS var so one map covers every phase
// without a shadow-[...] literal per color.
export const PHASE_GLOW: Record<string, string> = {
  Intake: "shadow-[0_0_16px_var(--color-brand-600)]",
  Route: "shadow-[0_0_16px_var(--color-phase-route)]",
  Resolve: "shadow-[0_0_16px_var(--color-phase-resolve)]",
  Compute: "shadow-[0_0_16px_var(--color-good-mint)]",
  Comply: "shadow-[0_0_16px_var(--color-phase-comply)]",
  Compare: "shadow-[0_0_16px_var(--color-phase-compare)]",
  Retrieve: "shadow-[0_0_16px_var(--color-phase-retrieve)]",
  Explain: "shadow-[0_0_16px_var(--color-phase-explain)]",
  Verify: "shadow-[0_0_16px_var(--color-phase-verify)]",
};

// What a step's status was, shown instead of its phase color whenever that
// status was not a plain success — a failure needs to stand out, not blend
// into the same palette as everything that went fine.
const STATUS_DOT: Partial<Record<TraceEntry["status"], string>> = {
  skipped: "bg-ink-200",
  refused: "bg-[#B07A16]",
  failed: "bg-warn-600",
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

      <ol className="mt-[15px] flex flex-col">
        {nodes.map((node, i) => {
          const entry = byNode.get(node);
          const isNext = running && i === nextIndex && !entry;
          const done = Boolean(entry);
          const pending = !done && !isNext;

          const dotClass = entry
            ? (STATUS_DOT[entry.status] ?? PHASE_DOT[node] ?? "bg-good-mint")
            : isNext
              ? (PHASE_DOT[node] ?? "bg-brand-600")
              : "bg-line-strong";

          return (
            <li key={`${node}-${i}`} className="flex gap-[11px]">
              <div className="flex w-[11px] flex-none flex-col items-center">
                <span
                  className={`relative mt-[3px] h-[11px] w-[11px] flex-none rounded-full transition-[background-color,box-shadow] duration-300 ${dotClass} ${
                    isNext ? (PHASE_GLOW[node] ?? PHASE_GLOW.Intake) : ""
                  }`}
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
                  {isNext && (
                    <span
                      className={`absolute -inset-[3px] rounded-full pulse-dot ${PHASE_RING[node] ?? "bg-brand-600/30"}`}
                    />
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
                      entry ? "font-medium text-ink-900" : isNext ? "font-medium text-brand-600" : "text-ink-400"
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
