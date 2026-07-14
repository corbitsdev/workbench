import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./utils";

export type RichEmptyStateActionVariant = "primary" | "secondary";

export interface RichEmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
  variant?: RichEmptyStateActionVariant;
}

export interface RichEmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: ReactNode;
  /** Suggested next steps; rendered as tokenized buttons or links. */
  actions?: RichEmptyStateAction[];
  /** Extra controls (e.g. custom menus) below the primary actions. */
  footer?: ReactNode;
  className?: string;
}

function ActionControl({ action }: { action: RichEmptyStateAction }) {
  const variant = action.variant === "primary" ? "primary" : "secondary";
  if (action.href) {
    return (
      <a
        href={action.href}
        className={cn(
          variant === "primary"
            ? "inline-flex items-center justify-center rounded-lg bg-orange px-4 py-2 text-base font-medium text-white transition-[background-color] hover:bg-orange-deep"
            : "inline-flex items-center justify-center rounded-lg border border-border bg-surface-2 px-4 py-2 text-base font-medium text-text transition-[background-color] hover:bg-surface-2",
        )}
      >
        {action.label}
      </a>
    );
  }
  return (
    <Button type="button" variant={variant} size="md" onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/**
 * Rich empty-state block: icon, message, and suggested actions. Theme-aware via
 * design tokens only.
 */
export function RichEmptyState({
  icon,
  title,
  description,
  actions,
  footer,
  className,
}: RichEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[12px] border border-border bg-surface px-6 py-10 text-center",
        className,
      )}
      data-testid="rich-empty-state"
    >
      {icon ? (
        <div
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-[12px] bg-surface-2 text-text-2"
          aria-hidden
        >
          {icon}
        </div>
      ) : null}
      <h3 className="text-[15px] font-bold tracking-[-0.01em] text-text">
        {title}
      </h3>
      <p className="mt-2 max-w-md text-[13px] leading-relaxed text-text-2">
        {description}
      </p>
      {actions && actions.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {actions.map((action) => (
            <ActionControl key={action.label} action={action} />
          ))}
        </div>
      ) : null}
      {footer ? <div className="mt-4">{footer}</div> : null}
    </div>
  );
}