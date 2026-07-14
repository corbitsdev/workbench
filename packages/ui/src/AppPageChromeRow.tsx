import { type ReactNode } from "react";
import { cn } from "./utils";

type TitleSize = "sm" | "lg";

export interface AppPageChromeRowProps {
  title: string;
  titleSize?: TitleSize;
  count?: number;
  subtitle?: string;
  children?: ReactNode;
  className?: string;
}

const titleClassName: Record<TitleSize, string> = {
  lg: "text-library-title tracking-[-0.02em] text-text",
  sm: "text-library-title-sm tracking-[-0.01em] text-text",
};

/**
 * Title + trailing controls row for `useSetPageChrome` (app top bar). No page
 * padding — the shell owns horizontal inset.
 */
export function AppPageChromeRow({
  title,
  titleSize = "lg",
  count,
  subtitle,
  children,
  className,
}: AppPageChromeRowProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-wrap items-center gap-[14px]",
        className,
      )}
    >
      <div className="flex min-w-0 shrink-0 flex-col gap-0.5">
        <h1 className={titleClassName[titleSize]}>{title}</h1>
        {subtitle !== undefined && subtitle !== "" && (
          <p className="truncate text-[12px] text-text-3">{subtitle}</p>
        )}
      </div>
      {count !== undefined && (
        <span className="shrink-0 rounded-input bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
          {count} items
        </span>
      )}
      <div className="min-w-[8px] flex-1" />
      {children}
    </div>
  );
}
