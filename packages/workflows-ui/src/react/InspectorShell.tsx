import type { ReactNode } from "react";
import { cn } from "./cn";

export function InspectorShell({
  header,
  children,
  empty,
  className,
  bodyClassName,
}: {
  /** Eyebrow + title + actions region. */
  header?: ReactNode;
  children?: ReactNode;
  /** Shown when no selection; replaces body. */
  empty?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  if (empty !== undefined && empty !== null && header === undefined) {
    return (
      <aside
        className={cn(
          "flex min-h-0 flex-col overflow-auto border-l border-border bg-surface",
          className,
        )}
        aria-label="Workflow inspector"
      >
        <div className="flex flex-1 flex-col items-start justify-center px-5 py-10 text-[13px] text-text-3">
          {empty}
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col overflow-hidden border-l border-border bg-surface",
        className,
      )}
      aria-label="Workflow inspector"
    >
      {header ? (
        <div className="shrink-0 border-b border-border px-4 pb-3 pt-4">
          {header}
        </div>
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-4 py-3",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </aside>
  );
}

export function InspectorEmpty({
  title,
  description,
  className,
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("max-w-[260px]", className)}>
      <strong className="block text-[14px] font-semibold text-text">
        {title}
      </strong>
      {description ? (
        <p className="mt-1.5 text-[12.5px] leading-snug text-text-3">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function InspectorHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {eyebrow ? (
        <div className="flex flex-wrap items-center gap-1.5">{eyebrow}</div>
      ) : null}
      <h2 className="text-[16px] font-bold tracking-[-0.02em] text-text">
        {title}
      </h2>
      {description ? (
        <p className="text-[12.5px] leading-snug text-text-3">{description}</p>
      ) : null}
      {actions ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

export function InspectorPanelTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-2 mt-4 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-3 first:mt-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function InspectorKv({
  rows,
  className,
}: {
  rows: readonly { label: string; value: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-3 text-[12.5px]"
        >
          <span className="shrink-0 text-text-3">{row.label}</span>
          <span
            className={cn(
              "min-w-0 truncate text-right text-text-2",
              row.mono && "font-mono text-[11.5px]",
            )}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}
