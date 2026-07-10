import { Fragment, useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@workbench/ui";
import { AnimatePresence, motion } from "framer-motion";
import {
  fuzzyMatch,
  rankPaletteItems,
  type PaletteResultItem,
  type RankedPaletteItem,
} from "@workbench/shared";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import {
  detectShortcutPlatform,
  formatChord,
  PALETTE_GLOBAL_SHORTCUT_HINTS,
  PALETTE_LOCAL_SHORTCUT_HINTS,
  type ShortcutPlatform,
} from "../lib/keyboard-shortcut-display";
import {
  PALETTE_CATEGORY_LABELS,
  PALETTE_CATEGORY_ORDER,
} from "../lib/palette-items";

// Opacity-only transition: the palette is keyboard-triggered and used many times
// a day, so it must never animate scale or position. Exported so a regression
// test can assert the config carries no transform keys.
export const PALETTE_PANEL_MAX_WIDTH_CLASS = "max-w-2xl" as const;

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
}

function buildGroups(ranked: RankedPaletteItem[]): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  for (const category of PALETTE_CATEGORY_ORDER) {
    const inCategory = ranked.filter((r) => r.item.category === category);
    if (inCategory.length === 0) continue;
    groups.push({
      category,
      label: PALETTE_CATEGORY_LABELS[category],
      items: inCategory,
    });
  }
  return groups;
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

function emptyMessage(
  loading: boolean,
  error: boolean,
  trimmed: string,
): string {
  if (loading) return "Searching…";
  if (error) return "Search failed. Please try again.";
  if (trimmed) return `No matches for “${trimmed}”.`;
  return "Type to search for entities.";
}

function PaletteShortcutFooter({ platform }: { platform: ShortcutPlatform }) {
  return (
    <div
      className="flex flex-col gap-2 border-t border-border px-4 py-3"
      data-testid="command-palette-footer"
    >
      <p className="text-xs text-text-3">
        Search entities or pick a destination below.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-2">
        {PALETTE_GLOBAL_SHORTCUT_HINTS.map((hint) => (
          <span key={hint.keys} className="inline-flex items-center gap-1.5">
            <span>{hint.label}</span>
            <CommandShortcut className="ml-0 tracking-normal">
              {formatChord(hint.keys, platform)}
            </CommandShortcut>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-3">
        {PALETTE_LOCAL_SHORTCUT_HINTS.map((hint) => (
          <span key={hint.keys} className="inline-flex items-center gap-1.5">
            <span>{hint.label}</span>
            <CommandShortcut className="ml-0 tracking-normal">
              {hint.keys}
            </CommandShortcut>
          </span>
        ))}
      </div>
    </div>
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
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Nav commands are ranked client-side (fuzzy); entity results already arrive
  // query-matched and ordered from the server, so they are highlight-only.
  const groups = useMemo(() => {
    const navRanked = rankPaletteItems(query, navItems);
    const entityRanked: RankedPaletteItem[] = entityItems.map((item) => ({
      item,
      titleIndices: fuzzyMatch(query, item.title)?.indices ?? [],
      score: 0,
    }));
    return buildGroups([...navRanked, ...entityRanked]);
  }, [query, navItems, entityItems]);

  // The provider keeps this component mounted across open/close, so the focus
  // handoff must key off `open`, not mount. When it opens, capture the element
  // that had focus and move focus into the search input; the cleanup restores
  // that element when it closes (or on unmount while open). A DOM mutation that
  // must run before paint — the canonical useLayoutEffect case. cmdk owns
  // listbox/combobox semantics and keyboard navigation, but not this handoff.
  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [open]);

  // cmdk drives arrow/Enter navigation from a single keydown handler on the
  // Command root. We intercept on the input — which bubbles to that root — to
  // (1) close on Escape (cmdk has no concept of a closable surface) and (2)
  // swallow keys mid-IME-composition so an Enter that commits a candidate never
  // also selects a row. Stopping propagation keeps cmdk's handler from acting.
  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (composingRef.current || event.nativeEvent.isComposing) {
      event.stopPropagation();
    }
  };

  const trimmed = query.trim();
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(undefined), []);

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
            onClick={(e) => e.stopPropagation()}
            className={cn("w-full", PALETTE_PANEL_MAX_WIDTH_CLASS)}
            data-testid="command-palette-panel"
          >
            <Command
              // Results are server-ranked (entities) or ranked here (nav); cmdk
              // must not re-filter or it would drop server rows whose text does
              // not fuzzy-match its own scorer. We own the matching.
              shouldFilter={false}
              aria-label="Search commands and entities"
              className="flex max-h-[70vh] min-h-[min(22rem,48vh)] flex-col border border-border shadow-[var(--shadow)]"
            >
              <CommandInput
                ref={inputRef}
                value={query}
                onValueChange={onQueryChange}
                onKeyDown={handleInputKeyDown}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                placeholder="Search or jump to…"
              />

              <CommandList aria-busy={loading}>
                <CommandEmpty>
                  {emptyMessage(loading, error, trimmed)}
                </CommandEmpty>

                {groups.map((group) => (
                  <CommandGroup key={group.category} heading={group.label}>
                    {group.items.map((ranked) => (
                      <CommandItem
                        key={ranked.item.id}
                        value={ranked.item.id}
                        onSelect={() => onSelect(ranked.item)}
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
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>

              <PaletteShortcutFooter platform={shortcutPlatform} />

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
            </Command>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
