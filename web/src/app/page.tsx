import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowDown, Check } from "lucide-react";
import { askFromHome } from "@/app/actions";
import { HeroDemo, type HeroLine } from "@/components/home/HeroDemo";
import { HomeNav } from "@/components/home/HomeNav";
import { Reveal } from "@/components/home/Reveal";
import { UseList } from "@/components/home/UseList";
import { formatDate, type ComputeResponse } from "@/lib/api";
import { isKnownVisitor } from "@/lib/guest";
import { HERO_QUESTION, currentSnapshot, heroAnswer, planSummary, starterAnswers, type Starter, type StarterKey } from "@/lib/sample";

/**
 * The homepage, the first screen for everyone (see proxy.ts).
 *
 * Nothing on it is an illustration. The hero video was rendered from a real
 * answer (see /video), and every figure in the paper cards below is computed
 * by the engine when the page renders, from the rules in force. Each section
 * has a scenario of its own. If the API cannot be reached the figures are
 * left out, never made up.
 */

const USES = [
  { label: "Tax on a salary", question: "How is tax on a salary worked out?" },
  { label: "Freelance and professional fees", question: "How is freelance income taxed?" },
  { label: "Clients paid in dollars", question: "How is income from clients abroad taxed?" },
  { label: "Whether to file a return", question: "Who needs to file an income tax return?" },
  { label: "Return and instalment dates", question: "When is my return due for 2025/2026?" },
  { label: "What changed in the law", question: "What changed between 2025/2026 and 2026/2027?" },
  { label: "EPF and APIT", question: "Is EPF deductible?" },
  { label: "The personal relief", question: "What is the personal relief this year?" },
];

const TRUST = [
  ["Your NIC never reaches a model", "Names, NIC and TIN numbers and employers are removed from a question before any part of it leaves Citetax."],
  ["Two people sign every change to the law", "A new rate or relief is read from the published source, then signed by two different reviewers before any answer uses it."],
  ["Every answer can be run again", "Each answer records the rules and the date of the law it used, so it can be checked, or asked again under today's law."],
  ["A payslip is read only with your agreement", "It goes to Google's Gemini model to read the figures, which you check before anything is worked out. The image is never stored."],
];

function lkr(v: string | number): string {
  return `LKR ${Math.round(Number(v)).toLocaleString("en-GB")}`;
}

function step(c: ComputeResponse, key: string) {
  return c.steps.find((s) => s.rule_key === key && !s.is_zero);
}

/* --------------------------------------------------------------- pieces */

function AskForm({ question, label, dark = false }: { question: string; label: string; dark?: boolean }) {
  return (
    <form action={askFromHome}>
      <input type="hidden" name="question" value={question} />
      <button
        type="submit"
        className={`inline-flex h-11 items-center rounded-full px-5 text-[14.5px] font-medium transition-colors ${
          dark ? "bg-white text-ink-900 hover:bg-white/85" : "bg-ink-900 text-white hover:bg-ink-700"
        }`}
      >
        {label}
      </button>
    </form>
  );
}

function Paper({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-ink-900/10 bg-white p-5 shadow-[0_24px_50px_-28px_rgba(1,33,81,0.45)] ${className}`}>
      {children}
    </div>
  );
}

function Cite({ children }: { children: React.ReactNode }) {
  return <span className="statute inline-block rounded-md bg-ink-900/[0.05] px-2 py-0.5 text-[13.5px] italic text-ink-700">{children}</span>;
}

function Stamp({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white py-1.5 pl-1.5 pr-4 text-[14px] text-good-700 shadow-[0_10px_30px_-14px_rgba(1,33,81,0.4)] ring-1 ring-good-300">
      <span className="flex size-6 items-center justify-center rounded-full bg-good-600 text-white"><Check className="size-3.5" strokeWidth={3} /></span>
      {children}
    </span>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line-faint py-2 text-[14px]">
      <span className="text-ink-500">{label}</span>
      <span className={`tnum whitespace-nowrap ${strong ? "font-semibold text-ink-900" : "text-ink-700"}`}>{value}</span>
    </div>
  );
}

/* The three scenarios, each drawn from its own computation. */

function SalaryCards({ c }: { c: ComputeResponse }) {
  const apit = step(c, "credit.apit");
  return (
    <div className="relative mx-auto w-full max-w-[460px] sm:h-[330px]">
      <Paper className="absolute left-0 top-6 hidden w-[210px] sm:block -rotate-3 bg-[#fbfaf6]">
        <div className="text-[14px] font-medium text-ink-900">Payslip</div>
        <div className="text-[12.5px] text-ink-400">September</div>
        <div className="mt-8 text-[12.5px] text-ink-400">Monthly salary</div>
        <div className="tnum text-[22px] font-semibold text-ink-900">LKR 275,000</div>
        <div className="mt-3 h-1.5 w-24 rounded-full bg-ink-900/10" />
        <div className="mt-2 h-1.5 w-32 rounded-full bg-ink-900/10" />
      </Paper>
      <Paper className="w-full sm:absolute sm:right-0 sm:top-0 sm:w-[280px] rotate-2">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-medium text-ink-900">Filing check</span>
          <span className="rounded bg-brand-100 px-1.5 text-[12px] font-medium text-brand-700">{c.ya}</span>
        </div>
        <div className="mt-3 text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink-900">No return required.</div>
        <div className="mt-4">
          <Line label="Tax for the year" value={lkr(c.gross_tax)} />
          {apit && <Line label="Deducted through APIT" value={lkr(apit.value)} strong />}
        </div>
        {c.compliance?.citation_label && <div className="mt-3"><Cite>{c.compliance.citation_label}</Cite></div>}
      </Paper>
      <div className="mt-5 sm:absolute sm:bottom-2 sm:mt-0 sm:left-10"><Stamp>Covered by your employer</Stamp></div>
    </div>
  );
}

function AbroadCards({ c }: { c: ComputeResponse }) {
  const capped = step(c, "band.foreign_service_cap");
  const taxable = step(c, "charge.taxable_income");
  return (
    <div className="relative mx-auto w-full max-w-[460px] sm:h-[330px]">
      <Paper className="absolute left-0 top-10 hidden w-[220px] sm:block rotate-[-4deg] bg-[#fbfaf6]">
        <div className="text-[14px] font-medium text-ink-900">Client payouts</div>
        <div className="text-[12.5px] text-ink-400">Paid in USD, through a bank</div>
        <div className="mt-8 text-[12.5px] text-ink-400">This year</div>
        <div className="tnum text-[22px] font-semibold text-ink-900">LKR 4,800,000</div>
        <div className="mt-3 h-1.5 w-28 rounded-full bg-ink-900/10" />
      </Paper>
      <Paper className="w-full sm:absolute sm:right-0 sm:top-0 sm:w-[280px] rotate-[1.5deg]">
        <div className="text-[14px] font-medium text-ink-900">Foreign-currency service income</div>
        <div className="mt-3 text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink-900">Taxed at most 15%.</div>
        <div className="mt-4">
          {taxable && <Line label="Taxable income" value={lkr(taxable.value)} />}
          {capped && <Line label="Tax" value={lkr(capped.value)} strong />}
        </div>
        {capped?.citation_label && <div className="mt-3"><Cite>{capped.citation_label}</Cite></div>}
      </Paper>
      <div className="mt-5 sm:absolute sm:bottom-2 sm:mt-0 sm:left-8"><Stamp>Every band capped for you</Stamp></div>
    </div>
  );
}

function SideCards({ c }: { c: ComputeResponse }) {
  const apit = step(c, "credit.apit");
  return (
    <div className="relative mx-auto w-full max-w-[460px] sm:h-[330px]">
      <Paper className="absolute left-0 top-8 hidden w-[210px] sm:block -rotate-2 bg-[#fbfaf6]">
        <div className="text-[14px] font-medium text-ink-900">Tuition fees</div>
        <div className="text-[12.5px] text-ink-400">Evening classes</div>
        <div className="mt-8 text-[12.5px] text-ink-400">This year</div>
        <div className="tnum text-[22px] font-semibold text-ink-900">LKR 900,000</div>
        <div className="mt-3 h-1.5 w-20 rounded-full bg-ink-900/10" />
      </Paper>
      <Paper className="w-full sm:absolute sm:right-0 sm:top-0 sm:w-[280px] rotate-[2.5deg]">
        <div className="text-[14px] font-medium text-ink-900">Balance payable</div>
        <div className="tnum mt-3 text-[26px] font-semibold tracking-[-0.02em] text-ink-900">{lkr(c.balance_payable)}</div>
        <div className="mt-4">
          <Line label="Tax for the year" value={lkr(c.gross_tax)} />
          {apit && <Line label="Less APIT on the salary" value={lkr(apit.value)} />}
        </div>
        {c.compliance?.return_due && (
          <div className="mt-3 text-[13px] text-ink-500">
            Return due {formatDate(c.compliance.return_due)} {c.compliance.citation_label && <Cite>{c.compliance.citation_label}</Cite>}
          </div>
        )}
      </Paper>
      <div className="mt-5 sm:absolute sm:bottom-2 sm:mt-0 sm:left-10"><Stamp>Salary and fees together</Stamp></div>
    </div>
  );
}

const FEATURES: Record<StarterKey, { title: string; body: string; points: string[]; Cards: React.FC<{ c: ComputeResponse }> }> = {
  salary: {
    title: "Already taxed through your payslip",
    body: "Your employer deducts APIT every month. Citetax counts it, and tells you when that means there is nothing more to pay and no return to file.",
    points: ["APIT from your salary, credited", "Whether you need to file at all", "EPF shown, and why it is not deducted"],
    Cards: SalaryCards,
  },
  abroad: {
    title: "Clients abroad, paid in dollars",
    body: "Income from services used outside Sri Lanka, paid in foreign currency through a bank, is taxed at the ordinary rates but never above 15%.",
    points: ["The 15% maximum on every band", "Relief set where it saves you most", "Foreign tax already paid, credited"],
    Cards: AbroadCards,
  },
  side: {
    title: "A salary and something on the side",
    body: "Tuition, channelling, consulting: fees on top of a salary are taxed with it. Citetax keeps the APIT on the salary and works out the rest.",
    points: ["Salary and fees in one computation", "Business expenses, when you have them", "When the return and payments are due"],
    Cards: SideCards,
  },
};

/* ----------------------------------------------------------------- page */

export default async function HomePage() {
  const [starters, snapshot, plans, jar] = await Promise.all([
    starterAnswers(), currentSnapshot(), planSummary(), cookies(),
  ]);
  const hero = await heroAnswer();
  // The lines that carry a figure; the chat shows every line.
  const heroLines: HeroLine[] = (hero?.steps ?? [])
    .filter((s) => !s.is_zero)
    .map((s) => ({ label: s.label, value: s.value, cite: s.citation_label, assumed: s.detail?.assumed === true }));
  const known = isKnownVisitor(jar.getAll().map((c) => c.name));
  const byKey = Object.fromEntries(starters.map((s) => [s.key, s])) as Record<StarterKey, Starter>;
  const individual = plans?.find((p) => p.key === "individual");

  return (
    <div className="min-h-screen bg-paper text-ink-900">
      <HomeNav known={known} />

      {/* ------------------------------------------------ hero, framed */}
      <section className="mx-auto -mt-14 max-w-[1240px] px-3 pt-14 sm:px-5">
        <div className="grid border-x border-b border-ink-900/10 lg:grid-cols-2">
          <div className="flex flex-col px-6 pb-8 pt-10 sm:px-10 lg:pt-14">
            <h1 className="mt-6 max-w-[12ch] text-[52px] font-semibold leading-[0.98] tracking-[-0.05em] sm:text-[74px] lg:mt-20">
              Your income tax, worked out and cited.
            </h1>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/chat" className="inline-flex h-12 items-center rounded-full bg-ink-900 px-6 text-[15px] font-medium text-white transition-colors hover:bg-ink-700">
                Ask a question
              </Link>
              <Link href="/pricing" className="inline-flex h-12 items-center rounded-full px-5 text-[15px] font-medium text-ink-900 ring-1 ring-ink-900/15 transition-colors hover:bg-white">
                See plans
              </Link>
            </div>
            <div className="mt-14 border-t border-ink-900/10 pt-6 lg:mt-auto">
              <p className="max-w-[46ch] text-[17px] leading-[1.6] text-ink-700">
                Sri Lankan personal income tax in plain words. Every figure comes
                from the rules in force for your year, with the section of the Act beside it.
              </p>
              <a href="#uses" aria-label="Scroll to what Citetax does" className="mt-5 inline-flex size-9 items-center justify-center rounded-full bg-ink-900/[0.06] text-ink-700 hover:bg-ink-900/10">
                <ArrowDown className="size-4" />
              </a>
            </div>
          </div>

          <div className="flex flex-col justify-center border-t border-ink-900/10 p-5 sm:p-8 lg:border-l lg:border-t-0">
            {hero && heroLines.length > 0 && (
              <HeroDemo
                question={HERO_QUESTION}
                ya={hero.ya}
                lines={heroLines}
                balance={hero.balance_payable}
                rules={new Set(hero.steps.map((s) => s.rule_key)).size}
              />
            )}
            {/* The note in the margin: the law's own voice, in serif italic. */}
            <div className="mt-3 flex items-start gap-2">
              <svg aria-hidden className="mt-1 h-7 w-7 flex-none text-ink-400" viewBox="0 0 28 28" fill="none">
                <path d="M24 24 C 12 22, 6 16, 5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M1.5 8.5 L 5 3.5 L 9 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div>
                <span className="statute block text-[18px] italic leading-snug text-ink-700">each figure, with the section of the Act it comes from</span>
                <span className="mt-1 block text-[13px] text-ink-400">A real answer for a doctor with a hospital salary and channelling fees, worked out by the engine as this page loaded.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------- what people ask about */}
      <section id="uses" className="mx-auto grid max-w-[1180px] gap-10 px-5 py-24 sm:px-8 lg:grid-cols-12 lg:py-32">
        <h2 className="text-[26px] font-medium leading-[1.2] tracking-[-0.02em] lg:col-span-4 lg:sticky lg:top-40 lg:self-start">
          Salaried workers, freelancers and practices ask Citetax about:
        </h2>
        <div className="lg:col-span-8">
          <UseList items={USES} />
        </div>
      </section>

      {/* ------------------------------------------- three scenarios */}
      {(["salary", "abroad", "side"] as StarterKey[]).map((key) => {
        const s = byKey[key];
        const f = FEATURES[key];
        return (
          <section key={key} className="mx-auto max-w-[1180px] px-5 sm:px-8">
            <div className="grid items-center gap-12 border-t border-ink-900/10 py-20 lg:grid-cols-2 lg:py-24">
              <div>
                <h2 className="text-[36px] font-semibold leading-[1.08] tracking-[-0.04em] sm:text-[44px]">{f.title}</h2>
                <p className="mt-4 max-w-[48ch] text-[17px] leading-[1.6] text-ink-500">{f.body}</p>
                <ul className="mt-6 flex flex-col gap-2.5">
                  {f.points.map((p) => (
                    <li key={p} className="flex items-center gap-2.5 text-[15px] text-ink-700">
                      <Check className="size-4 text-good-600" /> {p}
                    </li>
                  ))}
                </ul>
                {s && (
                  <div className="mt-8">
                    <p className="max-w-[52ch] text-[14.5px] italic leading-[1.55] text-ink-500">&ldquo;{s.question}&rdquo;</p>
                    <div className="mt-4 flex flex-wrap items-center gap-4">
                      <AskForm question={s.question} label="Ask this question" />
                      {s.answer && <span className="tnum text-[15px] font-medium text-brand-700">{s.answer}</span>}
                    </div>
                  </div>
                )}
              </div>
              {s?.computation && (
                <Reveal>
                  <f.Cards c={s.computation} />
                </Reveal>
              )}
            </div>
          </section>
        );
      })}

      {/* ----------------------------------------------- pricing band */}
      <section className="mt-12 bg-night text-white [background-image:radial-gradient(rgba(255,255,255,0.07)_1px,transparent_1px)] [background-size:22px_22px]">
        <div className="mx-auto grid max-w-[1180px] items-center gap-10 px-5 py-20 sm:px-8 lg:grid-cols-2 lg:py-24">
          <div>
            <div className="text-[18px] text-white/75">Start free. Individual is</div>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="tnum text-[60px] font-semibold leading-none tracking-[-0.045em] sm:text-[76px]">
                {individual ? lkr(individual.price_lkr) : "LKR 1,500"}
              </span>
            </div>
            <div className="mt-2 text-[17px] text-white/75">{individual?.price_unit ?? "per year of assessment"}</div>
          </div>
          <div>
            <p className="max-w-[44ch] text-[17px] leading-[1.6] text-white/80">
              Every plan uses the same engine, the same law and the same checks.
              Paid plans let you ask more and bring in a payslip. Teams pay per seat.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/pricing" className="inline-flex h-11 items-center rounded-full bg-white px-5 text-[14.5px] font-medium text-ink-900 hover:bg-white/85">
                Compare plans
              </Link>
              <Link href="/chat" className="inline-flex h-11 items-center rounded-full px-5 text-[14.5px] font-medium text-white ring-1 ring-white/30 hover:bg-white/10">
                Ask for free
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ trust */}
      <section className="mx-auto grid max-w-[1180px] gap-12 px-5 py-24 sm:px-8 lg:grid-cols-12 lg:py-28">
        <div className="lg:col-span-4">
          <h2 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.04em]">Built so you can check every answer.</h2>
          <p className="mt-4 max-w-[36ch] text-[16px] leading-[1.6] text-ink-500">What leaves Citetax, who changes the law in it, and how an answer can be checked.</p>
        </div>
        <div className="grid overflow-hidden rounded-2xl bg-white ring-1 ring-ink-900/10 sm:grid-cols-2 lg:col-span-8">
          {TRUST.map(([t, b], i) => (
            <div key={t} className={`p-7 ${i % 2 === 0 ? "sm:border-r" : ""} ${i < 2 ? "border-b" : ""} border-ink-900/10`}>
              <h3 className="text-[19px] font-medium leading-snug tracking-[-0.01em]">{t}</h3>
              <p className="mt-2 text-[15px] leading-[1.6] text-ink-500">{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------- final ask */}
      <section className="mx-auto max-w-[1180px] px-5 pb-24 sm:px-8">
        <div className="grid gap-10 rounded-3xl bg-white p-8 ring-1 ring-ink-900/10 sm:p-12 lg:grid-cols-2">
          <h2 className="text-[38px] font-semibold leading-[1.05] tracking-[-0.045em] sm:text-[48px]">Ask your first question.</h2>
          <form action={askFromHome}>
            <label htmlFor="home-question" className="text-[14px] font-medium text-ink-900">Your question</label>
            <textarea
              id="home-question"
              name="question"
              rows={3}
              maxLength={600}
              required
              placeholder="I'm a nurse earning LKR 210,000 a month. Do I need to file?"
              className="mt-2 block w-full resize-none rounded-xl border border-input bg-paper px-4 py-3 text-[16px] leading-[1.5] text-ink-900 outline-none placeholder:text-ink-300 focus-visible:border-brand-600 focus-visible:ring-3 focus-visible:ring-brand-600/15"
            />
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
              <button type="submit" className="inline-flex h-11 items-center rounded-full bg-ink-900 px-6 text-[15px] font-medium text-white hover:bg-ink-700">
                Ask Citetax
              </button>
              <span className="text-[13.5px] text-ink-400">Free, no account needed.</span>
            </div>
          </form>
        </div>
      </section>

      <footer className="border-t border-ink-900/10">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-3 px-5 py-8 text-[13.5px] text-ink-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>
            Personal income tax for 2025/2026 and 2026/2027.
            {snapshot ? ` Rules as of ${snapshot.label}.` : ""} Not tax advice.
          </span>
          <span className="flex gap-5">
            <Link href="/pricing" className="hover:text-ink-900">Pricing</Link>
            <Link href="/deadlines" className="hover:text-ink-900">Deadlines</Link>
            <Link href="/compare" className="hover:text-ink-900">What changed</Link>
            <Link href="/signin" className="hover:text-ink-900">Sign in</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
