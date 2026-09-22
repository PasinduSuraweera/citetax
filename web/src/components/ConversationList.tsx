"use client";

/**
 * Recent chats, in the rail.
 *
 * Reads only the first page of titles when the app opens; opening a thread is
 * a separate request. Signed out, it renders nothing: anonymous questions are
 * not kept as conversations.
 */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "@/lib/api";
import { requestNewQuestion } from "@/lib/ask-store";
import {
  deleteConversation,
  ensureList,
  loadFirstPage,
  loadMore,
  renameConversation,
  syncOwner,
  useConversations,
} from "@/lib/conversations";
import { useSession } from "@/lib/session";

export function ConversationList({ onNavigate }: { onNavigate: () => void }) {
  const { user } = useSession();
  const owner = user?.email ?? null;
  const { list } = useConversations();
  const pathname = usePathname();
  const params = useSearchParams();
  const activeId = pathname === "/" ? params.get("c") : null;
  const [menuFor, setMenuFor] = useState<string | null>(null);

  useEffect(() => {
    syncOwner(owner);
    ensureList();
  }, [owner]);

  if (!user) return null;

  const { items, status, error, hasMore, loadingMore } = list;

  return (
    <section aria-label="Recent chats" className="mt-[22px] flex min-h-0 flex-1 flex-col">
      <div className="mb-[9px] font-mono text-[10px] font-medium tracking-[0.16em] text-white/[0.32]">
        RECENT
      </div>

      <div className="-mx-1 min-h-[120px] flex-1 overflow-y-auto px-1 [scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin] lg:min-h-0">
        {(status === "idle" || status === "loading") && items.length === 0 && (
          <div className="flex flex-col gap-[6px]" aria-label="Loading chats">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[30px] animate-pulse rounded-lg bg-white/[0.05]" />
            ))}
          </div>
        )}

        {status === "error" && items.length === 0 && (
          <div className="rounded-lg border border-white/10 px-[11px] py-[10px]">
            <p className="text-[12px] leading-[1.45] text-white/60">{error}</p>
            <button
              type="button"
              onClick={() => void loadFirstPage()}
              className="mt-2 font-mono text-[10.5px] text-good-mintsoft hover:text-white"
            >
              Retry
            </button>
          </div>
        )}

        {status === "ready" && items.length === 0 && (
          <p className="px-[11px] py-2 text-[12px] leading-[1.5] text-white/40">
            No chats yet. Your questions will appear here.
          </p>
        )}

        {items.length > 0 && (
          <ul className="flex flex-col gap-px">
            {items.map((c) => (
              <ConversationItem
                key={c.id}
                conversation={c}
                active={c.id === activeId}
                menuOpen={menuFor === c.id}
                onMenu={(open) => setMenuFor(open ? c.id : null)}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}

        {hasMore && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-2 w-full rounded-lg px-[11px] py-[7px] text-left font-mono text-[10.5px] text-white/45 transition-colors hover:bg-white/[0.04] hover:text-white/80 disabled:opacity-60"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        )}

        {status === "ready" && error && (
          <p className="mt-2 px-[11px] text-[11.5px] text-[#F5A9A2]">{error}</p>
        )}
      </div>
    </section>
  );
}

function ConversationItem({
  conversation, active, menuOpen, onMenu, onNavigate,
}: {
  conversation: ConversationSummary;
  active: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "rename" | "confirm">("idle");
  const [draft, setDraft] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter saves and the blur that follows would save again; Escape cancels
  // and the blur on unmount must not save. The first of them settles it.
  const renameSettled = useRef(false);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
  }, [mode]);

  const close = () => {
    setMode("idle");
    setError(null);
    onMenu(false);
  };

  const saveRename = async () => {
    if (renameSettled.current) return;
    renameSettled.current = true;
    const title = draft.trim();
    if (!title || title === conversation.title) {
      close();
      return;
    }
    setBusy(true);
    try {
      await renameConversation(conversation.id, title);
      close();
    } catch {
      renameSettled.current = false;
      setError("Could not rename.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteConversation(conversation.id);
      onMenu(false);
      if (active) {
        // The open chat is gone; start a new one rather than show a 404.
        requestNewQuestion();
        router.push("/");
      }
    } catch {
      setError("Could not delete.");
      setBusy(false);
    }
  };

  return (
    <li className="group relative">
      {mode === "rename" ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={120}
          aria-label="Chat title"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveRename();
            if (e.key === "Escape") {
              renameSettled.current = true;
              close();
            }
          }}
          onBlur={() => void saveRename()}
          className="w-full rounded-lg border border-white/25 bg-white/[0.06] px-[10px] py-[6px] text-[13px] text-white outline-none focus:border-good-mintsoft"
        />
      ) : (
        <Link
          href={`/?c=${conversation.id}`}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          title={conversation.title}
          className={`block truncate rounded-lg py-[7px] pl-[11px] pr-9 text-[13px] transition-colors ${
            active
              ? "bg-white/[0.09] font-medium text-white"
              : "text-white/55 hover:bg-white/[0.04] hover:text-white/85"
          }`}
        >
          {conversation.title}
        </Link>
      )}

      {mode !== "rename" && (
        <button
          type="button"
          aria-label={`Options for ${conversation.title}`}
          aria-expanded={menuOpen}
          onClick={() => {
            setMode("idle");
            setError(null);
            onMenu(!menuOpen);
          }}
          className={`absolute right-1 top-[4px] flex h-[24px] w-[26px] items-center justify-center rounded-md font-mono text-[13px] leading-none text-white/60 transition-opacity hover:bg-white/10 hover:text-white focus:opacity-100 ${
            active || menuOpen ? "opacity-100" : "opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
          }`}
        >
          ⋯
        </button>
      )}

      {/* Inline rather than a floating menu, so the scrolling list never
          clips it. */}
      {menuOpen && mode === "idle" && (
        <div className="mx-[6px] mb-1 mt-px flex gap-1 rounded-lg border border-white/10 bg-[#141B3A] p-1">
          <button
            type="button"
            onClick={() => {
              renameSettled.current = false;
              setDraft(conversation.title);
              setMode("rename");
            }}
            className="flex-1 rounded-md px-2 py-[5px] text-[12px] text-white/75 hover:bg-white/[0.06] hover:text-white"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => setMode("confirm")}
            className="flex-1 rounded-md px-2 py-[5px] text-[12px] text-[#F5A9A2] hover:bg-white/[0.06]"
          >
            Delete
          </button>
        </div>
      )}

      {menuOpen && mode === "confirm" && (
        <div className="mx-[6px] mb-1 mt-px rounded-lg border border-[#F5A9A2]/30 bg-[#141B3A] px-[10px] py-2">
          <p className="text-[11.5px] leading-[1.45] text-white/70">
            Delete this chat for good? Its answers stay in History.
          </p>
          <div className="mt-2 flex gap-1">
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="flex-1 rounded-md bg-[#A22B23] px-2 py-[5px] text-[12px] font-semibold text-white hover:bg-[#7A2018] disabled:opacity-60"
            >
              {busy ? "Deleting..." : "Delete"}
            </button>
            <button
              type="button"
              onClick={close}
              className="flex-1 rounded-md px-2 py-[5px] text-[12px] text-white/70 hover:bg-white/[0.06]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="px-[11px] pb-1 text-[11px] text-[#F5A9A2]">{error}</p>}
    </li>
  );
}
