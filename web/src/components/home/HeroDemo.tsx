"use client";

/**
 * The home page hero: a question becomes a cited answer, played live in the
 * page with Motion. Not a recording: the figures are the engine's own answer,
 * computed when the page rendered, so they follow the law as it changes.
 *
 * One clock drives the whole sequence; every row's space is reserved from the
 * start, so nothing on the page moves as the answer fills in. With reduced
 * motion the finished answer is shown, still.
 */

import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

// The reduced motion preference, read so the server render (no preference
// known) and the first browser render agree, then updated: no hydration
// mismatch, unlike reading it during render.
const QUERY = "(prefers-reduced-motion: reduce)";
function subscribe(cb: () => void) {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
function useStill(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}

export interface HeroLine {
  label: string;
  value: string;
  cite: string | null;
  assumed: boolean;
}

interface Props {
  question: string;
  ya: string;
  lines: HeroLine[];
  balance: string;
  rules: number;
}

const TYPE_MS = 26;
const CYCLE_HOLD = 4200;

function money(v: string): string {
  return Math.round(Number(v)).toLocaleString("en-GB");
}

export function HeroDemo({ question, ya, lines, balance, rules }: Props) {
  const still = useStill();
  const [cycle, setCycle] = useState(0);
  const [t, setT] = useState(0);

  const typedEnd = question.length * TYPE_MS;
  const sentAt = typedEnd + 250;
  const checks = [
    "Personal details removed",
    `${rules} rules in force for ${ya}`,
    "Worked out in plain code",
    "Every figure traced",
  ];
  const checkAt = (i: number) => sentAt + 350 + i * 420;
  const rowAt = (i: number) => checkAt(2) + 200 + i * 360;
  const balanceAt = rowAt(lines.length - 1) + 450;
  const verifiedAt = Math.max(balanceAt + 500, checkAt(3));
  const end = verifiedAt + CYCLE_HOLD;

  useEffect(() => {
    if (still) return;
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const e = now - start;
      if (e >= end) {
        setCycle((c) => c + 1);
        return;
      }
      setT(e);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cycle, end, still]);

  const now = still ? end : t;
  const typed = Math.min(question.length, Math.floor(now / TYPE_MS));
  const sent = now >= sentAt;
  const spring = { type: "spring" as const, stiffness: 260, damping: 26 };

  return (
    <div className="relative">
      {/* A slow glow behind the panel: the one decorative motion. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-6 rounded-[40px] bg-[radial-gradient(60%_60%_at_70%_20%,rgba(34,211,224,0.28),transparent_70%),radial-gradient(50%_50%_at_20%_90%,rgba(7,102,214,0.35),transparent_70%)] blur-2xl"
        animate={still ? undefined : { opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
      />
      <AnimatePresence mode="wait">
        <motion.div
          key={cycle}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45 }}
          className="relative rounded-3xl bg-night p-4 shadow-[0_40px_80px_-40px_rgba(1,33,81,0.8)] ring-1 ring-white/10 sm:p-5"
          role="img"
          aria-label={`An answer being worked out: ${question} Balance payable LKR ${money(balance)}, every line cited.`}
        >
          {/* The question, typed */}
          <div className="flex items-start gap-3 rounded-2xl bg-white p-3.5 sm:p-4">
            <p className="min-h-[3em] flex-1 text-[14.5px] leading-[1.5] text-ink-900 sm:text-[15.5px]">
              {question.slice(0, typed)}
              {!sent && <span className="ml-px inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-brand-600" />}
            </p>
            <motion.span
              className="flex size-9 flex-none items-center justify-center rounded-full"
              animate={{ backgroundColor: sent ? "#0766d6" : "#eff2f7", scale: sent && now < sentAt + 250 ? 1.12 : 1 }}
              transition={{ duration: 0.25 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={sent ? "#fff" : "#8791a7"} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </motion.span>
          </div>

          {/* The checks an answer passes */}
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {checks.map((c, i) => {
              const on = now >= checkAt(i);
              return (
                <motion.li
                  key={c}
                  initial={false}
                  animate={{ opacity: on ? 1 : 0, y: on ? 0 : 6 }}
                  transition={spring}
                  className="flex items-center gap-1.5 rounded-full bg-white/[0.08] py-1 pl-1 pr-2.5 text-[12.5px] text-white/80 ring-1 ring-white/10"
                >
                  <motion.span
                    initial={false}
                    animate={{ scale: on ? 1 : 0.4 }}
                    transition={{ ...spring, delay: 0.08 }}
                    className="flex size-4 items-center justify-center rounded-full bg-sidebar-primary text-ink-900"
                  >
                    <Check className="size-2.5" strokeWidth={3.5} />
                  </motion.span>
                  {c}
                </motion.li>
              );
            })}
          </ul>

          {/* The ledger */}
          <div className="mt-3 rounded-2xl bg-white px-4 py-2 sm:px-5">
            <div className="flex justify-between border-b border-line py-2 text-[12px] text-ink-400">
              <span>Year of assessment {ya}</span>
              <span>LKR</span>
            </div>
            {lines.map((l, i) => {
              const on = now >= rowAt(i);
              const fresh = on && now < rowAt(i) + 700;
              return (
                <motion.div
                  key={l.label}
                  initial={false}
                  animate={{ opacity: on ? 1 : 0, y: on ? 0 : 8, backgroundColor: fresh ? "rgba(7,102,214,0.06)" : "rgba(7,102,214,0)" }}
                  transition={{ ...spring, backgroundColor: { duration: 0.6 } }}
                  className="-mx-2 flex items-center justify-between gap-4 rounded-lg border-b border-line-faint px-2 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-ink-900 sm:text-[14.5px]">{l.label}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {l.cite && (
                        <motion.span
                          initial={false}
                          animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 1.35, rotate: on ? 0 : -4 }}
                          transition={{ type: "spring", stiffness: 320, damping: 14, delay: on ? 0.12 : 0 }}
                          className="inline-block origin-left whitespace-nowrap rounded-md bg-ink-900/[0.05] px-1.5 font-serif text-[13px] italic leading-[1.6] text-ink-700"
                        >
                          {l.cite}
                        </motion.span>
                      )}
                      {l.assumed && <span className="text-[11.5px] text-[#7e5d1b]">assumed from the salary</span>}
                    </div>
                  </div>
                  <motion.span
                    initial={false}
                    animate={{ opacity: on ? 1 : 0, x: on ? 0 : 12 }}
                    transition={{ ...spring, delay: on ? 0.05 : 0 }}
                    className="tnum whitespace-nowrap text-[15px] font-semibold text-ink-900 sm:text-[16px]"
                  >
                    {money(l.value)}
                  </motion.span>
                </motion.div>
              );
            })}
          </div>

          {/* The balance, then the check */}
          <motion.div
            initial={false}
            animate={{ opacity: now >= balanceAt ? 1 : 0, y: now >= balanceAt ? 0 : 12 }}
            transition={spring}
            className="mt-3 flex items-baseline justify-between rounded-2xl bg-ink-900 px-4 py-3.5 text-white sm:px-5"
          >
            <span className="text-[15px] font-semibold">Balance payable</span>
            <motion.span
              initial={false}
              animate={{ scale: now >= balanceAt ? 1 : 0.9 }}
              transition={{ type: "spring", stiffness: 300, damping: 18, delay: 0.1 }}
              className="tnum text-[26px] font-semibold tracking-[-0.02em] sm:text-[30px]"
            >
              <span className="mr-2 text-[15px] font-medium text-sidebar-primary">LKR</span>
              {money(balance)}
            </motion.span>
          </motion.div>
          <motion.div
            initial={false}
            animate={{ opacity: now >= verifiedAt ? 1 : 0 }}
            transition={{ duration: 0.3 }}
            className="mt-3 flex items-center gap-2.5 px-1 text-[13.5px] text-white/85"
          >
            <motion.span
              initial={false}
              animate={{ scale: now >= verifiedAt ? 1 : 0, rotate: now >= verifiedAt ? 0 : -45 }}
              transition={{ type: "spring", stiffness: 360, damping: 13 }}
              className="flex size-6 items-center justify-center rounded-full bg-gold-500 text-ink-900"
            >
              <Check className="size-3.5" strokeWidth={3.2} />
            </motion.span>
            Verified. Every line cites a rule in force for {ya}.
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
