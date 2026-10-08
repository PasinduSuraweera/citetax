import Link from "next/link";
import { askFromHome } from "@/app/actions";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { API_BASE, formatDate, money, type ComputeResponse, type Snapshot } from "@/lib/api";

/**
 * The homepage, for someone who has not used Citetax yet (see proxy.ts).
 *
 * The ledger on the right is not an illustration. It is computed by the
 * engine when the page renders, from the rules in force, so what it shows is
 * exactly what the chat would answer. If the API cannot be reached the ledger
 * is left out rather than shown with made up figures.
 */

const SAMPLE_MONTHLY = "250000";
const SAMPLE_YA = "2026/2027";

const QUESTIONS: Array<[string, string[]]> = [
  ["What you owe", [
    "I earn LKR 250,000 a month and LKR 1,500,000 a year from freelance work. What do I owe for 2026/2027?",
    "I freelance for clients abroad and earn LKR 6,000,000 a year, paid in USD. What is my tax for 2026/2027?",
  ]],
  ["Whether and when to file", [
    "Do I need to file a return if my only income is a salary of LKR 300,000 a month?",
    "When is my return due for 2025/2026?",
  ]],
  ["The rules themselves", [
    "What is the personal relief this year?",
    "What changed between 2025/2026 and 2026/2027?",
  ]],
];

const CHECKS = [
  ["Your details stay here.", "Names, NIC numbers and employers are removed from a question before any part of it is sent to a language model."],
  ["The right year's law.", "Rules are chosen by year of assessment and effective date, in code. A model never decides which rate applies."],
  ["Arithmetic without a model.", "Every figure comes from the rules table and plain code, so the same question gives the same answer every time."],
  ["Checked before you see it.", "Each number in the written explanation is matched against the ledger and the law. If one does not match, the explanation is withheld and you still get the figures."],
];

async function sampleLedger(): Promise<ComputeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/compute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ya: SAMPLE_YA, employment_income: String(Number(SAMPLE_MONTHLY) * 12) }),
      next: { revalidate: 3600 },
    });
    return res.ok ? ((await res.json()) as ComputeResponse) : null;
  } catch {
    return null;
  }
}

async function currentSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/snapshot/current`, { next: { revalidate: 3600 } });
    return res.ok ? ((await res.json()) as Snapshot) : null;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const [ledger, snapshot] = await Promise.all([sampleLedger(), currentSnapshot()]);

  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/" aria-label="Citetax home">
          <Logo height={36} priority />
        </Link>
        <nav className="flex items-center gap-1 text-[14px] sm:gap-2">
          <Link href="/deadlines" className="hidden rounded-md px-3 py-2 text-ink-500 hover:text-ink-900 sm:block">
            Deadlines
          </Link>
          <Link href="/compare" className="hidden rounded-md px-3 py-2 text-ink-500 hover:text-ink-900 sm:block">
            What changed
          </Link>
          <Link href="/signin" className="rounded-md px-3 py-2 font-medium text-ink-900 hover:bg-muted">
            Sign in
          </Link>
        </nav>
      </header>

      <main>
        {/* The question and the proof side by side: what you type, and what
            comes back. */}
        <section className="mx-auto grid max-w-[1180px] gap-12 px-5 pb-20 pt-10 sm:px-8 lg:grid-cols-12 lg:gap-10 lg:pt-16">
          <div className="lg:col-span-6 lg:pt-6">
            <h1 className="max-w-[14ch] text-balance text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink-900 sm:text-[54px]">
              Your income tax, worked out line by line.
            </h1>
            <p className="mt-6 max-w-[46ch] text-[17px] leading-[1.6] text-ink-500">
              Ask about Sri Lankan personal income tax in plain words. Every
              figure in the answer comes from the rules in force for your year,
              with the section of the Act beside it.
            </p>

            <form action={askFromHome} className="mt-9 max-w-[560px]">
              <label htmlFor="home-question" className="text-[14px] font-medium text-ink-900">
                Your question
              </label>
              <textarea
                id="home-question"
                name="question"
                rows={3}
                maxLength={600}
                required
                placeholder="My salary is LKR 250,000 a month. What do I owe for 2026/2027?"
                className="mt-2 block w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-[16px] leading-[1.5] text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus-visible:border-brand-600 focus-visible:ring-3 focus-visible:ring-brand-600/15"
              />
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
                <Button type="submit" size="lg" className="h-10 px-5 text-[15px]">
                  Ask Citetax
                </Button>
                <span className="text-[13.5px] text-ink-400">
                  No account needed.{" "}
                  <Link href="/signin?mode=signup" className="font-medium text-ink-700 underline-offset-4 hover:underline">
                    Create one
                  </Link>{" "}
                  to keep your history.
                </span>
              </div>
            </form>
          </div>

          {ledger && (
            <figure className="lg:col-span-6 lg:col-start-7 xl:col-span-5 xl:col-start-8">
              <div className="rounded-xl border border-line bg-white">
                <div className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
                  <div>
                    <div className="text-[15px] font-semibold text-ink-900">
                      Salary of LKR {money(SAMPLE_MONTHLY)} a month
                    </div>
                    <div className="mt-[2px] text-[13px] text-ink-400">Year of assessment {ledger.ya}</div>
                  </div>
                  <div className="text-[13px] text-ink-400">LKR</div>
                </div>

                <ol className="px-5 py-1 sm:px-6">
                  {ledger.steps.filter((s) => !s.is_zero).map((s) => (
                    <li
                      key={s.step_no}
                      className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-line-faint py-[10px] last:border-0"
                    >
                      <span className="text-[14.5px] text-ink-900">{s.label}</span>
                      <span className="tnum text-right text-[14.5px] text-ink-900">
                        {money(s.value, { decimals: false })}
                      </span>
                      {s.citation_label && (
                        <span className="statute col-span-2 text-[13px] italic leading-[1.45] text-ink-400">
                          {s.citation_label}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>

                <div className="flex items-baseline justify-between gap-4 rounded-b-xl bg-brand-050 px-5 py-4 sm:px-6">
                  <span className="text-[15px] font-semibold text-ink-900">
                    {ledger.is_refund ? "Refund due" : "Tax for the year"}
                  </span>
                  <span className="tnum text-[26px] font-semibold tracking-[-0.02em] text-brand-700">
                    {money(ledger.balance_payable.replace(/^-/, ""), { decimals: false })}
                  </span>
                </div>
              </div>
              <figcaption className="mt-3 max-w-[52ch] text-[13px] leading-[1.55] text-ink-400">
                Worked out just now by the same engine the chat uses. Lines
                with nothing to deduct are left out, and APIT your employer
                has already deducted is not taken off here.
                {ledger.compliance?.return_due
                  ? ` The return for this year is due ${formatDate(String(ledger.compliance.return_due))}.`
                  : ""}
              </figcaption>
            </figure>
          )}
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-[1180px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-12 lg:py-20">
            <div className="lg:col-span-4">
              <h2 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink-900">
                Questions it answers
              </h2>
              <p className="mt-3 max-w-[34ch] text-[15px] leading-[1.6] text-ink-500">
                Choose one to ask it now. VAT, company tax and requests for
                advice are declined with the reason, never guessed at.
              </p>
            </div>
            <div className="grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:col-span-8 lg:grid-cols-3">
              {QUESTIONS.map(([group, qs]) => (
                <div key={group}>
                  <h3 className="text-[14px] font-semibold text-ink-900">{group}</h3>
                  <ul className="mt-3 space-y-1">
                    {qs.map((q) => (
                      <li key={q}>
                        <form action={askFromHome}>
                          <input type="hidden" name="question" value={q} />
                          <button
                            type="submit"
                            className="-mx-2 rounded-md px-2 py-[6px] text-left text-[15px] leading-[1.5] text-ink-700 decoration-brand-600/40 underline-offset-4 hover:bg-white hover:text-ink-900 hover:underline"
                          >
                            {q}
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="text-[15px] leading-[1.6] text-ink-500 sm:col-span-2 lg:col-span-3">
                Signed in, you can also upload a payslip. With your agreement it
                is sent to Google&apos;s Gemini model to read the figures, which you
                check before anything is worked out. Citetax never stores the image.
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-[1180px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-12 lg:py-24">
          <h2 className="text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink-900 lg:col-span-4">
            What happens to a question
          </h2>
          <ol className="grid gap-x-12 gap-y-8 sm:grid-cols-2 lg:col-span-8">
            {CHECKS.map(([title, body], i) => (
              <li key={title} className="grid grid-cols-[2.25rem_1fr]">
                <span className="tnum text-[15px] font-semibold text-brand-600">{i + 1}</span>
                <div>
                  <h3 className="text-[16px] font-semibold text-ink-900">{title}</h3>
                  <p className="mt-2 text-[15px] leading-[1.6] text-ink-500">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-3 px-5 py-8 text-[13.5px] text-ink-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>
            Personal income tax for 2025/2026 and 2026/2027.
            {snapshot ? ` Rules as of ${snapshot.label}.` : ""} Not tax advice.
          </span>
          <span className="flex gap-5">
            <Link href="/deadlines" className="hover:text-ink-900">Deadlines</Link>
            <Link href="/compare" className="hover:text-ink-900">What changed</Link>
            <Link href="/signin" className="hover:text-ink-900">Sign in</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
