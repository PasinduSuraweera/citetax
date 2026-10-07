"use client";

/**
 * Onboarding: three questions, then a draft question in the composer.
 *
 * The rule that shapes this: never invent a figure. An onboarding that fills
 * the box with someone else's salary produces a first answer that is fiction,
 * and the person has to delete it before they can do anything. So step 3 asks
 * for the real amount, and the composed question is handed over UNSENT so they
 * can check it and change it.
 *
 * Steps that do not need a figure skip step 3 entirely: a deadline is the same
 * date for everyone, and "just looking" means get out of the way.
 *
 * Nothing is stored. The answers only compose the draft.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useYears, type YA } from "@/lib/years";
import { Loader2 } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useSession } from "@/lib/session";

type Work = "employed" | "freelance" | "both" | "investments";
type Goal = "owe" | "file" | "deadline" | "explore";

/* ---------------------------------------------------------------- icons */

const ICON: Record<string, React.ReactNode> = {
  briefcase: <><rect x="2.5" y="6" width="15" height="10.5" rx="2" /><path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h3A1.5 1.5 0 0 1 13 4.5V6" /><path d="M2.5 10.5h15" /></>,
  receipt: <><path d="M4.5 2.5h11v15l-2-1.4-1.8 1.4-1.7-1.4-1.8 1.4-1.7-1.4-2 1.4z" /><path d="M7.5 7h5M7.5 10.5h5" /></>,
  split: <><path d="M3 5h3.5l3 5 3 5H16" /><path d="M3 15h3.5l2-3.3" /><path d="M13.5 3l2.5 2-2.5 2" /><path d="M13.5 13l2.5 2-2.5 2" /></>,
  trend: <><path d="M2.5 13.5l4.5-4.5 3 3 5.5-6" /><path d="M12 5.5h4v4" /></>,
  calculator: <><rect x="4" y="2.5" width="12" height="15" rx="2" /><path d="M7 6h6" /><path d="M7.5 10h.01M10 10h.01M12.5 10h.01M7.5 13.5h.01M10 13.5h.01M12.5 13.5h.01" /></>,
  question: <><circle cx="10" cy="10" r="7.5" /><path d="M7.8 7.8a2.2 2.2 0 1 1 2.9 2.1c-.5.2-.7.6-.7 1.1v.4" /><path d="M10 14.2h.01" /></>,
  calendar: <><rect x="2.5" y="4" width="15" height="13.5" rx="2" /><path d="M2.5 8h15" /><path d="M6.5 2.5V5M13.5 2.5V5" /></>,
  compass: <><circle cx="10" cy="10" r="7.5" /><path d="M12.8 7.2l-1.5 4.1-4.1 1.5 1.5-4.1z" /></>,
};

function Icon({ name }: { name: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

function Arrow({ back }: { back?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={back ? "rotate-180" : undefined}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

/* ---------------------------------------------------------------- options */

const WORK: Array<{ key: Work; icon: string; name: string; desc: string }> = [
  { key: "employed", icon: "briefcase", name: "I have a job", desc: "A salary from an employer" },
  { key: "freelance", icon: "receipt", name: "I work for myself", desc: "Freelance, consulting or a small business" },
  { key: "both", icon: "split", name: "A bit of both", desc: "A salary plus something on the side" },
  { key: "investments", icon: "trend", name: "Mostly investments", desc: "Interest, dividends or rent" },
];

const GOALS: Array<{ key: Goal; icon: string; name: string; desc: string }> = [
  { key: "owe", icon: "calculator", name: "How much tax do I owe?", desc: "A figure for the year, worked out step by step" },
  { key: "file", icon: "question", name: "Do I need to file a return?", desc: "Check whether a return is required at all" },
  { key: "deadline", icon: "calendar", name: "When is my return due?", desc: "Filing date and the quarterly instalments" },
  { key: "explore", icon: "compass", name: "I will ask my own question", desc: "Take me straight in" },
];

/** What step 3 calls the money, per how they earn. */
const INCOME_LABEL: Record<Work, { label: string; hint: string }> = {
  employed: { label: "your salary", hint: "Before EPF and any tax already deducted" },
  freelance: { label: "what you invoiced", hint: "Total billed before expenses" },
  both: { label: "your total income", hint: "Salary plus anything on the side" },
  investments: { label: "your total income", hint: "Interest, dividends, rent and any salary" },
};

/* ---------------------------------------------------------------- draft */

/** The question the onboarding hands to the chat, for the year today falls in. */
function buildDraft(work: Work, goal: Goal, amount: string, monthly: boolean, YA: YA): string {
  if (goal === "deadline") return `When is my tax return due for ${YA}?`;
  if (goal === "explore") return "";

  const n = Number(amount.replace(/[^\d.]/g, ""));
  const figure = Number.isFinite(n) && n > 0 ? n.toLocaleString("en-GB") : null;
  if (!figure) {
    // No amount given: ask the shape of the question and let them fill it in.
    return goal === "file"
      ? `Do I need to file a return for ${YA}?`
      : `What tax do I owe for ${YA}?`;
  }

  const per = monthly ? "a month" : "a year";
  const earning = {
    employed: `I earn LKR ${figure} ${per} in salary, with EPF deducted`,
    freelance: `I invoiced LKR ${figure} ${per} for freelance work`,
    both: `I earn LKR ${figure} ${per} in total, from a salary and freelance work`,
    investments: `I earn LKR ${figure} ${per} in total, mostly from investments`,
  }[work];

  return goal === "file"
    ? `${earning}. Do I need to file a return for ${YA}?`
    : `${earning}. What tax do I owe for ${YA}?`;
}

/** Thousands separators while typing. Digits only: a salary is a whole
 *  number of rupees, and a stray decimal point only invites a typo. */
function groupDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 12);
  return digits ? Number(digits).toLocaleString("en-GB") : "";
}

/** First word of the account name, or nothing when Google gave none. */
function greetingName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  if (!first || first.length < 2) return null;
  return /\d/.test(first) ? first : first[0].toUpperCase() + first.slice(1);
}

/* ---------------------------------------------------------------- page */

export default function WelcomePage() {
  const router = useRouter();
  const { user, loading } = useSession();
  const { current: ya } = useYears();

  const [step, setStep] = useState(1);
  const [work, setWork] = useState<Work | null>(null);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [amount, setAmount] = useState("");
  const [monthly, setMonthly] = useState(true);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/signin?mode=signup");
  }, [loading, user, router]);

  const needsAmount = goal === "owe" || goal === "file";
  const totalSteps = needsAmount || goal === null ? 3 : 2;

  const draft = useMemo(
    () => (work && goal ? buildDraft(work, goal, amount, monthly, ya) : ""),
    [work, goal, amount, monthly, ya],
  );

  const handOver = (q: string) => {
    setLeaving(true);
    router.push(q ? `/chat?draft=${encodeURIComponent(q)}` : "/chat");
  };

  const chooseGoal = (g: Goal) => {
    setGoal(g);
    // Only a figure question needs a figure. The rest can leave now.
    if (g === "owe" || g === "file") setStep(3);
    else handOver(buildDraft(work ?? "employed", g, "", monthly, ya));
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-surface text-[14px] text-ink-400">
        <Loader2 className="size-4 animate-spin" />
        Loading
      </div>
    );
  }

  const name = greetingName(user?.name ?? null);
  const money = work ? INCOME_LABEL[work] : INCOME_LABEL.employed;

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-[62px] flex-none items-center justify-between border-b border-line bg-white px-5 sm:px-8">
        <Link href="/" aria-label="Citetax home">
          <Logo height={30} priority />
        </Link>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-[6px]" aria-label={`Step ${step} of ${totalSteps}`}>
            {Array.from({ length: totalSteps }, (_, i) => i + 1).map((n) => (
              <span
                key={n}
                className={`h-[6px] rounded-full transition-all ${
                  n === step ? "w-6 bg-brand-600"
                    : n < step ? "w-[6px] bg-brand-600/40" : "w-[6px] bg-line-strong"
                }`}
              />
            ))}
          </div>
          <Link href="/chat" className="text-[13px] font-medium text-ink-300 transition-colors hover:text-ink-700">
            Skip
          </Link>
        </div>
      </header>

      <div className="flex flex-1 items-start justify-center px-5 py-10 sm:px-8 sm:py-14">
        <div className="w-full max-w-[620px]">
          {/* ---------------------------------------------------- step 1 */}
          {step === 1 && (
            <div className="fade-up">
              <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[36px]">
                {name ? `Hi ${name}. ` : "Welcome. "}
                <span className="text-ink-400">How do you earn?</span>
              </h1>
              <p className="mt-3 text-[15.5px] leading-[1.6] text-ink-500">
                Two quick questions so your first answer is about you.
              </p>

              <div className="mt-8 flex flex-col gap-[10px]">
                {WORK.map((w) => (
                  <Card
                    key={w.key}
                    icon={w.icon}
                    name={w.name}
                    desc={w.desc}
                    onClick={() => {
                      setWork(w.key);
                      setStep(2);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ---------------------------------------------------- step 2 */}
          {step === 2 && (
            <div className="fade-up">
              <BackLink onClick={() => setStep(1)} />
              <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[36px]">
                What do you want to know?
              </h1>
              <p className="mt-3 text-[15.5px] leading-[1.6] text-ink-500">
                We will write the question for you. You can change it before sending.
              </p>

              <div className="mt-8 flex flex-col gap-[10px]">
                {GOALS.map((g) => (
                  <Card
                    key={g.key}
                    icon={g.icon}
                    name={g.name}
                    desc={g.desc}
                    busy={leaving && goal === g.key}
                    disabled={leaving}
                    onClick={() => chooseGoal(g.key)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ---------------------------------------------------- step 3 */}
          {step === 3 && (
            <div className="fade-up">
              <BackLink onClick={() => setStep(2)} />
              <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[36px]">
                Roughly, what is {money.label}?
              </h1>
              <p className="mt-3 text-[15.5px] leading-[1.6] text-ink-500">
                {money.hint}. An estimate is fine, you can correct it in a moment.
              </p>

              <div className="mt-8 rounded-xl border border-line bg-white p-5 transition-[border-color,box-shadow] focus-within:border-brand-600/50 focus-within:ring-4 focus-within:ring-brand-600/10 sm:p-6">
                <div className="flex items-center gap-3">
                  <span className="flex-none text-[20px] font-medium text-ink-300">LKR</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    value={amount}
                    // Group as they type, so the field reads the way the
                    // preview and the answer will.
                    onChange={(e) => setAmount(groupDigits(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && amount.trim()) handOver(draft);
                    }}
                    placeholder="250,000"
                    aria-label={`Amount in LKR, ${monthly ? "per month" : "per year"}`}
                    className="tnum min-w-0 flex-1 bg-transparent text-[30px] font-semibold tracking-[-0.02em] text-ink-900 outline-none placeholder:text-ink-200 focus-visible:outline-none sm:text-[34px]"
                  />
                </div>

                <div className="mt-5 flex gap-[3px] rounded-[10px] bg-panel p-[3px]">
                  {[
                    [true, "a month"],
                    [false, "a year"],
                  ].map(([val, label]) => (
                    <button
                      key={String(val)}
                      type="button"
                      onClick={() => setMonthly(val as boolean)}
                      aria-pressed={monthly === val}
                      className={`flex-1 rounded-[7px] py-[9px] text-[13.5px] transition-all ${
                        monthly === val
                          ? "bg-white font-semibold text-ink-900 shadow-[0_1px_2px_rgba(14,20,48,0.08)]"
                          : "font-medium text-ink-400 hover:text-ink-700"
                      }`}
                    >
                      {label as string}
                    </button>
                  ))}
                </div>
              </div>

              {/* What will land in the box. Shown so nothing is a surprise. */}
              {amount.trim() && (
                <div className="fade-up mt-4 rounded-xl border border-line bg-panel px-4 py-3">
                  <div className="text-[13px] font-medium text-ink-400">Your question</div>
                  <p className="mt-1 text-[15px] leading-[1.55] text-ink-900">{draft}</p>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => handOver(draft)}
                  disabled={!amount.trim() || leaving}
                  className="flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-[14.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue
                  <Arrow />
                </button>
                <button
                  type="button"
                  onClick={() => handOver(buildDraft(work ?? "employed", goal ?? "owe", "", monthly, ya))}
                  disabled={leaving}
                  className="text-[13.5px] font-medium text-ink-400 transition-colors hover:text-ink-700"
                >
                  I would rather type it myself
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="flex-none px-5 pb-8 text-center sm:px-8">
        <p className="mx-auto max-w-[520px] text-[12px] leading-[1.6] text-ink-300">
          Nothing here is saved to your account. Your name, NIC and employer are
          never sent anywhere.
        </p>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function Card({
  icon, name, desc, onClick, busy, disabled,
}: {
  icon: string; name: string; desc: string;
  onClick: () => void; busy?: boolean; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex items-center gap-4 rounded-xl border border-line bg-white px-4 py-4 text-left transition-colors hover:border-brand-600/60 hover:bg-panel disabled:cursor-wait disabled:opacity-60 sm:px-5"
    >
      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-brand-050 text-brand-600">
        <Icon name={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-semibold text-ink-900">{name}</span>
        <span className="mt-[3px] block text-[13.5px] leading-[1.5] text-ink-400">{desc}</span>
      </span>
      <span
        className={`flex-none transition-all ${
          busy ? "text-brand-600" : "text-ink-200 group-hover:translate-x-1 group-hover:text-brand-600"
        }`}
      >
        {busy ? <Spinner /> : <Arrow />}
      </span>
    </button>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-5 flex items-center gap-1.5 text-[13.5px] text-ink-400 transition-colors hover:text-ink-900"
    >
      <Arrow back />
      Back
    </button>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="animate-spin">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
