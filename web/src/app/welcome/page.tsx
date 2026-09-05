"use client";

/**
 * Onboarding. Three steps, ported from screen 02 of the Claude Design set.
 *
 * Nothing here is required and nothing is sent anywhere: the choices set the
 * default year and seed the first question. Asking for income types up front
 * would imply we store a profile, and we do not. The panel on the right says
 * what is never sent, because the first run is when that promise matters.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SUPPORTED_YAS, type YA } from "@/components/Shell";
import { useSession } from "@/lib/session";

const INCOME_TYPES = [
  { key: "employment", name: "Employment", desc: "Salary, wages, allowances, bonuses", rule: "Act s.5" },
  { key: "business", name: "Business or freelance", desc: "Self employed, consulting, invoicing clients", rule: "Act s.5" },
  { key: "investment", name: "Investment", desc: "Interest, dividends, rent", rule: "Act s.5" },
  { key: "other", name: "Other", desc: "Anything not covered above", rule: "Act s.5" },
];

const NEVER_STORED = [
  { what: "Your NIC or TIN", how: "Stripped by pattern match before anything is sent" },
  { what: "Your name", how: "Replaced with a placeholder at intake" },
  { what: "Your employer", how: "Tagged and masked; it does not affect a computation" },
  { what: "Payslip text", how: "Only the extracted figures continue past intake" },
];

const STARTERS: Record<string, string> = {
  employment: "What do I owe for {ya} on a salary of LKR 250,000 a month, with EPF deducted?",
  business: "I invoiced 2,500,000 freelance in {ya}. What is my tax?",
  investment: "I earned 400,000 in interest and 1,800,000 salary in {ya}. What do I owe?",
  other: "Do I need to file a return for {ya}?",
};

export default function WelcomePage() {
  const router = useRouter();
  const { user, loading } = useSession();
  const [step, setStep] = useState(1);
  const [ya, setYa] = useState<YA>("2026/2027");
  const [types, setTypes] = useState<Set<string>>(new Set(["employment"]));

  // Onboarding is for a signed in account. Anyone else belongs at sign in.
  useEffect(() => {
    if (!loading && !user) router.replace("/signin?mode=signup");
  }, [loading, user, router]);

  const toggle = (key: string) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const finish = () => {
    const primary = INCOME_TYPES.find((t) => types.has(t.key))?.key ?? "employment";
    const q = (STARTERS[primary] ?? STARTERS.employment).replace("{ya}", ya);
    router.push(`/?q=${encodeURIComponent(q)}`);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <span className="font-mono text-[12px] text-ink-300">Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-[62px] flex-none items-center justify-between border-b border-line bg-white px-5 sm:px-8">
        <Link href="/" className="text-[19px] font-bold tracking-[-0.025em] text-ink-900">
          Citetax
        </Link>

        <div className="hidden items-center gap-4 sm:flex">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <span
                className={`flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full font-mono text-[10.5px] font-semibold ${
                  n === step
                    ? "bg-brand-600 text-white"
                    : n < step
                      ? "bg-good-100 text-good-600"
                      : "bg-panel text-ink-300"
                }`}
              >
                {n < step ? "✓" : n}
              </span>
              <span className={`text-[12.5px] font-medium ${n === step ? "text-ink-900" : "text-ink-300"}`}>
                {["Year", "Income", "Privacy"][n - 1]}
              </span>
            </div>
          ))}
        </div>

        <Link href="/" className="text-[13px] font-medium text-ink-300 hover:text-ink-700">
          Skip for now
        </Link>
      </header>

      <div className="flex flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:flex-row lg:gap-12 lg:px-14 lg:py-11">
        <div className="min-w-0 flex-1 lg:max-w-[680px]">
          <div className="font-mono text-[11px] tracking-[0.16em] text-ink-300">
            STEP {step} OF 3
          </div>

          {step === 1 && (
            <div className="fade-up">
              <h1 className="mt-3 text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[33px]">
                {user?.name ? `Welcome, ${user.name.split(" ")[0]}.` : "Welcome."}
                <br />
                Which year of assessment?
              </h1>
              <p className="mt-3 max-w-[560px] text-[15px] leading-[1.6] text-ink-500">
                Every rule resolves against a year, so Citetax never leaves it
                implicit. You can change it on any question later.
              </p>

              <div className="mt-7 flex flex-col gap-3 sm:max-w-[460px]">
                {SUPPORTED_YAS.map((year) => {
                  const on = year === ya;
                  return (
                    <button
                      key={year}
                      type="button"
                      onClick={() => setYa(year)}
                      aria-pressed={on}
                      className={`flex items-center justify-between rounded-xl border bg-white px-5 py-4 text-left transition-all ${
                        on
                          ? "border-brand-600 shadow-[0_0_0_3px_rgba(43,68,199,0.10)]"
                          : "border-line hover:border-line-strong"
                      }`}
                    >
                      <div>
                        <div className="tnum font-mono text-[17px] font-semibold text-ink-900">
                          {year.replace("/", " / ")}
                        </div>
                        <div className="mt-1 text-[12.5px] text-ink-400">
                          1 April {year.split("/")[0]} to 31 March {year.split("/")[1]}
                        </div>
                      </div>
                      <span
                        className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 ${
                          on ? "border-brand-600 bg-brand-600 text-white" : "border-line-strong"
                        }`}
                      >
                        {on && <span className="text-[9px] font-bold">✓</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="fade-up">
              <h1 className="mt-3 text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[33px]">
                Where does your income come from?
              </h1>
              <p className="mt-3 max-w-[560px] text-[15px] leading-[1.6] text-ink-500">
                This only shapes the first question we suggest. Nothing is stored
                against your account, and you can ask about anything regardless.
              </p>

              <div className="mt-7 flex flex-col gap-[10px] lg:max-w-[600px]">
                {INCOME_TYPES.map((t) => {
                  const on = types.has(t.key);
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => toggle(t.key)}
                      aria-pressed={on}
                      className={`flex items-start gap-[14px] rounded-xl border bg-white px-4 py-4 text-left transition-all sm:px-[18px] ${
                        on
                          ? "border-brand-600 shadow-[0_0_0_3px_rgba(43,68,199,0.10)]"
                          : "border-line hover:border-line-strong"
                      }`}
                    >
                      <span
                        className={`mt-[2px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border-2 text-[10px] font-bold text-white ${
                          on ? "border-brand-600 bg-brand-600" : "border-line-strong"
                        }`}
                      >
                        {on && "✓"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-semibold text-ink-900">{t.name}</div>
                        <div className="mt-1 text-[13px] leading-[1.5] text-ink-400">{t.desc}</div>
                      </div>
                      <span className="hidden flex-none rounded-[5px] bg-panel px-[7px] py-1 font-mono text-[11px] text-ink-300 sm:block">
                        {t.rule}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="fade-up">
              <h1 className="mt-3 text-[27px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900 sm:text-[33px]">
                What Citetax never sends
              </h1>
              <p className="mt-3 max-w-[560px] text-[15px] leading-[1.6] text-ink-500">
                Identifiers are stripped in process before any hosted call. The
                model receives structured facts and law text, never an identity.
              </p>

              <div className="mt-7 rounded-xl bg-ink-900 px-5 py-6 sm:px-6 lg:max-w-[600px]">
                <div className="font-mono text-[10px] tracking-[0.16em] text-white/40">
                  NEVER LEAVES THIS SERVER
                </div>
                <div className="mt-4 flex flex-col gap-3">
                  {NEVER_STORED.map((n) => (
                    <div key={n.what} className="flex items-start gap-[10px]">
                      <span className="mt-[2px] font-mono text-[11px] font-semibold text-[#F5A9A2]">✕</span>
                      <div>
                        <div className="text-[13.5px] font-semibold text-white">{n.what}</div>
                        <div className="mt-[2px] text-[12px] leading-[1.45] text-white/45">{n.how}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-5 border-t border-white/10 pt-[14px] text-[12px] leading-[1.55] text-white/50">
                  The figures a computation needs are deliberately preserved,
                  which is the harder half of the job.
                </p>
              </div>

              <div className="mt-4 rounded-xl border border-line bg-white px-5 py-4 text-[13.5px] leading-[1.6] text-ink-500 lg:max-w-[600px]">
                Citetax is a computation aid, not a tax agent. Every figure is
                traced to a rule version so you can check it, and you can flag any
                step that looks wrong.
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="rounded-lg border border-line-strong bg-white px-5 py-[11px] text-[14px] font-medium text-ink-700 transition-colors hover:border-brand-600"
              >
                Back
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                disabled={step === 2 && types.size === 0}
                className="rounded-lg bg-brand-600 px-6 py-[11px] text-[14px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                onClick={finish}
                className="rounded-lg bg-brand-600 px-6 py-[11px] text-[14px] font-semibold text-white transition-colors hover:bg-brand-700"
              >
                Ask my first question
              </button>
            )}
          </div>
        </div>

        {/* Aside. Below lg it drops entirely: the steps carry the message. */}
        <aside className="hidden w-[330px] flex-none flex-col gap-3 lg:flex">
          <div className="rounded-xl border border-line bg-white px-5 py-5">
            <div className="eyebrow">HOW AN ANSWER IS BUILT</div>
            <ol className="mt-4 flex flex-col gap-3">
              {[
                ["Identifiers stripped", "In process, before any hosted call"],
                ["The agent picks a plan", "A deadline question skips the arithmetic"],
                ["Rules resolved by date", "One version, or a refusal. Never a guess"],
                ["Computed in plain Python", "No model touches a number"],
                ["Every figure verified", "Untraceable prose is withheld, figures stand"],
              ].map(([title, sub], i) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-[2px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-panel font-mono text-[10px] font-semibold text-ink-400">
                    {i + 1}
                  </span>
                  <div>
                    <div className="text-[13px] font-medium text-ink-900">{title}</div>
                    <div className="mt-[2px] text-[11.5px] leading-[1.45] text-ink-400">{sub}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="rounded-xl border border-line bg-white px-5 py-5">
            <div className="eyebrow">SCOPE</div>
            <p className="mt-[11px] text-[13px] leading-[1.6] text-ink-500">
              Personal income tax for {SUPPORTED_YAS.join(" and ")}. VAT, company
              tax and advisory questions are refused with a reason and a pointer
              to the right IRD resource.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
