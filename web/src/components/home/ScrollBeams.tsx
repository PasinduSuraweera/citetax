"use client";

/**
 * Lines in the empty margins either side of the home page that draw
 * themselves down as the page scrolls, with a bright head at the tip: a
 * tracing beam. The faint full path is always there; the bright part shows
 * how far down the page the reader is. Only on screens wide enough to have
 * margins, never under the content, and still with reduced motion.
 */

import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";

// Circuit-like paths in a 100 x 1000 box, stretched to the viewport's height.
const LEFT = "M 70 0 V 180 Q 70 210 50 230 L 34 246 Q 20 260 20 290 V 560 Q 20 590 40 608 Q 58 626 58 656 V 1000";
const RIGHT = "M 30 0 V 320 Q 30 350 50 368 L 66 384 Q 80 398 80 428 V 720 Q 80 750 60 768 Q 42 786 42 816 V 1000";

function Beam({ d, side }: { d: string; side: "left" | "right" }) {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 28, mass: 0.4 });
  const length = useTransform(progress, (p) => Math.max(0.02, p));
  const head = useTransform(progress, (p) => Math.max(0, p - 0.045));
  // A fixed length still has to be a motion value: a plain number here is
  // written as an inert style and the head would draw the whole route.
  const headLength = useTransform(progress, () => 0.045);
  const id = `beam-${side}`;

  return (
    <svg
      className="h-full w-full"
      viewBox="0 0 100 1000"
      preserveAspectRatio="none"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={`${id}-trail`} x1="0" y1="0" x2="0" y2="1000" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0766d6" stopOpacity="0" />
          <stop offset="0.35" stopColor="#0766d6" stopOpacity="0.55" />
          <stop offset="1" stopColor="#22d3e0" stopOpacity="0.9" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-200%" y="-20%" width="500%" height="140%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* The whole route, faint. */}
      <path d={d} stroke="#012151" strokeOpacity="0.08" strokeWidth="1" />
      {!reduce && (
        <>
          {/* How far the reader has come. */}
          <motion.path
            d={d}
            stroke={`url(#${id}-trail)`}
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ pathLength: length }}
          />
          {/* The bright head at the tip. */}
          <motion.path
            d={d}
            stroke="#22d3e0"
            strokeWidth="2.5"
            strokeLinecap="round"
           
            filter={`url(#${id}-glow)`}
            style={{ pathLength: headLength, pathOffset: head }}
          />
        </>
      )}
    </svg>
  );
}

export function ScrollBeams() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-y-0 left-0 right-0 z-0 hidden xl:block">
      <div className="absolute inset-y-0 left-[max(8px,calc((100vw-1240px)/2-92px))] w-[84px]">
        <Beam d={LEFT} side="left" />
      </div>
      <div className="absolute inset-y-0 right-[max(8px,calc((100vw-1240px)/2-92px))] w-[84px]">
        <Beam d={RIGHT} side="right" />
      </div>
    </div>
  );
}
