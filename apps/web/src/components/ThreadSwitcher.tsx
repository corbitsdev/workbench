import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, Check, Search } from "lucide-react";
import type { MyraThread } from "../lib/hub-api";

type ThreadSwitcherProps = {
  threads: MyraThread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  creating?: boolean;
};

const PAGE_SIZE = 8;

type Anchor = { top: number; right: number };

export function ThreadSwitcher({
  threads,
  activeThreadId,
  onSelect,
  onNew,
  creating,
}: ThreadSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const active = threads.find((t) => t.id === activeThreadId) ?? null;
  const label = active?.label ?? "Chat";

  const ordered = [...threads].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? ordered.filter((t) => t.label.toLowerCase().includes(needle))
    : ordered;
  const shown = filtered.slice(0, visible);
  const hasMore = filtered.length > shown.length;

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect)
      setAnchor({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    setQuery("");
    setVisible(PAGE_SIZE);
    setOpen(true);
  };

  const close = () => setOpen(false);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        className="flex items-center gap-1 rounded-[8px] px-2 py-1 text-xs font-medium text-text-2 transition-colors hover:text-text"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[140px] truncate">{label}</span>
        <ChevronDown size={14} />
      </button>

      {open &&
        anchor &&
        createPortal(
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="fixed inset-0 z-[60] cursor-default"
              onClick={close}
            />
            <div
              style={{ top: anchor.top, right: anchor.right }}
              className="fixed z-[61] flex max-h-[360px] w-[260px] flex-col rounded-[10px] border border-border bg-surface py-1 shadow-xl"
              role="listbox"
            >
              <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
                <div className="flex flex-1 items-center gap-2 rounded-[8px] border border-border px-2 py-1.5">
                  <Search size={13} className="shrink-0 text-text-3" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setVisible(PAGE_SIZE);
                    }}
                    placeholder="Search chats"
                    className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-3"
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                {shown.length === 0 && (
                  <p className="px-3 py-3 text-xs text-text-3">
                    No chats found
                  </p>
                )}
                {shown.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={t.id === activeThreadId}
                    onClick={() => {
                      onSelect(t.id);
                      close();
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-text-2 transition-colors hover:bg-page hover:text-text"
                  >
                    <span className="truncate">{t.label}</span>
                    {t.id === activeThreadId && (
                      <Check size={14} className="shrink-0 text-orange" />
                    )}
                  </button>
                ))}
                {hasMore && (
                  <button
                    type="button"
                    onClick={() => setVisible((v) => v + PAGE_SIZE)}
                    className="w-full px-3 py-2 text-left text-xs text-text-3 transition-colors hover:bg-page hover:text-text"
                  >
                    Show more
                  </button>
                )}
              </div>

              <button
                type="button"
                disabled={creating}
                onClick={() => {
                  onNew();
                  close();
                }}
                className="mt-1 flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs font-medium text-orange transition-colors hover:bg-page disabled:opacity-50"
              >
                <Plus size={14} />
                {creating ? "Creating…" : "New chat"}
              </button>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
