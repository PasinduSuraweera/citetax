"use client";

/** Settles a group of paper cards into place the first time it scrolls into
 *  view. The cards' resting tilt is theirs; this only adds the arrival. With
 *  reduced motion they are simply there. */

import { useEffect, useRef } from "react";
import { useHomeMotion } from "./HomeMotion";

export function Reveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const still = useHomeMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || still) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.animate([{ opacity: 0.3, transform: "translateY(28px)" }, { opacity: 1, transform: "none" }], { duration: 750, easing: "cubic-bezier(.22,1,.36,1)" });
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => { io.disconnect(); el.getAnimations().forEach((animation) => animation.cancel()); };
  }, [still]);

  return (
    <div
      ref={ref}
      className={className}
    >
      {children}
    </div>
  );
}
