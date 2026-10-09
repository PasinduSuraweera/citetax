"use client";

import Image from "next/image";
import { AnimatePresence, motion, useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useHomeMotion } from "./HomeMotion";

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

const QUESTION_MS = 4800;
const ROW_MS = 1150;
const ANSWER_HOLD_MS = 5000;
/** After a viewer picks a scene or a row, wait this long, then loop again. */
const RESUME_MS = 8000;
const CHAPTERS = ["Your question", "The calculation", "Your answer"];
const ease = [0.22, 1, 0.36, 1] as const;

function money(value: string) {
  return Math.round(Number(value)).toLocaleString("en-GB");
}

/** A looping walkthrough using the engine's actual figures and citations. */
export function HeroDemo({ question, ya, lines, balance, rules }: Props) {
  const still = useHomeMotion();
  const ref = useRef<HTMLDivElement>(null);
  const ledger = useRef<HTMLDivElement>(null);
  const clock = useRef(0);
  const visible = useInView(ref, { amount: 0.35 });
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [inspectedRow, setInspectedRow] = useState(0);
  const answerAt = QUESTION_MS + lines.length * ROW_MS + 800;
  const end = answerAt + ANSWER_HOLD_MS;
  const scene = selected ?? (still ? 2 : elapsed < QUESTION_MS ? 0 : elapsed < answerAt ? 1 : 2);
  const activeRow = selected === 1
    ? inspectedRow
    : Math.min(lines.length - 1, Math.max(0, Math.floor((elapsed - QUESTION_MS) / ROW_MS)));
  const currentLine = lines[activeRow];
  const typed = selected === 0 || still ? question.length : Math.floor(elapsed / 22);
  // Keep time only while the preview is on screen and the tab is visible,
  // and start again from the question after the answer has been held.
  useEffect(() => {
    if (still || !visible || !playing) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const delta = now - previous;
      previous = now;
      if (document.hidden) return;
      clock.current += delta;
      if (clock.current >= end) clock.current = 0;
      setElapsed(clock.current);
    }, 50);
    const resetTick = () => { previous = performance.now(); };
    document.addEventListener("visibilitychange", resetTick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resetTick);
    };
  }, [end, playing, still, visible]);

  // Follow the active figure within the ledger; never scroll the page itself.
  useEffect(() => {
    if (scene !== 1 || selected !== null) return;
    const timer = window.setTimeout(() => {
      const panel = ledger.current;
      const row = panel?.children[activeRow] as HTMLElement | undefined;
      if (panel && row) {
        panel.scrollTo({ top: Math.max(0, row.offsetTop - panel.clientHeight / 2 + row.clientHeight / 2), behavior: still ? "instant" : "smooth" });
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeRow, scene, selected, still]);

  // A viewer's choice holds for a while, then the loop starts over.
  useEffect(() => {
    if (selected === null || still) return;
    const timer = window.setTimeout(() => {
      clock.current = 0;
      setElapsed(0);
      setSelected(null);
      setPlaying(true);
    }, RESUME_MS);
    return () => window.clearTimeout(timer);
  }, [selected, inspectedRow, still]);

  return (
    <div ref={ref} className="tax-film" aria-label="An example tax calculation">
      <header className="tax-film-header">
        <Image src="/brand/logo-lockup.png" alt="Citetax" width={102} height={32} />
        <span>Year of assessment {ya}</span>
      </header>

      <div className="tax-film-stage" aria-live="off">
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={scene}
            className={`tax-film-scene tax-film-scene-${scene}`}
            initial={still ? false : { opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: still ? 0 : -12, scale: still ? 1 : 1.015 }}
            transition={{ duration: still ? 0 : 0.45, ease }}
          >
            {scene === 0 && (
              <>
                <div className="tax-film-intro">
                  <p className="tax-film-eyebrow">Start with your income</p>
                  <h3>A question.<br />In your own words.</h3>
                </div>
                <div className="tax-film-question">
                  <p aria-label={question}>
                    <span className="tax-film-question-reserve" aria-hidden="true">{question}</span>
                    <span className="tax-film-question-text" aria-hidden="true">
                      {question.slice(0, typed)}
                      {typed < question.length && <span className="tax-film-caret" />}
                    </span>
                  </p>
                  <div className="tax-film-question-bottom">
                    <span>Salary + private practice</span>
                    <motion.span className="tax-film-send" animate={{ backgroundColor: typed >= question.length ? "#0766d6" : "#012151" }} aria-hidden="true">
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </motion.span>
                  </div>
                </div>
                <p className="tax-film-intro-note">Follow this question through to a cited answer.</p>
              </>
            )}

            {scene === 1 && (
              <>
                <div className="tax-film-calculation-heading"><h3>Working it out.</h3><span>LKR</span></div>
                <div ref={ledger} className="tax-film-ledger" tabIndex={0} role="region" aria-label="Calculation breakdown">
                  {lines.map((line, i) => {
                    const shown = selected === 1 || still || i <= activeRow;
                    return (
                      <motion.button type="button" key={`${line.label}-${i}`} className="tax-film-row" data-active={i === activeRow} aria-pressed={i === activeRow}
                        onClick={() => { setInspectedRow(i); setSelected(1); setPlaying(false); }}
                        initial={false} animate={{ opacity: shown ? 1 : 0.24 }} transition={{ duration: 0.35 }}>
                        <span><span>{line.label}</span>{line.assumed && <small>Assumed from the salary</small>}</span>
                        <motion.strong initial={false} animate={{ opacity: shown ? 1 : 0, x: shown ? 0 : 8 }} transition={{ duration: 0.4 }}>{money(line.value)}</motion.strong>
                      </motion.button>
                    );
                  })}
                </div>
                <div className="tax-film-source">
                  <span>Behind this figure</span>
                  <AnimatePresence initial={false} mode="wait">
                    <motion.div key={activeRow} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: still ? 0 : 0.15 }}>
                      <strong>{currentLine?.label}</strong>
                      <cite>{currentLine?.cite ?? "Calculated from the preceding figures"}</cite>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </>
            )}

            {scene === 2 && (
              <>
                <div className="tax-film-result">
                  <p>Balance payable</p>
                  <motion.div className="tax-film-total" initial={still ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: still ? 0 : 0.15, ease }}>
                    <span>LKR</span><strong>{money(balance)}</strong>
                  </motion.div>
                  <span className="tax-film-result-year">For {ya}</span>
                </div>
                <div className="tax-film-summary" tabIndex={0} role="region" aria-label="The answer with its sources">
                  {lines.map((line, i) => (
                    <div key={`${line.label}-${i}`}>
                      <span>{line.label}{line.cite && <cite>{line.cite}</cite>}{line.assumed && <small>Assumed from the salary</small>}</span>
                      <strong>{money(line.value)}</strong>
                    </div>
                  ))}
                </div>
                <p className="tax-film-result-note">{rules} rules applied. Sources beside the figures.</p>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <footer className="tax-film-controls">
        <div className="tax-film-chapters" role="group" aria-label="Walkthrough scenes">
          {CHAPTERS.map((chapter, i) => (
            <button type="button" key={chapter} aria-pressed={scene === i} onClick={() => { setSelected(i); setInspectedRow(0); setPlaying(false); }}>
              <span className="tax-film-chapter-track" aria-hidden="true"><span style={{ transform: `scaleX(${scene > i ? 1 : scene < i ? 0 : selected !== null || still ? 1 : i === 0 ? elapsed / QUESTION_MS : i === 1 ? (elapsed - QUESTION_MS) / (answerAt - QUESTION_MS) : (elapsed - answerAt) / (end - answerAt)})` }} /></span>
              {chapter}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
