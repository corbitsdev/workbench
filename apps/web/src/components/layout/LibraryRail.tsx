import { useLibraryResources } from '@workbench/client/react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { SessionStatus, WorkflowSummary } from '@workbench/shared';
import { clientOptions } from '../../lib/client-options';
import {
  listAgentInstances,
  listWorkbenches,
  listEnrichedCredentials,
  assignCredentialToAgent,
  stopAgentInstance,
  launchInstanceSession,
  listAvailableTools,
  updateAgentTools,
  createTenantCredential,
  INFERENCE_PROVIDER_NAMES,
} from '../../lib/hub-api';
import type {
  AgentInstance,
  WorkbenchEntry,
  EnrichedCredential,
  CredentialRequirement,
  ToolSummary,
} from '../../lib/hub-api';
import { PROVIDER_REGISTRY } from '../../lib/providerRegistry';
import { useEffect, useState } from 'react';

type ResourceType = 'workflow' | 'agent';
type ResourceStatus = 'run' | 'done' | 'idle';
type RailGroup = 'Agents' | 'Workflows';

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
  agentStatus?: string;
  credentialRequirements?: CredentialRequirement[];
  capabilities?: Record<string, unknown> | null;
}

function agentStatusLabel(status: string): string {
  if (status === 'running') return 'Running';
  if (status === 'stopped') return 'Stopped';
  return 'Deploying';
}

function formatToolName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function agentToRailItem(a: AgentInstance): RailItem {
  return {
    id: a.id,
    group: 'Agents',
    name: a.agentName,
    type: 'agent',
    sub: `Agent · ${agentStatusLabel(a.status)}`,
    status: a.status === 'running' ? 'run' : 'idle',
    who: a.agentName.slice(0, 2).toUpperCase(),
    color: a.status === 'stopped' ? 'var(--text-3)' : 'var(--green)',
    instanceId: a.id,
    tenantId: a.tenantId,
    agentId: a.agentId,
    agentStatus: a.status,
    credentialRequirements: a.credentialRequirements,
    capabilities: a.capabilities,
  };
}

function useWorkbenchesAndAgents(externalTick = 0): {
  workbenches: WorkbenchEntry[];
  agentItems: RailItem[];
  isLoading: boolean;
  error: boolean;
  agentLoadError: boolean;
  retry: () => void;
} {
  const [workbenches, setWorkbenches] = useState<WorkbenchEntry[]>([]);
  const [agentItems, setAgentItems] = useState<RailItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [agentLoadError, setAgentLoadError] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setIsLoading(true);
    setError(false);
    setAgentLoadError(false);

    void (async () => {
      try {
        const entries = await listWorkbenches();
        setWorkbenches(entries);

        const agentResults = await Promise.allSettled(
          entries.map((w) => listAgentInstances(w.tenantId))
        );
        const loadedAgents = agentResults.flatMap((result) =>
          result.status === 'fulfilled' ? result.value : []
        );
        setAgentItems(loadedAgents.map(agentToRailItem));
        setAgentLoadError(agentResults.some((result) => result.status === 'rejected'));
        setError(false);
      } catch {
        setError(true);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [tick, externalTick]);

  const retry = () => setTick((n) => n + 1);

  return { workbenches, agentItems, isLoading, error, agentLoadError, retry };
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
  const name = w.companyName ?? w.firstPainPoint ?? w.transcriptPreview ?? 'Untitled workflow';
  const sub =
    w.painPointCount > 0
      ? `${w.painPointCount} pain point${w.painPointCount === 1 ? '' : 's'} · ${w.status}`
      : w.status;
  return {
    id: w.id,
    group: 'Workflows',
    name,
    type: 'workflow',
    sub,
    status: SESSION_STATUS_TO_RAIL[w.status] ?? 'idle',
    who: 'GA',
    color: 'var(--orange)',
  };
}

const GROUP_ORDER: RailGroup[] = ['Agents', 'Workflows'];

const TAG_STYLES: Record<ResourceType, string> = {
  workflow: 'bg-[rgba(233,132,40,0.16)] text-orange',
  agent: 'bg-[rgba(123,153,116,0.18)] text-green',
};

const DOT_STYLES: Record<ResourceType, string> = {
  workflow: 'bg-orange',
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
        setCredentials(await listEnrichedCredentials(tenantId));
      } finally {
        setLoading(false);
      }
    })();
  }, [tenantId]);

  const currentCredName = currentRequirements[0]?.name ?? '';

  const inferenceCredentials = credentials.filter((c) =>
    INFERENCE_PROVIDER_NAMES.includes(c.providerPlugin as (typeof INFERENCE_PROVIDER_NAMES)[number])
  );

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
        defaultValue={inferenceCredentials.find((c) => c.name === currentCredName)?.id ?? ''}
        disabled={saving}
        className="mb-2 w-full rounded-[8px] border border-border bg-bg px-2 py-1.5 text-[12px] text-text outline-none focus:border-orange disabled:opacity-50"
      >
        {inferenceCredentials.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.providerPlugin})
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || inferenceCredentials.length === 0}
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

function AgentToolEditor({
  tenantId,
  agentId,
  currentCapabilities,
  onSaved,
  onCancel,
}: {
  tenantId: string;
  agentId: string;
  currentCapabilities: Record<string, unknown> | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [availableTools, setAvailableTools] = useState<ToolSummary[]>([]);
  const [existingCredsByProvider, setExistingCredsByProvider] = useState<
    Map<string, EnrichedCredential>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Pending credential field values keyed by providerName → fieldKey → value
  const [pendingCreds, setPendingCreds] = useState<Record<string, Record<string, string>>>({});

  const currentTools = Array.isArray(currentCapabilities?.tools)
    ? currentCapabilities.tools.filter((t): t is string => typeof t === 'string')
    : [];

  useEffect(() => {
    void (async () => {
      try {
        const [tools, credentials] = await Promise.all([
          listAvailableTools(),
          listEnrichedCredentials(tenantId),
        ]);
        setAvailableTools(tools);
        setSelected(new Set(currentTools));
        const byProvider = new Map<string, EnrichedCredential>();
        for (const c of credentials) {
          if (
            !INFERENCE_PROVIDER_NAMES.includes(
              c.providerPlugin as (typeof INFERENCE_PROVIDER_NAMES)[number]
            )
          ) {
            byProvider.set(c.providerPlugin, c);
          }
        }
        setExistingCredsByProvider(byProvider);
      } catch {
        setError('Failed to load tools.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggleTool = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // Providers that are needed by the current selection but have no credential yet.
  const missingProviders = PROVIDER_REGISTRY.filter((p) => {
    const needed = p.tools.some((t) => selected.has(t.name));
    return needed && !existingCredsByProvider.has(p.name);
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Create any missing credentials first.
      for (const provider of missingProviders) {
        const fields = pendingCreds[provider.name] ?? {};
        const apiKey = fields['apiKey'] ?? '';
        if (!apiKey) {
          setError(`API key required for ${provider.label}.`);
          setSaving(false);
          return;
        }
        await createTenantCredential(tenantId, {
          provider: provider.name,
          name: provider.label,
          apiKey,
          ...(fields['baseURL'] ? { baseURL: fields['baseURL'] } : {}),
        });
      }
      await updateAgentTools(tenantId, agentId, Array.from(selected));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tools.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="px-3 py-2 text-[12px] text-text-3">Loading tools…</p>;
  }

  if (availableTools.length === 0) {
    return (
      <div className="mt-1 rounded-[10px] border border-border bg-surface px-3 py-3">
        <p className="text-[12px] text-text-3">No tools available.</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mt-1 rounded-[10px] border border-border bg-surface px-3 py-3"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-text-3">Tools</p>
      {error && <p className="mb-2 text-[11px] text-orange-deep">{error}</p>}
      <div className="mb-2 flex flex-wrap gap-2">
        {availableTools.map((tool) => (
          <label
            key={tool.name}
            className={`flex cursor-pointer items-center gap-1.5 rounded-[7px] border px-2 py-1 text-[12px] transition-colors ${
              selected.has(tool.name)
                ? 'border-orange bg-[rgba(233,132,40,0.12)] text-orange'
                : 'border-border text-text-2 hover:text-text'
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(tool.name)}
              onChange={() => toggleTool(tool.name)}
              disabled={saving}
              className="h-3 w-3 accent-orange"
            />
            {formatToolName(tool.name)}
          </label>
        ))}
      </div>
      {missingProviders.length > 0 && (
        <div className="mb-3 space-y-3">
          {missingProviders.map((provider) => (
            <div key={provider.name} className="rounded-[7px] border border-border bg-bg px-3 py-2">
              <p className="mb-1.5 text-[11px] font-medium text-text-2">
                {provider.label} credentials required
              </p>
              {provider.fields.map((field) => (
                <div key={field.key} className="mb-1.5">
                  <label className="mb-0.5 block text-[11px] text-text-3">
                    {field.label}
                    {field.required ? '' : ' (optional)'}
                  </label>
                  <input
                    type={field.type === 'password' ? 'password' : 'text'}
                    placeholder={field.placeholder}
                    value={pendingCreds[provider.name]?.[field.key] ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setPendingCreds((prev) => ({
                        ...prev,
                        [provider.name]: { ...prev[provider.name], [field.key]: val },
                      }));
                    }}
                    disabled={saving}
                    className="w-full rounded-[6px] border border-border bg-surface px-2 py-1 text-[12px] text-text placeholder:text-text-3 focus:border-orange focus:outline-none"
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
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
  onNewWorkbench?: () => void;
  onNewWorkflow?: () => void;
  onAgentSelect?: (selection: AgentSelection) => void;
  onWorkflowSelect?: (workflowId: string) => void;
  onWorkbenchSelect?: (slug: string) => void;
  onAgentDeleted?: () => void;
  onWorkflowDeleted?: (workflowId: string) => void;
  activeAgentInstanceId?: string;
  activeWorkflowId?: string;
  activeWorkbenchSlug?: string;
  refreshTick?: number;
}

const SEGMENT_FILTER: Record<string, ResourceType | null> = {
  All: null,
  Agents: 'agent',
  Workflows: 'workflow',
};

export function LibraryRail({
  onClose,
  onNew,
  onNewWorkbench,
  onNewWorkflow,
  onAgentSelect,
  onWorkflowSelect,
  onWorkbenchSelect,
  onAgentDeleted,
  onWorkflowDeleted,
  activeAgentInstanceId,
  activeWorkflowId,
  activeWorkbenchSlug,
  refreshTick,
}: LibraryRailProps = {}) {
  const {
    workbenches,
    agentItems: allAgentItems,
    error: workbenchError,
    agentLoadError,
    retry: retryWorkbenches,
  } = useWorkbenchesAndAgents(refreshTick);

  const [activeSegment, setActiveSegment] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingCredentialFor, setEditingCredentialFor] = useState<string | null>(null);
  const [editingToolsFor, setEditingToolsFor] = useState<string | null>(null);
  const [stoppingInstanceId, setStoppingInstanceId] = useState<string | null>(null);
  const [restartingInstanceId, setRestartingInstanceId] = useState<string | null>(null);
  const [deletingWorkflowId, setDeletingWorkflowId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Resolve the tenantId for the active workbench so agents can be scoped.
  const activeWorkbench = workbenches.find((w) => w.tenantSlug === activeWorkbenchSlug);
  const activeWorkbenchTenantId = activeWorkbench?.tenantId;

  const {
    data: workflows,
    isLoading: jobsLoading,
    isError,
  } = useLibraryResources(clientOptions, {
    tenantId: activeWorkbenchSlug ? (activeWorkbenchTenantId ?? null) : undefined,
  });

  // Scope agents to the active workbench; fall back to all agents when no slug is set.
  const agentItems = activeWorkbenchTenantId
    ? allAgentItems.filter((a) => a.tenantId === activeWorkbenchTenantId)
    : allAgentItems;

  const jobItems = (workflows ?? []).map(workflowToRailItem);
  const items: RailItem[] = [...agentItems, ...jobItems];
  const isLoading = jobsLoading;

  const segments: { label: string; count: number }[] = [
    { label: 'All', count: items.length },
    { label: 'Agents', count: agentItems.length },
    { label: 'Workflows', count: jobItems.length },
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
      {/* Workbench switcher */}
      <div className="border-b border-border px-[18px] pb-[12px] pt-[16px]">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[6px]">
            {workbenches.length === 0 && (
              <span className="text-[13px] font-bold uppercase tracking-[0.04em] text-text-3">
                Workbench
              </span>
            )}
            {workbenches.map((wb) => {
              const isActive = wb.tenantSlug === activeWorkbenchSlug;
              return (
                <button
                  key={wb.id}
                  type="button"
                  onClick={() => onWorkbenchSelect?.(wb.tenantSlug)}
                  className={`rounded-[8px] border px-2.5 py-[5px] text-[12px] font-semibold transition-colors ${
                    isActive
                      ? 'border-orange bg-[rgba(233,132,40,0.12)] text-orange'
                      : 'border-border text-text-2 hover:border-orange/60 hover:text-text'
                  }`}
                >
                  {wb.tenantName}
                </button>
              );
            })}
            {onNewWorkbench && (
              <button
                type="button"
                onClick={onNewWorkbench}
                aria-label="New workbench"
                className="grid h-[27px] w-[27px] place-items-center rounded-[8px] border border-dashed border-border text-text-3 transition-colors hover:border-orange hover:text-orange"
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
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close workbench"
              className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
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

      {/* Filter tabs */}
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

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-[10px] pb-[22px] pt-1">
        {isLoading && (
          <div className="px-[10px] py-6 text-[13px] text-text-3">Loading workbench…</div>
        )}
        {isError && (
          <div className="px-[10px] py-6 text-[13px] text-text-3">Could not load workflows.</div>
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
        {agentLoadError && !workbenchError && (
          <div className="px-[10px] py-3 text-[13px] text-text-3">
            Some agents could not be loaded.
          </div>
        )}
        {GROUP_ORDER.map((group) => {
          const inGroup = visibleItems.filter((i) => i.group === group);
          // Always render the Agents group header when onNew is provided so the
          // deploy button is accessible even before any agents exist. Do the same
          // for Jobs when onNewWorkflow is provided.
          const showGroup =
            inGroup.length > 0 ||
            (group === 'Agents' && onNew !== undefined) ||
            (group === 'Workflows' && onNewWorkflow !== undefined);
          if (!showGroup) return null;

          return (
            <div key={group}>
              <div className="flex items-center gap-2 px-[10px] pb-[7px] pt-[14px] text-[11.5px] font-bold uppercase tracking-[0.05em] text-text-3">
                {group}
                <span className="font-mono text-[11px] font-normal opacity-70">
                  {inGroup.length}
                </span>
                <span className="h-px flex-1 bg-border" />
                {group === 'Agents' && onNew && (
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
                {group === 'Workflows' && onNewWorkflow && (
                  <button
                    type="button"
                    onClick={onNewWorkflow}
                    aria-label="New workflow"
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
                  item.agentStatus !== 'stopped' &&
                  onAgentSelect !== undefined &&
                  item.instanceId !== undefined &&
                  item.tenantId !== undefined;
                const isClickableWorkflow =
                  item.type === 'workflow' && onWorkflowSelect !== undefined;
                const isClickable = isClickableAgent || isClickableWorkflow;
                const isActiveAgent =
                  item.type === 'agent' && item.instanceId === activeAgentInstanceId;
                const isActiveWorkflow = item.type === 'workflow' && item.id === activeWorkflowId;
                const isEditingCred = editingCredentialFor === item.id;
                const isEditingTools = editingToolsFor === item.id;
                const isRestarting = restartingInstanceId === item.instanceId;

                const openItem = () => {
                  if (isClickableAgent) {
                    onAgentSelect({
                      instanceId: item.instanceId!,
                      tenantId: item.tenantId!,
                      agentName: item.name,
                    });
                  } else if (isClickableWorkflow) {
                    onWorkflowSelect!(item.id);
                  }
                };

                const stopAgent = async () => {
                  if (!item.instanceId || !item.tenantId) return;
                  setStoppingInstanceId(item.instanceId);
                  try {
                    await stopAgentInstance(item.tenantId, item.instanceId);
                    onAgentDeleted?.();
                  } finally {
                    setStoppingInstanceId(null);
                  }
                };

                const restartAgent = async () => {
                  if (!item.instanceId) return;
                  setRestartingInstanceId(item.instanceId);
                  try {
                    await launchInstanceSession(item.instanceId);
                    onAgentDeleted?.();
                  } finally {
                    setRestartingInstanceId(null);
                  }
                };

                const deleteWorkflow = async () => {
                  setDeletingWorkflowId(item.id);
                  try {
                    await api('DELETE', `/workflows/${item.id}`);
                    await queryClient.invalidateQueries({ queryKey: ['workflows'] });
                    onWorkflowDeleted?.(item.id);
                  } finally {
                    setDeletingWorkflowId(null);
                  }
                };

                return (
                  <div key={item.id} className="rounded-[12px]">
                    <div
                      role={isClickable ? 'button' : undefined}
                      tabIndex={isClickable ? 0 : undefined}
                      onClick={isClickable ? openItem : undefined}
                      onKeyDown={
                        isClickable
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openItem();
                              }
                            }
                          : undefined
                      }
                      className={`group relative flex items-center gap-[11px] rounded-[12px] px-[11px] py-[10px] transition-colors ${isClickable ? 'cursor-pointer hover:bg-[var(--row-hover)]' : ''} ${isActiveAgent || isActiveWorkflow ? 'bg-surface ring-1 ring-orange/60' : ''}`}
                    >
                      <StatusDot status={item.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-text">
                          {item.name}
                        </div>
                        <div className="mt-px font-mono text-[11.5px] text-text-3">
                          {isRestarting ? 'Agent · Creating…' : item.sub}
                        </div>
                      </div>
                      {item.type === 'agent' && item.agentId && item.tenantId && (
                        <div className="flex flex-none gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          {item.agentStatus === 'stopped' ? (
                            <>
                              <button
                                type="button"
                                aria-label="Create Agent"
                                disabled={restartingInstanceId === item.instanceId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void restartAgent();
                                }}
                                className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-text disabled:opacity-50"
                              >
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  className="h-[13px] w-[13px]"
                                >
                                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                  <path d="M3 3v5h5" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                aria-label="Remove Agent"
                                disabled={stoppingInstanceId === item.instanceId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Remove ${item.name}?`)) void stopAgent();
                                }}
                                className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-orange-deep disabled:opacity-50"
                              >
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  className="h-[13px] w-[13px]"
                                >
                                  <rect x="3" y="3" width="18" height="18" rx="2" />
                                </svg>
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                aria-label="Configure tools"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingToolsFor(isEditingTools ? null : item.id);
                                  if (!isEditingTools) setEditingCredentialFor(null);
                                }}
                                className={`grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-text ${isEditingTools ? 'opacity-100 text-orange' : ''}`}
                              >
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  className="h-[13px] w-[13px]"
                                >
                                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                aria-label="Configure credential"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingCredentialFor(isEditingCred ? null : item.id);
                                  if (!isEditingCred) setEditingToolsFor(null);
                                }}
                                className={`grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-text ${isEditingCred ? 'opacity-100 text-orange' : ''}`}
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
                              <button
                                type="button"
                                aria-label="Remove Agent"
                                disabled={stoppingInstanceId === item.instanceId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Remove ${item.name}?`)) void stopAgent();
                                }}
                                className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-orange-deep disabled:opacity-50"
                              >
                                <svg
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  className="h-[13px] w-[13px]"
                                >
                                  <rect x="3" y="3" width="18" height="18" rx="2" />
                                </svg>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {item.type === 'workflow' && (
                        <div className="flex flex-none gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            aria-label="Delete workflow"
                            disabled={deletingWorkflowId === item.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`Delete ${item.name}?`)) void deleteWorkflow();
                            }}
                            className="grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-border text-text-3 hover:text-orange-deep disabled:opacity-50"
                          >
                            <Trash2 className="h-[13px] w-[13px]" />
                          </button>
                        </div>
                      )}
                      <span
                        className={`flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[0.03em] ${TAG_STYLES[item.type]}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[item.type]}`} />
                        {item.type === 'workflow' ? 'Workflow' : item.type}
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
                    {isEditingTools && item.agentId && item.tenantId && (
                      <div className="px-[11px] pb-2">
                        <AgentToolEditor
                          tenantId={item.tenantId}
                          agentId={item.agentId}
                          currentCapabilities={item.capabilities ?? null}
                          onSaved={() => {
                            setEditingToolsFor(null);
                            retryWorkbenches();
                          }}
                          onCancel={() => setEditingToolsFor(null)}
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
