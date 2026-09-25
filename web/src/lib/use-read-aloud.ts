"use client";

/**
 * Read-aloud through the browser's speech synthesis. Chrome cuts off a single
 * long utterance after about fifteen seconds, so the text is spoken a sentence
 * at a time.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

const subscribe = () => () => {};
const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** Splits on sentence ends and keeps each piece short enough to speak reliably. */
function chunks(text: string): string[] {
  const parts = text.match(/[^.!?\n]+[.!?]*/g) ?? [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function useReadAloud(lang = "en-LK") {
  const supported = useSyncExternalStore(subscribe, canSpeak, () => false);
  const [speaking, setSpeaking] = useState(false);
  // Bumped on every start and stop, so a cancelled run's late events are ignored.
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
    if (canSpeak()) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!canSpeak() || !text.trim()) return;
      window.speechSynthesis.cancel();
      const run = ++runRef.current;
      const pieces = chunks(text);
      setSpeaking(true);
      pieces.forEach((piece, i) => {
        const u = new SpeechSynthesisUtterance(piece);
        u.lang = lang;
        u.rate = 0.98;
        const done = () => {
          if (runRef.current === run && i === pieces.length - 1) setSpeaking(false);
        };
        u.onend = done;
        u.onerror = done;
        window.speechSynthesis.speak(u);
      });
    },
    [lang],
  );

  // Leaving the page must not leave the answer talking.
  useEffect(() => () => {
    if (canSpeak()) window.speechSynthesis.cancel();
  }, []);

  return { supported, speaking, speak, stop };
}
