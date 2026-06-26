import type { ViewMode } from "./use-view-mode";

interface ViewToggleProps {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const OPTIONS: { value: ViewMode; label: string; path: string }[] = [
  {
    value: "grid",
    label: "Grid view",
    path: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  },
  {
    value: "rows",
    label: "Rows view",
    path: "M3 5h18M3 12h18M3 19h18",
  },
];

/**
 * Segmented Grid/Rows control shared by every library page. Stateless: the page
 * owns the persisted `mode` (via `useViewMode`) and passes `onChange`.
 */
export function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label="View"
      className="flex items-center gap-0.5 rounded-[9px] border border-border p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-label={opt.label}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`grid h-[28px] w-[30px] place-items-center rounded-[6px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
              active
                ? "bg-surface-2 text-text"
                : "text-text-3 hover:bg-[var(--row-hover)] hover:text-text-2"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-[15px] w-[15px]"
            >
              <path d={opt.path} />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
