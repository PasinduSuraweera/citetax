"use client";

/**
 * Years of assessment, and the one the user is looking at.
 *
 * The supported years and today's year come from the API (/v1/years), which
 * reads them from config, so the app never keeps its own list (#57). The
 * user's choice is one selection shared by every page and kept across reloads
 * (#74); with no choice made, it is the year today falls in.
 */

import { useSyncExternalStore } from "react";
import { API_BASE } from "./api";

export type YA = string;

const KEY = "citetax.ya";

interface State {
  /** Newest first, the order the pickers show. */
  years: YA[];
  current: YA;
  selected: YA | null;
}

// Shown only until /v1/years answers, which on a warm API is the first paint.
const INITIAL: State = { years: ["2026/2027", "2025/2026"], current: "2026/2027", selected: null };

let state = INITIAL;
let started = false;
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function readStored(): YA | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function start() {
  if (started) return;
  started = true;
  const stored = readStored();
  if (stored) set({ selected: stored });
  fetch(`${API_BASE}/v1/years`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { supported: YA[]; current: YA } | null) => {
      if (!data?.supported?.length) return;
      const years = [...data.supported].sort().reverse();
      // A stored year the API no longer supports falls back to today's.
      set({ years, current: data.current, selected: state.selected && years.includes(state.selected) ? state.selected : null });
    })
    .catch(() => undefined);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  start();
  return () => listeners.delete(listener);
}

const snapshot = () => state;
const serverSnapshot = () => INITIAL;

export function useYears(): { years: YA[]; current: YA } {
  const s = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return { years: s.years, current: s.current };
}

/** The selected year and a setter, shared by every page. */
export function useYa(): [YA, (ya: YA) => void] {
  const s = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return [s.selected ?? s.current, selectYa];
}

export function selectYa(ya: YA) {
  try {
    window.localStorage.setItem(KEY, ya);
  } catch {
    /* private mode: the choice lasts for this page load */
  }
  set({ selected: ya });
}

/** "2025/2026 and 2026/2027", oldest first. */
export function yearsPhrase(years: YA[], joiner = "and"): string {
  const asc = [...years].sort();
  return asc.length < 2 ? (asc[0] ?? "") : `${asc.slice(0, -1).join(", ")} ${joiner} ${asc[asc.length - 1]}`;
}
