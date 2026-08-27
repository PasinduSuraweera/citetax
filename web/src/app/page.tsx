"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentTrace } from "@/components/AgentTrace";
import { AnswerView } from "@/components/AnswerView";
import { Shell, SUPPORTED_YAS, type YA } from "@/components/Shell";
import { SnapshotPanel } from "@/components/SnapshotPanel";
import { api, ApiError, type AnswerResponse, type Snapshot } from "@/lib/api";

const EXAMPLES = [
  "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?",
  "Do I need to file if I earn 1,500,000 a year?",
  "I earned 3,000,000 salary and 1,200,000 freelance in 2026/2027. What is my tax?",
  "When is my return due for 2025/2026?",
];

export default function AskPage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      setBusy(true);
      setError(null);
      setAsked(text);
      setAnswer(null);
      try {
        setAnswer(await api.ask(text, ya));
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.message
            : "Something went wrong reaching the API.",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, ya],
  );

  const showComposer = !asked && !busy;

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell
        ya={ya}
        onYaChange={setYa}
        snapshot={snapshot}
        onSnapshotClick={() => setSnapshotOpen(true)}
      />

      <main className="flex flex-1 flex-col overflow-y-auto px-11 py-9">
        {showComposer && (
          <div className="mx-auto w-full max-w-[1000px]">
            <div className="max-w-[780px]">
              <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900">
                What would you like checked?
              </h1>
              <p className="mt-[10px] text-[15px] leading-[1.6] text-ink-500">
                Ask about personal income tax for {ya}. Every figure comes back
                traced to the rule that produced it.
              </p>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(question);
              }}
              className="mt-6 rounded-[13px] border-[1.5px] border-brand-600 bg-white shadow-[0_0_0_4px_rgba(43,68,199,0.09)]"
            >
              <textarea
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(question);
                  }
                }}
                rows={3}
                autoFocus
                placeholder="What do I owe for 2026/2027 on a salary of LKR 250,000 a month?"
                className="w-full resize-none bg-transparent px-[22px] pb-[6px] pt-5 text-[17px] leading-[1.5] text-ink-900 outline-none placeholder:text-ink-200"
              />
              <div className="flex items-center justify-between px-4 pb-[14px] pl-[22px] pt-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-lg border border-line-strong px-[11px] py-[7px] text-[12.5px] font-medium text-ink-700">
                    Y/A {ya.replace("/", " / ")}
                  </span>
                </div>
                <button
                  type="submit"
                  disabled={!question.trim()}
                  className="rounded-lg bg-brand-600 px-[18px] py-[9px] text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Ask
                </button>
              </div>
            </form>

            <div className="mt-5 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => {
                    setQuestion(ex);
                    ask(ex);
                  }}
                  className="rounded-full border border-line-strong bg-white px-[13px] py-[7px] text-[12.5px] text-ink-500 transition-colors hover:border-brand-600 hover:text-brand-600"
                >
                  {ex.length > 62 ? `${ex.slice(0, 62)}...` : ex}
                </button>
              ))}
            </div>

            <div className="mt-8 flex gap-3 rounded-[9px] bg-brand-050 px-[13px] py-3">
              <span className="mt-[1px] font-mono text-[11px] font-semibold text-brand-600">
                i
              </span>
              <span className="text-[12.5px] leading-[1.5] text-ink-700">
                Citetax covers personal income tax for {SUPPORTED_YAS.join(" and ")}.
                VAT, company tax and advisory questions are refused with a
                reason. Identifiers are stripped before anything reaches the
                hosted model.
              </span>
            </div>
          </div>
        )}

        {busy && asked && (
          <div className="mx-auto w-full max-w-[1000px]">
            <div className="flex items-start gap-[14px] rounded-xl border border-line bg-white px-[18px] py-4">
              <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-ink-900 text-[11px] font-semibold text-white">
                You
              </span>
              <p className="flex-1 text-[16px] leading-[1.5] text-ink-900">
                {asked}
              </p>
            </div>
            <div className="mt-[14px] max-w-[420px]">
              <AgentTrace trace={[]} running />
            </div>
          </div>
        )}

        {error && (
          <div className="mx-auto mt-4 w-full max-w-[1000px] rounded-xl border border-warn-300 bg-warn-100 px-5 py-4">
            <div className="eyebrow text-warn-600">CANNOT REACH THE API</div>
            <p className="mt-2 text-[14px] leading-[1.55] text-warn-500">{error}</p>
            <p className="mt-3 font-mono text-[12px] text-warn-500">
              cd api &amp;&amp; .venv\Scripts\python.exe -m uvicorn app.main:app --reload
            </p>
          </div>
        )}

        {answer && asked && !busy && (
          <div className="mx-auto w-full max-w-[1400px]">
            <AnswerView question={asked} answer={answer} onClarifyAnswer={(t) => ask(`${asked} ${t}`)} />
            <button
              type="button"
              onClick={() => {
                setAsked(null);
                setAnswer(null);
                setQuestion("");
              }}
              className="mt-5 rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
            >
              Ask another question
            </button>
          </div>
        )}
      </main>

      {snapshotOpen && snapshot && (
        <SnapshotPanel snapshot={snapshot} onClose={() => setSnapshotOpen(false)} />
      )}
    </div>
  );
}
