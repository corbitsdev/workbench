import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listEnrichedCredentials, createTenantCredential } from '../lib/hub-api';

const ADD_NEW = '__add_new__';

const INFERENCE_PROVIDER_NAMES = new Set([
  'anthropic',
  'openai',
  'google-genai',
  'openai-compatible',
]);

export interface CredentialFieldProps {
  tenantId: string;
  /** Provider name used when creating a new credential (e.g. 'granola', 'openai-compatible'). */
  providerName: string;
  /** Provider names accepted when selecting an existing credential. Defaults to [providerName]. */
  matchProviderNames?: string[];
  label: string;
  value: string | undefined;
  onChange: (credentialId: string | undefined) => void;
}

/**
 * Select an existing tenant credential matching a provider, or add a new one
 * inline. Shared by the agent and workflow add flows so credential creation
 * never requires leaving the modal.
 */
export function CredentialField({
  tenantId,
  providerName,
  matchProviderNames,
  label,
  value,
  onChange,
}: CredentialFieldProps) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isInference = INFERENCE_PROVIDER_NAMES.has(providerName);

  const credentialsQuery = useQuery({
    queryKey: ['credentials', 'enriched', tenantId],
    queryFn: () => listEnrichedCredentials(tenantId),
    enabled: tenantId !== '',
  });

  const acceptedNames = matchProviderNames ?? [providerName];
  const matching = (credentialsQuery.data ?? []).filter((c) =>
    acceptedNames.includes(c.providerName)
  );

  const createMutation = useMutation({
    mutationFn: () =>
      createTenantCredential(tenantId, {
        provider: providerName,
        name: name.trim(),
        apiKey: apiKey.trim(),
        ...(isInference && model.trim() ? { model: model.trim() } : {}),
        ...(isInference && baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['credentials', 'enriched', tenantId] });
      onChange(res.credentialId);
      setAdding(false);
      setName('');
      setApiKey('');
      setModel('');
      setBaseURL('');
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create credential');
    },
  });

  const handleSelect = (next: string) => {
    if (next === ADD_NEW) {
      setAdding(true);
      onChange(undefined);
      return;
    }
    setAdding(false);
    onChange(next || undefined);
  };

  const canCreate = name.trim().length > 0 && apiKey.trim().length > 0 && !createMutation.isPending;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-text">{label}</span>
      <select
        value={adding ? ADD_NEW : (value ?? '')}
        onChange={(e) => handleSelect(e.target.value)}
        className="rounded-[10px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none focus:border-orange"
      >
        <option value="">Select {label.toLowerCase()}</option>
        {matching.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value={ADD_NEW}>+ Add new…</option>
      </select>

      {adding && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface-2 p-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Credential name"
            className="rounded-[8px] border border-border bg-bg px-3 py-1.5 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange"
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key"
            className="rounded-[8px] border border-border bg-bg px-3 py-1.5 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange"
          />
          {isInference && (
            <>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model (e.g. gpt-4o)"
                className="rounded-[8px] border border-border bg-bg px-3 py-1.5 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange"
              />
              <input
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="Base URL (optional)"
                className="rounded-[8px] border border-border bg-bg px-3 py-1.5 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-orange"
              />
            </>
          )}
          {error && <p className="text-[12px] text-orange">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!canCreate}
              onClick={() => createMutation.mutate()}
              className="rounded-[8px] bg-orange px-3 py-1.5 text-[12px] font-medium text-white hover:bg-orange-deep disabled:opacity-50"
            >
              {createMutation.isPending ? 'Saving…' : 'Save credential'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className="rounded-[8px] border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
