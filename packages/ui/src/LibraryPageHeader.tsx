import { type ReactNode } from "react";
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
    "rounded-input border border-border bg-transparent focus:border-border-strong",
  ghost:
    "rounded-sm border border-transparent bg-transparent focus:border-border focus:bg-surface",
};

/**
 * Consistent search box for library headers. Controlled — the page owns the
 * query state and any filtering derived from it.
 */
export function LibrarySearchInput({
  label,
  value,
  onChange,
  placeholder,
  variant = "bordered",
  className,
}: LibrarySearchInputProps) {
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={placeholder ?? label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-[34px] w-[180px] px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:outline-none",
        searchVariantClassName[variant],
        className,
      )}
    />
  );
}
