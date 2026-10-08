import type { Metadata } from "next";
import { Check } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { PlanChooser } from "@/components/PlanChooser";
import { API_BASE, type PlanInfo, type PlanKey } from "@/lib/api";

export const metadata: Metadata = { title: "Pricing · Citetax" };

/**
 * Plans and prices. The prices and limits come from the API (app.core.plans),
 * so this page cannot disagree with what the API enforces. Only features that
 * exist today are listed; the Team workspace is marked as coming.
 */

const FEATURES: Record<PlanKey, { lead: string; items: string[]; soon?: string[] }> = {
  free: {
    lead: "To see what Citetax does.",
    items: [
      "Tax worked out line by line, every figure cited",
      "Whether you need to file, and when",
      "What changed between the years",
      "Your chats kept when you sign in",
    ],
  },
  individual: {
    lead: "For your own return, all season.",
    items: [
      "Everything in Free",
      "15 times the questions of Free",
      "Read your payslip into the computation",
    ],
  },
  team: {
    lead: "For practices and finance teams.",
    items: [
      "Everything in Individual, for each person",
      "One plan for the whole team",
    ],
    soon: ["Shared workspace and client labels", "Exportable audit trail"],
  },
};

async function loadPlans(): Promise<{ plans: PlanInfo[]; guest_daily_questions: number } | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/plans`, { next: { revalidate: 300 } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function priceLine(p: PlanInfo): { amount: string; unit: string } {
  if (p.price_lkr === 0) return { amount: "LKR 0", unit: "" };
  return { amount: `LKR ${p.price_lkr.toLocaleString("en-GB")}`, unit: p.price_unit };
}

function limitLine(p: PlanInfo, guestDaily: number): string {
  if (p.key === "free") return `${p.monthly_questions} questions a month signed in, ${guestDaily} a day without an account`;
  if (p.key === "team") return `${p.monthly_questions?.toLocaleString("en-GB")} questions a person a month`;
  return `${p.monthly_questions} questions a month`;
}

export default async function PricingPage() {
  const data = await loadPlans();

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-10 sm:px-8 lg:pt-16">
        <div className="max-w-[640px]">
          <h1 className="text-balance text-[38px] font-semibold leading-[1.08] tracking-[-0.03em] text-ink-900 sm:text-[50px]">
            One price for the whole tax season.
          </h1>
          <p className="mt-5 max-w-[52ch] text-[17px] leading-[1.6] text-ink-500">
            Start free. Every plan gets the same engine, the same law and the same
            checks: what changes is how much you ask and what you can bring in.
          </p>
        </div>

        {data ? (
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {data.plans.map((p) => {
              const f = FEATURES[p.key];
              const price = priceLine(p);
              const featured = p.key === "individual";
              return (
                <section
                  key={p.key}
                  className={`flex flex-col rounded-2xl border bg-white p-6 sm:p-7 ${
                    featured ? "border-brand-600 shadow-[0_18px_50px_-24px_rgba(18,52,120,0.45)]" : "border-line"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-[19px] font-semibold text-ink-900">{p.name}</h2>
                    {featured && (
                      <span className="rounded-full bg-brand-100 px-2.5 py-0.5 text-[12px] font-medium text-brand-700">
                        Most people
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[14.5px] text-ink-500">{f.lead}</p>
                  <div className="mt-6 flex flex-wrap items-baseline gap-x-2">
                    <span className="tnum whitespace-nowrap text-[34px] font-semibold tracking-[-0.03em] text-ink-900">{price.amount}</span>
                    {price.unit && <span className="text-[14px] text-ink-400">{price.unit}</span>}
                  </div>
                  <p className="mt-2 text-[13.5px] leading-[1.5] text-ink-400">{limitLine(p, data.guest_daily_questions)}</p>

                  <ul className="mt-6 flex flex-1 flex-col gap-2.5">
                    {f.items.map((item) => (
                      <li key={item} className="flex gap-2.5 text-[14.5px] leading-[1.5] text-ink-700">
                        <Check className="mt-[3px] size-4 flex-none text-brand-600" aria-hidden />
                        {item}
                      </li>
                    ))}
                    {f.soon?.map((item) => (
                      <li key={item} className="flex gap-2.5 text-[14.5px] leading-[1.5] text-ink-400">
                        <span className="mt-[2px] flex-none rounded bg-muted px-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-500">
                          Soon
                        </span>
                        {item}
                      </li>
                    ))}
                  </ul>

                  <div className="mt-7">
                    <PlanChooser plan={p.key} featured={featured} />
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <p className="mt-12 rounded-xl border border-line bg-white p-6 text-[15px] text-ink-500">
            Prices could not be loaded just now. Try again in a moment.
          </p>
        )}

        <section className="mt-20 grid gap-10 border-t border-line pt-12 lg:grid-cols-3">
          {[
            ["How do I pay?", "Payments are not open yet. Request a plan and we will confirm it with you and switch it on. Nothing is charged automatically."],
            ["What counts as a question?", "An answered question. A refusal, a clarifying question back to you, or a greeting does not count."],
            ["Is the Free answer any different?", "No. The same engine, rules and checks produce every answer. Plans differ only in how much you can ask and what you can upload."],
          ].map(([q, a]) => (
            <div key={q}>
              <h3 className="text-[16px] font-semibold text-ink-900">{q}</h3>
              <p className="mt-2 max-w-[44ch] text-[14.5px] leading-[1.6] text-ink-500">{a}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
