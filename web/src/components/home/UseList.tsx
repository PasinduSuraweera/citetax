"use client";

/**
 * What people use Citetax for, one line lit at a time as the list passes the
 * middle of the screen. Each line asks the question it names. With reduced
 * motion every line is shown at full strength.
 */

import { useEffect, useRef, useState } from "react";
import { askFromHome } from "@/app/actions";

export function UseList({ items }: { items: Array<{ label: string; question: string }> }) {
  const refs = useRef<Array<HTMLLIElement | null>>([]);
  const [active, setActive] = useState(0);
  const [still, setStill] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    // A browser preference, unknown during the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStill(media.matches);
    const pick = () => {
      const mid = window.innerHeight / 2;
      let best = 0;
      let dist = Infinity;
      refs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      setActive(best);
    };
    pick();
    window.addEventListener("scroll", pick, { passive: true });
    window.addEventListener("resize", pick);
    return () => {
      window.removeEventListener("scroll", pick);
      window.removeEventListener("resize", pick);
    };
  }, []);

  return (
    <ul className="flex flex-col">
      {items.map((item, i) => {
        const distance = Math.abs(i - active);
        const tone = still || distance === 0 ? "text-ink-900" : distance === 1 ? "text-ink-300" : "text-ink-200";
        return (
          <li key={item.label} ref={(el) => { refs.current[i] = el; }}>
            {/* Asked as a guest when not signed in, like the question box. */}
            <form action={askFromHome}>
              <input type="hidden" name="question" value={item.question} />
              <button
                type="submit"
                className={`block py-1 text-left text-[34px] font-medium leading-[1.25] tracking-[-0.035em] transition-colors duration-300 sm:text-[46px] ${tone} hover:text-brand-700`}
              >
                {item.label}
              </button>
            </form>
          </li>
        );
      })}
    </ul>
  );
}
