"use client";

/**
 * The Ask page, and for a signed in user, their conversations.
 *
 * "/" is a new chat: an empty draft that becomes a conversation, with its own
 * URL, when the first question is answered. "/chat?c=<id>" is that conversation,
 * loaded from the API, so it survives a refresh, a sign out and another
 * device. Starting a new chat never clears or overwrites an existing one.
 *
 * Signed out, the page works exactly as it always has: one question, one
 * answer, nothing kept as a conversation.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpenText, Calculator, CalendarClock, FileCheck2, GitCompareArrows, Landmark, MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AnswerView } from "@/components/AnswerView";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Composer } from "@/components/Composer";
import { LiveTrace } from "@/components/LiveTrace";
import { LogoMark } from "@/components/Logo";
import { PayslipConfirm } from "@/components/PayslipConfirm";
import { UserAvatar } from "@/components/UserAvatar";
import { Shell } from "@/components/Shell";
import { useYa, useYears, yearsPhrase } from "@/lib/years";
import { SnapshotNote, TurnSummary } from "@/components/TurnSummary";
import {
  api,
  ApiError,
  type AnswerResponse,
  type ConversationSummary,
  type StreamStep,
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

const EXAMPLES: Array<{ kind: string; icon: LucideIcon; question: string }> = [
  { kind: "Tax on a salary", icon: Calculator, question: "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?" },
  { kind: "Filing deadline", icon: CalendarClock, question: "When is my return due for 2025/2026?" },
  { kind: "A rule's value", icon: BookOpenText, question: "What is the personal relief this year?" },
  { kind: "What changed", icon: GitCompareArrows, question: "What changed between 2025/2026 and 2026/2027?" },
  { kind: "Whether to file", icon: FileCheck2, question: "Do I need to file if I earn 1,500,000 a year?" },
  { kind: "How a scheme works", icon: Landmark, question: "How does APIT work for a salaried employee?" },
];

/** The hour, day and month in Sri Lanka, whatever clock the server runs on,
 *  so the server render and the browser agree. */
function colomboNow(): { hour: number; day: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric", day: "numeric", month: "numeric", hourCycle: "h23", timeZone: "Asia/Colombo",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour"), day: get("day"), month: get("month") };
}

/**
 * A greeting with a little personality. The variant is picked by the date,
 * not at random, so it holds for the day and never flickers between the
 * server render and the browser.
 */
function greeting(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  if (!first) return "What would you like checked?";
  const { hour, day, month } = colomboNow();
  const pick = (options: string[]) => options[day % options.length];

  if (hour < 4) return pick([`Up late, ${first}?`, `Burning the midnight oil, ${first}?`]);
  if (hour < 6) return pick([`Early start, ${first}`, `Up with the sun, ${first}`]);
  // Returns for the year are due on 30 November.
  if (month === 11 && hour < 22) return pick([`Return season, ${first}`, `Filing month, ${first}`]);
  if (hour < 12) return pick([`Good morning, ${first}`, `Morning, ${first}`]);
  if (hour < 17) return pick([`Good afternoon, ${first}`, `Afternoon, ${first}`]);
  if (hour < 22) return pick([`Good evening, ${first}`, `Evening, ${first}`]);
  return pick([`Still at it, ${first}?`, `Winding down, ${first}?`]);
}

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

/** What the stream has reported so far for the question running in a chat. */
interface LiveRun {
  steps: StreamStep[];
  plan: string[] | null;
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

  const [ya, setYa] = useYa();
  const { years } = useYears();
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
  const [live, setLive] = useState<Record<string, LiveRun>>({});
  // A payslip being read and confirmed, tied to the chat it was added in.
  const [payslip, setPayslip] = useState<{ key: string; file: File } | null>(null);
  // Earlier turns are collapsed; these are the ones opened by hand.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const key = activeId ?? `draft:${draftGen}`;
  const draft = drafts[key] ?? "";
  const thread = activeId ? store.threads[activeId] ?? EMPTY : null;
  const pendingQuestion = store.pending[key] ?? null;
  const failure = store.failures[key] ?? null;
  const liveRun = live[key] ?? null;
  const payslipFile = payslip?.key === key ? payslip.file : null;

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
      setLive((l) => ({ ...l, [askKey]: { steps: [], plan: null } }));
      requestAnimationFrame(() =>
        document.getElementById("pending-turn")?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );

      const update = (f: (run: LiveRun) => LiveRun) =>
        setLive((l) => (l[askKey] ? { ...l, [askKey]: f(l[askKey]) } : l));

      let res: AnswerResponse;
      try {
        res = await api.askStream(
          question,
          ya,
          (step) => update((r) => ({ ...r, steps: [...r.steps, step] })),
          {
            conversationId,
            reaskMessageId: opts.reaskMessageId,
            onPlan: (plan) => update((r) => ({ ...r, plan })),
          },
        );
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
          window.history.replaceState(null, "", `/chat?c=${res.conversation_id}`);
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
      // A one time handoff from another page: the question starts on arrival.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    setPayslip(null);
    setPrefilled(false);
    handedOff.current = true;
    // On "/chat?c=" the "New chat" link navigates to "/chat" itself. Only a
    // handed over ?q= or ?draft= needs clearing here.
    if (!new URLSearchParams(window.location.search).get("c")) {
      window.history.replaceState(null, "", "/chat");
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
    router.push("/chat");
  };

  /* ---------- what the main column shows ---------- */

  const composer = (placeholder?: string, autoFocus = false) => (
    <Composer
      value={draft}
      onChange={setDraft}
      onSubmit={(v) => void submit(v)}
      ya={ya}
      onYaChange={setYa}
      busy={Boolean(pendingQuestion)}
      onAttach={(file) => setPayslip({ key, file })}
      inputRef={inputRef}
      autoFocus={autoFocus}
      placeholder={placeholder}
    />
  );

  let body: React.ReactNode;
  // The composer stays at the foot of a conversation, like any chat.
  let dock: React.ReactNode = null;

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
        <>
          <ThreadHeader
            key={activeId}
            conversation={thread?.conversation ?? null}
            onDeleted={onDeleted}
          />

          {(thread?.status === "loading" || thread?.status === "idle") && turns.length === 0 && (
            <ThreadSkeleton />
          )}

          {thread?.status === "error" && turns.length === 0 && (
            <Notice tone="error" title="This chat did not load">
              {thread.error}{" "}
              <button type="button" onClick={() => void openThread(activeId)} className="font-medium underline underline-offset-4">
                Try again
              </button>
            </Notice>
          )}

          {thread?.hasMore && (
            <Button
              variant="ghost"
              onClick={() => void onLoadEarlier()}
              disabled={thread.loadingEarlier}
              className="mt-6 w-full text-ink-500"
            >
              {thread.loadingEarlier ? "Loading" : "Show earlier messages"}
            </Button>
          )}

          {thread?.status === "ready" && thread.error && turns.length > 0 && (
            <p className="mt-3 text-[13px] text-warn-600">{thread.error}</p>
          )}

          <ol aria-label="Conversation" className="mt-8 flex flex-col gap-12">
            {turns.map((t, i) => {
              const latest = i === turns.length - 1 && !pendingQuestion;
              const expandKey = t.reply?.id ?? t.question.id;
              const open = latest || expanded[expandKey];
              const reply = t.reply;
              return (
                <li key={t.seq} id={`turn-${t.seq}`} className="scroll-mt-6">
                  {!open ? (
                    <TurnSummary
                      turn={t}
                      onExpand={() => setExpanded((x) => ({ ...x, [expandKey]: true }))}
                    />
                  ) : (
                    <div className="flex flex-col gap-3">
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
                            className="self-start text-[13px] text-ink-400 hover:text-ink-900"
                          >
                            Collapse
                          </button>
                        )
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {pendingQuestion && (
            <PendingTurn question={pendingQuestion} run={liveRun} className="mt-12" />
          )}

          {failure && <FailureBanner failure={failure} />}

          {payslipFile && (
            <div className="mt-12">
              <PayslipConfirm file={payslipFile} ya={ya} onClose={() => setPayslip(null)} />
            </div>
          )}
        </>
      );
      if (!payslipFile && thread?.status === "ready") {
        dock = composer("Ask a follow-up, for example: what if I also earn LKR 500,000 from freelance work?");
      }
    }
  } else if (payslipFile) {
    body = <PayslipConfirm file={payslipFile} ya={ya} onClose={() => setPayslip(null)} />;
  } else if (pendingQuestion) {
    body = <PendingTurn question={pendingQuestion} run={liveRun} className="mt-2" />;
    dock = composer();
  } else if (loose && loose.key === key) {
    body = (
      <>
        <AnswerView
          question={loose.question}
          answer={loose.answer}
          onClarifyAnswer={(t) => void submit(`${loose.question} ${t}`)}
        />
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button variant="outline" onClick={reset}>
            Ask another question
          </Button>
          {loose.answer.run_id && (
            <span className="text-[13px] text-ink-400">
              Saved to <Link href="/history" className="underline underline-offset-4 hover:text-ink-900">History</Link>
            </span>
          )}
          {loose.answer.message_persisted === false && (
            <span className="text-[13px] text-warn-600">This answer could not be saved to a chat.</span>
          )}
        </div>
      </>
    );
  } else {
    body = (
      <div className="flex min-h-full flex-col justify-center py-8">
        <LogoMark size={44} className="mb-5" />
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900 sm:text-[34px]">
          {greeting(user?.name)}
        </h1>
        <p className="mt-2 max-w-[56ch] text-[16px] leading-[1.6] text-ink-500">
          {user
            ? `Ask about your personal income tax for ${ya}. Every figure comes back with the rule behind it.`
            : `Personal income tax for ${ya}. Every figure comes back with the rule behind it.`}
        </p>

        {prefilled && (
          <p className="fade-up mt-6 text-[14px] leading-[1.5] text-brand-700">
            We drafted this from your answers. Check the figures, edit anything,
            then send it.
          </p>
        )}

        <div className={prefilled ? "mt-3" : "mt-7"}>
          {composer(undefined, true)}
        </div>

        {failure && <FailureBanner failure={failure} />}

        <ul className="mt-6 grid gap-2 sm:grid-cols-2">
          {EXAMPLES.map(({ kind, icon: Icon, question }) => (
            <li key={question}>
              <button
                type="button"
                onClick={() => void submit(question)}
                className="group flex h-full w-full items-start gap-3 rounded-xl border border-line bg-white px-3.5 py-3 text-left transition-colors hover:border-line-strong hover:bg-panel"
              >
                <span className="mt-[1px] flex size-8 flex-none items-center justify-center rounded-lg bg-brand-050 text-brand-600 transition-colors group-hover:bg-brand-100">
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-ink-400">{kind}</span>
                  <span className="mt-0.5 block text-[14px] leading-[1.45] text-ink-900">{question}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="mt-8 text-[12.5px] leading-[1.6] text-ink-400">
          Covers personal income tax for {yearsPhrase(years)}. VAT,
          company tax and requests for advice are declined with the reason.
          Names and ID numbers are removed before anything reaches a language
          model.
          {user && " Your chats are saved to your account with those details already removed."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Shell ya={ya} onYaChange={setYa} />

      <main ref={mainRef} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] flex-1 px-5 pb-10 pt-[76px] sm:px-8 lg:pt-10">
          {body}
        </div>
        {dock && (
          <div className="sticky bottom-0 z-10 bg-background">
            <div className="mx-auto w-full max-w-[860px] px-5 pb-4 pt-2 sm:px-8">
              {dock}
            </div>
          </div>
        )}
      </main>
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
  return { status: 0, message: "Citetax could not reach its server. Check your connection and try again." };
}

/* ---------- pieces ---------- */

function PendingTurn({
  question, run, className = "",
}: {
  question: string;
  run: LiveRun | null;
  className?: string;
}) {
  return (
    <div id="pending-turn" className={`scroll-mt-6 ${className}`}>
      <QuestionOnly question={question} />
      <LiveTrace steps={run?.steps ?? []} plan={run?.plan ?? null} />
    </div>
  );
}

function QuestionOnly({ question }: { question: string }) {
  return (
    <div className="flex items-start gap-3">
      <UserAvatar size={28} />
      <p className="min-w-0 flex-1 pt-[2px] text-[19px] font-medium leading-[1.4] tracking-[-0.01em] text-ink-900">
        {question}
      </p>
    </div>
  );
}

/** A message that is not an answer: an error, or a screen that needs sign-in. */
function Notice({
  tone = "neutral", title, children, action,
}: {
  tone?: "neutral" | "error";
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={`mt-8 rounded-lg px-5 py-4 ${tone === "error" ? "bg-warn-100 text-warn-700" : "bg-muted text-ink-700"}`}
    >
      <h2 className={`text-[15px] font-semibold ${tone === "error" ? "text-warn-700" : "text-ink-900"}`}>{title}</h2>
      {children && <div className="mt-1 text-[14px] leading-[1.55]">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function FailureBanner({ failure }: { failure: AskFailure }) {
  return (
    <Notice tone="error" title={failure.status === 0 ? "Citetax is not reachable" : "That question was not answered"}>
      {failure.message}
    </Notice>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mt-8 flex flex-col gap-4" aria-label="Loading chat">
      <div className="flex items-center gap-3">
        <Skeleton className="size-7 rounded-full" />
        <Skeleton className="h-5 w-2/3" />
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function ThreadMissing() {
  return (
    <Notice
      title="This chat is not available"
      action={
        <Button nativeButton={false} render={<Link href="/chat" onClick={() => requestNewQuestion()} />}>Start a new chat</Button>
      }
    >
      It may have been deleted, or it belongs to another account.
    </Notice>
  );
}

function SignInToOpen() {
  return (
    <Notice
      title="Sign in to open this chat"
      action={<Button nativeButton={false} render={<Link href="/signin" />}>Sign in with Google</Button>}
    >
      Chats are saved to an account, so only their owner can open them.
      Questions asked without an account still work, they are just not kept.
    </Notice>
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

  if (!conversation) {
    return <Skeleton className="h-6 w-64 max-w-full" />;
  }

  const save = async () => {
    const next = title.trim();
    if (!next || next === conversation.title) {
      setMode("idle");
      return;
    }
    setBusy(true);
    try {
      await renameConversation(conversation.id, next);
      setMode("idle");
      toast.success("Chat renamed");
    } catch {
      toast.error("Could not rename the chat. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteConversation(conversation.id);
      toast.success("Chat deleted", { description: "Its answers are still in History." });
      onDeleted();
    } catch {
      toast.error("Could not delete the chat. Try again.");
      setBusy(false);
    }
  };

  if (mode === "rename") {
    return (
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setMode("idle")}
          maxLength={120}
          autoFocus
          aria-label="Chat title"
          disabled={busy}
          className="h-9 text-[15px]"
        />
        <Button type="submit" disabled={busy} className="h-9">Save</Button>
        <Button type="button" variant="ghost" onClick={() => setMode("idle")} className="h-9">Cancel</Button>
      </form>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-medium text-ink-900">{conversation.title}</h1>
        {conversation.created_at && (
          <p className="text-[12.5px] text-ink-400">
            Started {new Date(conversation.created_at).toLocaleDateString("en-GB", {
              day: "numeric", month: "long", year: "numeric",
            })}
          </p>
        )}
      </div>

      {mode === "confirm" ? (
        <div className="flex flex-none items-center gap-2">
          <span className="hidden text-[13px] text-ink-500 sm:inline">Delete this chat?</span>
          <Button variant="destructive" size="sm" onClick={() => void remove()} disabled={busy}>
            {busy ? "Deleting" : "Delete"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMode("idle")}>Cancel</Button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Chat options"
            className="flex size-8 flex-none items-center justify-center rounded-md text-ink-400 hover:bg-muted hover:text-ink-900 data-popup-open:bg-muted"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem
              onClick={() => {
                setTitle(conversation.title);
                setMode("rename");
              }}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setMode("confirm")}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
