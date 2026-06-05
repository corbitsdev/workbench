// Library rail. Real workflow sessions come from @workbench/client; real
// workbenches come from hub-api. Search + segment interactivity is CL-985;
// this renders the visual rail only.

import { useLibraryResources } from '@workbench/client/react';
import type { SessionStatus, WorkflowSummary } from '@workbench/shared';
import { clientOptions } from '../../lib/client-options';
import { listWorkbenches } from '../../lib/hub-api';
import { useEffect, useState } from 'react';
import type { WorkbenchEntry } from '../../lib/hub-api';

type ResourceType = 'workflow' | 'workbench' | 'agent';
type ResourceStatus = 'run' | 'done' | 'idle';

interface RailItem {
  id: string;
  group: string;
  name: string;
  type: ResourceType;
  sub: string;
  status: ResourceStatus;
  who: string;
  color: string;
}

function workbenchToRailItem(w: WorkbenchEntry): RailItem {
  return {
    id: w.id,
    group: 'Workbenches & agents',
    name: w.tenantName,
    type: 'workbench',
    sub: w.tenantSlug,
    status: 'idle',
    who: w.tenantName.slice(0, 2).toUpperCase(),
    color: 'var(--blue)',
  };
}

function useWorkbenches(): {
  items: RailItem[];
  isLoading: boolean;
  error: boolean;
  retry: () => void;
} {
  const [workbenches, setWorkbenches] = useState<WorkbenchEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (import.meta.env.DEV) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(false);
    listWorkbenches()
      .then((data) => {
        setWorkbenches(data);
        setError(false);
      })
      .catch(() => setError(true))
      .finally(() => setIsLoading(false));
  }, [tick]);

  const retry = () => setTick((n) => n + 1);

  return { items: workbenches.map(workbenchToRailItem), isLoading, error, retry };
}

const SESSION_STATUS_TO_RAIL: Record<SessionStatus, ResourceStatus> = {
  analyzing: 'run',
  reviewing: 'run',
  generating: 'run',
  improving: 'run',
  exporting: 'run',
  done: 'done',
};

function workflowToRailItem(w: WorkflowSummary): RailItem {
  const name = w.companyName ?? w.firstPainPoint ?? w.transcriptPreview ?? 'Untitled session';
  const sub =
    w.painPointCount > 0
      ? `${w.painPointCount} pain point${w.painPointCount === 1 ? '' : 's'} · ${w.status}`
      : w.status;
  return {
    id: w.id,
    group: 'Sessions',
    name,
    type: 'workflow',
    sub,
    status: SESSION_STATUS_TO_RAIL[w.status] ?? 'idle',
    who: 'GA',
    color: 'var(--orange)',
  };
}

const GROUP_ORDER = ['Sessions', 'Workbenches & agents'];

const TAG_STYLES: Record<ResourceType, string> = {
  workflow: 'bg-[rgba(233,132,40,0.16)] text-orange',
  workbench: 'bg-[rgba(96,124,154,0.18)] text-blue',
  agent: 'bg-[rgba(123,153,116,0.18)] text-green',
};

const DOT_STYLES: Record<ResourceType, string> = {
  workflow: 'bg-orange',
  workbench: 'bg-blue',
  agent: 'bg-green',
};

function StatusDot({ status }: { status: ResourceStatus }) {
  if (status === 'done') {
    return (
      <span className="relative h-[15px] w-[15px] flex-none rounded-full bg-green">
        <span className="absolute left-[4px] top-[1.5px] h-2 w-1 rotate-[42deg] border-b-2 border-r-2 border-white" />
      </span>
    );
  }
  if (status === 'run') {
    return (
      <span className="relative h-[15px] w-[15px] flex-none rounded-full border-2 border-orange">
        <span className="absolute inset-[2px] rounded-full bg-orange" />
      </span>
    );
  }
  return (
    <span className="relative h-[15px] w-[15px] flex-none rounded-full border-2 border-text-3">
      <span className="absolute inset-[3px] rounded-full bg-text-3 opacity-40" />
    </span>
  );
}

interface LibraryRailProps {
  /** When provided, renders a close control (used by the mobile full-screen overlay). */
  onClose?: () => void;
  /** When provided, renders a "New" button in the "Workbenches & agents" section header. */
  onNew?: () => void;
}

const SEGMENT_FILTER: Record<string, ResourceType | null> = {
  All: null,
  Workflows: 'workflow',
  Workbenches: 'workbench',
  Agents: 'agent',
};

export function LibraryRail({ onClose, onNew }: LibraryRailProps = {}) {
  const {
    data: workflows,
    isLoading: sessionsLoading,
    isError,
  } = useLibraryResources(clientOptions);
  const {
    items: workbenchItems,
    error: workbenchError,
    retry: retryWorkbenches,
  } = useWorkbenches();

  const [activeSegment, setActiveSegment] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');

  const sessionItems = (workflows ?? []).map(workflowToRailItem);
  const items: RailItem[] = [...sessionItems, ...workbenchItems];
  const isLoading = sessionsLoading;

  const segments: { label: string; count: number }[] = [
    { label: 'All', count: items.length },
    { label: 'Workflows', count: items.filter((i) => i.type === 'workflow').length },
    { label: 'Workbenches', count: items.filter((i) => i.type === 'workbench').length },
    { label: 'Agents', count: items.filter((i) => i.type === 'agent').length },
  ];

  const typeFilter = SEGMENT_FILTER[activeSegment] ?? null;
  const query = searchQuery.trim().toLowerCase();

  const visibleItems = items.filter((item) => {
    if (typeFilter !== null && item.type !== typeFilter) return false;
    if (query !== '' && !item.name.toLowerCase().includes(query) && !item.sub.toLowerCase().includes(query)) return false;
    return true;
  });

  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
      <div className="px-[18px] pb-[10px] pt-[18px]">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-bold uppercase tracking-[0.04em] text-text-3">
            Workspace
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close workspace"
              className="grid h-[30px] w-[30px] place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-[18px] w-[18px]"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="mt-3 flex items-center gap-[9px] rounded-[12px] border border-border bg-surface px-[11px] py-2 focus-within:border-orange">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-[15px] w-[15px] flex-none text-text-3"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            aria-label="Search workflows, agents"
            placeholder="Search workflows, agents…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full border-none bg-transparent text-[14px] text-text outline-none placeholder:text-text-3"
          />
          {searchQuery === '' && (
            <span className="flex-none rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-3">
              ⌘K
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-[3px] px-4 pb-1.5 pt-3">
        {segments.map((seg) => (
          <button
            key={seg.label}
            type="button"
            onClick={() => setActiveSegment(seg.label)}
            className={`flex items-center gap-[5px] whitespace-nowrap rounded-[9px] px-[9px] py-1.5 text-[12px] font-semibold transition-colors ${
              activeSegment === seg.label
                ? 'bg-surface text-text shadow-[0_2px_6px_rgba(0,0,0,0.2)]'
                : 'text-text-2 hover:bg-[var(--row-hover)]'
            }`}
          >
            {seg.label} <span className="font-mono text-[10.5px] text-text-3">{seg.count}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-[10px] pb-[22px] pt-1">
        {isLoading && (
          <div className="px-[10px] py-6 text-[13px] text-text-3">Loading workspace…</div>
        )}
        {isError && (
          <div className="px-[10px] py-6 text-[13px] text-text-3">Could not load sessions.</div>
        )}
        {workbenchError && (
          <div className="flex flex-col gap-2 px-[10px] py-6">
            <p className="text-[13px] text-text-3">Could not load workbenches.</p>
            <button
              type="button"
              onClick={retryWorkbenches}
              className="self-start rounded-[9px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
            >
              Retry
            </button>
          </div>
        )}
        {GROUP_ORDER.map((group) => {
          const inGroup = visibleItems.filter((i) => i.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group}>
              <div className="flex items-center gap-2 px-[10px] pb-[7px] pt-[14px] text-[11.5px] font-bold uppercase tracking-[0.05em] text-text-3">
                {group}
                <span className="font-mono text-[11px] font-normal opacity-70">
                  {inGroup.length}
                </span>
                <span className="h-px flex-1 bg-border" />
                {group === 'Workbenches & agents' && onNew && (
                  <button
                    type="button"
                    onClick={onNew}
                    aria-label="New workbench"
                    className="grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border border-border text-text-3 transition-colors hover:border-orange hover:text-orange"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      className="h-[11px] w-[11px]"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                )}
              </div>
              {inGroup.map((item) => (
                <div
                  key={item.id}
                  className="group relative flex items-center gap-[11px] rounded-[12px] px-[11px] py-[10px] transition-colors hover:bg-[var(--row-hover)]"
                >
                  <StatusDot status={item.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-text">{item.name}</div>
                    <div className="mt-px font-mono text-[11.5px] text-text-3">{item.sub}</div>
                  </div>
                  <span
                    className={`flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.03em] ${TAG_STYLES[item.type]}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[item.type]}`} />
                    {item.type}
                  </span>
                  <div
                    className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full text-[10px] font-bold text-white"
                    style={{ background: item.color }}
                  >
                    {item.who}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
