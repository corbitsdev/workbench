import type { ReactNode } from "react";
import { cn } from "./cn";
import { FilterChip } from "./primitives";
import type { KindPickerItem } from "./types";

export function KindPickerCard({
  item,
  selected,
  onSelect,
  className,
}: {
  item: KindPickerItem;
  selected?: boolean;
  onSelect?: (item: KindPickerItem) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-kind-id={item.id}
      aria-selected={selected ?? false}
      onClick={() => onSelect?.(item)}
      className={cn(
        "flex w-full flex-col gap-1 rounded-[12px] border px-3.5 py-3 text-left transition-colors",
        "hover:bg-row-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        selected
          ? "border-accent/40 bg-sel"
          : "border-border bg-surface",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-bold text-text">{item.label}</span>
        {item.alreadyOn ? (
          <span className="rounded-full bg-green/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] text-green-deep">
            {item.alreadyOnLabel ?? "Already on"}
          </span>
        ) : null}
      </div>
      <p className="text-[12.5px] leading-snug text-text-3">
        {item.description}
      </p>
      <span className="mt-1 text-[10.5px] font-bold uppercase tracking-[0.05em] text-text-3">
        {item.categoryLabel}
      </span>
    </button>
  );
}

export function KindPickerShell({
  items,
  categories,
  selectedCategory,
  onCategoryChange,
  search,
  onSearchChange,
  selectedId,
  onSelect,
  searchPlaceholder = "Search workflows…",
  className,
  empty,
  header,
}: {
  items: readonly KindPickerItem[];
  categories?: readonly { id: string; label: string }[];
  selectedCategory?: string;
  onCategoryChange?: (id: string) => void;
  search?: string;
  onSearchChange?: (value: string) => void;
  selectedId?: string | null;
  onSelect?: (item: KindPickerItem) => void;
  searchPlaceholder?: string;
  className?: string;
  empty?: ReactNode;
  header?: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      {header}
      {onSearchChange ? (
        <div className="flex items-center gap-2 rounded-[9px] border border-border bg-surface px-3 py-2 shadow-sm">
          <span className="text-text-3" aria-hidden="true">
            ⌕
          </span>
          <input
            value={search ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-text outline-none placeholder:text-text-3"
            aria-label="Search workflow kinds"
          />
        </div>
      ) : null}
      {categories && categories.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {categories.map((cat) => (
            <FilterChip
              key={cat.id}
              selected={selectedCategory === cat.id}
              onClick={() => onCategoryChange?.(cat.id)}
            >
              {cat.label}
            </FilterChip>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {items.length === 0
          ? empty ?? (
              <p className="py-8 text-center text-[13px] text-text-3">
                No workflow kinds match.
              </p>
            )
          : items.map((item) => (
              <KindPickerCard
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                {...(onSelect ? { onSelect } : {})}
              />
            ))}
      </div>
    </div>
  );
}
