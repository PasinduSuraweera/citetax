import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

/**
 * Sign in and create account. Ported from screen 01 of the Claude Design set.
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
  const { mode, next } = await searchParams;
  if (session?.user) redirect(next ?? "/");

  const signup = mode === "signup";
  // A new account lands on onboarding; a returning user goes where they meant.
  const destination = next ?? (signup ? "/welcome" : "/");

  return (
    <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:flex-row lg:overflow-hidden">
      {/* Story panel. On mobile it becomes a compact header rather than
          600px of scrolling before the button. */}
      <div className="flex flex-none flex-col justify-between bg-ink-900 px-6 py-8 sm:px-10 lg:w-[600px] lg:px-[52px] lg:py-14">
        <div className="flex items-center justify-between">
          <Link href="/">
            <div className="text-[22px] font-bold leading-none tracking-[-0.025em] text-white sm:text-[26px]">
              Citetax
            </div>
            <div className="mt-[6px] text-[13px] text-white/45">Every number, cited.</div>
          </Link>
          <Link
            href="/"
            className="font-mono text-[11px] text-white/40 transition-colors hover:text-white/80 lg:hidden"
          >
            skip
          </Link>
        </div>

        <div className="hidden lg:block">
          <h1 className="max-w-[440px] text-[38px] font-semibold leading-[1.15] tracking-[-0.03em] text-white">
            Three versions of the same circular were issued in one week.
          </h1>
          <p className="mt-5 max-w-[430px] text-[16px] leading-[1.65] text-white/[0.52]">
            Citetax answers only from the law in force for your year of
            assessment, and shows you the dates it applied. If a figure cannot be
            traced to a rule, it is not released.
          </p>
          <div className="mt-[30px] flex flex-wrap gap-[10px]">
            {[
              "No model in the arithmetic",
              "Identifiers stripped before any hosted call",
            ].map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-white/[0.16] px-[13px] py-[7px] font-mono text-xs font-medium text-white/70"
              >
                {chip}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-6 text-xs text-white/30 lg:mt-0">
          Personal income tax only. Y/A 2025/2026 and 2026/2027. Not tax advice.
        </div>
      </div>

      <div className="flex flex-1 flex-col justify-center bg-panel px-6 py-10 sm:px-10 lg:px-[84px] lg:py-14">
        <div className="mx-auto w-full max-w-[392px]">
          <h2 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.028em] text-ink-900 sm:text-[30px]">
            {signup ? "Create your account" : "Sign in"}
          </h2>
          <p className="mt-[9px] text-[14.5px] leading-[1.55] text-ink-500">
            {signup
              ? "Free. Your computations are kept so you can re-check them against the corpus snapshot they ran on, and your identifiers are never stored."
              : "Welcome back. Your history is stamped with the snapshot each answer was computed against."}
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
              className="flex w-full items-center justify-center gap-3 rounded-[9px] border border-line-strong bg-white py-3 text-sm font-medium text-ink-900 transition-colors hover:border-brand-600 hover:shadow-[0_1px_3px_rgba(14,20,48,0.08)]"
            >
              <GoogleMark />
              {signup ? "Sign up with Google" : "Continue with Google"}
            </button>
          </form>

          <p className="mt-3 text-center text-[12px] text-ink-300">
            {signup ? "Already have an account? " : "New to Citetax? "}
            <Link
              href={signup ? "/signin" : "/signin?mode=signup"}
              className="font-medium text-brand-600 hover:underline"
            >
              {signup ? "Sign in" : "Create one"}
            </Link>
          </p>

          <div className="my-[22px] flex items-center gap-3">
            <div className="h-px flex-1 bg-[#DFE5F2]" />
            <span className="font-mono text-[11px] font-medium tracking-[0.1em] text-ink-200">
              OR
            </span>
            <div className="h-px flex-1 bg-[#DFE5F2]" />
          </div>

          <Link
            href="/"
            className="block rounded-[9px] border border-line-strong bg-white py-3 text-center text-sm font-medium text-ink-700 transition-colors hover:border-brand-600"
          >
            Continue without an account
          </Link>
          <p className="mt-2 text-center text-[11.5px] leading-[1.5] text-ink-300">
            You can ask anything. Answers just are not saved to a history.
          </p>

          <div className="mt-[26px] flex items-start gap-[9px] rounded-[9px] bg-brand-050 px-[13px] py-3">
            <span className="mt-[1px] font-mono text-[11px] font-semibold text-brand-600">
              i
            </span>
            <span className="text-[12.5px] leading-[1.5] text-ink-700">
              Citetax covers personal income tax for two years of assessment. VAT,
              company tax and advisory questions are refused with a reason.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.8-6.8C35.6 2.5 30.1 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.1 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.2 5.6c4.2-3.9 6.6-9.6 6.6-16.4z"
      />
      <path
        fill="#FBBC05"
        d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.2-8.7 2.2-6.3 0-11.6-3.6-13.5-8.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}
