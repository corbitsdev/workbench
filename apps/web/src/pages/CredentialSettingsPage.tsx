import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCredentials } from '../hooks/use-credentials';
import {
  createTenantCredential,
  deleteTenantCredential,
  type LLMProviderType,
  type CreateTenantCredentialInput,
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

function modelListForProvider(p: LLMProviderType) {
  if (p === 'anthropic') return ANTHROPIC_MODELS;
  if (p === 'openai') return OPENAI_MODELS;
  if (p === 'google-genai') return GEMINI_MODELS;
  return [];
}

const INPUT_CLASS =
  'w-full rounded-[8px] border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange';
const LABEL_CLASS = 'mb-1 block text-[12px] font-medium text-text-2';

export default function CredentialSettingsPage() {
  const { principals, credentialsByTenant, isLoading } = useCredentials();
  const queryClient = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [formTenantId, setFormTenantId] = useState('');
  const [provider, setProvider] = useState<LLMProviderType>('anthropic');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(ANTHROPIC_MODELS[0].value);
  const [baseURL, setBaseURL] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const tenantIds = [...new Set(principals.map((p) => p.tenantId))];

  const tenantName = (tenantId: string) => {
    const p = principals.find((pr) => pr.tenantId === tenantId);
    return p?.tenantName ?? tenantId;
  };

  const handleProviderChange = (next: LLMProviderType) => {
    setProvider(next);
    const models = modelListForProvider(next);
    setModel(models.length > 0 ? models[0].value : '');
    setFormError(null);
  };

  const handleShowForm = () => {
    setFormTenantId(tenantIds[0] ?? '');
    setProvider('anthropic');
    setName('');
    setApiKey('');
    setModel(ANTHROPIC_MODELS[0].value);
    setBaseURL('');
    setFormError(null);
    setShowForm(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTenantId) return;
    if (provider === 'openai-compatible' && !baseURL.trim()) {
      setFormError('Base URL is required for OpenAI-compatible providers.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const input: CreateTenantCredentialInput =
        provider === 'openai-compatible'
          ? { provider, name: name.trim(), apiKey, model, baseURL: baseURL.trim() }
          : { provider, name: name.trim(), apiKey, model };
      await createTenantCredential(formTenantId, input);
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create credential.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (tenantId: string, credentialId: string) => {
    setDeletingId(credentialId);
    try {
      await deleteTenantCredential(tenantId, credentialId);
      await queryClient.invalidateQueries({ queryKey: ['credentials'] });
    } catch {
      // Leave deletingId set only during the operation
    } finally {
      setDeletingId(null);
    }
  };

  const allCredentials = tenantIds.flatMap((tenantId) =>
    (credentialsByTenant[tenantId] ?? []).map((c) => ({ ...c, tenantId }))
  );

  const modelOptions = modelListForProvider(provider);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
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
              className="rounded-[8px] bg-orange px-3 py-1.5 text-[13px] font-medium text-text hover:bg-orange-deep"
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
                type="text"
                className={INPUT_CLASS}
                placeholder="e.g. My Anthropic Key"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
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
                  type="url"
                  className={INPUT_CLASS}
                  placeholder="https://your-endpoint.example.com/v1"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
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
                type="password"
                className={INPUT_CLASS}
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={saving}
              />
            </div>

            <div className="mb-4">
              <label className={LABEL_CLASS} htmlFor="cred-model">
                Model
              </label>
              {modelOptions.length > 0 ? (
                <select
                  id="cred-model"
                  className={INPUT_CLASS}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
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
                  id="cred-model"
                  type="text"
                  className={INPUT_CLASS}
                  placeholder="e.g. llama-3.1-8b"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving}
                />
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving || !name.trim() || !apiKey.trim() || !model.trim()}
                className="rounded-[8px] bg-orange px-3 py-1.5 text-[13px] font-medium text-text hover:bg-orange-deep disabled:opacity-50"
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
                  <th className="px-4 py-2 text-left font-medium text-text-3">Tenant</th>
                  <th className="px-4 py-2 text-left font-medium text-text-3">Provider</th>
                  <th className="px-4 py-2 text-left font-medium text-text-3">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {allCredentials.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-text">{c.name}</td>
                    <td className="px-4 py-2">
                      <span className="rounded-[4px] bg-surface px-1.5 py-0.5 text-[11px] text-text-3 ring-1 ring-border">
                        {tenantName(c.tenantId)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-text-2">{c.providerId}</td>
                    <td className="px-4 py-2 capitalize text-text-2">{c.status}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        disabled={deletingId === c.id}
                        onClick={() => void handleDelete(c.tenantId, c.id)}
                        className="text-[12px] text-text-3 hover:text-red-500 disabled:opacity-40"
                      >
                        {deletingId === c.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
