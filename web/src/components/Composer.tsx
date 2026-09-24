"use client";

/**
 * The question box. The empty page and the follow-up box under a thread use
 * the same one, so asking looks and behaves the same either way: Enter sends,
 * Shift+Enter adds a line.
 */

import { useRef, type RefObject } from "react";

const PAYSLIP_TYPES = "image/jpeg,image/png,image/webp,application/pdf";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  ya: string;
  /** Shows "Upload payslip" and hands the chosen file over. */
  onAttach?: (file: File) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  /** A question is already running here. */
  busy?: boolean;
  rows?: number;
  autoFocus?: boolean;
  submitLabel?: string;
  className?: string;
}

export function Composer({
  value, onChange, onSubmit, ya, onAttach, inputRef, placeholder, busy = false,
  rows = 3, autoFocus = false, submitLabel = "Ask", className = "",
}: Props) {
  const disabled = busy || !value.trim();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit(value);
      }}
      className={`rounded-[13px] border-[1.5px] border-brand-600 bg-white shadow-[0_0_0_4px_rgba(43,68,199,0.09)] ${className}`}
    >
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!disabled) onSubmit(value);
          }
        }}
        rows={rows}
        autoFocus={autoFocus}
        aria-label="Your question"
        placeholder={placeholder ?? "What do I owe for 2026/2027 on a salary of LKR 250,000 a month?"}
        className="w-full resize-none bg-transparent px-4 pb-[6px] pt-5 text-[16px] leading-[1.5] text-ink-900 outline-none placeholder:text-ink-200 sm:px-[22px] sm:text-[17px]"
      />
      <div className="flex items-center justify-between px-3 pb-[14px] pl-4 pt-3 sm:px-4 sm:pl-[22px]">
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-line-strong px-[11px] py-[7px] text-[12.5px] font-medium text-ink-700">
            Y/A {ya.replace("/", " / ")}
          </span>
          {onAttach && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={PAYSLIP_TYPES}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Cleared so choosing the same file again still fires.
                  e.target.value = "";
                  if (f) onAttach(f);
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-[6px] rounded-lg border border-line-strong px-[11px] py-[7px] text-[12.5px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600 disabled:opacity-40"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13.5 7.5l-5.6 5.6a3.3 3.3 0 01-4.7-4.7l5.9-5.9a2.2 2.2 0 013.1 3.1l-5.9 5.9a1.1 1.1 0 01-1.6-1.6l5.3-5.3" />
                </svg>
                Upload payslip
              </button>
            </>
          )}
        </div>
        <button
          type="submit"
          disabled={disabled}
          className="rounded-lg bg-brand-600 px-[18px] py-[9px] text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Working..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
