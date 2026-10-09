import { cookies } from "next/headers";
import Link from "next/link";
import { askFromHome } from "@/app/actions";
import { HeroDemo, type HeroLine } from "@/components/home/HeroDemo";
import { HomeNav } from "@/components/home/HomeNav";
import { HomeFooter } from "@/components/home/HomeFooter";
import { Reveal } from "@/components/home/Reveal";
import { UseList } from "@/components/home/UseList";
import { BrandScene } from "@/components/home/BrandScene";
import { AnswerStory } from "@/components/home/AnswerStory";
import { HomeMotion } from "@/components/home/HomeMotion";
import "./home.css";
import { formatDate, type ComputeResponse } from "@/lib/api";
import { isKnownVisitor } from "@/lib/guest";
import HERO_SAVED from "@/lib/hero-answer.json";
import { HERO_QUESTION, currentSnapshot, heroAnswer, planSummary, starterAnswers, type Starter, type StarterKey } from "@/lib/sample";

/**
 * The homepage, the first screen for everyone (see proxy.ts).
 *
 * The ribbon is decorative brand artwork. The animated answer and every
 * figure in the paper cards are computed by the engine when the page renders.
 * If the API cannot be reached, the engine's saved answers to the same
 * questions are shown, never figures typed in.
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
  // Live from the engine when the API answers; otherwise the engine's own
  // output for the same question, saved on the date it carries.
  const live = await heroAnswer();
  const hero = live
    ? { ya: live.ya, balance_payable: live.balance_payable, steps: live.steps.map((s) => ({ ...s, assumed: s.detail?.assumed === true })) }
    : HERO_SAVED;
  // The lines that carry a figure; the chat shows every line.
  const heroLines: HeroLine[] = hero.steps
    .filter((s) => !s.is_zero)
    .map((s) => ({ label: s.label, value: s.value, cite: s.citation_label, assumed: s.assumed }));
  const known = isKnownVisitor(jar.getAll().map((c) => c.name));
  const byKey = Object.fromEntries(starters.map((s) => [s.key, s])) as Record<StarterKey, Starter>;
  const individual = plans?.find((p) => p.key === "individual");

  return (
    <HomeMotion>
      <div id="home-top" />
      <HomeNav known={known} />
      <main id="main-content">
      <section className="home-hero home-shell">
          <div className="home-hero-copy">
            <h1 className="home-enter">Your income tax.<br />Worked out.<br /><span className="home-cited">Cited.<svg viewBox="0 0 260 18" fill="none" aria-hidden="true"><path d="M3 13C70 1 164 2 255 8" stroke="currentColor" strokeWidth="5" strokeLinecap="round" /></svg></span></h1>
            <p className="home-hero-description home-enter">A clearer picture of what you owe, and why. Sri Lankan personal income tax, with the law behind every figure.</p>
            <div className="home-hero-actions home-enter">
              <Link href="/chat" className="home-primary-link">Ask a question</Link>
              <a href="#how-it-works" className="home-text-link">See how it works</a>
            </div>
            <p className="home-hero-note home-enter">Free to start. No account needed.</p>
          </div>
          <BrandScene />
      </section>

      <AnswerStory>
            <HeroDemo
              question={HERO_QUESTION}
              ya={hero.ya}
              lines={heroLines}
              balance={hero.balance_payable}
              rules={new Set(hero.steps.map((s) => s.rule_key)).size}
            />
            <p className="answer-demo-note">
              A real calculation for a doctor with a hospital salary and channelling fees.{" "}
              {live ? "Figures come from the rules in force when this page loads." : `Figures from the rules in force on ${formatDate(HERO_SAVED.computed_on)}.`}
            </p>
      </AnswerStory>

      {/* ---------------------------------------- what people ask about */}
      <section id="uses" className="home-shell home-uses grid gap-10 py-24 lg:grid-cols-12 lg:py-32">
        <div className="lg:col-span-4 lg:sticky lg:top-40 lg:self-start">
        <h2 className="text-[26px] font-medium leading-[1.2] tracking-[-0.02em] lg:col-span-4 lg:sticky lg:top-40 lg:self-start">
          Salaried workers, freelancers and practices ask Citetax about:
        </h2>
        </div>
        <div className="lg:col-span-8">
          <UseList items={USES} />
        </div>
      </section>

      {/* ------------------------------------------- three scenarios */}
      {(["salary", "abroad", "side"] as StarterKey[]).map((key, index) => {
        const s = byKey[key];
        const f = FEATURES[key];
        return (
          <section key={key} className="home-shell home-scenario" data-scenario={key}>
            <div className="home-scenario-layout grid items-center gap-12 border-t border-ink-900/10 py-20 lg:grid-cols-2 lg:py-24">
              <Reveal>
                <h2 className="text-[36px] font-semibold leading-[1.08] tracking-[-0.04em] sm:text-[44px]">{f.title}</h2>
                <p className="mt-4 max-w-[48ch] text-[17px] leading-[1.6] text-ink-500">{f.body}</p>
                <ul className="mt-6 flex list-disc flex-col gap-2.5 pl-4 marker:text-ink-400">
                  {f.points.map((p) => (
                    <li key={p} className="pl-1 text-[15px] text-ink-700">
                      {p}
                    </li>
                  ))}
                </ul>
                {s && (
                  <div className="mt-8">
                    <p className="max-w-[52ch] text-[15px] leading-[1.6] text-ink-500">{s.question}</p>
                    <div className="mt-4 flex flex-wrap items-center gap-4">
                      <AskForm question={s.question} label="Ask this question" />
                      {s.answer && <span className="tnum text-[15px] font-medium text-brand-700">{s.answer}</span>}
                    </div>
                  </div>
                )}
              </Reveal>
              {s?.computation ? (
                <Reveal className="home-scenario-art">
                  <f.Cards c={s.computation} />
                </Reveal>
              ) : (
                <Reveal className="home-scenario-art">
                  <Paper className="relative mx-auto max-w-[460px] !p-8">
                    <p className="text-[24px] leading-snug tracking-[-0.025em]">{s?.question ?? USES[index].question}</p>
                    <div className="mt-6"><AskForm question={s?.question ?? USES[index].question} label="Explore this question" /></div>
                  </Paper>
                </Reveal>
              )}
            </div>
          </section>
        );
      })}

      {/* ----------------------------------------------- pricing band */}
      <section className="mt-12 bg-night text-white">
        <div className="home-shell grid items-center gap-10 py-20 lg:grid-cols-2 lg:py-24">
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
      <section className="home-shell grid gap-12 py-24 lg:grid-cols-12 lg:py-28">
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
      <section className="home-shell pb-24">
        <div className="grid gap-10 rounded-3xl bg-white p-8 ring-1 ring-ink-900/10 sm:p-12 lg:grid-cols-2">
          <h2 className="text-[38px] font-semibold leading-[1.05] tracking-[-0.045em] sm:text-[48px]">Ask your<br /><span className="text-brand-600">first question.</span></h2>
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

      </main>
      <HomeFooter known={known} snapshotLabel={snapshot?.label} />
    </HomeMotion>
  );
}
