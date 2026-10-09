"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { MotionConfig, motion, useScroll } from "motion/react";

const MotionContext = createContext(true);
const query = "(prefers-reduced-motion: reduce)";
function subscribe(callback: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function useHomeMotion() {
  return useContext(MotionContext);
}

export function HomeMotion({ children }: { children: React.ReactNode }) {
  const still = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
  const { scrollYProgress } = useScroll();

  return (
    <MotionContext.Provider value={still}>
      <MotionConfig reducedMotion={still ? "always" : "never"}>
        <div className="home-experience" data-still={still}>
          {!still && <motion.div className="home-progress" style={{ scaleX: scrollYProgress }} aria-hidden />}
          {children}
        </div>
      </MotionConfig>
    </MotionContext.Provider>
  );
}
