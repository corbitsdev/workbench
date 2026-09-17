// The credential + model-offering step this onboarding page runs before
// installing Myra: connects a provider credential through the
// stock native credentials/providers routes (`@corbits/inference-settings`'
// `shadowOffering`), then derives the exactly-one offering it mints into
// `sourceOfferingIds`/`defaultSourceOfferingId` — no separate offering
// picker, because a freshly connected provider names exactly one model.
// A tenant that already resolves a catalog offering (inherited, or from
// an earlier run of this same step) skips this UI entirely: see
// `resolveExistingOffering` in `onboarding-page.tsx`.
import { Button, Input, RadioGroup, RadioOption } from "@corbits/react-ui";
import { getResolvedCatalog, shadowOffering } from "@corbits/inference-settings";
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
};

// Deliberately small: `ModelProviderPlugin` names the adapters this hub
// ships (`vendor/intx/types/src/catalog.ts`), and each option below picks
// one canonical model so connecting a provider mints exactly one
// offering — no second "which model" prompt (per the ruling,
// the flow asks only where a human input is genuinely required).
// Widening this list (more models per provider, an `openai-compatible`
// custom-baseURL card) is a follow-up, not a blocker for a working
// install.
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    plugin: "anthropic",
    label: "Anthropic",
    description: "Claude models, direct from Anthropic.",
    canonicalName: "claude-sonnet-4-5",
    modelDisplayName: "Claude Sonnet 4.5",
    baseURL: "https://api.anthropic.com",
    keyHint: "sk-ant-",
  },
  {
    plugin: "openai",
    label: "OpenAI",
    description: "GPT models, direct from OpenAI.",
    canonicalName: "gpt-5",
    modelDisplayName: "GPT-5",
    baseURL: "https://api.openai.com/v1",
    keyHint: "sk-",
  },
  {
    plugin: "google-genai",
    label: "Google",
    description: "Gemini models, direct from Google.",
    canonicalName: "gemini-2.5-pro",
    modelDisplayName: "Gemini 2.5 Pro",
    baseURL: "https://generativelanguage.googleapis.com",
    keyHint: "AIza",
  },
];

export type ExistingOffering = {
  readonly sourceOfferingIds: readonly string[];
  readonly defaultSourceOfferingId: string;
};

/** A tenant that already resolves a catalog offering (inherited from an
 * ancestor, or minted by an earlier run of this step) needs no UI at
 * all: every visible offering becomes `sourceOfferingIds`, and the
 * lowest-priority one is the default — the same rule
 * `resolveRealSourceOfferingIds` in the deleted onboarding package applies. */
export async function resolveExistingOffering(tenantId: string): Promise<ExistingOffering | null> {
  const models = await getResolvedCatalog(tenantId);
  const offerings = models
    .flatMap((model) => model.offerings)
    .sort((a, b) => a.priority - b.priority);
  const defaultSourceOfferingId = offerings[0]?.offeringId;
  if (defaultSourceOfferingId === undefined) return null;
  return {
    sourceOfferingIds: offerings.map((offering) => offering.offeringId),
    defaultSourceOfferingId,
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
  const [submitting, setSubmitting] = useState(false);

  const option =
    PROVIDER_OPTIONS.find((candidate) => candidate.plugin === selected) ?? PROVIDER_OPTIONS[0];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (option === undefined || apiKey.trim().length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const created = await shadowOffering(tenantId, {
        canonicalName: option.canonicalName,
        modelDisplayName: option.modelDisplayName,
        providerName: option.label,
        plugin: option.plugin,
        baseURL: option.baseURL,
        apiKey: apiKey.trim(),
        priority: 0,
      });
      onConnected({
        sourceOfferingIds: [created.id],
        defaultSourceOfferingId: created.id,
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
        onValueChange={(value) => setSelected(value as ModelProviderPlugin)}
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
      <Button type="submit" disabled={submitting || apiKey.trim().length === 0}>
        {submitting ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}
