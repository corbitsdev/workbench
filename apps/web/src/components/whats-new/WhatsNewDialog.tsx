import { useEffect, useRef } from "react";
import { Link } from "react-router";
import type { ChangelogRelease } from "@workbench/shared";

interface WhatsNewDialogProps {
  readonly release: ChangelogRelease;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

/**
 * The "what's new" walkthrough: lists the latest release's entries, each with
 * an optional "Take me there" link. Follows the app's established hand-rolled
 * dialog pattern (role="dialog", backdrop click and Escape close, `Done`
 * commits) — see `AddArtifactModal` and the onboarding tour's `TourOverlay`,
 * the two existing references for this convention.
 */
export function WhatsNewDialog({
  release,
  onClose,
  onDone,
}: WhatsNewDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function handleDone() {
    onDone();
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`New in Workbench ${release.version}`}
      className="fixed inset-0 z-[100] grid place-items-center bg-[rgba(0,0,0,0.45)] p-4"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex w-full max-w-[480px] flex-col gap-4 rounded-panel border border-border bg-surface p-6 shadow-xl focus:outline-none"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-text-3">{release.date}</p>
            <h2 className="mt-1 text-base font-semibold text-text">
              New in Workbench {release.version}
            </h2>
            <p className="mt-1 text-sm text-text-2">{release.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-page hover:text-text"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <ul className="flex max-h-[22rem] flex-col gap-3 overflow-y-auto">
          {release.entries.map((entry) => (
            <li
              key={entry.title}
              className="rounded-lg border border-border p-3"
            >
              <p className="text-sm font-medium text-text">{entry.title}</p>
              <p className="mt-1 text-xs text-text-2">{entry.description}</p>
              {entry.to && (
                <Link
                  to={entry.to}
                  onClick={onClose}
                  className="mt-2 inline-block text-xs font-medium text-orange transition-colors hover:text-orange-deep"
                >
                  Take me there
                </Link>
              )}
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleDone}
            className="rounded-lg bg-orange px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-orange-deep"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
