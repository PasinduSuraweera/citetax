import Link from "next/link";
import { redirect } from "next/navigation";
import { continueAsGuest } from "@/app/actions";
import { auth, signIn } from "@/auth";
import { LogoFull, Logo } from "@/components/Logo";
import { money } from "@/lib/api";
import { safeNext } from "@/lib/guest";
import { SAMPLE_MONTHLY, sampleLedger } from "@/lib/sample";

/**
 * Sign in and create account.
 *
 * Google is the only provider, so "sign up" and "sign in" are the same OAuth
 * call. They are still presented as two modes, because a first time visitor
 * asked to "sign in" to a service they have never used hesitates. The copy
 * changes; the button does the same thing.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; next?: string }>;
}) {
  const session = await auth();
  const { mode, next: rawNext } = await searchParams;
  // Only ever a path on this site, so the page cannot bounce anyone elsewhere.
  const next = safeNext(rawNext);
  if (session?.user) redirect(next ?? "/chat");

  const signup = mode === "signup";
  // A new account lands on onboarding; a returning user goes where they meant.
  const destination = next ?? (signup ? "/welcome" : "/chat");
  const ledger = await sampleLedger();
  const taxable = ledger?.steps.find((s) => s.rule_key === "charge.taxable_income");
  const relief = ledger?.steps.find((s) => s.rule_key === "relief.personal");

  return (
    <div className="flex min-h-dvh flex-col bg-background lg:flex-row">
      {/* The brand side. On a phone it shrinks to the logo, so the button is
          on the first screen. */}
      <aside className="relative flex flex-none flex-col bg-sidebar px-6 py-6 text-white sm:px-10 lg:w-[46%] lg:max-w-[640px] lg:px-14 lg:py-12">
        <Link href="/" className="self-start" aria-label="Citetax home">
          <LogoFull height={52} tone="dark" priority className="hidden lg:block" />
          <Logo height={34} tone="dark" priority className="lg:hidden" />
        </Link>

        <div className="hidden flex-1 flex-col justify-center py-12 lg:flex">
          <h1 className="max-w-[16ch] text-[36px] font-semibold leading-[1.1] tracking-[-0.025em]">
            Every figure, with the law behind it.
          </h1>
          <p className="mt-4 max-w-[44ch] text-[16px] leading-[1.6] text-white/65">
            Citetax works out Sri Lankan personal income tax from the rules in
            force for your year, and names the section that produced each line.
          </p>

          {ledger && taxable && relief && (
            <figure className="mt-10 max-w-[420px] rounded-xl bg-white/[0.06] p-5 ring-1 ring-inset ring-white/10">
              <figcaption className="text-[13px] text-white/55">
                Salary of LKR {money(SAMPLE_MONTHLY)} a month, {ledger.ya}
              </figcaption>
              <dl className="mt-3 divide-y divide-white/10">
                {[relief, taxable].map((s) => (
                  <div key={s.step_no} className="flex items-baseline justify-between gap-4 py-2.5">
                    <dt>
                      <span className="block text-[14.5px]">{s.label}</span>
                      <span className="statute text-[13px] italic text-white/50">{s.citation_label}</span>
                    </dt>
                    <dd className="tnum text-[14.5px]">{money(s.value, { decimals: false })}</dd>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-4 pt-3">
                  <dt className="text-[14.5px] font-semibold">Tax for the year</dt>
                  <dd className="tnum text-[22px] font-semibold text-sidebar-primary">
                    {money(ledger.balance_payable.replace(/^-/, ""), { decimals: false })}
                  </dd>
                </div>
              </dl>
            </figure>
          )}
        </div>

        <p className="hidden text-[12.5px] text-white/40 lg:block">
          Personal income tax only, for 2025/2026 and 2026/2027. Not tax advice.
        </p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-6 py-12 sm:px-10">
        <div className="w-full max-w-[380px]">
          <h2 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink-900">
            {signup ? "Create your account" : "Sign in to Citetax"}
          </h2>
          <p className="mt-2 text-[15px] leading-[1.6] text-ink-500">
            {signup
              ? "Free. Your answers are kept with the rules they were worked out from, and your ID numbers are never stored."
              : "Pick up your chats and history where you left them."}
          </p>

          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: destination });
            }}
            className="mt-8"
          >
            <button
              type="submit"
              className="flex h-11 w-full items-center justify-center gap-3 rounded-lg border border-line-strong bg-white text-[15px] font-medium text-ink-900 shadow-[0_1px_2px_rgba(16,34,74,0.06)] transition-colors hover:border-ink-300 hover:bg-panel active:bg-muted"
            >
              <GoogleMark />
              {signup ? "Sign up with Google" : "Continue with Google"}
            </button>
          </form>

          <p className="mt-4 text-center text-[13.5px] text-ink-500">
            {signup ? "Already have an account? " : "New to Citetax? "}
            <Link
              href={`/signin${signup ? "" : "?mode=signup"}${next ? `${signup ? "?" : "&"}next=${encodeURIComponent(next)}` : ""}`}
              className="font-medium text-brand-600 underline-offset-4 hover:underline"
            >
              {signup ? "Sign in" : "Create an account"}
            </Link>
          </p>

          <div className="my-7 flex items-center gap-3 text-[12.5px] text-ink-300">
            <div className="h-px flex-1 bg-line" />
            or
            <div className="h-px flex-1 bg-line" />
          </div>

          <form action={continueAsGuest}>
            {next && <input type="hidden" name="next" value={next} />}
            <button
              type="submit"
              className="h-11 w-full rounded-lg bg-secondary text-[15px] font-medium text-ink-900 transition-colors hover:bg-canvas active:bg-line"
            >
              Continue without an account
            </button>
          </form>
          <p className="mt-3 text-center text-[13px] leading-[1.5] text-ink-400">
            You can ask anything. Answers are just not kept.
          </p>

          <p className="mt-12 text-center text-[13px] text-ink-400">
            <Link href="/" className="hover:text-ink-900">Back to the homepage</Link>
          </p>
        </div>
      </main>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.8-6.8C35.6 2.5 30.1 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.1 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.2 5.6c4.2-3.9 6.6-9.6 6.6-16.4z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.2-8.7 2.2-6.3 0-11.6-3.6-13.5-8.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
