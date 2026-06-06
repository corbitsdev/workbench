import { useLibraryResources } from '@workbench/client/react';
import type { SessionStatus, WorkflowSummary } from '@workbench/shared';
import { clientOptions } from '../../lib/client-options';
import {
  listAgentInstances,
  listWorkbenches,
  listEnrichedCredentials,
  assignCredentialToAgent,
  getMyPrincipals,
} from '../../lib/hub-api';
import { useEffect, useState } from 'react';
import type {
  AgentInstance,
  WorkbenchEntry,
  EnrichedCredential,
  CredentialRequirement,
} from '../../lib/hub-api';

type ResourceType = 'workflow' | 'workbench' | 'agent';
type ResourceStatus = 'run' | 'done' | 'idle';

interface RailItem {
  id: string;
  group: RailGroup;
  name: string;
  type: ResourceType;
  sub: string;
  status: ResourceStatus;
  who: string;
  color: string;
  instanceId?: string;
  tenantId?: string;
  agentId?: string;
  credentialRequirements?: CredentialRequirement[];
}

function workbenchToRailItem(w: WorkbenchEntry): RailItem {
  return {
    id: w.id,
    group: 'Workbenches and agents',
    name: w.tenantName,
    type: 'workbench',
    sub: w.tenantSlug,
    status: 'idle',
    who: w.tenantName.slice(0, 2).toUpperCase(),
    color: 'var(--blue)',
  };
}

function agentToRailItem(a: AgentInstance): RailItem {
  return {
    id: a.id,
    group: 'Workbenches and agents',
    name: a.agentName,
    type: 'agent',
    sub: `Agent · ${a.status}`,
    status: 'idle',
    who: a.agentName.slice(0, 2).toUpperCase(),
    color: 'var(--green)',
    instanceId: a.id,
    tenantId: a.tenantId,
    agentId: a.agentId,
    credentialRequirements: a.credentialRequirements,
  };
}

function useWorkbenchesAndAgents(externalTick = 0): {
  items: RailItem[];
  isLoading: boolean;
  error: boolean;
  retry: () => void;
} {
  const [items, setItems] = useState<RailItem[]>([]);
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

    void (async () => {
      try {
        const workbenches = await listWorkbenches();
        const workbenchItems = workbenches.map(workbenchToRailItem);

        const agentLists = await Promise.all(
          workbenches.map((w) => listAgentInstances(w.tenantId).catch(() => []))
        );
        const agentItems = agentLists.flat().map(agentToRailItem);

        setItems([...workbenchItems, ...agentItems]);
        setError(false);
      } catch {
        setError(true);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [tick, externalTick]);

  const retry = () => setTick((n) => n + 1);

  return { items, isLoading, error, retry };
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

const GROUP_ORDER = ['Sessions', 'Workbenches and agents'] as const;
type RailGroup = (typeof GROUP_ORDER)[number];

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

function AgentCredentialEditor({
  tenantId,
  agentId,
  currentRequirements,
  onSaved,
  onCancel,
}: {
  tenantId: string;
  agentId: string;
  currentRequirements: CredentialRequirement[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [credentials, setCredentials] = useState<EnrichedCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const principals = await getMyPrincipals();
        const tenantIds = [...new Set(principals.map((p) => p.tenantId))];
        const lists = await Promise.all(tenantIds.map((id) => listEnrichedCredentials(id)));
        setCredentials(lists.flat());
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const currentCredName = currentRequirements[0]?.name ?? '';

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const credId = fd.get('credentialId') as string;
    if (!credId) return;

    setSaving(true);
    setError(null);
    try {
      await assignCredentialToAgent(tenantId, agentId, credId);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update credential.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="px-3 py-2 text-[12px] text-text-3">Loading credentials…</p>;
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mt-1 rounded-[10px] border border-border bg-surface px-3 py-3"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-text-3">
        Credential
      </p>
      {error && <p className="mb-2 text-[11px] text-orange-deep">{error}</p>}
      <select
        name="credentialId"
        defaultValue={credentials.find((c) => c.name === currentCredName)?.id ?? ''}
        disabled={saving}
        className="mb-2 w-full rounded-[8px] border border-border bg-bg px-2 py-1.5 text-[12px] text-text outline-none focus:border-orange disabled:opacity-50"
      >
        {credentials.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.providerPlugin})
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || credentials.length === 0}
          className="rounded-[7px] bg-orange px-2.5 py-1 text-[12px] font-medium text-white hover:bg-orange-deep disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-[7px] border border-border px-2.5 py-1 text-[12px] text-text-2 hover:text-text disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export interface AgentSelection {
  instanceId: string;
  tenantId: string;
  agentName: string;
}

export interface LibraryRailProps {
  onClose?: () => void;
  onNew?: () => void;
  onAgentSelect?: (selection: AgentSelection) => void;
  refreshTick?: number;
}

const SEGMENT_FILTER: Record<string, ResourceType | null> = {
  All: null,
  Workflows: 'workflow',
  Workbenches: 'workbench',
  Agents: 'agent',
};

export function LibraryRail({ onClose, onNew, onAgentSelect, refreshTick }: LibraryRailProps = {}) {
  const {
    data: workflows,
    isLoading: sessionsLoading,
    isError,
  } = useLibraryResources(clientOptions);
  const {
    items: workbenchAndAgentItems,
    error: workbenchError,
    retry: retryWorkbenches,
  } = useWorkbenchesAndAgents(refreshTick);

  const [activeSegment, setActiveSegment] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingCredentialFor, setEditingCredentialFor] = useState<string | null>(null);

  const sessionItems = (workflows ?? []).map(workflowToRailItem);
  const items: RailItem[] = [...sessionItems, ...workbenchAndAgentItems];
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
    if (
      query !== '' &&
      !item.name.toLowerCase().includes(query) &&
      !item.sub.toLowerCase().includes(query)
    )
      return false;
    return true;
  });

  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
      <div className="px-[18px] pb-[10px] pt-[18px]">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-bold uppercase tracking-[0.04em] text-text-3">
            Workbench
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close workbench"
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
          <div className="px-[10px] py-6 text-[13px] text-text-3">Loading workbench…</div>
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
                {group === 'Workbenches and agents' && onNew && (
                  <button
                    type="button"
                    onClick={onNew}
                    aria-label="New agent"
                    className="-m-[11px] grid h-[40px] w-[40px] flex-none place-items-center rounded-[5px] text-text-3 transition-colors hover:text-orange"
                  >
                    <span className="grid h-[18px] w-[18px] place-items-center rounded-[5px] border border-border transition-colors hover:border-orange">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        className="h-[11px] w-[11px]"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </span>
                  </button>
                )}
              </div>
              {inGroup.map((item) => {
                const isClickableAgent =
                  item.type === 'agent' &&
                  onAgentSelect !== undefined &&
                  item.instanceId !== undefined &&
                  item.tenantId !== undefined;
                const isEditingCred = editingCredentialFor === item.id;
                return (
                  <div key={item.id} className="rounded-[12px]">
                    <div
                      role={isClickableAgent ? 'button' : undefined}
                      tabIndex={isClickableAgent ? 0 : undefined}
                      onClick={
                        isClickableAgent
                          ? () =>
                              onAgentSelect!({
                                instanceId: item.instanceId!,
                                tenantId: item.tenantId!,
                                agentName: item.name,
                              })
                          : undefined
                      }
                      onKeyDown={
                        isClickableAgent
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onAgentSelect!({
                                  instanceId: item.instanceId!,
                                  tenantId: item.tenantId!,
                                  agentName: item.name,
                                });
                              }
                            }
                          : undefined
                      }
                      className={`group relative flex items-center gap-[11px] rounded-[12px] px-[11px] py-[10px] transition-colors hover:bg-[var(--row-hover)] ${isClickableAgent ? 'cursor-pointer' : ''}`}
                    >
                      <StatusDot status={item.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-text">
                          {item.name}
                        </div>
                        <div className="mt-px font-mono text-[11.5px] text-text-3">{item.sub}</div>
                      </div>
                      {item.type === 'agent' && item.agentId && item.tenantId && (
                        <button
                          type="button"
                          aria-label="Configure credential"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingCredentialFor(isEditingCred ? null : item.id);
                          }}
                          className={`grid h-[22px] w-[22px] flex-none place-items-center rounded-[6px] border border-border text-text-3 opacity-0 transition-opacity hover:text-text group-hover:opacity-100 ${isEditingCred ? 'opacity-100 text-orange' : ''}`}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="h-[13px] w-[13px]"
                          >
                            <circle cx="12" cy="12" r="3" />
                            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                          </svg>
                        </button>
                      )}
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
                    {isEditingCred && item.agentId && item.tenantId && (
                      <div className="px-[11px] pb-2">
                        <AgentCredentialEditor
                          tenantId={item.tenantId}
                          agentId={item.agentId}
                          currentRequirements={item.credentialRequirements ?? []}
                          onSaved={() => setEditingCredentialFor(null)}
                          onCancel={() => setEditingCredentialFor(null)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
