import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search } from "lucide-react";
import {
  fuzzyMatch,
  rankPaletteItems,
  type PaletteResultItem,
  type RankedPaletteItem,
} from "@workbench/shared";
import {
  PALETTE_CATEGORY_LABELS,
  PALETTE_CATEGORY_ORDER,
} from "../lib/palette-items";

// Opacity-only transition: the palette is keyboard-triggered and used many times
// a day, so it must never animate scale or position. Exported so a regression
// test can assert the config carries no transform keys.
export const PALETTE_PANEL_MOTION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.12 },
} as const;

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** Static nav commands, fuzzy-ranked client-side against the query. */
  navItems: PaletteResultItem[];
  /** Server-matched entity results; rendered in server order, highlight-only. */
  entityItems: PaletteResultItem[];
  onSelect: (item: PaletteResultItem) => void;
  loading?: boolean;
  error?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

interface PaletteGroup {
  category: PaletteResultItem["category"];
  label: string;
  items: RankedPaletteItem[];
  // Index of this group's first row in the flat keyboard-navigation order.
  startIndex: number;
}

function buildGroups(ranked: RankedPaletteItem[]): {
  groups: PaletteGroup[];
  flat: RankedPaletteItem[];
} {
  const groups: PaletteGroup[] = [];
  const flat: RankedPaletteItem[] = [];
  for (const category of PALETTE_CATEGORY_ORDER) {
    const inCategory = ranked.filter((r) => r.item.category === category);
    if (inCategory.length === 0) continue;
    groups.push({
      category,
      label: PALETTE_CATEGORY_LABELS[category],
      items: inCategory,
      startIndex: flat.length,
    });
    flat.push(...inCategory);
  }
  return { groups, flat };
}

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {Array.from(text).map((char, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold text-orange">
            {char}
          </span>
        ) : (
          <Fragment key={i}>{char}</Fragment>
        ),
      )}
    </>
  );
}

export function CommandPalette({
  open,
  onClose,
  query,
  onQueryChange,
  navItems,
  entityItems,
  onSelect,
  loading = false,
  error = false,
  hasMore = false,
  onLoadMore,
}: CommandPaletteProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Nav commands are ranked client-side (fuzzy); entity results already arrive
  // query-matched and ordered from the server, so they are highlight-only.
  const { groups, flat } = useMemo(() => {
    const navRanked = rankPaletteItems(query, navItems);
    const entityRanked: RankedPaletteItem[] = entityItems.map((item) => ({
      item,
      titleIndices: fuzzyMatch(query, item.title)?.indices ?? [],
      score: 0,
    }));
    return buildGroups([...navRanked, ...entityRanked]);
  }, [query, navItems, entityItems]);

  // Keep the active row valid as results shrink/grow with the query.
  const clampedIndex =
    flat.length === 0 ? 0 : Math.min(activeIndex, flat.length - 1);
  const activeItem = flat[clampedIndex];
  const activeOptionId = activeItem
    ? `palette-option-${activeItem.item.id}`
    : undefined;

  // The provider keeps this component mounted across open/close, so the focus
  // handoff must key off `open`, not mount. When it opens, capture the element
  // that had focus and move focus into the search input; the cleanup restores
  // that element when it closes (or on unmount while open). A DOM mutation that
  // must run before paint — the canonical useLayoutEffect case.
  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeOptionId || typeof CSS === "undefined") return;
    const el = list.querySelector<HTMLElement>(
      `#${CSS.escape(activeOptionId)}`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);

  const isComposing = (event: React.KeyboardEvent) =>
    composingRef.current || event.nativeEvent.isComposing;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      // preventDefault first so the text caret never moves, then bail on IME.
      event.preventDefault();
      if (isComposing(event)) return;
      setActiveIndex(() =>
        clampedIndex + 1 >= flat.length ? clampedIndex : clampedIndex + 1,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (isComposing(event)) return;
      setActiveIndex(() => (clampedIndex <= 0 ? 0 : clampedIndex - 1));
      return;
    }
    if (event.key === "Enter") {
      if (isComposing(event)) return;
      if (!activeItem) return;
      event.preventDefault();
      onSelect(activeItem.item);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  // Trap Tab/Shift+Tab inside the panel so focus can't escape to the page
  // behind the scrim. Row navigation is arrow-driven; Tab just cycles the
  // focusable controls (input, rows, load-more) within the modal.
  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const trimmed = query.trim();
  let emptyMessage: string | null = null;
  if (flat.length === 0) {
    if (loading) emptyMessage = "Searching…";
    else if (error) emptyMessage = "Search failed. Please try again.";
    else if (trimmed) emptyMessage = `No matches for “${trimmed}”.`;
  }

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-start justify-center bg-[rgba(0,0,0,0.55)] p-4 pt-[12vh] backdrop-blur-[2px]"
          initial={PALETTE_PANEL_MOTION.initial}
          animate={PALETTE_PANEL_MOTION.animate}
          exit={PALETTE_PANEL_MOTION.exit}
          transition={PALETTE_PANEL_MOTION.transition}
          onClick={onClose}
          data-testid="command-palette-scrim"
        >
          <div
            ref={panelRef}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handlePanelKeyDown}
            className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[var(--shadow)]"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
              <Search size={16} className="flex-none text-text-3" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls="command-palette-list"
                aria-autocomplete="list"
                aria-activedescendant={activeOptionId}
                aria-label="Search commands and entities"
                value={query}
                onChange={(e) => {
                  onQueryChange(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                placeholder="Search or jump to…"
                className="w-full rounded-sm bg-surface-2 px-3 py-2 text-sm text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
              />
            </div>

            {/* Live status region — outside the listbox (a listbox may own only
                option/group children) so screen readers announce the
                searching/empty/no-results state and the busy flag. */}
            <div role="status" aria-live="polite" aria-busy={loading}>
              {emptyMessage && (
                <p className="py-10 text-center text-xs text-text-3">
                  {emptyMessage}
                </p>
              )}
            </div>

            <div
              ref={listRef}
              id="command-palette-list"
              role="listbox"
              aria-label="Results"
              aria-busy={loading}
              className="flex-1 overflow-y-auto overscroll-contain p-2"
            >
              {groups.map((group) => (
                <div
                  key={group.category}
                  role="group"
                  aria-label={group.label}
                  className="mb-1"
                >
                  <div className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-3">
                    {group.label}
                  </div>
                  {group.items.map((ranked, localIndex) => {
                    const flatIndex = group.startIndex + localIndex;
                    const isActive = flatIndex === clampedIndex;
                    return (
                      <button
                        key={ranked.item.id}
                        type="button"
                        id={`palette-option-${ranked.item.id}`}
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onClick={() => onSelect(ranked.item)}
                        className={`flex min-h-[40px] w-full items-center gap-3 rounded-sm px-2.5 py-2 text-left transition-colors ${
                          isActive ? "bg-orange/15" : "hover:bg-row-hover"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-text">
                            <Highlight
                              text={ranked.item.title}
                              indices={ranked.titleIndices}
                            />
                          </span>
                          {ranked.item.subtitle && (
                            <span className="block truncate text-xs text-text-3">
                              {ranked.item.subtitle}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {hasMore && onLoadMore && (
              <div className="border-t border-border p-2">
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loading}
                  className="w-full rounded-sm px-2.5 py-2 text-center text-xs font-medium text-text-2 transition-colors hover:bg-row-hover disabled:opacity-50"
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
