import { useState, useRef, useEffect } from 'react';
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

function modelListForProvider(p: LLMProviderType | string) {
  if (p === 'anthropic') return ANTHROPIC_MODELS;
  if (p === 'openai') return OPENAI_MODELS;
  if (p === 'google-genai') return GEMINI_MODELS;
  return [];
}

function providerLabel(plugin: string): string {
  return PROVIDER_LABELS[plugin] ?? plugin;
}

const INPUT_CLASS =
  'w-full rounded-[8px] border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange disabled:opacity-50';
const LABEL_CLASS = 'mb-1 block text-[12px] font-medium text-text-2';

function AssignAgentsPopover({
  credential,
  instances,
  onAssign,
}: {
  credential: EnrichedCredential;
  instances: AgentInstance[];
  onAssign: (agentId: string, assigned: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const tenantInstances = instances.filter((i) => i.tenantId === credential.tenantId);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isAssigned = (inst: AgentInstance) =>
    inst.credentialRequirements.some((r) => r.source === 'tenant' && r.name === credential.name);

  const toggle = async (inst: AgentInstance) => {
    setBusy(inst.id);
    try {
      await onAssign(inst.agentId, !isAssigned(inst));
    } finally {
      setBusy(null);
    }
  };

  const assignedCount = tenantInstances.filter(isAssigned).length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-[4px] border border-border px-2 py-0.5 text-[11px] text-text-2 hover:border-orange hover:text-orange"
      >
        {assignedCount > 0 ? (
          <span>
            {assignedCount} agent{assignedCount !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="text-text-3">Assign</span>
        )}
        <span className="text-text-3">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-[8px] border border-border bg-bg shadow-lg">
          {tenantInstances.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-text-3">No agents in this tenant.</p>
          ) : (
            <ul className="py-1">
              {tenantInstances.map((inst) => {
                const assigned = isAssigned(inst);
                const loading = busy === inst.id;
                return (
                  <li key={inst.id}>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void toggle(inst)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-text hover:bg-surface disabled:opacity-50"
                    >
                      <span
                        className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border ${
                          assigned
                            ? 'border-orange bg-orange text-white'
                            : 'border-border bg-transparent'
                        }`}
                      >
                        {assigned && <span className="text-[9px] leading-none">✓</span>}
                      </span>
                      <span>{inst.agentName}</span>
                      {loading && <span className="ml-auto text-text-3">...</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

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
        model: (fd.get('model') as string).trim(),
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
        {credential.providerPlugin === 'openai-compatible' && (
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
              required
              disabled={saving}
            />
          </div>
        )}
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

  const handleAssign = async (cred: EnrichedCredential, agentId: string, assign: boolean) => {
    await assignCredentialToAgent(cred.tenantId, agentId, assign ? cred.id : null);
    await queryClient.invalidateQueries({ queryKey: ['agents', 'instances'] });
  };

  const isLoading = principalsQuery.isLoading || credentialsQuery.isLoading;

  const [showForm, setShowForm] = useState(false);
  const [formTenantId, setFormTenantId] = useState('');
  const [provider, setProvider] = useState<LLMProviderType>('anthropic');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const tenantName = (tenantId: string) => {
    const p = principals.find((pr) => pr.tenantId === tenantId);
    return p?.tenantName ?? tenantId;
  };

  const handleProviderChange = (next: LLMProviderType) => {
    setProvider(next);
    setFormError(null);
  };

  const handleShowForm = () => {
    setFormTenantId(tenantIds[0] ?? '');
    setProvider('anthropic');
    setFormError(null);
    setShowForm(true);
  };

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formTenantId) return;
    const fd = new FormData(e.currentTarget);
    const baseURL = (fd.get('baseURL') as string | null) ?? '';
    if (provider === 'openai-compatible' && !baseURL.trim()) {
      setFormError('Base URL is required for OpenAI-compatible providers.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const name = (fd.get('name') as string).trim();
      const apiKey = fd.get('apiKey') as string;
      const model = (fd.get('model') as string).trim();
      const input: CreateTenantCredentialInput =
        provider === 'openai-compatible'
          ? { provider, name, apiKey, model, baseURL: baseURL.trim() }
          : { provider, name, apiKey, model };
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
      model: data.model || undefined,
      baseURL: c.providerPlugin === 'openai-compatible' ? data.baseURL : undefined,
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
                Tenant
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
              <label className={LABEL_CLASS} htmlFor="cred-provider">
                Provider
              </label>
              <select
                id="cred-provider"
                className={INPUT_CLASS}
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value as LLMProviderType)}
                disabled={saving}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="google-genai">Google Gemini</option>
                <option value="openai-compatible">OpenAI-compatible (custom)</option>
              </select>
            </div>

            {provider === 'openai-compatible' && (
              <div className="mb-3">
                <label className={LABEL_CLASS} htmlFor="cred-baseurl">
                  Base URL
                </label>
                <input
                  id="cred-baseurl"
                  name="baseURL"
                  type="url"
                  className={INPUT_CLASS}
                  placeholder="https://your-endpoint.example.com/v1"
                  required
                  disabled={saving}
                />
              </div>
            )}

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
          <div className="rounded-[10px] border border-border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="px-4 py-2 text-left font-medium text-text-3">Name</th>
                  <th className="px-4 py-2 text-left font-medium text-text-3">Tenant</th>
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
                        <AssignAgentsPopover
                          credential={c}
                          instances={allInstances}
                          onAssign={(agentId, assign) => handleAssign(c, agentId, assign)}
                        />
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
