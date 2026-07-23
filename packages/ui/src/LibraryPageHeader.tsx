import { type ReactNode, useRef, useState } from "react";
import { AppPageChromeRow } from "./AppPageChromeRow";
import { cn } from "./utils";

interface LibraryPageHeaderProps {
  title: string;
  /** `lg` (21px, default) for catalog pages; `sm` (17px) for the chats list. */
  titleSize?: "sm" | "lg";
  /** When provided, renders a "{count} items" badge beside the title. */
  count?: number;
  /** Trailing controls: search, view toggle, action buttons. */
  children?: ReactNode;
  className?: string;
}

/**
 * @deprecated Prefer `AppPageChromeRow` via `useSetPageChrome`. Kept for tests and
 * any legacy in-page header until routes are migrated.
 */
export function LibraryPageHeader({
  title,
  titleSize = "lg",
  count,
  children,
  className,
}: LibraryPageHeaderProps) {
  return (
    <div className={cn("px-4 pb-[14px] pt-5 sm:px-7", className)}>
      <AppPageChromeRow
        title={title}
        titleSize={titleSize}
        {...(count !== undefined ? { count } : {})}
      >
        {children}
      </AppPageChromeRow>
    </div>
  );
}

type SearchVariant = "bordered" | "ghost";

interface LibrarySearchInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** `bordered` (default) for catalog pages; `ghost` for the chats list. */
  variant?: SearchVariant;
  className?: string;
}

const searchVariantClassName: Record<SearchVariant, string> = {
  bordered:
    "rounded-input border border-border bg-surface focus:border-border-strong",
  ghost:
    "rounded-sm border border-transparent bg-transparent focus:border-border focus:bg-surface",
};

const SEARCH_COLLAPSED_WIDTH = "180px";
const SEARCH_EXPANDED_WIDTH = "340px";

/**
 * Consistent search box for library headers. Controlled — the page owns the
 * query state and any filtering derived from it.
 *
 * Reserves a fixed-width slot in the header's flex flow at all times (so
 * neighboring controls never shift), but the input itself is positioned
 * `absolute` inside that slot and grows leftward — over the header's own
 * flexible spacer, never over another control — while focused or holding a
 * value. It collapses back to the reserved width on blur once empty. Escape
 * clears an active query first, then relinquishes focus once already empty,
 * so it never traps keyboard focus.
 */
export function LibrarySearchInput({
  label,
  value,
  onChange,
  placeholder,
  variant = "bordered",
  className,
}: LibrarySearchInputProps) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const expanded = focused || value.length > 0;

  return (
    <div
      className="relative h-[34px] shrink-0"
      style={{ width: SEARCH_COLLAPSED_WIDTH }}
    >
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (value.length > 0) {
            e.stopPropagation();
            onChange("");
          } else {
            inputRef.current?.blur();
          }
        }}
        className={cn(
          "absolute right-0 top-0 h-[34px] px-[11px] text-[12.5px] text-text placeholder:text-text-3 transition-[width] duration-150 ease-out focus:outline-none",
          expanded ? "z-20" : "z-10",
          searchVariantClassName[variant],
          className,
        )}
        style={{
          width: expanded ? SEARCH_EXPANDED_WIDTH : SEARCH_COLLAPSED_WIDTH,
        }}
      />
    </div>
  );
}
