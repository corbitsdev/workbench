import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  useDeleteMyraThread,
  useMyraThreads,
  useRenameMyraThread,
  writeLastActiveThreadId,
} from "../../hooks/use-myra-threads";
import { isMyraThreadUsed } from "../../hooks/myra-threads-cache";
import type { MyraThread } from "../../lib/hub-api";

// The sidebar shows only the most-recently-active chats; the rest live on the
// /chats page reached via the "View all" link below.
const SIDEBAR_THREAD_LIMIT = 10;

function useActiveThreadId(): string | null {
  const location = useLocation();
  const match = location.pathname.match(/^\/chats\/([^/]+)/);
  return match?.[1] ?? null;
}

function ThreadRow({
  thread,
  active,
  onOpen,
}: {
  thread: MyraThread;
  active: boolean;
  onOpen: (thread: MyraThread) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.label);
  const rename = useRenameMyraThread();
  const remove = useDeleteMyraThread();
  const navigate = useNavigate();
  const threads =
    useMyraThreads({ limit: SIDEBAR_THREAD_LIMIT }).data?.threads ?? [];

  const commitRename = () => {
    const label = draft.trim();
    setEditing(false);
    if (!label || label === thread.label) {
      setDraft(thread.label);
      return;
    }
    rename.mutate(
      { id: thread.id, label },
      { onError: () => setDraft(thread.label) },
    );
  };

  const confirmDelete = () => {
    setMenuOpen(false);
    remove.mutate(thread.id, {
      onSuccess: () => {
        if (active) {
          const next = threads.find((t) => t.id !== thread.id);
          navigate(next ? `/chats/${next.id}` : "/chats", { replace: true });
        }
      },
    });
  };

  if (editing) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: rename field should capture focus immediately
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitRename();
          if (e.key === "Escape") {
            setDraft(thread.label);
            setEditing(false);
          }
        }}
        className="w-full rounded-[8px] border border-border bg-page px-2 py-1.5 text-sm text-text outline-none focus:border-orange"
      />
    );
  }

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        onClick={() => onOpen(thread)}
        className={`flex-1 truncate rounded-[8px] px-2 py-1.5 text-left text-sm transition-colors ${
          active
            ? "bg-orange/10 font-medium text-orange"
            : "text-text-2 hover:bg-page hover:text-text"
        }`}
      >
        {thread.label}
      </button>
      <button
        type="button"
        aria-label="Thread options"
        onClick={() => setMenuOpen((v) => !v)}
        className="absolute right-1 grid h-7 w-7 place-items-center rounded-[8px] text-text-3 opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
      >
        <MoreHorizontal size={16} />
      </button>

      {menuOpen && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute right-1 top-8 z-20 w-[140px] rounded-[10px] border border-border bg-surface py-1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setDraft(thread.label);
                setEditing(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-2 hover:bg-page hover:text-text"
            >
              <Pencil size={14} /> Rename
            </button>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={confirmDelete}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-500 hover:bg-page disabled:opacity-50"
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ThreadList() {
  const { data, isLoading, isError } = useMyraThreads({
    limit: SIDEBAR_THREAD_LIMIT,
  });
  const activeThreadId = useActiveThreadId();
  const navigate = useNavigate();

  const openThread = (thread: MyraThread) => {
    writeLastActiveThreadId(thread.id);
    navigate(`/chats/${thread.id}`);
  };

  if (isLoading) {
    return <div className="px-2 py-1 text-xs text-text-3">Loading chats…</div>;
  }

  if (isError) {
    return (
      <div className="px-2 py-1 text-xs text-text-3">Couldn't load chats</div>
    );
  }

  // A freshly created thread stays out of the sidebar until its first message
  // is sent — "+ New chat" navigates without mutating the list (CL-3749).
  const shown = (data?.threads ?? []).filter(isMyraThreadUsed);
  if (shown.length === 0) {
    return <div className="px-2 py-1 text-xs text-text-3">No chats yet</div>;
  }

  // The server reports the member's full thread count; if it exceeds the
  // fetched page, offer the full list rather than silently truncating. Compared
  // against the raw page (not the used-filtered `shown`) so hidden unused
  // threads don't fake a "View all" link.
  const hasMore = (data?.total ?? 0) > (data?.threads.length ?? 0);

  return (
    <div className="flex flex-col gap-0.5">
      {shown.map((thread) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          active={thread.id === activeThreadId}
          onOpen={openThread}
        />
      ))}
      {hasMore && (
        <Link
          to="/chats"
          className="rounded-[8px] px-2 py-1.5 text-left text-xs text-text-3 transition-colors hover:bg-page hover:text-text"
        >
          View all chats
        </Link>
      )}
    </div>
  );
}
