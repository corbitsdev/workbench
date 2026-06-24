import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Search } from 'lucide-react';
import {
  useCreateMyraThread,
  useMyraThreads,
  writeLastActiveThreadId,
} from '../hooks/use-myra-threads';
import type { MyraThread } from '../lib/hub-api';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Full searchable list of the member's Myra chats. The sidebar shows recent
 * threads for quick switching; this is the browse-all surface.
 */
export function ChatsListPage() {
  const { data: threads, isLoading, isError, refetch } = useMyraThreads();
  const createThread = useCreateMyraThread();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const open = (thread: MyraThread) => {
    writeLastActiveThreadId(thread.id);
    navigate(`/chats/${thread.id}`);
  };

  const newChat = () => {
    createThread.mutate(undefined, {
      onSuccess: (thread) => {
        writeLastActiveThreadId(thread.id);
        navigate(`/chats/${thread.id}`);
      },
    });
  };

  const normalized = query.trim().toLowerCase();
  const filtered = (threads ?? []).filter((t) => t.label.toLowerCase().includes(normalized));

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-text">Chats</h1>
        <button
          type="button"
          onClick={newChat}
          disabled={createThread.isPending}
          className="flex items-center gap-2 rounded-[10px] bg-orange px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Plus size={16} />
          {createThread.isPending ? 'Creating…' : 'New chat'}
        </button>
      </div>

      <div className="relative mt-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-3" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          className="w-full rounded-[10px] border border-border bg-surface py-2 pl-9 pr-3 text-sm text-text outline-none transition-colors focus:border-orange"
        />
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {isLoading && <p className="px-1 py-6 text-sm text-text-2">Loading chats…</p>}

        {isError && (
          <div className="flex flex-col items-start gap-2 px-1 py-6 text-sm text-text-2">
            <span>Couldn't load your chats.</span>
            <button type="button" onClick={() => void refetch()} className="text-orange underline">
              Try again
            </button>
          </div>
        )}

        {!isLoading && !isError && (threads?.length ?? 0) === 0 && (
          <p className="px-1 py-6 text-sm text-text-2">You don't have any chats yet.</p>
        )}

        {!isLoading && !isError && (threads?.length ?? 0) > 0 && filtered.length === 0 && (
          <p className="px-1 py-6 text-sm text-text-3">No chats match "{query}".</p>
        )}

        <div className="flex flex-col gap-1">
          {filtered.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => open(thread)}
              className="flex items-center justify-between gap-3 rounded-[10px] border border-transparent px-3 py-3 text-left transition-colors hover:border-border hover:bg-surface"
            >
              <span className="truncate text-sm font-medium text-text">{thread.label}</span>
              <span className="shrink-0 text-xs text-text-3">{formatWhen(thread.createdAt)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
