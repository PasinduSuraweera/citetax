"use client";

/**
 * The passages an explanation was written from, and the "(n)" markers in the
 * prose that point at them.
 *
 * The explain prompt numbers passages 1..n in the order the API returns them,
 * so a "(2)" in the prose is the second card here. That is the only link
 * between the two; nothing is inferred from the passage text.
 */

import { Fragment, useState, type ReactNode } from "react";
import type { Passage } from "@/lib/api";

const EXCERPT_CHARS = 260;

/** A heading a person can read: the rule's name, or the page title without
 *  the site's name wrapped around it. */
export function sourceTitle(p: Passage): string {
  if (p.rule_title) return p.rule_title;
  const site = siteName(p.url);
  if (p.title) {
    // Scraped titles can run on into the page's script ("... window.dataLayer
    // = ..."); nothing after the first bit of code is title.
    const clean = p.title.split(/\s(?:window\.|document\.|function\s*\(|var\s|const\s)|[{};]/)[0];
    // "Site Name :: - Page title" or "Page title | Site Name": keep the
    // longest part, which is the page's own title.
    const parts = clean
      .split(/\s*(?:::|\||·|—|–)\s*/)
      .map((s) => s.replace(/^[\s\-:]+|[\s\-:]+$/g, ""))
      .filter(Boolean);
    const best = parts.sort((a, b) => b.length - a.length)[0];
    // A lone file name or query string ("Tools.aspx?menuid=1605") is where
    // the scraper fell back to the URL; it names nothing.
    if (best && !/^[^\s]*[.?=/][^\s]*$/.test(best)) return best;
  }
  if (p.rule_key) return "Rule text";
  return site ? `Page on ${site}` : "Published source";
}

function siteName(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function matchedBy(p: Passage): string {
  return p.matched_by === "both"
    ? "Matched by keyword and meaning"
    : p.matched_by === "dense"
      ? "Matched by meaning"
      : "Matched by keyword";
}

export function SourcesList({ passages, highlight }: { passages: Passage[]; highlight?: number | null }) {
  return (
    <div className="flex flex-col gap-2">
      {passages.map((p, i) => (
        <SourceCard key={p.chunk_id} n={i + 1} passage={p} highlighted={highlight === i + 1} />
      ))}
      <p className="px-1 text-[12px] leading-[1.5] text-ink-400">
        Retrieved for the explanation only. No figure in any answer comes from
        a passage; figures come from the rules table.
      </p>
    </div>
  );
}

function SourceCard({ n, passage: p, highlighted }: { n: number; passage: Passage; highlighted: boolean }) {
  const [open, setOpen] = useState(false);
  const site = siteName(p.url);
  const long = p.text.length > EXCERPT_CHARS;

  return (
    <article
      id={`source-${n}`}
      className={`scroll-mt-4 rounded-xl border bg-white px-5 py-4 transition-colors ${
        highlighted ? "border-brand-600 ring-3 ring-brand-600/10" : "border-line"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          title={matchedBy(p)}
          className="mt-[2px] flex h-[20px] min-w-[20px] flex-none items-center justify-center rounded-[5px] bg-brand-100 px-1 text-[11px] font-semibold text-brand-600"
        >
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold leading-[1.4] text-ink-900">{sourceTitle(p)}</h3>
          <div className="mt-[2px] text-[12px] text-ink-400">
            {site ?? (p.rule_key ? "Rules table" : "Citetax corpus")}
          </div>

          <p className={`mt-2 text-[13.5px] leading-[1.6] text-ink-700 ${long && !open ? "line-clamp-3" : ""}`}>
            {p.text}
          </p>

          {(long || p.url) && (
            <div className="mt-2 flex items-center gap-4 text-[12.5px]">
              {long && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  className="font-medium text-ink-500 hover:text-brand-600"
                >
                  {open ? "Show less" : "Show more"}
                </button>
              )}
              {p.url && (
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand-600 hover:underline"
                >
                  Open source ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * Prose with each marker that names a real passage turned into a link to it.
 *
 * Two kinds of marker point at a passage: its number, "(2)" or "[2]", and the
 * rule key a rule passage is labelled with in the prompt, "(credit.apit)". A number
 * glued to the word before it, as in "s.93(3)", is a subsection and is left
 * alone, as is a number beyond the passages or a key no passage carries.
 */
export function ProseWithSources({
  text, passages, onSource,
}: {
  text: string;
  passages: Passage[];
  onSource?: (n: number) => void;
}) {
  if (!onSource || passages.length === 0) return <>{text}</>;

  const byKey = new Map<string, number>();
  passages.forEach((p, i) => {
    if (p.rule_key && !byKey.has(p.rule_key)) byKey.set(p.rule_key, i + 1);
  });

  const out: ReactNode[] = [];
  // The prompt asks for "[2]"; the model sometimes writes "(2)" or "([2])".
  const ref = String.raw`\d{1,2}|[a-z_]+(?:\.[a-z_]+)+`;
  const re = new RegExp(String.raw`(^|\s)(?:\((${ref})\)|\(?\[(${ref})\]\)?)`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = m[2] ?? m[3];
    const n = /^\d+$/.test(key) ? Number(key) : (byKey.get(key) ?? 0);
    if (n < 1 || n > passages.length) continue;
    const start = m.index + m[1].length;
    out.push(text.slice(last, start));
    out.push(
      <button
        key={`${start}-${n}`}
        type="button"
        onClick={() => onSource(n)}
        title={`Source ${n}`}
        className="relative -top-[1px] mx-[1px] inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-brand-100 px-1 align-middle text-[11px] font-semibold leading-none text-brand-600 transition-colors hover:bg-brand-600 hover:text-white"
      >
        {n}
      </button>,
    );
    last = start + m[0].length - m[1].length;
  }
  out.push(text.slice(last));
  return <>{out.map((part, i) => <Fragment key={i}>{part}</Fragment>)}</>;
}
