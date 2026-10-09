"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { useHomeMotion } from "./HomeMotion";

const STEPS = [
  { title: "Describe your income", body: "Ask about your salary, overseas clients or other income in plain language." },
  { title: "Follow the calculation", body: "See the income, reliefs and credits, with the source beside each figure." },
  { title: "Understand what comes next", body: "Check which tax year applies and whether you need to file a return or make a payment." },
];

export function AnswerStory({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const still = useHomeMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const rotateX = useTransform(scrollYProgress, [0, 0.45, 1], [9, 0, -3]);
  const y = useTransform(scrollYProgress, [0, 1], [35, -35]);

  return (
    <section ref={ref} id="how-it-works" className="answer-story home-shell">
      <div className="answer-story-copy">
        <h2>See how your tax<br /><span className="text-brand-600">is worked out.</span></h2>
        <div className="answer-story-steps">
          {STEPS.map(({ title, body }) => (
            <div className="answer-story-step" key={title}>
              <div><h3>{title}</h3><p>{body}</p></div>
            </div>
          ))}
        </div>
        <a className="home-text-link" href="#uses">Find your situation</a>
      </div>
      <div className="answer-story-stage">
        <motion.div className="answer-story-demo" style={{ rotateX: still ? 0 : rotateX, y: still ? 0 : y }}>
          {children}
        </motion.div>
      </div>
    </section>
  );
}
