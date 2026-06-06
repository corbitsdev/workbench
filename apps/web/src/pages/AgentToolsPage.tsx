import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyPrincipals, listAgentInstances, updateAgentTools } from '../lib/hub-api';
import type { AgentInstance } from '../lib/hub-api';

const AVAILABLE_TOOLS = [
  { name: 'exa_search', label: 'Exa Search', description: 'Search the web using Exa.' },
  {
    name: 'granola_list_notes',
    label: 'Granola List Notes',
    description: 'List notes from Granola.',
  },
  {
    name: 'granola_get_note',
    label: 'Granola Get Note',
    description: 'Read a specific Granola note.',
  },
];

function getAgentTools(capabilities: Record<string, unknown> | null): string[] {
  if (!capabilities || typeof capabilities !== 'object') return [];
  const tools = capabilities['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.filter((t): t is string => typeof t === 'string');
}

export default function AgentToolsPage() {
  const queryClient = useQueryClient();

  const principalsQuery = useQuery({
    queryKey: ['me', 'principals'],
    queryFn: () => getMyPrincipals(),
  });
  const principals = principalsQuery.data ?? [];
  const tenantIds = [...new Set(principals.map((p) => p.tenantId))];

  const agentInstancesQuery = useQuery<AgentInstance[]>({
    queryKey: ['agents', 'instances', tenantIds],
    queryFn: async () => {
      const results = await Promise.all(tenantIds.map((id) => listAgentInstances(id)));
      return results.flat();
    },
    enabled: tenantIds.length > 0,
  });
  const allInstances = agentInstancesQuery.data ?? [];

  const isLoading = principalsQuery.isLoading || agentInstancesQuery.isLoading;

  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);
  const [errorAgentId, setErrorAgentId] = useState<string | null>(null);

  const tenantName = (tenantId: string) => {
    const p = principals.find((pr) => pr.tenantId === tenantId);
    return p?.tenantName ?? tenantId;
  };

  const handleToggleTool = async (agent: AgentInstance, toolName: string, enabled: boolean) => {
    const currentTools = getAgentTools(agent.capabilities);
    const nextTools = enabled
      ? [...new Set([...currentTools, toolName])]
      : currentTools.filter((t) => t !== toolName);

    setSavingAgentId(agent.agentId);
    setErrorAgentId(null);
    try {
      await updateAgentTools(agent.tenantId, agent.agentId, nextTools);
      await queryClient.invalidateQueries({ queryKey: ['agents', 'instances'] });
    } catch {
      setErrorAgentId(agent.agentId);
    } finally {
      setSavingAgentId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link
          to="/settings"
          className="mb-4 flex items-center gap-1 text-[12px] text-text-3 hover:text-text-2"
        >
          <span>←</span>
          <span>Settings</span>
        </Link>

        <div className="mb-6">
          <h1 className="text-[18px] font-semibold text-text">Agent Tools</h1>
          <p className="mt-1 text-[13px] text-text-3">
            Manage which tools are available to each agent.
          </p>
        </div>

        {isLoading && <p className="text-[13px] text-text-3">Loading...</p>}

        {!isLoading && allInstances.length === 0 && (
          <p className="text-[13px] text-text-3">No agents found.</p>
        )}

        {allInstances.length > 0 && (
          <div className="space-y-4">
            {allInstances.map((agent) => {
              const currentTools = getAgentTools(agent.capabilities);
              const isSaving = savingAgentId === agent.agentId;
              const hasError = errorAgentId === agent.agentId;

              return (
                <div key={agent.id} className="rounded-[10px] border border-border bg-surface p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h2 className="text-[14px] font-medium text-text">{agent.agentName}</h2>
                      <p className="mt-0.5 text-[12px] text-text-3">
                        {tenantName(agent.tenantId)} · {agent.status}
                      </p>
                    </div>
                    {hasError && <span className="text-[12px] text-red-500">Failed to save</span>}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {AVAILABLE_TOOLS.map((tool) => {
                      const enabled = currentTools.includes(tool.name);
                      return (
                        <label
                          key={tool.name}
                          className={`flex cursor-pointer items-start gap-3 rounded-[8px] border px-3 py-2 transition-colors ${
                            enabled
                              ? 'border-orange bg-orange/10'
                              : 'border-border bg-bg hover:bg-surface-2'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={isSaving}
                            onChange={(e) =>
                              void handleToggleTool(agent, tool.name, e.target.checked)
                            }
                            className="mt-0.5 accent-orange"
                          />
                          <div>
                            <span className="block text-[13px] font-medium text-text">
                              {tool.label}
                            </span>
                            <span className="mt-0.5 block text-[12px] text-text-3">
                              {tool.description}
                            </span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
