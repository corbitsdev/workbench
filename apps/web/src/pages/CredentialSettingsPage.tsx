import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getMyPrincipals,
  listEnrichedCredentials,
  listAgentInstances,
  createTenantCredential,
  updateTenantCredential,
  deleteTenantCredential,
  assignCredentialToAgent,
} from '../lib/hub-api';
import type {
  LLMProviderType,
  CreateTenantCredentialInput,
  EnrichedCredential,
  AgentInstance,
} from '../lib/hub-api';

const ANTHROPIC_MODELS = [
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const OPENAI_MODELS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
];

const GEMINI_MODELS = [
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'google-genai': 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible',
};

const INFERENCE_PROVIDER_NAMES = ['anthropic', 'openai', 'google-genai', 'openai-compatible'];

function modelListForProvider(p: LLMProviderType | string) {
  if (p === 'anthropic') return ANTHROPIC_MODELS;
  if (p === 'openai') return OPENAI_MODELS;
  if (p === 'google-genai') return GEMINI_MODELS;
  return [];
}

function isInferenceProvider(p: string): p is LLMProviderType {
  return INFERENCE_PROVIDER_NAMES.includes(p);
}

function providerLabel(plugin: string): string {
  return PROVIDER_LABELS[plugin] ?? plugin;
}

function requirementMatchesCredential(
  requirement: AgentInstance['credentialRequirements'][number],
  credential: EnrichedCredential
): boolean {
  return (
    requirement.source === 'tenant' &&
    requirement.providerName === credential.providerName &&
    (requirement.name === undefined || requirement.name === credential.name)
  );
}

const INPUT_CLASS =
  'w-full rounded-[8px] border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange disabled:opacity-50';
const LABEL_CLASS = 'mb-1 block text-[12px] font-medium text-text-2';

function EditCredentialForm({
  credential,
  onSave,
  onCancel,
}: {
  credential: EnrichedCredential;
  onSave: (data: { name: string; apiKey: string; model: string; baseURL: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelOptions = modelListForProvider(credential.providerPlugin);
  const isInferenceCredential = isInferenceProvider(credential.providerPlugin);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const baseURL = (fd.get('baseURL') as string | null) ?? '';
    if (credential.providerPlugin === 'openai-compatible' && !baseURL.trim()) {
      setError('Base URL is required for OpenAI-compatible providers.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: (fd.get('name') as string).trim(),
        apiKey: (fd.get('apiKey') as string).trim(),
        model: ((fd.get('model') as string | null) ?? '').trim(),
        baseURL: baseURL.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update credential.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      {error && (
        <p className="mb-3 rounded-lg border border-orange bg-[rgba(233,132,40,0.16)] px-3 py-2 text-[12px] text-orange-deep">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS} htmlFor={`edit-name-${credential.id}`}>
            Name
          </label>
          <input
            id={`edit-name-${credential.id}`}
            name="name"
            type="text"
            className={INPUT_CLASS}
            defaultValue={credential.name}
            required
            disabled={saving}
            autoFocus
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor={`edit-apikey-${credential.id}`}>
            API key (leave blank to keep current)
          </label>
          <input
            id={`edit-apikey-${credential.id}`}
            name="apiKey"
            type="password"
            autoComplete="new-password"
            className={INPUT_CLASS}
            placeholder="sk-..."
            disabled={saving}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor={`edit-baseurl-${credential.id}`}>
            Base URL
          </label>
          <input
            id={`edit-baseurl-${credential.id}`}
            name="baseURL"
            type="url"
            className={INPUT_CLASS}
            defaultValue={credential.baseURL}
            required={credential.providerPlugin === 'openai-compatible'}
            disabled={saving}
          />
        </div>
        {isInferenceCredential && (
          <div>
            <label className={LABEL_CLASS} htmlFor={`edit-model-${credential.id}`}>
              Model
            </label>
            {modelOptions.length > 0 ? (
              <select
                id={`edit-model-${credential.id}`}
                name="model"
                className={INPUT_CLASS}
                defaultValue={credential.model}
                disabled={saving}
              >
                {modelOptions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`edit-model-${credential.id}`}
                name="model"
                type="text"
                className={INPUT_CLASS}
                defaultValue={credential.model}
                required
                disabled={saving}
              />
            )}
          </div>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-[8px] bg-orange px-3 py-1.5 text-[13px] font-medium text-white hover:bg-orange-deep disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-[8px] border border-border px-3 py-1.5 text-[13px] text-text-2 hover:text-text disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function CredentialSettingsPage() {
  const queryClient = useQueryClient();

  const principalsQuery = useQuery({
    queryKey: ['me', 'principals'],
    queryFn: () => getMyPrincipals(),
  });
  const principals = principalsQuery.data ?? [];
  const tenantIds = [...new Set(principals.map((p) => p.tenantId))];

  const credentialsQuery = useQuery<EnrichedCredential[]>({
    queryKey: ['credentials', 'enriched', tenantIds],
    queryFn: async () => {
      const results = await Promise.all(tenantIds.map((id) => listEnrichedCredentials(id)));
      return results.flat();
    },
    enabled: tenantIds.length > 0,
  });

  const allCredentials = credentialsQuery.data ?? [];

  const agentInstancesQuery = useQuery<AgentInstance[]>({
    queryKey: ['agents', 'instances', tenantIds],
    queryFn: async () => {
      const results = await Promise.all(tenantIds.map((id) => listAgentInstances(id)));
      return results.flat();
    },
    enabled: tenantIds.length > 0,
  });
  const allInstances = agentInstancesQuery.data ?? [];

  function linkedAgentsForCredential(cred: EnrichedCredential): AgentInstance[] {
    return allInstances.filter(
      (inst) =>
        inst.tenantId === cred.tenantId &&
        inst.credentialRequirements.some((r) => requirementMatchesCredential(r, cred))
    );
  }

  function linkableAgentsForCredential(cred: EnrichedCredential): AgentInstance[] {
    if (!isInferenceProvider(cred.providerPlugin)) return [];

    return allInstances.filter(
      (inst) =>
        inst.tenantId === cred.tenantId &&
        !inst.credentialRequirements.some((r) => requirementMatchesCredential(r, cred))
    );
  }

  const isLoading = principalsQuery.isLoading || credentialsQuery.isLoading;

  const [showForm, setShowForm] = useState(false);
  const [formTenantId, setFormTenantId] = useState('');
  const [providerCategory, setProviderCategory] = useState<'inference' | 'other'>('inference');
  const [provider, setProvider] = useState('anthropic');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [assigningAgentId, setAssigningAgentId] = useState<string | null>(null);

  const tenantName = (tenantId: string) => {
    const p = principals.find((pr) => pr.tenantId === tenantId);
    return p?.tenantName ?? tenantId;
  };

  const handleProviderChange = (next: string) => {
    setProvider(next);
    setFormError(null);
  };

  const handleShowForm = () => {
    setFormTenantId(tenantIds[0] ?? '');
    setProviderCategory('inference');
    setProvider('anthropic');
    setFormError(null);
    setShowForm(true);
  };

  const handleProviderCategoryChange = (next: 'inference' | 'other') => {
    setProviderCategory(next);
    setProvider(next === 'inference' ? 'anthropic' : 'granola');
    setFormError(null);
  };

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formTenantId) return;
    const fd = new FormData(e.currentTarget);
    const providerName = (fd.get('provider') as string).trim();
    const baseURL = (fd.get('baseURL') as string | null) ?? '';
    if (!providerName) {
      setFormError('Provider is required.');
      return;
    }
    if (providerName === 'openai-compatible' && !baseURL.trim()) {
      setFormError('Base URL is required for OpenAI-compatible providers.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const name = (fd.get('name') as string).trim();
      const apiKey = fd.get('apiKey') as string;
      const model = ((fd.get('model') as string | null) ?? '').trim();
      const input: CreateTenantCredentialInput = {
        provider: providerName,
        name,
        apiKey,
        ...(isInferenceProvider(providerName) ? { model } : {}),
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
      };
      await createTenantCredential(formTenantId, input);
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create credential.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (
    c: EnrichedCredential,
    data: { name: string; apiKey: string; model: string; baseURL: string }
  ) => {
    await updateTenantCredential(c.tenantId, c.id, {
      name: data.name || undefined,
      apiKey: data.apiKey || undefined,
      model: isInferenceProvider(c.providerPlugin) ? data.model || undefined : undefined,
      baseURL: data.baseURL || undefined,
    });
    await queryClient.invalidateQueries({ queryKey: ['credentials'] });
    setEditingId(null);
  };

  const handleDelete = async (tenantId: string, credentialId: string) => {
    setDeletingId(credentialId);
    try {
      await deleteTenantCredential(tenantId, credentialId);
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
    } finally {
      setDeletingId(null);
    }
  };

  const handleAssignAgent = async (cred: EnrichedCredential, agentId: string) => {
    if (!agentId) return;
    setAssigningAgentId(agentId);
    try {
      await assignCredentialToAgent(cred.tenantId, agentId, cred.id);
      await queryClient.invalidateQueries({ queryKey: ['agents', 'instances'] });
    } finally {
      setAssigningAgentId(null);
    }
  };

  const handleRemoveAgent = async (cred: EnrichedCredential, agentId: string) => {
    setAssigningAgentId(agentId);
    try {
      await assignCredentialToAgent(cred.tenantId, agentId, null);
      await queryClient.invalidateQueries({ queryKey: ['agents', 'instances'] });
    } finally {
      setAssigningAgentId(null);
    }
  };

  const modelOptions = modelListForProvider(provider);

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

        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-[18px] font-semibold text-text">Credentials</h1>
            <p className="mt-1 text-[13px] text-text-3">
              API keys and credentials available to your agents.
            </p>
          </div>
          {!showForm && (
            <button
              type="button"
              onClick={handleShowForm}
              className="rounded-[8px] bg-orange px-3 py-1.5 text-[13px] font-medium text-white hover:bg-orange-deep"
            >
              Add credential
            </button>
          )}
        </div>

        {showForm && (
          <form
            onSubmit={(e) => void handleCreate(e)}
            className="mb-6 rounded-[10px] border border-border bg-surface p-5"
          >
            <p className="mb-4 text-[14px] font-medium text-text">New credential</p>

            {formError && (
              <p className="mb-4 rounded-lg border border-orange bg-[rgba(233,132,40,0.16)] px-3 py-2 text-[13px] text-orange-deep">
                {formError}
              </p>
            )}

            <div className="mb-3">
              <label className={LABEL_CLASS} htmlFor="cred-tenant">
                Workbench
              </label>
              <select
                id="cred-tenant"
                className={INPUT_CLASS}
                value={formTenantId}
                onChange={(e) => setFormTenantId(e.target.value)}
                disabled={saving}
              >
                {tenantIds.map((id) => (
                  <option key={id} value={id}>
                    {tenantName(id)}
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-3">
              <label className={LABEL_CLASS} htmlFor="cred-name">
                Name
              </label>
              <input
                id="cred-name"
                name="name"
                type="text"
                className={INPUT_CLASS}
                placeholder="e.g. My Anthropic Key"
                required
                disabled={saving}
                autoFocus
              />
            </div>

            <div className="mb-3">
              <span className={LABEL_CLASS}>Credential type</span>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer gap-3 rounded-[8px] border border-border bg-bg px-3 py-2 has-[:checked]:border-orange has-[:checked]:bg-orange/10">
                  <input
                    type="radio"
                    name="providerCategory"
                    value="inference"
                    checked={providerCategory === 'inference'}
                    onChange={() => handleProviderCategoryChange('inference')}
                    disabled={saving}
                    className="mt-1 accent-orange"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-text">AI Inference</span>
                    <span className="mt-0.5 block text-[12px] text-text-3">
                      Model providers agents use for LLM calls.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer gap-3 rounded-[8px] border border-border bg-bg px-3 py-2 has-[:checked]:border-orange has-[:checked]:bg-orange/10">
                  <input
                    type="radio"
                    name="providerCategory"
                    value="other"
                    checked={providerCategory === 'other'}
                    onChange={() => handleProviderCategoryChange('other')}
                    disabled={saving}
                    className="mt-1 accent-orange"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-text">Other</span>
                    <span className="mt-0.5 block text-[12px] text-text-3">
                      Service credentials for tools like Granola or Linear.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="mb-3">
              <label className={LABEL_CLASS} htmlFor="cred-provider">
                Provider
              </label>
              {providerCategory === 'inference' ? (
                <select
                  id="cred-provider"
                  name="provider"
                  className={INPUT_CLASS}
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  required
                  disabled={saving}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google-genai">Google GenAI</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
              ) : (
                <>
                  <input
                    id="cred-provider"
                    name="provider"
                    type="text"
                    className={INPUT_CLASS}
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    list="credential-provider-options"
                    placeholder="e.g. granola"
                    required
                    disabled={saving}
                  />
                  <datalist id="credential-provider-options">
                    <option value="granola" />
                    <option value="linear" />
                    <option value="slack" />
                  </datalist>
                </>
              )}
            </div>

            <div className="mb-3">
              <label className={LABEL_CLASS} htmlFor="cred-baseurl">
                Base URL
              </label>
              <input
                id="cred-baseurl"
                name="baseURL"
                type="url"
                className={INPUT_CLASS}
                placeholder="https://service.example.com"
                required={provider === 'openai-compatible'}
                disabled={saving}
              />
            </div>

            <div className="mb-3">
              <label className={LABEL_CLASS} htmlFor="cred-apikey">
                API key
              </label>
              <input
                id="cred-apikey"
                name="apiKey"
                type="password"
                autoComplete="new-password"
                className={INPUT_CLASS}
                placeholder="sk-..."
                required
                disabled={saving}
              />
            </div>

            {isInferenceProvider(provider) && (
              <div className="mb-4">
                <label className={LABEL_CLASS} htmlFor="cred-model">
                  Model
                </label>
                {modelOptions.length > 0 ? (
                  <select id="cred-model" name="model" className={INPUT_CLASS} disabled={saving}>
                    {modelOptions.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="cred-model"
                    name="model"
                    type="text"
                    className={INPUT_CLASS}
                    placeholder="e.g. llama-3.1-8b"
                    required
                    disabled={saving}
                  />
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-[8px] bg-orange px-3 py-1.5 text-[13px] font-medium text-white hover:bg-orange-deep disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                disabled={saving}
                className="rounded-[8px] border border-border px-3 py-1.5 text-[13px] text-text-2 hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {isLoading && <p className="text-[13px] text-text-3">Loading...</p>}

        {!isLoading && allCredentials.length === 0 && (
          <p className="text-[13px] text-text-3">No credentials configured.</p>
        )}

        {allCredentials.length > 0 && (
          <div className="overflow-hidden rounded-[10px] border border-border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="px-4 py-2 text-left font-medium text-text-3">Name</th>
                  <th className="px-4 py-2 text-left font-medium text-text-3">Workbench</th>
                  <th className="px-4 py-2 text-left font-medium text-text-3">Provider</th>
                  <th className="px-4 py-2 text-left font-medium text-text-3">Agents</th>
                  <th className="px-4 py-2 text-left font-medium text-text-3">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {allCredentials.map((c) =>
                  editingId === c.id ? (
                    <tr key={c.id} className="border-b border-border last:border-0 bg-surface">
                      <td colSpan={6} className="px-4 py-4">
                        <EditCredentialForm
                          credential={c}
                          onSave={(data) => handleSaveEdit(c, data)}
                          onCancel={() => setEditingId(null)}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium text-text">{c.name}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-[4px] bg-surface px-1.5 py-0.5 text-[11px] text-text-3 ring-1 ring-border">
                          {tenantName(c.tenantId)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-text-2">{providerLabel(c.providerPlugin)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          {linkedAgentsForCredential(c).length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {linkedAgentsForCredential(c).map((agent) => (
                                <span
                                  key={agent.id}
                                  className="inline-flex items-center gap-1 rounded-[4px] bg-orange/10 px-1.5 py-0.5 text-[11px] text-orange ring-1 ring-orange/30"
                                >
                                  {agent.agentName}
                                  <button
                                    type="button"
                                    aria-label={`Remove ${agent.agentName}`}
                                    disabled={assigningAgentId === agent.agentId}
                                    onClick={() => void handleRemoveAgent(c, agent.agentId)}
                                    className="text-orange hover:text-red-500 disabled:opacity-40"
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[12px] text-text-3">None</span>
                          )}

                          {linkableAgentsForCredential(c).length > 0 && (
                            <select
                              aria-label={`Add agent for ${c.name}`}
                              defaultValue=""
                              disabled={!!assigningAgentId}
                              onChange={(e) => {
                                const agentId = e.currentTarget.value;
                                e.currentTarget.value = '';
                                void handleAssignAgent(c, agentId);
                              }}
                              className="max-w-[160px] rounded-[6px] border border-border bg-bg px-2 py-1 text-[11px] text-text-2 outline-none focus:border-orange disabled:opacity-50"
                            >
                              <option value="" disabled>
                                Add agent...
                              </option>
                              {linkableAgentsForCredential(c).map((agent) => (
                                <option key={agent.agentId} value={agent.agentId}>
                                  {agent.agentName}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 capitalize text-text-2">{c.status}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => setEditingId(c.id)}
                            disabled={!!deletingId}
                            className="text-[12px] text-text-3 hover:text-text disabled:opacity-40"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={deletingId === c.id}
                            onClick={() => void handleDelete(c.tenantId, c.id)}
                            className="text-[12px] text-text-3 hover:text-red-500 disabled:opacity-40"
                          >
                            {deletingId === c.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
