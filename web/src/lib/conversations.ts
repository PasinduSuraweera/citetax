"use client";

/**
 * Conversations, client side.
 *
 * PostgreSQL is the store of record. This module holds only what is on screen
 * for the signed in user: the Recent list and the threads opened in this tab,
 * so moving between pages does not refetch them. Nothing is written to
 * localStorage. Everything here is dropped when the signed in user changes,
 * including on sign out, so another account in the same browser never sees
 * the previous one's titles.
 *
 * Every response is checked against the owner it was requested for, and a
 * thread only ever renders the state stored under its own id, so a slow
 * response for one conversation can never show up in another.
 */

import { useSyncExternalStore } from "react";
import {
  api,
  ApiError,
  type AnswerResponse,
  type ConversationSummary,
  type ConversationTurn,
} from "./api";

type Status = "idle" | "loading" | "ready" | "error";

export interface ListState {
  items: ConversationSummary[];
  cursor: string | null;
  hasMore: boolean;
  status: Status;
  loadingMore: boolean;
  error: string | null;
}

export interface ThreadState {
  status: Status;
  conversation: ConversationSummary | null;
  turns: ConversationTurn[];
  hasMore: boolean;
  beforeSeq: number | null;
  loadingEarlier: boolean;
  error: string | null;
  notFound: boolean;
}

interface State {
  owner: string | null;
  list: ListState;
  threads: Record<string, ThreadState>;
  /** Question text running per conversation key (an id, or a draft key). */
  pending: Record<string, string>;
  /** Last ask failure per conversation key. Status 0 means unreachable. */
  failures: Record<string, AskFailure>;
}

export interface AskFailure {
  message: string;
  status: number;
}

const PAGE = 20;

const EMPTY_LIST: ListState = {
  items: [], cursor: null, hasMore: false, status: "idle", loadingMore: false, error: null,
};

const EMPTY_THREAD: ThreadState = {
  status: "idle", conversation: null, turns: [], hasMore: false, beforeSeq: null,
  loadingEarlier: false, error: null, notFound: false,
};

let state: State = { owner: null, list: EMPTY_LIST, threads: {}, pending: {}, failures: {} };
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function patchThread(id: string, patch: Partial<ThreadState>): void {
  const current = state.threads[id] ?? EMPTY_THREAD;
  set({ threads: { ...state.threads, [id]: { ...current, ...patch } } });
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/* ---------- owner ---------- */

/** Point the store at the signed in user. A different user, or none, empties it. */
export function syncOwner(owner: string | null): void {
  if (state.owner === owner) return;
  state = { owner, list: EMPTY_LIST, threads: {}, pending: {}, failures: {} };
  listeners.forEach((fn) => fn());
}

/* ---------- Recent list ---------- */

export function ensureList(): void {
  if (!state.owner || state.list.status !== "idle") return;
  void loadFirstPage();
}

export async function loadFirstPage(): Promise<void> {
  const owner = state.owner;
  if (!owner) return;
  set({ list: { ...state.list, status: "loading", error: null } });
  try {
    const page = await api.conversations(null, PAGE);
    if (state.owner !== owner) return;
    set({
      list: {
        ...state.list,
        items: page.conversations,
        cursor: page.next_cursor,
        hasMore: Boolean(page.next_cursor),
        status: "ready",
        error: null,
      },
    });
  } catch (e) {
    if (state.owner !== owner) return;
    set({ list: { ...state.list, status: "error", error: message(e, "Could not load your chats.") } });
  }
}

export async function loadMore(): Promise<void> {
  const owner = state.owner;
  const { cursor, loadingMore } = state.list;
  if (!owner || !cursor || loadingMore) return;
  set({ list: { ...state.list, loadingMore: true, error: null } });
  try {
    const page = await api.conversations(cursor, PAGE);
    if (state.owner !== owner) return;
    const known = new Set(state.list.items.map((c) => c.id));
    set({
      list: {
        ...state.list,
        items: [...state.list.items, ...page.conversations.filter((c) => !known.has(c.id))],
        cursor: page.next_cursor,
        hasMore: Boolean(page.next_cursor),
        loadingMore: false,
      },
    });
  } catch (e) {
    if (state.owner !== owner) return;
    set({ list: { ...state.list, loadingMore: false, error: message(e, "Could not load more chats.") } });
  }
}

/** A conversation had a new turn: it moves to the top of Recent. */
function touch(summary: ConversationSummary): void {
  const rest = state.list.items.filter((c) => c.id !== summary.id);
  set({ list: { ...state.list, items: [summary, ...rest] } });
}

/* ---------- threads ---------- */

const requestSeq: Record<string, number> = {};

/** Load the newest turns. A thread already on screen stays while it refreshes. */
export async function openThread(id: string): Promise<void> {
  const owner = state.owner;
  if (!owner) return;
  const ticket = (requestSeq[id] = (requestSeq[id] ?? 0) + 1);
  const cached = state.threads[id];
  patchThread(id, {
    status: cached?.turns.length ? "ready" : "loading",
    error: null,
    notFound: false,
  });
  try {
    const page = await api.conversation(id);
    if (state.owner !== owner || requestSeq[id] !== ticket) return;
    // Keep a turn added here after this request was sent.
    const newest = page.turns.length ? page.turns[page.turns.length - 1].seq : 0;
    const local = (state.threads[id]?.turns ?? []).filter((t) => t.seq > newest);
    patchThread(id, {
      status: "ready",
      conversation: page.conversation,
      turns: [...page.turns, ...local],
      hasMore: page.has_more,
      beforeSeq: page.before_seq,
    });
  } catch (e) {
    if (state.owner !== owner || requestSeq[id] !== ticket) return;
    if (e instanceof ApiError && e.status === 404) {
      patchThread(id, { status: "error", notFound: true, error: null });
      return;
    }
    patchThread(id, {
      status: cached?.turns.length ? "ready" : "error",
      error: message(e, "Could not load this chat."),
    });
  }
}

export async function loadEarlier(id: string): Promise<void> {
  const owner = state.owner;
  const thread = state.threads[id];
  if (!owner || !thread?.beforeSeq || thread.loadingEarlier) return;
  patchThread(id, { loadingEarlier: true, error: null });
  try {
    const page = await api.conversation(id, thread.beforeSeq);
    if (state.owner !== owner) return;
    const current = state.threads[id] ?? EMPTY_THREAD;
    const known = new Set(current.turns.map((t) => t.seq));
    patchThread(id, {
      turns: [...page.turns.filter((t) => !known.has(t.seq)), ...current.turns],
      hasMore: page.has_more,
      beforeSeq: page.before_seq,
      loadingEarlier: false,
    });
  } catch (e) {
    if (state.owner !== owner) return;
    patchThread(id, { loadingEarlier: false, error: message(e, "Could not load earlier messages.") });
  }
}

/** A saved /v1/ask response, as the turn a reload would show. */
export function turnFrom(res: AnswerResponse): ConversationTurn {
  return {
    seq: res.seq ?? 0,
    question: {
      id: res.question_message_id ?? "",
      content: res.user_message ?? "",
      created_at: res.conversation?.updated_at ?? null,
    },
    reply: {
      id: res.message_id ?? "",
      seq: (res.seq ?? 0) + 1,
      kind: res.kind,
      created_at: res.conversation?.updated_at ?? null,
      answer: res,
    },
  };
}

/** Record a turn the API saved: into its thread, and to the top of Recent.
 *  `owner` is who asked; a response that lands after a sign out or a switch
 *  of account is dropped rather than shown to the next user. */
export function recordTurn(res: AnswerResponse, owner: string | null): void {
  if (!res.conversation_id || !res.conversation || state.owner !== owner) return;
  const id = res.conversation_id;
  const current = state.threads[id];
  const turn = turnFrom(res);
  if (current && current.status !== "idle") {
    patchThread(id, {
      conversation: res.conversation,
      turns: [...current.turns.filter((t) => t.seq !== turn.seq), turn],
    });
  } else {
    // A brand new conversation: this one turn is the whole thread.
    patchThread(id, {
      status: "ready",
      conversation: res.conversation,
      turns: [turn],
      hasMore: false,
      beforeSeq: null,
    });
  }
  touch(res.conversation);
}

/* ---------- rename and delete ---------- */

export async function renameConversation(id: string, title: string): Promise<void> {
  const summary = await api.renameConversation(id, title);
  set({
    list: {
      ...state.list,
      items: state.list.items.map((c) => (c.id === id ? summary : c)),
    },
  });
  if (state.threads[id]) patchThread(id, { conversation: summary });
}

export async function deleteConversation(id: string): Promise<void> {
  await api.deleteConversation(id);
  const threads = { ...state.threads };
  delete threads[id];
  set({
    threads,
    list: { ...state.list, items: state.list.items.filter((c) => c.id !== id) },
  });
}

/* ---------- asking ---------- */

export function startPending(key: string, question: string): void {
  const failures = { ...state.failures };
  delete failures[key];
  set({ pending: { ...state.pending, [key]: question }, failures });
}

export function endPending(key: string, failure?: AskFailure): void {
  const pending = { ...state.pending };
  delete pending[key];
  set({
    pending,
    failures: failure ? { ...state.failures, [key]: failure } : state.failures,
  });
}

export function clearFailure(key: string): void {
  if (!(key in state.failures)) return;
  const failures = { ...state.failures };
  delete failures[key];
  set({ failures });
}

/* ---------- hooks ---------- */

const getState = () => state;
const getServerState = () => state;

export function useConversations(): State {
  return useSyncExternalStore(subscribe, getState, getServerState);
}

export const EMPTY = EMPTY_THREAD;
