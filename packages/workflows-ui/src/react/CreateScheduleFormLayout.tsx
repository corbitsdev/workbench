import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Two-column create-schedule layout: form body on the left, sticky summary on the right.
 * Host owns fields, validation, and submit mutation.
 */
export function CreateScheduleFormLayout({
  form,
  summary,
  footer,
  className,
  formClassName,
  summaryClassName,
}: {
  form: ReactNode;
  summary: ReactNode;
  footer?: ReactNode;
  className?: string;
  formClassName?: string;
  summaryClassName?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]",
        className,
      )}
    >
      <div className={cn("min-w-0", formClassName)}>
        {form}
        {footer ? <div className="mt-5">{footer}</div> : null}
      </div>
      <aside
        className={cn(
          "h-fit rounded-[14px] border border-border bg-surface p-4 shadow-sm lg:sticky lg:top-4",
          summaryClassName,
        )}
      >
        {summary}
      </aside>
    </div>
  );
}

export function CreateScheduleSummary({
  title = "Summary",
  rows,
  actions,
  className,
}: {
  title?: string;
  rows: readonly { label: string; value: ReactNode }[];
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-text-3">
        {title}
      </div>
      <dl className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5">
            <dt className="text-[11px] font-semibold text-text-3">
              {row.label}
            </dt>
            <dd className="text-[13px] font-semibold text-text">{row.value}</dd>
          </div>
        ))}
      </dl>
      {actions ? (
        <div className="mt-2 flex flex-col gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
