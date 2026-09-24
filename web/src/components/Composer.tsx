"use client";

/**
 * The question box. The empty page and the follow-up box under a thread use
 * the same one, so asking looks and behaves the same either way: Enter sends,
 * Shift+Enter adds a line. It grows with what is typed, up to a limit.
 */

import { ArrowUp, CalendarDays, Check, ChevronDown, Loader2, Paperclip } from "lucide-react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUPPORTED_YAS, type YA } from "./Shell";

const PAYSLIP_TYPES = "image/jpeg,image/png,image/webp,application/pdf";
const MAX_HEIGHT = 240;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  ya: string;
  /** Lets the year be switched from the box itself. */
  onYaChange?: (ya: YA) => void;
  /** Shows "Upload payslip" and hands the chosen file over. */
  onAttach?: (file: File) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  /** A question is already running here. */
  busy?: boolean;
  autoFocus?: boolean;
  className?: string;
}

export function Composer({
  value, onChange, onSubmit, ya, onYaChange, onAttach, inputRef, placeholder, busy = false,
  autoFocus = false, className = "",
}: Props) {
  const disabled = busy || !value.trim();
  const fileRef = useRef<HTMLInputElement>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, ref]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit(value);
      }}
      className={`rounded-2xl border border-line-strong bg-white shadow-[0_1px_2px_rgba(26,29,33,0.04),0_10px_28px_-16px_rgba(26,29,33,0.18)] transition-[border-color,box-shadow] focus-within:border-brand-600/50 focus-within:ring-4 focus-within:ring-brand-600/10 ${className}`}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!disabled) onSubmit(value);
          }
        }}
        rows={2}
        autoFocus={autoFocus}
        aria-label="Your question"
        placeholder={placeholder ?? "What do I owe for 2026/2027 on a salary of LKR 250,000 a month?"}
        className="block max-h-[240px] w-full resize-none bg-transparent px-4 pb-1 pt-4 text-[16px] leading-[1.5] text-ink-900 outline-none placeholder:text-ink-300 focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
        <div className="flex min-w-0 items-center gap-1">
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
                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13.5px] text-ink-500 transition-colors hover:bg-muted hover:text-ink-900 disabled:opacity-40"
              >
                <Paperclip className="size-4" />
                <span className="hidden sm:inline">Upload payslip</span>
              </button>
            </>
          )}
          {onYaChange ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Year of assessment ${ya}. Change year`}
                className="tnum flex h-8 items-center gap-1.5 rounded-md px-2 text-[13.5px] text-ink-500 transition-colors hover:bg-muted hover:text-ink-900 data-popup-open:bg-muted"
              >
                <CalendarDays className="size-4" />
                {ya}
                <ChevronDown className="size-3.5 text-ink-300" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-[12px] font-normal text-ink-400">Year of assessment</DropdownMenuLabel>
                  {SUPPORTED_YAS.map((y) => (
                    <DropdownMenuItem key={y} onClick={() => onYaChange(y)} className="tnum justify-between">
                      {y}
                      {y === ya && <Check className="text-brand-600" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="tnum hidden px-2 text-[13px] text-ink-400 sm:inline">Year {ya}</span>
          )}
        </div>
        <button
          type="submit"
          disabled={disabled}
          aria-label="Ask"
          className="flex size-9 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85 disabled:bg-canvas disabled:text-ink-300"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
    </form>
  );
}
