"use client";

/**
 * Spec section 6.2 addition 1: the corpus snapshot is clickable, and opens a
 * panel showing what it contains in the approvers' own changelog words. A
 * passive date claims freshness; an explorable one demonstrates it.
 */

import { useEffect } from "react";
import type { Snapshot } from "@/lib/api";

interface Props {
  snapshot: Snapshot;
  onClose: () => void;
}

export function SnapshotPanel({ snapshot, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const unsigned = snapshot.changelog?.includes("NOT yet reviewer-signed");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Corpus snapshot"
      className="fixed inset-0 z-50 flex justify-end bg-ink-900/25"
      onClick={onClose}
    >
      <div
        className="fade-up flex h-full w-[440px] flex-col overflow-y-auto bg-white px-7 py-7 shadow-[-24px_0_60px_-30px_rgba(14,20,48,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="eyebrow">CORPUS SNAPSHOT</div>
            <div className="mt-2 text-[24px] font-semibold tracking-[-0.02em] text-ink-900">
              {snapshot.label}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 font-mono text-sm text-ink-300 hover:bg-panel hover:text-ink-900"
          >
            ✕
          </button>
        </div>

        <p className="mt-4 text-[13.5px] leading-[1.6] text-ink-500">
          Every answer records the snapshot it was computed against, so any
          figure can be re-derived exactly as the corpus stood at the time.
        </p>

        <div className="mt-5 rounded-xl border border-line bg-panel px-4 py-4">
          <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">
            SNAPSHOT ID
          </div>
          <div className="mt-[6px] break-all font-mono text-[11.5px] text-ink-700">
            {snapshot.id}
          </div>
        </div>

        {snapshot.changelog && (
          <div className="mt-4">
            <div className="eyebrow">WHAT CHANGED</div>
            <p className="mt-[10px] text-[13.5px] leading-[1.6] text-ink-700">
              {snapshot.changelog}
            </p>
          </div>
        )}

        {unsigned && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-4 py-4">
            <div className="font-mono text-[10px] tracking-[0.14em] text-warn-600">
              NOT REVIEWER SIGNED
            </div>
            <p className="mt-2 text-[12.5px] leading-[1.55] text-warn-500">
              These rule versions were seeded from published sources but have
              not been approved by a reviewer against the gazetted text. Until
              the review pipeline signs them, treat the figures as indicative.
            </p>
          </div>
        )}

        <div className="mt-auto pt-6">
          <p className="border-t border-line pt-4 text-[12px] leading-[1.55] text-ink-400">
            Rollback selects a previous snapshot and marks it current. Because
            every answer already records the snapshot it used, rollback never
            rewrites history, it only changes what new answers resolve against.
          </p>
        </div>
      </div>
    </div>
  );
}
