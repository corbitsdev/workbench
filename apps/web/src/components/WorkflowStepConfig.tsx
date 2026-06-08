import { useState } from 'react';
import { useUpdateStepConfig, useWorkbenchAgents } from '../hooks/use-workflow';
import type { WorkflowStepConfig, StepConfig, AgentInstance } from '../hooks/use-workflow';

interface WorkflowStepConfigProps {
  workflowId: string;
  currentConfig: WorkflowStepConfig;
}

const CONFIGURABLE_STEPS = ['analyze', 'generate', 'improve'] as const;
type ConfigurableStep = (typeof CONFIGURABLE_STEPS)[number];

const STEP_LABELS: Record<ConfigurableStep, string> = {
  analyze: 'Analyze',
  generate: 'Generate',
  improve: 'Improve',
};

interface StepRowProps {
  step: ConfigurableStep;
  config: StepConfig;
  agents: AgentInstance[];
  onChange: (step: ConfigurableStep, config: StepConfig) => void;
}

function StepRow({ step, config, agents, onChange }: StepRowProps) {
  const selectedAgent = agents.find((a) => a.id === config.agentId) ?? null;
  const rawTools = selectedAgent?.capabilities?.['tools'];
  const availableTools: string[] = Array.isArray(rawTools)
    ? (rawTools as string[]).filter((t): t is string => typeof t === 'string')
    : [];

  const handleAgentChange = (agentId: string) => {
    // Clear tool selection when agent changes — tools are agent-specific
    onChange(step, { agentId: agentId || undefined, toolIds: [] });
  };

  const handleToolToggle = (tool: string) => {
    const current = config.toolIds ?? [];
    const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool];
    onChange(step, { ...config, toolIds: next });
  };

  const handleMaxOutputTokensChange = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      const { maxOutputTokens: _omit, ...rest } = config;
      onChange(step, rest);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1) return;
    onChange(step, { ...config, maxOutputTokens: parsed });
  };

  return (
    <div className="space-y-2">
      <p className="text-[12px] font-semibold text-text">{STEP_LABELS[step]}</p>

      {/* Agent selector */}
      <div>
        <label className="block text-[11px] text-text-3 mb-1">Agent</label>
        <select
          value={config.agentId ?? ''}
          onChange={(e) => handleAgentChange(e.target.value)}
          className="w-full px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] bg-surface-2 text-text focus:outline-none focus:ring-1 focus:ring-orange"
        >
          <option value="">Default</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.agentName}
            </option>
          ))}
        </select>
      </div>

      {/* Max output tokens — cap tuned to the model (reasoning models need more) */}
      <div>
        <label className="block text-[11px] text-text-3 mb-1">Max output tokens</label>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={config.maxOutputTokens ?? ''}
          placeholder="Default"
          onChange={(e) => handleMaxOutputTokensChange(e.target.value)}
          className="w-full px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] bg-surface-2 text-text focus:outline-none focus:ring-1 focus:ring-orange"
        />
      </div>

      {/* Tool multi-select — only shown when an agent is selected and it has tools */}
      {selectedAgent !== null && availableTools.length > 0 && (
        <div>
          <label className="block text-[11px] text-text-3 mb-1">Tools</label>
          <div className="flex flex-wrap gap-1.5">
            {availableTools.map((tool) => {
              const active = (config.toolIds ?? []).includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  onClick={() => handleToolToggle(tool)}
                  className={`rounded-[6px] border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    active
                      ? 'border-orange bg-orange/8 text-text'
                      : 'border-border text-text-2 hover:border-orange/60 hover:text-text'
                  }`}
                >
                  {tool}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkflowStepConfig({ workflowId, currentConfig }: WorkflowStepConfigProps) {
  const [draft, setDraft] = useState<WorkflowStepConfig>(currentConfig);
  const [saved, setSaved] = useState(false);
  const updateStepConfig = useUpdateStepConfig(workflowId);
  const { data: agents = [] } = useWorkbenchAgents();

  const handleStepChange = (step: ConfigurableStep, config: StepConfig) => {
    setDraft((prev) => ({ ...prev, [step]: config }));
    setSaved(false);
  };

  const handleSave = () => {
    updateStepConfig.mutate(draft, {
      onSuccess: () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      },
    });
  };

  const isDirty = JSON.stringify(draft) !== JSON.stringify(currentConfig);

  return (
    <div className="space-y-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-text-3">
        Step configuration
      </p>

      <div className="space-y-4">
        {CONFIGURABLE_STEPS.map((step) => (
          <StepRow
            key={step}
            step={step}
            config={draft[step] ?? {}}
            agents={agents}
            onChange={handleStepChange}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={updateStepConfig.isPending || !isDirty}
          onClick={handleSave}
          className="rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 hover:text-text hover:border-orange disabled:opacity-40 transition-colors"
        >
          {updateStepConfig.isPending ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-[11px] text-green">Saved</span>}
        {updateStepConfig.isError && (
          <span className="text-[11px] text-orange">
            {updateStepConfig.error instanceof Error
              ? updateStepConfig.error.message
              : 'Save failed'}
          </span>
        )}
      </div>
    </div>
  );
}
