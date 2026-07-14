import type { ReactNode } from "react";

export type ArtifactDetailShellProps = {
  accentClass: string;
  header: ReactNode;
  rail: ReactNode;
  children: ReactNode;
  /** When true, stack rail below hero on narrow surfaces (modal). */
  compactRail?: boolean;
};

/**
 * Full-width artifact detail chrome: hero band, scrollable main stage, metadata rail.
 * Replaces narrow single-column layouts for gallery drill-in (CL-3515).
 */
export function ArtifactDetailShell({
  accentClass,
  header,
  rail,
  children,
  compactRail = false,
}: ArtifactDetailShellProps) {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="artifact-detail-shell"
    >
      <div className={`h-1.5 w-full shrink-0 ${accentClass}`} aria-hidden />
      <div className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        {header}
      </div>
      <div
        className={
          compactRail
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "flex min-h-0 flex-1 overflow-hidden"
        }
      >
        <main
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6"
          data-testid="artifact-detail-main"
        >
          <div className="mx-auto w-full max-w-none">{children}</div>
        </main>
        <aside
          className={
            compactRail
              ? "shrink-0 border-t border-border px-4 py-3 sm:px-6"
              : "w-full shrink-0 overflow-y-auto border-t border-border px-4 py-4 sm:w-72 sm:border-t-0 sm:border-l lg:w-80"
          }
          data-testid="artifact-detail-rail"
        >
          {rail}
        </aside>
      </div>
    </div>
  );
}
