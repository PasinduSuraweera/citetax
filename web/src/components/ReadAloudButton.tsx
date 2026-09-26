"use client";

import { Square, Volume2 } from "lucide-react";
import { useReadAloud } from "@/lib/use-read-aloud";

/** Speaks `text`, and stops it on a second press. Hidden where the browser cannot. */
export function ReadAloudButton({ text }: { text: string }) {
  const { supported, speaking, speak, stop } = useReadAloud();
  if (!supported || !text.trim()) return null;
  return (
    <button
      type="button"
      onClick={() => (speaking ? stop() : speak(text))}
      aria-pressed={speaking}
      className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13.5px] transition-colors ${
        speaking ? "bg-brand-050 font-medium text-brand-700" : "text-ink-500 hover:bg-muted hover:text-ink-900"
      }`}
    >
      {speaking ? <Square className="size-3.5 fill-current" /> : <Volume2 className="size-4" />}
      {speaking ? "Stop" : "Listen"}
    </button>
  );
}
