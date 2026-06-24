import { useState } from 'react';
import { ChevronDown, Plus, Check } from 'lucide-react';
import type { MyraThread } from '../lib/hub-api';

type ThreadSwitcherProps = {
  threads: MyraThread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  creating?: boolean;
};

export function ThreadSwitcher({
  threads,
  activeThreadId,
  onSelect,
  onNew,
  creating,
}: ThreadSwitcherProps) {
  const [open, setOpen] = useState(false);
  const active = threads.find((t) => t.id === activeThreadId) ?? null;
  const label = active?.label ?? 'Chat';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-[8px] px-2 py-1 text-xs font-medium text-text-2 transition-colors hover:text-text"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[140px] truncate">{label}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute right-0 z-20 mt-1 max-h-[280px] w-[220px] overflow-auto rounded-[10px] border border-border bg-surface py-1 shadow-lg"
            role="listbox"
          >
            {threads.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={t.id === activeThreadId}
                onClick={() => {
                  onSelect(t.id);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-text-2 transition-colors hover:bg-page hover:text-text"
              >
                <span className="truncate">{t.label}</span>
                {t.id === activeThreadId && <Check size={14} className="shrink-0 text-orange" />}
              </button>
            ))}
            <button
              type="button"
              disabled={creating}
              onClick={() => {
                onNew();
                setOpen(false);
              }}
              className="mt-1 flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs font-medium text-orange transition-colors hover:bg-page disabled:opacity-50"
            >
              <Plus size={14} />
              {creating ? 'Creating…' : 'New chat'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
