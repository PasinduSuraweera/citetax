"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AgentTrace } from "@/components/AgentTrace";
import { AnswerView } from "@/components/AnswerView";
import { PayslipConfirm } from "@/components/PayslipConfirm";
import { Shell, SUPPORTED_YAS, type YA } from "@/components/Shell";
import { SnapshotPanel } from "@/components/SnapshotPanel";
import { api, ApiError, type AnswerResponse, type Snapshot } from "@/lib/api";
import { onNewQuestion } from "@/lib/ask-store";

const EXAMPLES = [
  "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?",
  "When is my return due for 2025/2026?",
  "What is the personal relief this year?",
  "What changed between 2025/2026 and 2026/2027?",
  "Do I need to file if I earn 1,500,000 a year?",
  "How does APIT work for a salaried employee?",
];

export default function AskPage() {
  return (
    <Suspense fallback={null}>
      <AskPageInner />
    </Suspense>
  );
}

function AskPageInner() {
  const params = useSearchParams();
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);
  const [payslipFile, setPayslipFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const payslipInputRef = useRef<HTMLInputElement>(null);

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

  // Other pages hand a question over. ?q= asks it straight away, which is what
  // "ask the agent to explain" on the comparison page wants. ?draft= only fills
  // the box and focuses it, so onboarding can compose a question from what
  // someone told it while leaving them in control of sending it.
  const handedOff = useRef(false);
  useEffect(() => {
    if (handedOff.current) return;
    const q = params.get("q");
    const draft = params.get("draft");
    if (q) {
      handedOff.current = true;
      setQuestion(q);
      ask(q);
    } else if (draft) {
      handedOff.current = true;
      setQuestion(draft);
      setPrefilled(true);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(draft.length, draft.length);
      });
    }
  }, [params, ask]);

  const reset = useCallback(() => {
    setAsked(null);
    setAnswer(null);
    setQuestion("");
    setError(null);
    setPrefilled(false);
    handedOff.current = true;
    window.history.replaceState(null, "", "/");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // "New question" in the sidebar is a link to "/", so on this page Next.js
  // sees no route change and nothing resets. The sidebar publishes an intent
  // instead and we clear the answer here.
  useEffect(() => onNewQuestion(reset), [reset]);

  const showComposer = !asked && !busy;

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell
        ya={ya}
        onYaChange={setYa}
        snapshot={snapshot}
        onSnapshotClick={() => setSnapshotOpen(true)}
      />

      <main className="flex flex-1 flex-col overflow-y-auto px-4 pb-10 pt-[72px] sm:px-6 lg:px-11 lg:pb-9 lg:pt-9">
        {showComposer && (
          <div className="mx-auto w-full max-w-[1000px]">
            <div className="max-w-[780px]">
              <h1 className="text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[32px]">
                What would you like checked?
              </h1>
              <p className="mt-[10px] text-[15px] leading-[1.6] text-ink-500">
                Ask about personal income tax for {ya}: a figure, a deadline, a
                rule, or what changed. The agent picks the path; every figure
                comes back traced to the rule that produced it.
              </p>
            </div>

            {prefilled && (
              <div className="fade-up mt-6 flex items-start gap-2 rounded-[9px] border border-brand-600/25 bg-brand-050 px-[13px] py-[10px]">
                <span className="mt-[1px] flex-none text-brand-600">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" />
                  </svg>
                </span>
                <span className="text-[12.5px] leading-[1.5] text-ink-700">
                  We drafted this from your answers. Check the figures are right,
                  edit anything, then send it.
                </span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(question);
              }}
              className={`rounded-[13px] border-[1.5px] border-brand-600 bg-white shadow-[0_0_0_4px_rgba(43,68,199,0.09)] ${
                prefilled ? "mt-3" : "mt-6"
              }`}
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
                className="w-full resize-none bg-transparent px-4 pb-[6px] pt-5 text-[16px] leading-[1.5] text-ink-900 outline-none placeholder:text-ink-200 sm:px-[22px] sm:text-[17px]"
              />
              <div className="flex items-center justify-between px-3 pb-[14px] pl-4 pt-3 sm:px-4 sm:pl-[22px]">
                <div className="flex items-center gap-2">
                  <span className="rounded-lg border border-line-strong px-[11px] py-[7px] text-[12.5px] font-medium text-ink-700">
                    Y/A {ya.replace("/", " / ")}
                  </span>
                  <input
                    ref={payslipInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setPayslipFile(f);
                      if (payslipInputRef.current) payslipInputRef.current.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => payslipInputRef.current?.click()}
                    className="rounded-lg border border-line-strong px-[11px] py-[7px] text-[12.5px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
                  >
                    Upload payslip
                  </button>
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

            <div className="mt-5">
              <div className="mb-2 font-mono text-[10px] tracking-[0.14em] text-ink-300">
                TRY ONE
              </div>
              <div className="flex flex-wrap gap-2">
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
                    {ex.length > 64 ? `${ex.slice(0, 64)}...` : ex}
                  </button>
                ))}
              </div>
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
            <div className="mt-[14px] max-w-[440px]">
              <AgentTrace trace={[]} running />
            </div>
            <p className="mt-3 max-w-[440px] px-1 text-[12px] leading-[1.5] text-ink-400">
              The model reads the question first and chooses the plan. A
              deadline question will skip the computation; a figure will run it.
            </p>
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
          <div className="mx-auto w-full max-w-[1440px]">
            <AnswerView question={asked} answer={answer} onClarifyAnswer={(t) => ask(`${asked} ${t}`)} />
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setAsked(null);
                  setAnswer(null);
                  setQuestion("");
                  handedOff.current = true;
                  window.history.replaceState(null, "", "/");
                }}
                className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
              >
                Ask another question
              </button>
              {answer.run_id && (
                <span className="font-mono text-[11px] text-ink-300">
                  saved to history · run {answer.run_id.slice(0, 8)}
                </span>
              )}
            </div>
          </div>
        )}
      </main>

      {snapshotOpen && snapshot && (
        <SnapshotPanel snapshot={snapshot} onClose={() => setSnapshotOpen(false)} />
      )}

      {payslipFile && (
        <PayslipConfirm file={payslipFile} ya={ya} onClose={() => setPayslipFile(null)} />
      )}
    </div>
  );
}
