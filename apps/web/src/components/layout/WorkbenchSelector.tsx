import { useState } from 'react';
import { ChevronDown, LayoutGrid } from 'lucide-react';
import { useActiveWorkbench } from '../../lib/active-workbench-context';

/**
 * Sidebar tenancy toggle. Switches the active workbench in the global tenancy
 * context — the sidebar stays fixed; the tenancy-scoped pages (artifacts,
 * workflows, insights) re-load against the new selection.
 */
export function WorkbenchSelector() {
  const [open, setOpen] = useState(false);
  const { workbenches, loading, activeWorkbench, setActiveWorkbench } = useActiveWorkbench();

  if (!loading && workbenches.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-sm text-text-2 transition-colors duration-150 hover:bg-page hover:text-text"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <LayoutGrid size={17} />
        <span className="flex-1 truncate text-left">
          {activeWorkbench?.tenantName ?? 'Workbench'}
        </span>
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
            {workbenches.map((w) => (
              <button
                key={w.id}
                type="button"
                role="option"
                aria-selected={w.id === activeWorkbench?.id}
                onClick={() => {
                  setActiveWorkbench(w.id);
                  setOpen(false);
                }}
                className={`block w-full truncate px-3 py-2 text-left text-xs transition-colors hover:bg-page ${
                  w.id === activeWorkbench?.id ? 'text-orange' : 'text-text-2 hover:text-text'
                }`}
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
