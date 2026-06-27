import { useState } from "react";
import { useNavigate } from "react-router";
import { PagePanel } from "@workbench/ui";
import { Plus } from "lucide-react";
import {
  useCreateMyraThread,
  useMyraThreads,
  writeLastActiveThreadId,
} from "../hooks/use-myra-threads";
import type { MyraThread } from "../lib/hub-api";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Full searchable list of the member's Myra chats. The sidebar shows recent
 * threads for quick switching; this is the browse-all surface.
 */
export function ChatsListPage() {
  const { data: threads, isLoading, isError, refetch } = useMyraThreads();
  const createThread = useCreateMyraThread();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [newChatError, setNewChatError] = useState<string | null>(null);

  const open = (thread: MyraThread) => {
    writeLastActiveThreadId(thread.id);
    navigate(`/chats/${thread.id}`);
  };

  const newChat = () => {
    setNewChatError(null);
    createThread.mutate(undefined, {
      onSuccess: (thread) => {
        writeLastActiveThreadId(thread.id);
        navigate(`/chats/${thread.id}`);
      },
      onError: () => {
        setNewChatError("Could not start a new chat. Try again.");
      },
    });
  };

  const normalized = query.trim().toLowerCase();
  const filtered = (threads ?? []).filter((t) =>
    t.label.toLowerCase().includes(normalized),
  );

  return (
    <PagePanel>
      <div className="flex items-center gap-[14px] px-4 pb-[14px] pt-5 sm:px-7">
        <h1 className="text-[21px] font-bold tracking-[-0.02em] text-text">
          Chats
        </h1>
        {!isLoading && (
          <span className="rounded-[7px] bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
            {filtered.length} {filtered.length === 1 ? "chat" : "chats"}
          </span>
        )}
        <div className="flex-1" />
        {newChatError && (
          <span className="text-[12px] text-orange-deep">{newChatError}</span>
        )}
        <input
          type="search"
          aria-label="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          className="h-[34px] w-[180px] rounded-[9px] border border-border bg-transparent px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
        />
        <button
          type="button"
          onClick={newChat}
          disabled={createThread.isPending}
          className="flex items-center gap-[7px] rounded-[9px] border border-border bg-transparent px-[13px] py-[7px] text-[12.5px] font-semibold text-text transition-colors hover:bg-surface disabled:opacity-50"
        >
          <Plus size={16} className="text-orange" />
          {createThread.isPending ? "Creating…" : "New chat"}
        </button>
      </div>

      <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7">
        {isLoading && (
          <div className="py-10 text-[13px] text-text-3">Loading chats…</div>
        )}

        {isError && (
          <div className="flex flex-col items-start gap-3 py-10 text-[13px] text-text-3">
            <span>Could not load chats.</span>
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-[9px] border border-border px-[11px] py-[6px] text-[12.5px] font-semibold text-text transition-colors hover:bg-surface"
            >
              Try again
            </button>
          </div>
        )}

        {!isLoading && !isError && (threads?.length ?? 0) === 0 && (
          <div className="py-10 text-[13px] text-text-3">
            No chats yet. Start a new chat when you're ready.
          </div>
        )}

        {!isLoading &&
          !isError &&
          (threads?.length ?? 0) > 0 &&
          filtered.length === 0 && (
            <div className="py-10 text-[13px] text-text-3">
              No chats match &ldquo;{query.trim()}&rdquo;.
            </div>
          )}

        {!isLoading && !isError && filtered.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[var(--gap)]">
            {filtered.map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => open(thread)}
                className="group flex min-h-[104px] flex-col justify-between rounded-lg border border-border bg-surface p-[13px] text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange"
              >
                <span className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-text">
                  {thread.label}
                </span>
                <span className="mt-5 flex items-center justify-between gap-3 font-mono text-[11px] text-text-3">
                  <span>{formatWhen(thread.createdAt)}</span>
                  <span className="font-sans text-[12px] font-medium text-text-3 transition-colors group-hover:text-text-2">
                    Open chat
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </PagePanel>
  );
}
