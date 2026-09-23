"use client";

/**
 * A tiny event bus so the sidebar can start a new chat on the ask page.
 *
 * "+ New chat" and the Ask nav item are links to "/". When you are already
 * on "/", Next.js sees no route change and nothing happens, so the button
 * looked broken. Rather than force a full page reload, which throws away the
 * snapshot fetch and the whole React tree, the sidebar publishes an intent and
 * the ask page listens for it.
 *
 * A new chat is only a fresh, empty draft. It creates nothing and clears
 * nothing: saved conversations are untouched, and a question still running in
 * the previous draft finishes into its own conversation.
 *
 * Pages other than "/" still navigate normally; the listener is only mounted
 * on the ask page, and the reset fires on arrival via the pathname effect.
 */

const RESET = "citetax:new-question";

export function requestNewQuestion(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RESET));
}

export function onNewQuestion(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(RESET, handler);
  return () => window.removeEventListener(RESET, handler);
}
