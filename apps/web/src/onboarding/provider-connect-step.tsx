// Connects one provider credential through the stock catalog routes and
// derives the single offering it mints; a tenant that already resolves an
// offering skips this step (see `resolveExistingOffering`).
import { Button, Input, RadioGroup, RadioOption } from "@corbits/react-ui";
import { getResolvedCatalog, shadowOffering } from "@/settings/inference";
import { reportError } from "@corbits/error-sink";
import { useState } from "react";
import type { FormEvent } from "react";

import type { ModelProviderPlugin } from "@intx/types";

export type ProviderOption = {
  readonly plugin: ModelProviderPlugin;
  readonly label: string;
  readonly description: string;
  readonly canonicalName: string;
  readonly modelDisplayName: string;
  readonly baseURL: string;
  readonly keyHint: string;
  /** A server on this machine: base URL and model are typed in, no key needed. */
  readonly local: boolean;
};

// Each hosted option names one canonical model so connecting mints exactly
// one offering and the flow never asks "which model".
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    plugin: "anthropic",
    label: "Anthropic",
    description: "Claude models, direct from Anthropic.",
    canonicalName: "claude-sonnet-4-5",
    modelDisplayName: "Claude Sonnet 4.5",
    baseURL: "https://api.anthropic.com",
    keyHint: "sk-ant-",
    local: false,
  },
  {
    plugin: "openai",
    label: "OpenAI",
    description: "GPT models, direct from OpenAI.",
    canonicalName: "gpt-5",
    modelDisplayName: "GPT-5",
    baseURL: "https://api.openai.com/v1",
    keyHint: "sk-",
    local: false,
  },
  {
    plugin: "google-genai",
    label: "Google",
    description: "Gemini models, direct from Google.",
    canonicalName: "gemini-2.5-pro",
    modelDisplayName: "Gemini 2.5 Pro",
    baseURL: "https://generativelanguage.googleapis.com",
    keyHint: "AIza",
    local: false,
  },
  {
    plugin: "openai-compatible",
    label: "Ollama (local)",
    description: "A model served by Ollama on this machine. No key needed.",
    canonicalName: "",
    modelDisplayName: "",
    baseURL: "http://localhost:11434/v1",
    keyHint: "",
    local: true,
  },
];

// The credential row requires a secret; Ollama ignores whatever is sent.
const LOCAL_PLACEHOLDER_KEY = "ollama";

/** A `(plugin, canonicalName)` pair, the identity the deploy gate approves
 * an inference source under. */
export type DeclaredSource = {
  readonly provider: ModelProviderPlugin;
  readonly model: string;
};

export type ExistingOffering = {
  readonly sourceOfferingIds: readonly string[];
  readonly defaultSourceOfferingId: string;
  /** Same order as `sourceOfferingIds`; Myra declares these so the probe
   * approves exactly what the offering chain resolves to. */
  readonly declaredSources: readonly DeclaredSource[];
};

/** Every visible offering becomes a source; the lowest priority is the default. */
export async function resolveExistingOffering(tenantId: string): Promise<ExistingOffering | null> {
  const models = await getResolvedCatalog(tenantId);
  const offerings = models
    .flatMap((model) =>
      model.offerings.map((offering) => ({ ...offering, model: model.canonicalName })),
    )
    .sort((a, b) => a.priority - b.priority);
  const defaultSourceOfferingId = offerings[0]?.offeringId;
  if (defaultSourceOfferingId === undefined) return null;
  return {
    sourceOfferingIds: offerings.map((offering) => offering.offeringId),
    defaultSourceOfferingId,
    declaredSources: offerings.map((offering) => ({
      provider: offering.plugin,
      model: offering.model,
    })),
  };
}

export function ProviderConnectStep({
  tenantId,
  onConnected,
  onError,
}: {
  readonly tenantId: string;
  readonly onConnected: (offering: ExistingOffering) => void;
  readonly onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<ModelProviderPlugin>(
    PROVIDER_OPTIONS[0]?.plugin ?? "anthropic",
  );
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [modelName, setModelName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const option =
    PROVIDER_OPTIONS.find((candidate) => candidate.plugin === selected) ?? PROVIDER_OPTIONS[0];
  const isLocal = option?.local === true;
  const ready = isLocal
    ? baseURL.trim().length > 0 && modelName.trim().length > 0
    : apiKey.trim().length > 0;

  function selectOption(plugin: ModelProviderPlugin) {
    setSelected(plugin);
    const next = PROVIDER_OPTIONS.find((candidate) => candidate.plugin === plugin);
    setBaseURL(next?.local === true ? next.baseURL : "");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (option === undefined || !ready || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const canonicalName = isLocal ? modelName.trim() : option.canonicalName;
      const created = await shadowOffering(tenantId, {
        canonicalName,
        modelDisplayName: isLocal ? modelName.trim() : option.modelDisplayName,
        providerName: option.label,
        plugin: option.plugin,
        baseURL: isLocal ? baseURL.trim() : option.baseURL,
        apiKey: isLocal ? LOCAL_PLACEHOLDER_KEY : apiKey.trim(),
        priority: 0,
      });
      onConnected({
        sourceOfferingIds: [created.id],
        defaultSourceOfferingId: created.id,
        declaredSources: [{ provider: option.plugin, model: canonicalName }],
      });
    } catch (cause) {
      const refId = reportError(cause, {
        operation: "onboarding.connect-provider",
        tenantId,
      });
      onError(`${cause instanceof Error ? cause.message : String(cause)} (ref ${refId})`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="onboarding-credential-form" onSubmit={(event) => void handleSubmit(event)}>
      <RadioGroup
        name="provider"
        label="Inference provider"
        value={selected}
        onValueChange={(value) => selectOption(value as ModelProviderPlugin)}
      >
        {PROVIDER_OPTIONS.map((candidate) => (
          <RadioOption
            key={candidate.plugin}
            value={candidate.plugin}
            label={candidate.label}
            description={candidate.description}
          />
        ))}
      </RadioGroup>
      {isLocal ? (
        <>
          <label>
            Base URL
            <Input
              type="url"
              autoComplete="off"
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              required
            />
          </label>
          <label>
            Model
            <Input
              type="text"
              autoComplete="off"
              placeholder="qwen2.5:14b"
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              required
            />
          </label>
        </>
      ) : (
        <label>
          API key
          <Input
            type="password"
            autoComplete="off"
            placeholder={option?.keyHint}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required
          />
        </label>
      )}
      <Button type="submit" disabled={submitting || !ready}>
        {submitting ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}
