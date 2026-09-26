"use client";

/**
 * Retrieval evaluation. Scores full text, dense and hybrid search on a
 * labelled question set, so a claim about retrieval quality has a number
 * behind it. Reviewers can re-run it after a corpus or search change.
 */

import { ChevronDown, Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import {
  admin, type EvalCase, type Me, type RetrievalEval, type RetrievalMode,
} from "@/lib/admin";

const MODES: RetrievalMode[] = ["hybrid", "dense", "fts"];

const MODE_META: Record<RetrievalMode, { label: string; note: string; bar: string; dot: string }> = {
  hybrid: { label: "Hybrid", note: "What Citetax uses: full text and dense, fused", bar: "bg-brand-600", dot: "bg-brand-600" },
  dense: { label: "Dense", note: "Embedding similarity only", bar: "bg-sky-500", dot: "bg-sky-500" },
  fts: { label: "Full text", note: "Postgres keyword match only", bar: "bg-amber-500", dot: "bg-amber-500" },
};

const CHART_METRICS: Array<[string, string]> = [
  ["hit@1", "Hit@1"],
  ["hit@3", "Hit@3"],
  ["hit@6", "Hit@6"],
  ["mrr", "MRR"],
  ["recall@6", "Recall@6"],
  ["ndcg@6", "nDCG@6"],
];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const three = (v: number) => v.toFixed(3);

export default function RetrievalEvalPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<RetrievalEval | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const who = await admin.me();
        setMe(who);
        if (who.is_reviewer) setData((await admin.retrievalEval()).result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the evaluation");
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setData((await admin.runRetrievalEval()).result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The evaluation failed");
    } finally {
      setRunning(false);
    }
  };

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <span className="font-mono text-[12px] text-ink-300">Loading...</span>
      </div>
    );
  }
  if (!me?.is_reviewer) return <NoAccess me={me} />;

  return (
    <AdminShell me={me}>
      <div className="px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">
              Retrieval evaluation
            </h1>
            <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
              How often search puts the right document in front of the model,
              measured on a labelled set of questions. Three retrievers are
              scored side by side, so the design can be defended with numbers.
            </p>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-[14px] font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-60"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? "Running..." : data ? "Run again" : "Run evaluation"}
          </button>
        </div>

        {error && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] text-warn-500">
            {error}
          </div>
        )}

        {!data && !running && !error && (
          <div className="mt-8 rounded-xl border border-dashed border-line-strong bg-white px-6 py-10 text-center">
            <p className="text-[15px] font-medium text-ink-900">No run yet</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-[13.5px] leading-[1.55] text-ink-500">
              A run sends each labelled question through all three retrievers.
              It takes a few seconds and uses one embedding call per question.
            </p>
          </div>
        )}

        {data && <Results data={data} />}
      </div>
    </AdminShell>
  );
}

function Results({ data }: { data: RetrievalEval }) {
  const modes = MODES.filter((m) => data.summary[m]);
  const embeddedShare = data.corpus.chunks ? data.corpus.embedded / data.corpus.chunks : 1;
  const unembedded = data.corpus.chunks - data.corpus.embedded;

  return (
    <div className="mt-6 flex flex-col gap-5">
      <p className="tnum text-[12.5px] text-ink-400">
        {data.questions} questions, eval set {data.eval_set_version}, run{" "}
        {new Date(data.ran_at).toLocaleString()}
        {data.run_by ? ` by ${data.run_by}` : ""}.
      </p>

      {(unembedded > 0 || !data.dense_enabled) && (
        <div className="rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] leading-[1.55] text-warn-500">
          {!data.dense_enabled ? (
            <>Dense search is off in this environment, so only full text was scored.</>
          ) : (
            <>
              <strong className="font-semibold">{unembedded} of {data.corpus.chunks} chunks ({pct(1 - embeddedShare)}) have no embedding.</strong>{" "}
              Dense search cannot see them, so any question whose answer lives
              there is missed by dense and can only be rescued by full text.
              Rebuild the index to close the gap.
            </>
          )}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        {modes.map((m) => {
          const a = data.summary[m]!.aggregate;
          return (
            <div key={m} className="rounded-xl border border-line bg-white px-5 py-4">
              <div className="flex items-center gap-2">
                <span className={`size-2.5 rounded-full ${MODE_META[m].dot}`} />
                <span className="text-[15px] font-semibold text-ink-900">{MODE_META[m].label}</span>
              </div>
              <p className="mt-0.5 text-[12.5px] text-ink-400">{MODE_META[m].note}</p>
              <div className="tnum mt-3 text-[34px] font-semibold leading-none tracking-[-0.03em] text-ink-900">
                {pct(a["hit@6"])}
              </div>
              <p className="mt-1 text-[12.5px] text-ink-400">
                of questions get a relevant document in the top 6
              </p>
              <dl className="tnum mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-[12.5px]">
                <div><dt className="text-ink-400">MRR</dt><dd className="font-medium text-ink-900">{three(a.mrr)}</dd></div>
                <div><dt className="text-ink-400">nDCG@6</dt><dd className="font-medium text-ink-900">{three(a["ndcg@6"])}</dd></div>
                <div><dt className="text-ink-400">Latency</dt><dd className="font-medium text-ink-900">{Math.round(a.avg_latency_ms)} ms</dd></div>
              </dl>
            </div>
          );
        })}
      </div>

      <MetricChart data={data} modes={modes} />
      <CategoryTable data={data} modes={modes} />
      <CaseList data={data} modes={modes} />

      <p className="max-w-[72ch] text-[12.5px] leading-[1.55] text-ink-400">
        {data.eval_set_note} Precision@6 is low by design here: most questions
        have one or two correct documents, so even a perfect search cannot fill
        six slots. Hit rate, MRR and nDCG are the fairer comparison.
      </p>
    </div>
  );
}

function MetricChart({ data, modes }: { data: RetrievalEval; modes: RetrievalMode[] }) {
  return (
    <section className="rounded-xl border border-line bg-white px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="eyebrow">METRICS, ALL QUESTIONS</div>
        <div className="flex gap-4">
          {modes.map((m) => (
            <span key={m} className="flex items-center gap-1.5 text-[12.5px] text-ink-500">
              <span className={`size-2.5 rounded-sm ${MODE_META[m].bar}`} />
              {MODE_META[m].label}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-2">
        {CHART_METRICS.map(([key, label]) => (
          <div key={key}>
            <div className="mb-1.5 text-[13px] font-medium text-ink-900">{label}</div>
            <div className="flex flex-col gap-1.5">
              {modes.map((m) => {
                const v = data.summary[m]!.aggregate[key] ?? 0;
                return (
                  <div key={m} className="flex items-center gap-2">
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${MODE_META[m].bar}`}
                        style={{ width: `${Math.max(v * 100, v > 0 ? 1.5 : 0)}%` }}
                      />
                    </div>
                    <span className="tnum w-11 text-right text-[12.5px] text-ink-700">{three(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CategoryTable({ data, modes }: { data: RetrievalEval; modes: RetrievalMode[] }) {
  const categories = Object.keys(data.summary[modes[0]]?.by_category ?? {});
  return (
    <section className="overflow-x-auto rounded-xl border border-line bg-white">
      <div className="border-b border-line px-5 py-3">
        <div className="eyebrow">HIT@6 BY KIND OF QUESTION</div>
        <p className="mt-1 text-[12px] text-ink-400">
          Where each retriever is strong. Keyword search suits exact rule
          wording; embeddings suit questions phrased in different words.
        </p>
      </div>
      <table className="w-full min-w-[520px] text-left text-[13.5px]">
        <thead>
          <tr className="bg-panel font-mono text-[10px] tracking-[0.14em] text-ink-300">
            <th className="px-5 py-2 font-normal">CATEGORY</th>
            <th className="px-3 py-2 font-normal">QUESTIONS</th>
            {modes.map((m) => (
              <th key={m} className="px-3 py-2 font-normal">{MODE_META[m].label.toUpperCase()}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c} className="border-t border-line-faint">
              <td className="px-5 py-2.5 capitalize text-ink-900">{c}</td>
              <td className="tnum px-3 py-2.5 text-ink-500">{data.summary[modes[0]]!.by_category[c].questions}</td>
              {modes.map((m) => (
                <td key={m} className="tnum px-3 py-2.5 font-medium text-ink-900">
                  {pct(data.summary[m]!.by_category[c]["hit@6"])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RankBadge({ rank }: { rank: number | null | undefined }) {
  if (rank === undefined) return <span className="text-ink-300">-</span>;
  if (rank === null) {
    return <span className="rounded-md bg-warn-100 px-2 py-0.5 text-[12px] font-medium text-warn-500">miss</span>;
  }
  return (
    <span className={`tnum rounded-md px-2 py-0.5 text-[12px] font-medium ${rank === 1 ? "bg-brand-100 text-brand-700" : "bg-muted text-ink-700"}`}>
      #{rank}
    </span>
  );
}

function CaseList({ data, modes }: { data: RetrievalEval; modes: RetrievalMode[] }) {
  const [onlyMisses, setOnlyMisses] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const shown = data.cases.filter(
    (c) => !onlyMisses || modes.some((m) => c.modes[m]?.first_relevant_rank === null),
  );
  return (
    <section className="rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <div className="eyebrow">EVERY QUESTION</div>
          <p className="mt-1 text-[12px] text-ink-400">
            Rank of the first relevant document for each retriever. Open a row
            to see what it returned.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-500">
          <input type="checkbox" checked={onlyMisses} onChange={(e) => setOnlyMisses(e.target.checked)} />
          Only questions any retriever missed
        </label>
      </div>
      <div>
        {shown.map((c) => (
          <CaseRow key={c.id} c={c} modes={modes} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} />
        ))}
        {shown.length === 0 && (
          <p className="px-5 py-6 text-[13.5px] text-ink-500">No misses. Every retriever found a relevant document for every question.</p>
        )}
      </div>
    </section>
  );
}

function CaseRow({
  c, modes, open, onToggle,
}: { c: EvalCase; modes: RetrievalMode[]; open: boolean; onToggle: () => void }) {
  const unembedded = c.coverage.filter((x) => x.chunks > 0 && x.embedded === 0);
  return (
    <div className="border-t border-line-faint first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-panel"
      >
        <span className="tnum w-8 flex-none font-mono text-[11px] text-ink-300">{c.id}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-[1.4] text-ink-900">{c.question}</span>
          <span className="text-[12px] capitalize text-ink-400">{c.category}</span>
        </span>
        <span className="hidden flex-none items-center gap-2 sm:flex">
          {modes.map((m) => (
            <span key={m} className="flex items-center gap-1" title={MODE_META[m].label}>
              <span className={`size-2 rounded-full ${MODE_META[m].dot}`} />
              <RankBadge rank={c.modes[m]?.first_relevant_rank} />
            </span>
          ))}
        </span>
        <ChevronDown className={`size-4 flex-none text-ink-300 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="border-t border-line-faint bg-panel px-5 py-4">
          <p className="text-[12.5px] text-ink-500">
            <span className="font-medium text-ink-700">Correct answer in:</span>{" "}
            {c.relevant.map((r) => (
              <code key={r} className="mr-1.5 rounded bg-white px-1.5 py-0.5 font-mono text-[11.5px] text-ink-700">{r}</code>
            ))}
          </p>
          {unembedded.length > 0 && (
            <p className="mt-2 text-[12.5px] leading-[1.5] text-warn-500">
              No embeddings for {unembedded.map((x) => x.label).join(", ")}, so
              dense search cannot find {unembedded.length > 1 ? "them" : "it"}.
            </p>
          )}
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            {modes.map((m) => {
              const r = c.modes[m];
              return (
                <div key={m}>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-ink-900">
                    <span className={`size-2 rounded-full ${MODE_META[m].dot}`} />
                    {MODE_META[m].label}
                    <span className="tnum font-normal text-ink-400">{r?.latency_ms} ms</span>
                  </div>
                  {r?.error && <p className="mb-1 text-[12px] text-warn-500">{r.error}</p>}
                  {r && r.retrieved.length === 0 && <p className="text-[12.5px] text-ink-400">Returned nothing.</p>}
                  <ol className="flex flex-col gap-1">
                    {r?.retrieved.map((p, i) => (
                      <li
                        key={`${p.url}-${i}`}
                        className={`flex gap-2 rounded-md border px-2 py-1.5 text-[12.5px] leading-[1.4] ${
                          p.relevant ? "border-brand-600/40 bg-brand-050 text-ink-900" : "border-line bg-white text-ink-500"
                        }`}
                      >
                        <span className="tnum flex-none text-ink-300">{i + 1}</span>
                        <span className="min-w-0 flex-1 break-words">{p.title ?? p.rule_key ?? p.url}</span>
                        {p.relevant && <span className="flex-none font-medium text-brand-700">correct</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
