import { useState } from 'react';
import { useNavigate } from 'react-router';
import { getMe, createTenantCredential, launchInstanceSession } from '../lib/hub-api';
import type { LLMProviderType, CreateTenantCredentialInput } from '../lib/hub-api';

const ANTHROPIC_MODELS = [
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const OPENAI_MODELS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
];

const GEMINI_MODELS = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
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
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-[14px] text-text-1 placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange';
const LABEL_CLASS = 'mb-1 block text-[13px] font-medium text-text-2';

export function OnboardingPage() {
  const navigate = useNavigate();

  const [provider, setProvider] = useState<LLMProviderType>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(ANTHROPIC_MODELS[0].value);
  const [baseURL, setBaseURL] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleProviderChange = (next: LLMProviderType) => {
    setProvider(next);
    setError(null);
    const models = modelListForProvider(next);
    setModel(models.length > 0 ? models[0].value : '');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (provider === 'openai-compatible' && !baseURL.trim()) {
      setError('Base URL is required for OpenAI-compatible providers.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const me = await getMe();
      if (!me.personalTenantId) {
        setError('Personal tenant not provisioned. Please try again.');
        return;
      }
      if (!me.paInstanceId) {
        setError('Myra instance not provisioned. Please try again.');
        return;
      }

      const input: CreateTenantCredentialInput =
        provider === 'openai-compatible'
          ? {
              provider: 'openai-compatible',
              name: 'Myra LLM',
              apiKey,
              model,
              baseURL: baseURL.trim(),
            }
          : { provider, name: 'Myra LLM', apiKey, model };

      try {
        await createTenantCredential(me.personalTenantId, input);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes('already exists'))) throw err;
        // Credential exists from a prior attempt — Interchange will resolve it by name.
      }

      const result = await launchInstanceSession(me.paInstanceId);
      if (!result.launched && result.launchError) {
        setError(
          `Credential saved, but Myra failed to start: ${result.launchError}. You can try again from Settings.`
        );
        return;
      }

      // Full reload rather than a client-side navigate: the persistent Myra chat
      // panel only connects on mount, so a soft navigate would leave it showing
      // its pre-onboarding state. A reload remounts it against the live session.
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credential. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const modelOptions = modelListForProvider(provider);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-sm px-4">
        <h1 className="mb-1 text-[18px] font-semibold text-text-1">Set up Myra</h1>
        <p className="mb-6 text-[13px] text-text-3">
          Add an LLM API key so Myra can respond to you.
        </p>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label className={LABEL_CLASS} htmlFor="provider-select">
            Provider
          </label>
          <select
            id="provider-select"
            className={`${INPUT_CLASS} mb-4`}
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as LLMProviderType)}
            disabled={loading}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google-genai">Google Gemini</option>
            <option value="openai-compatible">OpenAI-compatible (custom)</option>
          </select>

          {provider === 'openai-compatible' && (
            <>
              <label className={LABEL_CLASS} htmlFor="base-url">
                Base URL
              </label>
              <input
                id="base-url"
                type="url"
                className={`${INPUT_CLASS} mb-4`}
                placeholder="https://your-endpoint.example.com/v1"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                disabled={loading}
              />
            </>
          )}

          <label className={LABEL_CLASS} htmlFor="api-key">
            API key
          </label>
          <input
            id="api-key"
            type="password"
            className={`${INPUT_CLASS} mb-4`}
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={loading}
            autoFocus
          />

          {modelOptions.length > 0 ? (
            <>
              <label className={LABEL_CLASS} htmlFor="model-select">
                Model
              </label>
              <select
                id="model-select"
                className={`${INPUT_CLASS} mb-6`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading}
              >
                {modelOptions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label className={LABEL_CLASS} htmlFor="model-input">
                Model
              </label>
              <input
                id="model-input"
                type="text"
                className={`${INPUT_CLASS} mb-6`}
                placeholder="e.g. llama-3.1-8b"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading}
              />
            </>
          )}

          {error !== null && (
            <p role="alert" className="mb-4 text-[13px] text-red-500">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || apiKey.trim().length === 0 || model.trim().length === 0}
            className="mb-3 w-full rounded-md bg-orange px-4 py-2 text-[14px] font-medium text-white transition-opacity disabled:opacity-50"
          >
            {loading ? 'Saving...' : 'Finish setup'}
          </button>
          <button
            type="button"
            onClick={() => void navigate('/')}
            disabled={loading}
            className="w-full rounded-md px-4 py-2 text-[13px] text-text-3 transition-colors hover:text-text-2 disabled:opacity-50"
          >
            Skip for now
          </button>
        </form>
      </div>
    </div>
  );
}
