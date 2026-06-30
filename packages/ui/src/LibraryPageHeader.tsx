import { type ReactNode } from "react";
import { cn } from "./utils";

type TitleSize = "sm" | "lg";

interface LibraryPageHeaderProps {
  title: string;
  /** `lg` (21px, default) for catalog pages; `sm` (17px) for the chats list. */
  titleSize?: TitleSize;
  /** When provided, renders a "{count} items" badge beside the title. */
  count?: number;
  /** Trailing controls: search, view toggle, action buttons. */
  children?: ReactNode;
  className?: string;
}

const titleClassName: Record<TitleSize, string> = {
  lg: "text-library-title tracking-[-0.02em] text-text",
  sm: "text-library-title-sm tracking-[-0.01em] text-text",
};

/**
 * Shared header row for the library/catalog pages (Chats, Skills, Tools):
 * a title, an optional count badge, a flexible spacer, and trailing controls.
 * Owning the layout here means a header tweak is a single edit.
 */
export function LibraryPageHeader({
  title,
  titleSize = "lg",
  count,
  children,
  className,
}: LibraryPageHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-[14px] px-4 pb-[14px] pt-5 sm:px-7",
        className,
      )}
    >
      <h1 className={titleClassName[titleSize]}>{title}</h1>
      {count !== undefined && (
        <span className="rounded-input bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
          {count} items
        </span>
      )}
      <div className="flex-1" />
      {children}
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
