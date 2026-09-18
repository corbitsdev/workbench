// Connects one provider credential through the stock catalog routes and
// derives the single offering it mints; a tenant that already resolves an
// offering skips this step (see `resolveExistingOffering`).
import { Button, Input, RadioGroup, RadioOption, Select } from "@corbits/react-ui";
import {
  cancelProviderLogin,
  credentialNameFor,
  ensureProviderRow,
  getResolvedCatalog,
  readProviderLogin,
  shadowOffering,
  startProviderLogin,
} from "@/settings/inference";
import { reportError } from "@corbits/error-sink";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import type { ModelProviderPlugin } from "@intx/types";

import { fetchOllamaTags } from "./ollama-tags";

export type ProviderOption = {
  /** Stable option id: two OAuth providers share one plugin, so the plugin
   * cannot identify a row on its own. */
  readonly id: string;
  readonly plugin: ModelProviderPlugin;
  readonly label: string;
  readonly description: string;
  readonly canonicalName: string;
  readonly modelDisplayName: string;
  readonly baseURL: string;
  readonly keyHint: string;
  /** A server on this machine: base URL and model are typed in, no key needed. */
  readonly local: boolean;
  /** Set when this provider signs in instead of taking a key: the name the
   * hub registered its OAuth login under. */
  readonly oauthProvider?: string;
};

// Each hosted option names one canonical model so connecting mints exactly
// one offering and the flow never asks "which model".
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    id: "anthropic",
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
    id: "openai",
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
    id: "google-genai",
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
    id: "codex",
    plugin: "openai-responses",
    label: "Codex",
    description: "GPT models on your ChatGPT subscription. Sign in, no key.",
    canonicalName: "gpt-5.5",
    modelDisplayName: "GPT-5.5 (Codex)",
    // The ChatGPT backend the subscription token authenticates against —
    // not platform.openai.com, which only takes API keys.
    baseURL: "https://chatgpt.com/backend-api",
    keyHint: "",
    local: false,
    oauthProvider: "codex",
  },
  {
    id: "xai",
    plugin: "openai-responses",
    label: "xAI",
    description: "Grok models on your xAI account. Sign in, no key.",
    canonicalName: "grok-4.6",
    modelDisplayName: "Grok 4.6 (xAI)",
    // The grok-cli chat proxy; api.x.ai rejects these tokens outright.
    baseURL: "https://cli-chat-proxy.grok.com/v1",
    keyHint: "",
    local: false,
    oauthProvider: "xai",
  },
  {
    id: "ollama",
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

/** An offering minted from exactly one option: one credential, one model. */
function offeringFromOption(option: ProviderOption, canonicalName: string, id: string) {
  return {
    sourceOfferingIds: [id],
    defaultSourceOfferingId: id,
    declaredSources: [{ provider: option.plugin, model: canonicalName }],
  } satisfies ExistingOffering;
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
  const [selected, setSelected] = useState<string>(PROVIDER_OPTIONS[0]?.id ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [modelName, setModelName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loginId, setLoginId] = useState<string | null>(null);

  const option =
    PROVIDER_OPTIONS.find((candidate) => candidate.id === selected) ?? PROVIDER_OPTIONS[0];
  const isLocal = option?.local === true;
  const oauthProvider = option?.oauthProvider;

  // Fetched straight from the browser to the user-supplied base URL — this
  // never touches the hub. Validates the base URL is actually an Ollama
  // server and offers exactly the models it has pulled, so a fresh local
  // setup can't name a model Ollama doesn't have.
  const tagsQuery = useQuery({
    queryKey: ["onboarding", "ollama-tags", baseURL.trim()],
    queryFn: () => fetchOllamaTags(baseURL),
    enabled: isLocal && baseURL.trim().length > 0,
    retry: false,
    staleTime: 10_000,
  });
  const tags = tagsQuery.data ?? [];
  const modelKnown = !isLocal || tags.includes(modelName);

  const ready =
    oauthProvider !== undefined ||
    (isLocal
      ? baseURL.trim().length > 0 && modelName.trim().length > 0 && modelKnown
      : apiKey.trim().length > 0);

  function fail(cause: unknown, operation: string) {
    const refId = reportError(cause, { operation, tenantId });
    onError(`${cause instanceof Error ? cause.message : String(cause)} (ref ${refId})`);
  }

  function selectOption(id: string) {
    const next = PROVIDER_OPTIONS.find((candidate) => candidate.id === id);
    if (loginId !== null) {
      // Abandoning a login must free the fixed loopback port it holds.
      void cancelProviderLogin(tenantId, loginId).catch((cause: unknown) => {
        reportError(cause, { operation: "onboarding.cancel-provider-login", tenantId });
      });
      setLoginId(null);
    }
    setSelected(id);
    setBaseURL(next?.local === true ? next.baseURL : "");
    setModelName("");
  }

  // Starting a login is the hub's job end to end: it runs the loopback PKCE
  // flow and stores the tokens, and hands back only a URL to open.
  const startLogin = useMutation({
    mutationFn: async (target: { option: ProviderOption; provider: string }) => {
      const providerId = await ensureProviderRow(tenantId, {
        providerName: target.option.label,
        plugin: target.option.plugin,
        baseURL: target.option.baseURL,
      });
      return startProviderLogin(tenantId, {
        provider: target.provider,
        providerId,
        credentialName: credentialNameFor(target.option.label),
      });
    },
    onSuccess: (started) => {
      setLoginId(started.loginId);
      window.open(started.authorizeUrl, "_blank", "noopener,noreferrer");
    },
    onError: (cause: unknown) => {
      fail(cause, "onboarding.start-provider-login");
    },
  });

  // Polls the login the hub is hosting and, the moment it lands, mints the
  // offering over the credential the hub stored — the same catalog chain
  // the API-key path walks, differing only in where the secret came from.
  const login = useQuery({
    queryKey: ["onboarding", "oauth-login", tenantId, loginId],
    enabled: loginId !== null && option !== undefined,
    queryFn: async () => {
      if (loginId === null || option === undefined) throw new Error("no login in flight");
      const state = await readProviderLogin(tenantId, loginId);
      if (state.status !== "completed") return state;
      const created = await shadowOffering(tenantId, {
        canonicalName: option.canonicalName,
        modelDisplayName: option.modelDisplayName,
        providerName: option.label,
        plugin: option.plugin,
        baseURL: option.baseURL,
        credential: { credentialId: state.credentialId },
        priority: 0,
      });
      return {
        status: "connected" as const,
        offering: offeringFromOption(option, option.canonicalName, created.id),
      };
    },
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2000 : false),
  });

  const loginState = login.data;
  const loginError = login.error;

  // Handing the finished offering to the parent is the only thing left, and
  // it is a callback, not a fetch — every hub call above is a query.
  useEffect(() => {
    if (loginState?.status === "connected") onConnected(loginState.offering);
  }, [loginState, onConnected]);

  useEffect(() => {
    if (loginError !== null) fail(loginError, "onboarding.provider-login");
    // `fail` closes over props that are stable for this step's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginError]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (option === undefined || !ready || submitting) {
      return;
    }
    if (oauthProvider !== undefined) {
      startLogin.mutate({ option, provider: oauthProvider });
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
        credential: { apiKey: isLocal ? LOCAL_PLACEHOLDER_KEY : apiKey.trim() },
        priority: 0,
      });
      onConnected(offeringFromOption(option, canonicalName, created.id));
    } catch (cause) {
      fail(cause, "onboarding.connect-provider");
    } finally {
      setSubmitting(false);
    }
  }

  const waiting = startLogin.isPending || loginState?.status === "pending";
  const submitLabel =
    oauthProvider !== undefined
      ? waiting
        ? "Waiting for sign-in…"
        : `Continue with ${option?.label ?? ""}`
      : submitting
        ? "Connecting…"
        : "Connect";

  return (
    <form className="onboarding-credential-form" onSubmit={(event) => void handleSubmit(event)}>
      <RadioGroup
        name="provider"
        label="Inference provider"
        value={selected}
        onValueChange={selectOption}
      >
        {PROVIDER_OPTIONS.map((candidate) => (
          <RadioOption
            key={candidate.id}
            value={candidate.id}
            label={candidate.label}
            description={candidate.description}
          />
        ))}
      </RadioGroup>
      {oauthProvider !== undefined ? (
        <p>
          {waiting
            ? "Finish signing in on the tab that opened, then come back here."
            : "A new tab opens to sign in. Your workbench stores the result; no key to paste."}
        </p>
      ) : isLocal ? (
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
            <Select
              value={modelName}
              aria-label="Model"
              disabled={tagsQuery.isFetching || tags.length === 0}
              onChange={(event) => setModelName(event.target.value)}
            >
              <option value="">
                {tagsQuery.isFetching
                  ? "Checking Ollama…"
                  : tags.length === 0
                    ? "No models found"
                    : "Select a model…"}
              </option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </Select>
          </label>
          {tagsQuery.isError ? (
            <p className="onboarding-inline-error" role="alert">
              {tagsQuery.error instanceof Error ? tagsQuery.error.message : String(tagsQuery.error)}
            </p>
          ) : null}
          {!tagsQuery.isError && modelName !== "" && !modelKnown ? (
            <p className="onboarding-inline-error" role="alert">
              {modelName} is not one of the models Ollama reports at this base URL.
            </p>
          ) : null}
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
      <Button type="submit" disabled={submitting || waiting || !ready}>
        {submitLabel}
      </Button>
    </form>
  );
}
