"use client";

/**
 * The Ask page, and for a signed in user, their conversations.
 *
 * "/" is a new chat: an empty draft that becomes a conversation, with its own
 * URL, when the first question is answered. "/?c=<id>" is that conversation,
 * loaded from the API, so it survives a refresh, a sign out and another
 * device. Starting a new chat never clears or overwrites an existing one.
 *
 * Signed out, the page works exactly as it always has: one question, one
 * answer, nothing kept as a conversation.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AgentTrace } from "@/components/AgentTrace";
import { AnswerView } from "@/components/AnswerView";
import { Composer } from "@/components/Composer";
import { Shell, SUPPORTED_YAS, type YA } from "@/components/Shell";
import { SnapshotNote, TurnSummary } from "@/components/TurnSummary";
import { SnapshotPanel } from "@/components/SnapshotPanel";
import {
  api,
  ApiError,
  type AnswerResponse,
  type ConversationSummary,
  type Snapshot,
} from "@/lib/api";
import { onNewQuestion, requestNewQuestion } from "@/lib/ask-store";
import {
  EMPTY,
  deleteConversation,
  endPending,
  loadEarlier,
  openThread,
  recordTurn,
  renameConversation,
  startPending,
  syncOwner,
  useConversations,
  type AskFailure,
} from "@/lib/conversations";
import { useSession } from "@/lib/session";

const EXAMPLES = [
  "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?",
  "When is my return due for 2025/2026?",
  "What is the personal relief this year?",
  "What changed between 2025/2026 and 2026/2027?",
  "Do I need to file if I earn 1,500,000 a year?",
  "How does APIT work for a salaried employee?",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AskPage() {
  return (
    <Suspense fallback={null}>
      <AskPageInner />
    </Suspense>
  );
}

/** An answer that is not a turn of a saved conversation: every anonymous
 *  answer, and a signed in one whose turn could not be saved. */
interface LooseAnswer {
  key: string;
  question: string;
  answer: AnswerResponse;
}

function AskPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const rawId = params.get("c");
  const activeId = rawId && UUID.test(rawId) ? rawId.toLowerCase() : null;
  const badId = Boolean(rawId) && !activeId;

  const { user, loading: sessionLoading } = useSession();
  const owner = user?.email ?? null;
  const store = useConversations();

  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  // Each "+ New chat" is a fresh draft with its own key, so an answer still
  // running for the previous draft cannot land in the new one.
  const [draftGen, setDraftGen] = useState(0);
  const draftGenRef = useRef(0);
  // Unsent text per chat. ?draft= (from onboarding) seeds the first draft.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const d = params.get("draft");
    const seeded: Record<string, string> = {};
    if (d && !params.get("q")) seeded["draft:0"] = d;
    return seeded;
  });
  const [prefilled, setPrefilled] = useState(
    () => Boolean(params.get("draft")) && !params.get("q"),
  );
  const [loose, setLoose] = useState<LooseAnswer | null>(null);
  // Earlier turns are collapsed; these are the ones opened by hand.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const key = activeId ?? `draft:${draftGen}`;
  const draft = drafts[key] ?? "";
  const thread = activeId ? store.threads[activeId] ?? EMPTY : null;
  const pendingQuestion = store.pending[key] ?? null;
  const failure = store.failures[key] ?? null;

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

  useEffect(() => {
    syncOwner(owner);
  }, [owner]);

  // Opening a conversation reads it from the API; nothing is recomputed.
  useEffect(() => {
    if (activeId && owner) void openThread(activeId);
  }, [activeId, owner]);

  // A different conversation starts at the top, then jumps to its latest turn.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
    scrolledFor.current = null;
  }, [activeId]);
  useEffect(() => {
    if (!activeId || !thread || thread.status !== "ready") return;
    if (scrolledFor.current === activeId) return;
    scrolledFor.current = activeId;
    const last = thread.turns[thread.turns.length - 1];
    if (last && thread.turns.length > 1) {
      requestAnimationFrame(() =>
        document.getElementById(`turn-${last.seq}`)?.scrollIntoView({ block: "start" }),
      );
    }
  }, [activeId, thread]);

  const setDraft = useCallback(
    (value: string) => setDrafts((d) => ({ ...d, [key]: value })),
    [key],
  );

  const submit = useCallback(
    async (text: string, opts: { reaskMessageId?: string } = {}) => {
      const question = text.trim();
      if (!question || store.pending[key]) return;
      const askKey = key;
      const askOwner = store.owner;
      const conversationId = activeId;
      const gen = draftGenRef.current;

      startPending(askKey, question);
      requestAnimationFrame(() =>
        document.getElementById("pending-turn")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );

      let res: AnswerResponse;
      try {
        res = await api.ask(question, ya, {
          conversationId,
          reaskMessageId: opts.reaskMessageId,
        });
      } catch (e) {
        endPending(askKey, describeFailure(e));
        // Keep what they typed so they can send it again.
        if (!opts.reaskMessageId) setDrafts((d) => ({ ...d, [askKey]: question }));
        return;
      }

      if (conversationId && !res.message_persisted) {
        // Answered, but the turn could not be added to this chat. Most often
        // the chat was deleted while the question ran. The run is still in
        // History, which is where the answer can be found.
        endPending(askKey, {
          status: 409,
          message: res.conversation_id
            ? "The answer could not be saved to this chat. Its run is in History."
            : "This chat was deleted while the question was running. The answer was not saved here; its run is in History.",
        });
        return;
      }

      endPending(askKey);
      setDrafts((d) => {
        const next = { ...d };
        delete next[askKey];
        return next;
      });
      setPrefilled(false);

      if (res.message_persisted && res.conversation_id) {
        recordTurn(res, askOwner);
        const stillHere =
          !conversationId &&
          draftGenRef.current === gen &&
          !new URLSearchParams(window.location.search).get("c");
        if (stillHere) {
          // The draft is now a conversation and gets its own address.
          window.history.replaceState(null, "", `/?c=${res.conversation_id}`);
        }
        if (res.seq) {
          const seq = res.seq;
          requestAnimationFrame(() =>
            document.getElementById(`turn-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
          );
        }
      } else {
        setLoose({ key: askKey, question: res.user_message ?? question, answer: res });
      }
    },
    [key, activeId, ya, store.pending, store.owner],
  );

  // Other pages hand a question over. ?q= asks it straight away, which is what
  // "ask the agent to explain" on the comparison page wants. ?draft= only fills
  // the box and focuses it, so onboarding can compose a question from what
  // someone told it while leaving them in control of sending it.
  const handedOff = useRef(false);
  useEffect(() => {
    if (handedOff.current) return;
    const q = params.get("q");
    const d = params.get("draft");
    if (q) {
      handedOff.current = true;
      void submit(q);
    } else if (d) {
      handedOff.current = true;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(d.length, d.length);
      });
    }
  }, [params, submit]);

  const reset = useCallback(() => {
    draftGenRef.current += 1;
    setDraftGen(draftGenRef.current);
    setLoose(null);
    setPrefilled(false);
    handedOff.current = true;
    // On "/?c=" the "+ New chat" link navigates to "/" itself. Only a
    // handed over ?q= or ?draft= needs clearing here.
    if (!new URLSearchParams(window.location.search).get("c")) {
      window.history.replaceState(null, "", "/");
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // "+ New chat" in the sidebar is a link to "/", so on this page Next.js may
  // see no route change. The sidebar publishes an intent and a fresh draft
  // starts here.
  useEffect(() => onNewQuestion(reset), [reset]);

  const onLoadEarlier = async () => {
    if (!activeId) return;
    const el = mainRef.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    await loadEarlier(activeId);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - fromBottom;
    });
  };

  const onDeleted = () => {
    requestNewQuestion();
    router.push("/");
  };

  /* ---------- what the main column shows ---------- */

  let body: React.ReactNode;

  if (badId) {
    body = <ThreadMissing />;
  } else if (activeId) {
    if (sessionLoading) {
      body = <ThreadSkeleton />;
    } else if (!user) {
      body = <SignInToOpen />;
    } else if (thread?.notFound) {
      body = <ThreadMissing />;
    } else {
      const turns = thread?.turns ?? [];
      body = (
        <div className="mx-auto w-full max-w-[1440px]">
          <ThreadHeader
            key={activeId}
            conversation={thread?.conversation ?? null}
            onDeleted={onDeleted}
          />

          {(thread?.status === "loading" || thread?.status === "idle") && turns.length === 0 && (
            <ThreadSkeleton />
          )}

          {thread?.status === "error" && turns.length === 0 && (
            <div className="mt-6 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4">
              <div className="eyebrow text-warn-600">COULD NOT LOAD THIS CHAT</div>
              <p className="mt-2 text-[14px] leading-[1.55] text-warn-500">{thread.error}</p>
              <button
                type="button"
                onClick={() => void openThread(activeId)}
                className="mt-3 rounded-lg border border-warn-300 bg-white px-3 py-[6px] text-[13px] font-medium text-warn-600 hover:border-warn-600"
              >
                Retry
              </button>
            </div>
          )}

          {thread?.hasMore && (
            <button
              type="button"
              onClick={() => void onLoadEarlier()}
              disabled={thread.loadingEarlier}
              className="mt-5 w-full rounded-lg border border-dashed border-line-strong bg-white px-4 py-[9px] font-mono text-[11.5px] text-ink-400 transition-colors hover:border-brand-600 hover:text-brand-600 disabled:opacity-60"
            >
              {thread.loadingEarlier ? "Loading..." : "Load earlier messages"}
            </button>
          )}

          {thread?.status === "ready" && thread.error && turns.length > 0 && (
            <p className="mt-3 text-[12.5px] text-warn-600">{thread.error}</p>
          )}

          <ol aria-label="Conversation" className="mt-5 flex flex-col gap-4">
            {turns.map((t, i) => {
              const latest = i === turns.length - 1 && !pendingQuestion;
              const expandKey = t.reply?.id ?? t.question.id;
              const open = latest || expanded[expandKey];
              const reply = t.reply;
              return (
                <li key={t.seq} id={`turn-${t.seq}`} className="scroll-mt-4">
                  {!open ? (
                    <TurnSummary
                      turn={t}
                      onExpand={() => setExpanded((x) => ({ ...x, [expandKey]: true }))}
                    />
                  ) : (
                    <div className="flex flex-col gap-2">
                      {reply ? (
                        <AnswerView
                          question={t.question.content}
                          answer={reply.answer}
                          onClarifyAnswer={
                            latest && reply.kind === "clarify" ? (x) => void submit(x) : undefined
                          }
                        />
                      ) : (
                        <QuestionOnly question={t.question.content} />
                      )}
                      {reply?.kind === "answer" ? (
                        <SnapshotNote
                          answer={reply.answer}
                          answeredAt={reply.created_at}
                          busy={Boolean(pendingQuestion)}
                          onReask={() =>
                            void submit(t.question.content, { reaskMessageId: reply.id })
                          }
                          onCollapse={
                            latest
                              ? undefined
                              : () => setExpanded((x) => ({ ...x, [expandKey]: false }))
                          }
                        />
                      ) : (
                        !latest && (
                          <button
                            type="button"
                            onClick={() => setExpanded((x) => ({ ...x, [expandKey]: false }))}
                            className="self-end font-mono text-[10.5px] text-ink-300 hover:text-brand-600"
                          >
                            Collapse ▴
                          </button>
                        )
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {pendingQuestion && <PendingTurn question={pendingQuestion} className="mt-4" />}

          {failure && <FailureBanner failure={failure} />}

          {!pendingQuestion && thread?.status === "ready" && (
            <div className="mt-6 max-w-[1000px]">
              <Composer
                value={draft}
                onChange={setDraft}
                onSubmit={(v) => void submit(v)}
                ya={ya}
                inputRef={inputRef}
                rows={2}
                placeholder="Ask a follow-up, e.g. what if I also earn LKR 500,000 from freelance work?"
              />
              <p className="mt-2 px-1 text-[11.5px] leading-[1.5] text-ink-300">
                Each follow-up is answered against the current snapshot. Earlier
                answers are kept as they were given.
              </p>
            </div>
          )}
        </div>
      );
    }
  } else if (pendingQuestion) {
    body = (
      <div className="mx-auto w-full max-w-[1000px]">
        <PendingTurn question={pendingQuestion} />
      </div>
    );
  } else if (loose && loose.key === key) {
    body = (
      <div className="mx-auto w-full max-w-[1440px]">
        <AnswerView
          question={loose.question}
          answer={loose.answer}
          onClarifyAnswer={(t) => void submit(`${loose.question} ${t}`)}
        />
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
          >
            Ask another question
          </button>
          {loose.answer.run_id && (
            <span className="font-mono text-[11px] text-ink-300">
              saved to history · run {loose.answer.run_id.slice(0, 8)}
            </span>
          )}
          {loose.answer.message_persisted === false && (
            <span className="text-[12px] text-warn-600">
              This answer could not be saved to a chat.
            </span>
          )}
        </div>
      </div>
    );
  } else {
    body = (
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

        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={(v) => void submit(v)}
          ya={ya}
          inputRef={inputRef}
          autoFocus
          className={prefilled ? "mt-3" : "mt-6"}
        />

        {failure && <FailureBanner failure={failure} />}

        <div className="mt-5">
          <div className="mb-2 font-mono text-[10px] tracking-[0.14em] text-ink-300">
            TRY ONE
          </div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => void submit(ex)}
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
            {user && " Your chats are saved to your account with the identifiers already removed."}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell
        ya={ya}
        onYaChange={setYa}
        snapshot={snapshot}
        onSnapshotClick={() => setSnapshotOpen(true)}
      />

      <main
        ref={mainRef}
        className="flex flex-1 flex-col overflow-y-auto px-4 pb-10 pt-[72px] sm:px-6 lg:px-11 lg:pb-9 lg:pt-9"
      >
        {body}
      </main>

      {snapshotOpen && snapshot && (
        <SnapshotPanel snapshot={snapshot} onClose={() => setSnapshotOpen(false)} />
      )}
    </div>
  );
}

function describeFailure(e: unknown): AskFailure {
  if (e instanceof ApiError) {
    if (e.status === 404) return { status: 404, message: "This chat no longer exists." };
    if (e.status === 401) {
      return { status: 401, message: "Your session has expired. Sign in again to continue this chat." };
    }
    return { status: e.status, message: e.message };
  }
  return { status: 0, message: "Something went wrong reaching the API." };
}

/* ---------- pieces ---------- */

function PendingTurn({ question, className = "" }: { question: string; className?: string }) {
  return (
    <div id="pending-turn" className={`scroll-mt-4 ${className}`}>
      <div className="flex items-start gap-[14px] rounded-xl border border-line bg-white px-[18px] py-4">
        <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-ink-900 text-[11px] font-semibold text-white">
          You
        </span>
        <p className="flex-1 text-[16px] leading-[1.5] text-ink-900">{question}</p>
      </div>
      <div className="mt-[14px] max-w-[440px]">
        <AgentTrace trace={[]} running />
      </div>
      <p className="mt-3 max-w-[440px] px-1 text-[12px] leading-[1.5] text-ink-400">
        The model reads the question first and chooses the plan. A
        deadline question will skip the computation; a figure will run it.
      </p>
    </div>
  );
}

function QuestionOnly({ question }: { question: string }) {
  return (
    <div className="flex items-start gap-[14px] rounded-xl border border-line bg-white px-[18px] py-4">
      <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-ink-900 text-[11px] font-semibold text-white">
        You
      </span>
      <p className="flex-1 text-[16px] leading-[1.5] text-ink-900">{question}</p>
    </div>
  );
}

function FailureBanner({ failure }: { failure: AskFailure }) {
  if (failure.status === 0) {
    return (
      <div className="mt-4 w-full max-w-[1000px] rounded-xl border border-warn-300 bg-warn-100 px-5 py-4">
        <div className="eyebrow text-warn-600">CANNOT REACH THE API</div>
        <p className="mt-2 text-[14px] leading-[1.55] text-warn-500">{failure.message}</p>
        <p className="mt-3 font-mono text-[12px] text-warn-500">
          cd api &amp;&amp; .venv\Scripts\python.exe -m uvicorn app.main:app --reload
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 w-full max-w-[1000px] rounded-xl border border-warn-300 bg-warn-100 px-5 py-4">
      <div className="eyebrow text-warn-600">COULD NOT ANSWER</div>
      <p className="mt-2 text-[14px] leading-[1.55] text-warn-500">{failure.message}</p>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto mt-5 flex w-full max-w-[1000px] flex-col gap-4" aria-label="Loading chat">
      <div className="h-[58px] animate-pulse rounded-xl bg-white" />
      <div className="h-[220px] animate-pulse rounded-xl bg-white" />
    </div>
  );
}

function ThreadMissing() {
  return (
    <div className="mx-auto w-full max-w-[1000px] rounded-xl border border-line bg-white px-6 py-8">
      <div className="eyebrow">CHAT NOT FOUND</div>
      <p className="mt-3 max-w-[460px] text-[14px] leading-[1.6] text-ink-500">
        This chat does not exist, was deleted, or belongs to another account.
      </p>
      <Link
        href="/"
        onClick={() => requestNewQuestion()}
        className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700"
      >
        Start a new chat
      </Link>
    </div>
  );
}

function SignInToOpen() {
  return (
    <div className="mx-auto w-full max-w-[1000px] rounded-xl border border-line bg-white px-6 py-8">
      <div className="eyebrow">SIGN IN TO OPEN THIS CHAT</div>
      <p className="mt-3 max-w-[460px] text-[14px] leading-[1.6] text-ink-500">
        Chats are saved to your account, so only you can open them. Anonymous
        questions still work; they are just not kept as chats.
      </p>
      <Link
        href="/signin"
        className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700"
      >
        Sign in with Google
      </Link>
    </div>
  );
}

function ThreadHeader({
  conversation, onDeleted,
}: {
  conversation: ConversationSummary | null;
  onDeleted: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "confirm">("idle");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!conversation) {
    return <div className="h-[34px] w-[280px] max-w-full animate-pulse rounded-lg bg-white" />;
  }

  const save = async () => {
    const next = title.trim();
    if (!next || next === conversation.title) {
      setMode("idle");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameConversation(conversation.id, next);
      setMode("idle");
    } catch {
      setError("Could not rename this chat.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteConversation(conversation.id);
      onDeleted();
    } catch {
      setError("Could not delete this chat.");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      {mode === "rename" ? (
        <form
          className="flex min-w-0 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setMode("idle")}
            maxLength={120}
            autoFocus
            aria-label="Chat title"
            disabled={busy}
            className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white px-3 py-[7px] text-[16px] font-semibold text-ink-900 outline-none focus:border-brand-600"
          />
          <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
            Save
          </button>
          <button type="button" onClick={() => setMode("idle")} className="rounded-lg px-3 py-[7px] text-[13px] text-ink-500 hover:text-ink-900">
            Cancel
          </button>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[21px] font-semibold leading-[1.25] tracking-[-0.02em] text-ink-900 sm:text-[24px]">
            {conversation.title}
          </h1>
          {conversation.created_at && (
            <p className="mt-1 font-mono text-[10.5px] text-ink-300">
              started {new Date(conversation.created_at).toLocaleDateString("en-GB", {
                day: "numeric", month: "short", year: "numeric",
              })}
            </p>
          )}
        </div>
      )}

      {mode === "idle" && (
        <div className="flex flex-none gap-2">
          <button
            type="button"
            onClick={() => {
              setTitle(conversation.title);
              setMode("rename");
            }}
            className="rounded-lg border border-line-strong bg-white px-3 py-[6px] text-[12.5px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => setMode("confirm")}
            className="rounded-lg border border-line-strong bg-white px-3 py-[6px] text-[12.5px] font-medium text-warn-600 transition-colors hover:border-warn-600"
          >
            Delete
          </button>
        </div>
      )}

      {mode === "confirm" && (
        <div className="flex flex-none flex-wrap items-center gap-2 rounded-lg border border-warn-300 bg-warn-100 px-3 py-2">
          <span className="text-[12.5px] text-warn-500">
            Delete this chat for good? Its answers stay in History.
          </span>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-md bg-warn-600 px-3 py-[5px] text-[12.5px] font-semibold text-white hover:bg-warn-700 disabled:opacity-50"
          >
            {busy ? "Deleting..." : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setMode("idle")}
            className="rounded-md px-2 py-[5px] text-[12.5px] text-warn-500 hover:text-warn-700"
          >
            Cancel
          </button>
        </div>
      )}

      {error && <p className="basis-full text-[12.5px] text-warn-600">{error}</p>}
    </div>
  );
}
