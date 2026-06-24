import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ChevronDown, LayoutGrid } from 'lucide-react';
import { useWorkbenches } from '../../hooks/use-workbenches';

/**
 * Sidebar entry to reach a workbench (artifacts, library, workspace agents).
 * The workbench surface lives at `/workbenches/:slug`; this is the only way in
 * now that chat is the home — a lightweight selector rather than a landing page.
 */
export function WorkbenchSelector() {
  const [open, setOpen] = useState(false);
  const { data: workbenches, isLoading } = useWorkbenches();
  const navigate = useNavigate();
  const location = useLocation();
  const activeSlug = location.pathname.match(/^\/workbenches\/([^/]+)/)?.[1] ?? null;
  const active = workbenches?.find((w) => w.tenantSlug === activeSlug) ?? null;

  const itemClass = (isActive: boolean) =>
    `flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-sm transition-colors duration-150 ${
      isActive ? 'bg-page text-orange' : 'text-text-2 hover:bg-page hover:text-text'
    }`;

  if (!isLoading && (workbenches?.length ?? 0) === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={itemClass(activeSlug !== null)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <LayoutGrid size={17} />
        <span className="flex-1 truncate text-left">{active?.tenantName ?? 'Workbenches'}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute left-2 right-2 z-20 mt-1 max-h-[260px] overflow-auto rounded-[10px] border border-border bg-surface py-1 shadow-lg"
            role="listbox"
          >
            {(workbenches ?? []).map((w) => (
              <button
                key={w.id}
                type="button"
                role="option"
                aria-selected={w.tenantSlug === activeSlug}
                onClick={() => {
                  setOpen(false);
                  navigate(`/workbenches/${w.tenantSlug}`);
                }}
                className="block w-full truncate px-3 py-2 text-left text-xs text-text-2 transition-colors hover:bg-page hover:text-text"
              >
                {w.tenantName}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
