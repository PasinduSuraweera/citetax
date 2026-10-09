"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import { MotionConfig } from "motion/react";

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

  return (
    <MotionContext.Provider value={still}>
      <MotionConfig reducedMotion={still ? "always" : "never"}>
        <div className="home-experience" data-still={still}>
          {children}
        </div>
      </MotionConfig>
    </MotionContext.Provider>
  );
}
