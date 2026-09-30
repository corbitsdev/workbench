// Connects one provider credential through the stock catalog routes and
// derives the single offering it mints; a tenant that already resolves an
// offering skips this step (see `resolveExistingOffering`).
import { Button, Input, Select } from "@corbits/react-ui";
import { Cpu, Key, LinkSimple } from "@/lib/icons";
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
import { type } from "arktype";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import type { ModelProviderPlugin } from "@intx/types";

import { PROVIDER_MODELS } from "@/settings/provider-models";

import { fetchOllamaTags } from "./ollama-tags";
import "./provider-rows.css";

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
  /** An OpenAI-compatible relay: the model is typed in beside the key. */
  readonly typedModel?: boolean;
  /** The base URL is typed in too (Custom). */
  readonly customURL?: boolean;
};

const CUSTOM_MODEL = "__custom__";

// https everywhere; plain http only for a server on this machine.
const baseUrlSchema = type("string").narrow((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return ctx.mustBe("a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (url.protocol === "http:" && local)
    ? true
    : ctx.mustBe("an https URL (http only for localhost)");
});

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
    id: "openrouter",
    plugin: "openai-compatible",
    label: "OpenRouter",
    description: "Many models through one OpenRouter key.",
    canonicalName: "",
    modelDisplayName: "",
    baseURL: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-",
    local: false,
    typedModel: true,
  },
  {
    id: "custom",
    plugin: "openai-compatible",
    label: "Custom",
    description: "Any OpenAI-compatible endpoint: base URL, key, and model.",
    canonicalName: "",
    modelDisplayName: "",
    baseURL: "",
    keyHint: "",
    local: false,
    typedModel: true,
    customURL: true,
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
export async function resolveExistingOffering(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExistingOffering | null> {
  const models = await getResolvedCatalog(tenantId, fetchImpl);
  const offerings = models
    .flatMap((model) =>
      model.offerings.map((offering) => ({
        ...offering,
        model: model.canonicalName,
      })),
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
  onSkip,
}: {
  readonly tenantId: string;
  readonly onConnected: (offering: ExistingOffering) => void;
  readonly onError: (message: string) => void;
  /** Omitted outside onboarding: only the first-run flow can be skipped. */
  readonly onSkip?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [modelName, setModelName] = useState("");
  // "" = the provider's default (first listed); CUSTOM_MODEL = typed in.
  const [modelChoice, setModelChoice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loginId, setLoginId] = useState<string | null>(null);

  // No provider is preselected: the person chooses.
  const option = PROVIDER_OPTIONS.find((candidate) => candidate.id === selected);
  const isLocal = option?.local === true;
  const oauthProvider = option?.oauthProvider;
  const typedModel = option?.typedModel === true;
  const customURL = option?.customURL === true;
  const models = option === undefined ? [] : (PROVIDER_MODELS[option.id] ?? []);
  const listed = models.length > 0;
  const choice = modelChoice === "" ? (models[0]?.id ?? CUSTOM_MODEL) : modelChoice;
  const typedChoice = choice === CUSTOM_MODEL;
  // The model this option will mint: a listed pick, else the typed name.
  const resolvedModel =
    option === undefined
      ? ""
      : listed && !typedChoice
        ? choice
        : isLocal || typedModel || listed
          ? modelName.trim()
          : option.canonicalName;
  const resolvedLabel = models.find((model) => model.id === resolvedModel)?.label ?? resolvedModel;
  const urlCheck = baseUrlSchema(baseURL);
  const urlError = customURL && baseURL.trim() !== "" && urlCheck instanceof type.errors;

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
    option !== undefined &&
    resolvedModel !== "" &&
    (oauthProvider !== undefined ||
      (isLocal
        ? baseURL.trim().length > 0 && modelName.trim().length > 0 && modelKnown
        : typedModel
          ? apiKey.trim().length > 0 && (!customURL || !(urlCheck instanceof type.errors))
          : apiKey.trim().length > 0));

  function fail(cause: unknown, operation: string) {
    const refId = reportError(cause, { operation, tenantId });
    onError(`${cause instanceof Error ? cause.message : String(cause)} (ref ${refId})`);
  }

  function selectOption(id: string) {
    const next = PROVIDER_OPTIONS.find((candidate) => candidate.id === id);
    if (loginId !== null) {
      // Abandoning a login must free the fixed loopback port it holds.
      void cancelProviderLogin(tenantId, loginId).catch((cause: unknown) => {
        reportError(cause, {
          operation: "onboarding.cancel-provider-login",
          tenantId,
        });
      });
      setLoginId(null);
    }
    setSelected(id);
    setBaseURL(next?.local === true ? next.baseURL : "");
    setModelName("");
    setModelChoice("");
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
        canonicalName: resolvedModel,
        modelDisplayName: resolvedLabel,
        providerName: option.label,
        plugin: option.plugin,
        baseURL: option.baseURL,
        credential: { credentialId: state.credentialId },
        priority: 0,
      });
      return {
        status: "connected" as const,
        offering: offeringFromOption(option, resolvedModel, created.id),
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
      const canonicalName = resolvedModel;
      const created = await shadowOffering(tenantId, {
        canonicalName,
        modelDisplayName: resolvedLabel,
        providerName: option.label,
        plugin: option.plugin,
        baseURL: isLocal || customURL ? baseURL.trim() : option.baseURL,
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

  const modelPicker = listed ? (
    <>
      <label>
        Model
        <Select
          value={choice}
          aria-label="Model"
          onChange={(event) => setModelChoice(event.target.value)}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          <option value={CUSTOM_MODEL}>Custom…</option>
        </Select>
      </label>
      {typedChoice ? (
        <label>
          Custom model id
          <Input
            autoComplete="off"
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
            required
          />
        </label>
      ) : null}
    </>
  ) : (
    <label>
      Model
      <Input
        autoComplete="off"
        value={modelName}
        onChange={(event) => setModelName(event.target.value)}
        required
      />
    </label>
  );

  return (
    <form className="onboarding-credential-form" onSubmit={(event) => void handleSubmit(event)}>
      {/* Native radios until react-ui ships its RadioGroup again. */}
      <fieldset role="radiogroup" className="onboarding-provider-group">
        <legend>Inference provider</legend>
        {PROVIDER_OPTIONS.map((candidate) => {
          const rowId = `provider-${candidate.id}`;
          const RowIcon = candidate.local
            ? Cpu
            : candidate.oauthProvider !== undefined
              ? LinkSimple
              : Key;
          return (
            <div key={candidate.id} className="onboarding-provider-row">
              <input
                type="radio"
                name="provider"
                id={rowId}
                value={candidate.id}
                checked={selected === candidate.id}
                onChange={() => selectOption(candidate.id)}
                aria-describedby={`${rowId}-desc`}
              />
              <span className="onboarding-provider-icon" aria-hidden="true">
                <RowIcon size={16} />
              </span>
              <label htmlFor={rowId} className="onboarding-provider-text">
                <span className="onboarding-provider-name">{candidate.label}</span>
                <span id={`${rowId}-desc`} className="onboarding-provider-desc">
                  {candidate.description}
                </span>
              </label>
            </div>
          );
        })}
      </fieldset>
      {option === undefined ? null : oauthProvider !== undefined ? (
        <>
          {modelPicker}
          <p>
            {waiting
              ? "Finish signing in on the tab that opened, then come back here."
              : "A new tab opens to sign in. Your workbench stores the result; no key to paste."}
          </p>
        </>
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
        <>
          {customURL ? (
            <label>
              Base URL
              <Input
                type="url"
                autoComplete="off"
                placeholder="https://"
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                required
              />
            </label>
          ) : null}
          {urlError ? (
            <p className="onboarding-inline-error" role="alert">
              The base URL must be an https URL (http only for localhost).
            </p>
          ) : null}
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
          {typedModel || listed ? modelPicker : null}
        </>
      )}
      <div className="onboarding-actions">
        <Button type="submit" variant="primary" disabled={submitting || waiting || !ready}>
          {submitLabel}
        </Button>
        {onSkip === undefined ? null : (
          <Button type="button" variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        )}
      </div>
    </form>
  );
}
