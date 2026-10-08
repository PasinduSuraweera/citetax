"use client";

/** The home page's floating nav. It sits in the page at the top and turns to
 *  frosted glass once the page scrolls under it. */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";

const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/deadlines", label: "Deadlines" },
  { href: "/compare", label: "What changed" },
];

export function HomeNav({ known }: { known: boolean }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <div className="sticky top-3 z-40 px-3 sm:px-5">
      <nav
        className={`mx-auto flex max-w-[1180px] items-center justify-between rounded-full px-3 py-2 transition-[background-color,box-shadow,backdrop-filter] duration-300 sm:px-4 ${
          scrolled
            ? "bg-white/75 shadow-[0_8px_30px_-12px_rgba(1,33,81,0.25)] ring-1 ring-ink-900/5 backdrop-blur-md"
            : "bg-transparent"
        }`}
        aria-label="Main"
      >
        <Link href="/" aria-label="Citetax home" className="pl-1">
          <Logo height={32} priority />
        </Link>
        <div className="hidden items-center gap-1 rounded-full bg-ink-900/[0.045] p-1 md:flex">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="rounded-full px-4 py-1.5 text-[14px] text-ink-700 transition-colors hover:bg-white hover:text-ink-900">
              {l.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {!known && (
            <Link href="/signin" className="hidden rounded-full px-4 py-2 text-[14px] font-medium text-ink-900 hover:bg-ink-900/5 sm:block">
              Sign in
            </Link>
          )}
          <Link
            href="/chat"
            className="inline-flex h-10 items-center rounded-full bg-ink-900 px-5 text-[14px] font-medium text-white transition-colors hover:bg-ink-700"
          >
            {known ? "Open chat" : "Ask a question"}
          </Link>
        </div>
      </nav>
    </div>
  );
}
