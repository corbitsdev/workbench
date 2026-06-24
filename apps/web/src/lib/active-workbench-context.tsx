import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useWorkbenches } from '../hooks/use-workbenches';
import type { WorkbenchEntry } from './hub-api';

const STORAGE_KEY = 'active-workbench-id';

interface ActiveWorkbenchContextValue {
  workbenches: WorkbenchEntry[];
  loading: boolean;
  activeWorkbench: WorkbenchEntry | null;
  activeTenantId: string | null;
  /** Select the active workbench by its WorkbenchEntry `id` (principal id). */
  setActiveWorkbench: (workbenchId: string) => void;
}

const ActiveWorkbenchContext = createContext<ActiveWorkbenchContextValue>({
  workbenches: [],
  loading: false,
  activeWorkbench: null,
  activeTenantId: null,
  setActiveWorkbench: () => {},
});

function readStoredId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Holds the workbench (tenancy) the user is currently viewing. The sidebar
 * toggle sets it; tenancy-scoped pages (artifacts, workflows, insights) read
 * `activeTenantId` from it. The sidebar itself stays fixed — only page data
 * re-scopes when the selection changes. Defaults to the first workbench and
 * remembers the last selection across reloads.
 */
export function ActiveWorkbenchProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useWorkbenches();
  const workbenches = useMemo(() => data ?? [], [data]);
  const [selectedId, setSelectedId] = useState<string | null>(readStoredId);

  const setActiveWorkbench = useCallback((workbenchId: string) => {
    setSelectedId(workbenchId);
    try {
      localStorage.setItem(STORAGE_KEY, workbenchId);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const activeWorkbench = useMemo(() => {
    if (workbenches.length === 0) return null;
    return workbenches.find((w) => w.id === selectedId) ?? workbenches[0] ?? null;
  }, [workbenches, selectedId]);

  const value = useMemo<ActiveWorkbenchContextValue>(
    () => ({
      workbenches,
      loading: isLoading,
      activeWorkbench,
      activeTenantId: activeWorkbench?.tenantId ?? null,
      setActiveWorkbench,
    }),
    [workbenches, isLoading, activeWorkbench, setActiveWorkbench]
  );

  return <ActiveWorkbenchContext value={value}>{children}</ActiveWorkbenchContext>;
}

export function useActiveWorkbench(): ActiveWorkbenchContextValue {
  return useContext(ActiveWorkbenchContext);
}
