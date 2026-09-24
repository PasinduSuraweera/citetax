"use client";

/**
 * Recent chats, in the sidebar, grouped by when they were last used.
 *
 * Reads only the first page of titles when the app opens; opening a thread is
 * a separate request. Signed out, it renders nothing: anonymous questions are
 * not kept as conversations.
 */

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
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

const DAY = 24 * 60 * 60 * 1000;

function groupOf(c: ConversationSummary, today: number): string {
  const t = c.updated_at ?? c.created_at;
  if (!t) return "Older";
  const age = today - new Date(t).setHours(0, 0, 0, 0);
  if (age <= 0) return "Today";
  if (age <= DAY) return "Yesterday";
  if (age <= 7 * DAY) return "Previous 7 days";
  return "Older";
}

export function ConversationList({ onNavigate }: { onNavigate: () => void }) {
  const { user } = useSession();
  const owner = user?.email ?? null;
  const { list } = useConversations();
  const pathname = usePathname();
  const params = useSearchParams();
  const activeId = pathname === "/chat" ? params.get("c") : null;

  useEffect(() => {
    syncOwner(owner);
    ensureList();
  }, [owner]);

  if (!user) return null;

  const { items, status, error, hasMore, loadingMore } = list;
  const today = new Date().setHours(0, 0, 0, 0);
  const groups: Array<[string, ConversationSummary[]]> = [];
  for (const c of items) {
    const g = groupOf(c, today);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(c);
    else groups.push([g, [c]]);
  }

  return (
    <section aria-label="Recent chats" className="-mx-2 mt-6 min-h-[120px] flex-1 overflow-y-auto px-2 [scrollbar-width:thin] lg:min-h-0">
      {(status === "idle" || status === "loading") && items.length === 0 && (
        <div className="flex flex-col gap-2 px-2" aria-label="Loading chats">
          <Skeleton className="h-3 w-16 bg-white/10" />
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-7 w-full bg-white/10" />)}
        </div>
      )}

      {status === "error" && items.length === 0 && (
        <div className="px-2 text-[13px] leading-[1.5] text-white/60">
          {error}{" "}
          <button type="button" onClick={() => void loadFirstPage()} className="font-medium text-sidebar-primary hover:underline">
            Try again
          </button>
        </div>
      )}

      {status === "ready" && items.length === 0 && (
        <p className="px-2 text-[13px] leading-[1.5] text-white/50">
          Your chats will be listed here.
        </p>
      )}

      {groups.map(([label, chats]) => (
        <div key={label} className="mb-4">
          <h3 className="px-2 pb-1 text-[12px] font-medium text-white/45">{label}</h3>
          <ul className="flex flex-col">
            {chats.map((c) => (
              <ConversationItem key={c.id} conversation={c} active={c.id === activeId} onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      ))}

      {hasMore && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="w-full rounded-md px-2 py-[6px] text-left text-[13px] text-white/60 hover:bg-white/[0.05] hover:text-white disabled:opacity-60"
        >
          {loadingMore ? "Loading" : "Show older chats"}
        </button>
      )}

      {status === "ready" && error && (
        <p className="mt-2 px-2 text-[12.5px] text-[#f5b1a9]">{error}</p>
      )}
    </section>
  );
}

function ConversationItem({
  conversation, active, onNavigate,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "rename" | "confirm">("idle");
  const [draft, setDraft] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter saves and the blur that follows would save again; Escape cancels
  // and the blur on unmount must not save. The first of them settles it.
  const renameSettled = useRef(false);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
  }, [mode]);

  const saveRename = async () => {
    if (renameSettled.current) return;
    renameSettled.current = true;
    const title = draft.trim();
    if (!title || title === conversation.title) {
      setMode("idle");
      return;
    }
    setBusy(true);
    try {
      await renameConversation(conversation.id, title);
      setMode("idle");
      toast.success("Chat renamed");
    } catch {
      renameSettled.current = false;
      toast.error("Could not rename the chat. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteConversation(conversation.id);
      toast.success("Chat deleted", { description: "Its answers are still in History." });
      if (active) {
        // The open chat is gone; start a new one rather than show a 404.
        requestNewQuestion();
        router.push("/chat");
      }
    } catch {
      toast.error("Could not delete the chat. Try again.");
      setBusy(false);
      setMode("idle");
    }
  };

  if (mode === "rename") {
    return (
      <li>
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
              setMode("idle");
            }
          }}
          onBlur={() => void saveRename()}
          className="w-full rounded-md border border-sidebar-primary bg-white/10 px-2 py-[5px] text-[13.5px] text-white outline-none"
        />
      </li>
    );
  }

  if (mode === "confirm") {
    return (
      <li className="rounded-md bg-white/[0.07] px-2 py-2">
        <p className="text-[12.5px] leading-[1.45] text-white/80">
          Delete &ldquo;{conversation.title}&rdquo;? Its answers stay in History.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-md bg-[#c2372b] px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-[#a4271c] disabled:opacity-60"
          >
            {busy ? "Deleting" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setMode("idle")}
            className="rounded-md px-2.5 py-1 text-[12.5px] text-white/70 hover:bg-white/10 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group relative">
      <Link
        href={`/chat?c=${conversation.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        title={conversation.title}
        className={`block truncate rounded-md py-[6px] pl-2 pr-8 text-[13.5px] transition-colors ${
          active
            ? "bg-white/10 font-medium text-white"
            : "text-white/70 hover:bg-white/[0.05] hover:text-white"
        }`}
      >
        {conversation.title}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Options for ${conversation.title}`}
          className={`absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white data-popup-open:opacity-100 ${
            active ? "opacity-100" : "opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
          }`}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onClick={() => {
              renameSettled.current = false;
              setDraft(conversation.title);
              setMode("rename");
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setMode("confirm")}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
