// The browser side of the first-login hook: one call against the
// hub's native onboarding route, made once per session. A session with
// zero principals and no display name is reported as needs-onboarding so
// the UI can route into the naming wizard; only an explicit name creates
// the personal bench. Distinguishes real failures from "nothing to do",
// so a broken provisioning call never leaves the user silently benchless.

import { type } from "arktype";
import type { SupportedCredentialProvider } from "@workbench/hub-client/credential-test";

const ProvisionResult = type({
  kind: "'existing-member' | 'provisioned' | 'needs-onboarding'",
  "tenantId?": "string",
  "tenantSlug?": "string",
  "seeded?": "boolean",
  "seedSkipReason?": "string",
});

const ErrorEnvelope = type({
  error: { code: "string", message: "string" },
});

export type ProvisionOutcome =
  | {
      readonly kind: "existing-member";
      /**
       * Present only for the caller's own personal bench: `false` means
       * it still has no working inference credential (`bench_unseeded`)
       * and the credential step should stay open rather than read as
       * finished. Absent when membership is on some other tenant, whose
       * seed state this account has no say over.
       */
      readonly seeded?: boolean;
    }
  | { readonly kind: "needs-onboarding" }
  | {
      readonly kind: "provisioned";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly seeded: boolean;
      readonly seedSkipReason?: string;
    }
  | { readonly kind: "error"; readonly message: string };

export async function triggerFirstLoginProvisioning(
  displayName?: string,
): Promise<ProvisionOutcome> {
  try {
    const response = await fetch("/api/onboarding/provision", {
      method: "POST",
      ...(displayName !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: displayName }),
          }
        : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = ErrorEnvelope(body);
      return {
        kind: "error",
        message:
          envelope instanceof type.errors
            ? `The server answered ${response.status} while setting up your workbench.`
            : envelope.error.message,
      };
    }
    const parsed = ProvisionResult(body);
    if (parsed instanceof type.errors) {
      return {
        kind: "error",
        message: `Unexpected provisioning response shape: ${parsed.summary}`,
      };
    }
    if (parsed.kind === "existing-member") {
      return {
        kind: "existing-member",
        ...(parsed.seeded !== undefined ? { seeded: parsed.seeded } : {}),
      };
    }
    if (parsed.kind === "needs-onboarding") return { kind: "needs-onboarding" };
    if (
      parsed.tenantId === undefined ||
      parsed.tenantSlug === undefined ||
      parsed.seeded === undefined
    ) {
      return {
        kind: "error",
        message:
          "Unexpected provisioning response: a provisioned workbench is missing its details.",
      };
    }
    return {
      kind: "provisioned",
      tenantId: parsed.tenantId,
      tenantSlug: parsed.tenantSlug,
      seeded: parsed.seeded,
      ...(parsed.seedSkipReason !== undefined
        ? { seedSkipReason: parsed.seedSkipReason }
        : {}),
    };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export type CredentialProvider = SupportedCredentialProvider;

// The one-click paths: a plain navigation to the hub's connect route,
// which round-trips through the provider's consent page and lands back
// on /onboarding with the outcome in the query string.
export const OPENROUTER_CONNECT_START_PATH =
  "/api/onboarding/oauth/openrouter/start";
export const HUGGINGFACE_CONNECT_START_PATH =
  "/api/onboarding/oauth/huggingface/start";

export type ConnectReturn =
  | {
      readonly kind: "connected";
      readonly tenantSlug: string;
    }
  | { readonly kind: "error"; readonly message: string };

export type OpenRouterConnectReturn = ConnectReturn;

const OPENROUTER_CONNECT_ERROR_COPY: Readonly<Record<string, string>> = {
  state_expired:
    "The OpenRouter connection took too long or was already used. Start it again.",
  exchange_failed:
    "OpenRouter did not hand back a key for that connection. Try connecting again.",
  key_rejected:
    "OpenRouter minted a key, but its test call failed. Try connecting again.",
  no_bench:
    "No personal workbench was found for this account yet. Reload and try again.",
  setup_failed:
    "Your OpenRouter key checked out, but setting up your workbench failed. Try again in a moment.",
  signed_out:
    "Your session ended during the OpenRouter connection. Sign in and try again.",
  rate_limited:
    "OpenRouter limits how often it can create a new key. Wait a minute, then try connecting again.",
};

const HUGGINGFACE_CONNECT_ERROR_COPY: Readonly<Record<string, string>> = {
  state_expired:
    "The Hugging Face connection took too long or was already used. Start it again.",
  exchange_failed:
    "Hugging Face did not hand back a token for that connection. Try connecting again.",
  key_rejected:
    "Hugging Face minted a token, but its test call failed. Try connecting again.",
  no_bench:
    "No personal workbench was found for this account yet. Reload and try again.",
  setup_failed:
    "Your Hugging Face token checked out, but setting up your workbench failed. Try again in a moment.",
  signed_out:
    "Your session ended during the Hugging Face connection. Sign in and try again.",
  rate_limited:
    "Hugging Face limits how often it can create a new token. Wait a minute, then try connecting again.",
  not_configured:
    "Hugging Face connect isn't set up on this workbench yet. Paste a token instead.",
};

/**
 * Reads a connect round-trip's outcome out of the wizard's query string,
 * for the `connect=providerId` this provider's callback writes. The
 * parameters are hub-written but arrive through a redirect the browser
 * (or anyone) can replay, so they are treated as untrusted: anything
 * malformed collapses to an honest error, never a fabricated success.
 */
function readConnectReturn(
  search: string,
  providerId: string,
  providerLabel: string,
  errorCopy: Readonly<Record<string, string>>,
): ConnectReturn | null {
  const params = new URLSearchParams(search);
  if (params.get("connect") !== providerId) return null;
  const outcome = params.get("outcome");
  if (outcome === "connected") {
    const tenantSlug = params.get("tenantSlug");
    if (tenantSlug === null || tenantSlug === "") {
      return {
        kind: "error",
        message: `The ${providerLabel} connection finished but its result was incomplete. Try connecting again.`,
      };
    }
    return { kind: "connected", tenantSlug };
  }
  const code = params.get("code");
  return {
    kind: "error",
    message:
      (code !== null ? errorCopy[code] : undefined) ??
      `The ${providerLabel} connection did not finish. Try connecting again.`,
  };
}

export function readOpenRouterConnectReturn(
  search: string,
): ConnectReturn | null {
  return readConnectReturn(
    search,
    "openrouter",
    "OpenRouter",
    OPENROUTER_CONNECT_ERROR_COPY,
  );
}

export function readHuggingFaceConnectReturn(
  search: string,
): ConnectReturn | null {
  return readConnectReturn(
    search,
    "huggingface",
    "Hugging Face",
    HUGGINGFACE_CONNECT_ERROR_COPY,
  );
}

export type CredentialProviderCard = {
  readonly id: CredentialProvider;
  readonly label: string;
  /** One honest line of what picking this provider gets you — shown next
   * to the key field once it's selected, never a marketing pitch. */
  readonly description: string;
  readonly keyConsoleUrl: string;
  readonly keyHint: string;
};

/** The six the wizard leads with — the providers most people reach for
 * first. Order is deliberate and matches the card row left to right. */
export const PRIMARY_CREDENTIAL_PROVIDERS: readonly CredentialProviderCard[] = [
  {
    id: "openai",
    label: "OpenAI",
    description: "GPT models, direct from OpenAI.",
    keyConsoleUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude models, direct from Anthropic.",
    keyConsoleUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-",
  },
  {
    id: "google-genai",
    label: "Google",
    description: "Gemini models, direct from Google.",
    keyConsoleUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza",
  },
  {
    id: "xai",
    label: "xAI",
    description: "Grok models, direct from xAI.",
    keyConsoleUrl: "https://console.x.ai/team/default/api-keys",
    keyHint: "xai-",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "One key, many models — hundreds of models, one bill.",
    keyConsoleUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-",
  },
  {
    id: "opencode-zen",
    label: "Opencode Zen",
    description: "OpenCode's curated gateway of coding-agent-tested models.",
    keyConsoleUrl: "https://opencode.ai/auth",
    keyHint: "",
  },
];

/** The rest — still fully supported, just tucked behind the "More
 * providers" expander so the primary row stays to six cards. */
export const SECONDARY_CREDENTIAL_PROVIDERS: readonly CredentialProviderCard[] =
  [
    {
      id: "groq",
      label: "Groq",
      description: "Open models served at very high inference speed.",
      keyConsoleUrl: "https://console.groq.com/keys",
      keyHint: "gsk_",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      description: "DeepSeek's own models, direct from DeepSeek.",
      keyConsoleUrl: "https://platform.deepseek.com/api_keys",
      keyHint: "sk-",
    },
    {
      id: "mistral",
      label: "Mistral",
      description: "Mistral's own models, direct from Mistral.",
      keyConsoleUrl: "https://console.mistral.ai/api-keys",
      keyHint: "",
    },
    {
      id: "huggingface",
      label: "Hugging Face",
      description:
        "Pay-as-you-go across Groq, Together, Fireworks & more, billed to your HF account. A fine-grained access token (permission: Make calls to Inference Providers) never expires — the one-click connect above mints a token that does.",
      keyConsoleUrl: "https://huggingface.co/settings/tokens/new",
      keyHint: "hf_",
    },
  ];

/** Every provider card, primary row first — the flat list a lookup by id
 * (e.g. the active provider's description) reads from regardless of which
 * group renders it. */
export const CREDENTIAL_PROVIDERS: readonly CredentialProviderCard[] = [
  ...PRIMARY_CREDENTIAL_PROVIDERS,
  ...SECONDARY_CREDENTIAL_PROVIDERS,
];

const CredentialSeeded = type({
  kind: "'seeded'",
  "tenantId?": "string",
  tenantSlug: "string",
  workflows: "string[]",
});

export type CredentialOutcome =
  | {
      readonly kind: "seeded";
      /** Absent only for a response older than this field existing --
       * every current `/complete` response carries it. Consumers (the
       * onboarding wizard's optional "Connect your tools" phase) treat
       * a missing id as "skip that phase," never as an error. */
      readonly tenantId?: string;
      readonly tenantSlug: string;
      readonly workflows: string[];
    }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

async function postOnboarding(
  path: string,
  provider: CredentialProvider,
  apiKey: string,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(`/api/onboarding/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
  const body: unknown = await response.json().catch(() => null);
  return { response, body };
}

function readErrorEnvelope(
  status: number,
  body: unknown,
  verb: string,
): string {
  const envelope = ErrorEnvelope(body);
  return envelope instanceof type.errors
    ? `The server answered ${status} while ${verb}.`
    : envelope.error.message;
}

/**
 * Proves a user's own key with a real call through the hub, without
 * storing anything. Lets the wizard report success or a specific
 * rejection before committing to seeding the bench.
 */
export async function testCredential(
  provider: CredentialProvider,
  apiKey: string,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  try {
    const { response, body } = await postOnboarding(
      "credential/test",
      provider,
      apiKey,
    );
    if (!response.ok) {
      return {
        ok: false,
        message: readErrorEnvelope(response.status, body, "checking your key"),
      };
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Hands a user's own key to the hub, which proves it with a real call
 * before doing anything else with it, then seeds the caller's personal
 * bench and confirms every default routine answers. The credential
 * itself is stored through the hub's native `POST
 * /api/tenants/:id/credentials` route — this call only tells the hub
 * which provider and key to use, and reports the outcome. A rejected
 * key is reported by name (`"rejected"`) rather than folded into the
 * same `"error"` bucket a broken hub call gets — the retry story is
 * different for each.
 */
export async function submitCredential(
  provider: CredentialProvider,
  apiKey: string,
): Promise<CredentialOutcome> {
  try {
    const { response, body } = await postOnboarding(
      "complete",
      provider,
      apiKey,
    );
    if (!response.ok) {
      const message = readErrorEnvelope(
        response.status,
        body,
        "setting up your workbench",
      );
      return response.status === 422
        ? { kind: "rejected", message }
        : { kind: "error", message };
    }
    const parsed = CredentialSeeded(body);
    if (parsed instanceof type.errors) {
      return {
        kind: "error",
        message: `Unexpected credential response shape: ${parsed.summary}`,
      };
    }
    return {
      kind: "seeded",
      ...(parsed.tenantId !== undefined ? { tenantId: parsed.tenantId } : {}),
      tenantSlug: parsed.tenantSlug,
      workflows: parsed.workflows,
    };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

const CompleteSetupResult = type({
  kind: "'seeded' | 'unseeded'",
  "tenantId?": "string",
  "tenantSlug?": "string",
  "workflows?": "string[]",
});

export type CompleteSetupOutcome =
  | {
      readonly kind: "seeded";
      /** See `CredentialOutcome`'s own note on this field. */
      readonly tenantId?: string;
      readonly tenantSlug: string;
      readonly workflows: string[];
    }
  | { readonly kind: "unseeded" }
  | { readonly kind: "error"; readonly message: string };

/**
 * The follow-up call the wizard makes once it lands back from a
 * one-click connect: the OAuth callback itself only proved and stored
 * the key (fast, so the browser is never left waiting on a redirect),
 * and this is what actually deploys the default routines against it.
 * `"unseeded"` is not a failure — it means the workbench genuinely has
 * nothing to finish setting up with yet, and the wizard falls back to
 * the ordinary credential step rather than treating it as broken.
 */
export async function completeSetup(): Promise<CompleteSetupOutcome> {
  try {
    const response = await fetch("/api/onboarding/complete-setup", {
      method: "POST",
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        kind: "error",
        message: readErrorEnvelope(
          response.status,
          body,
          "finishing your workbench setup",
        ),
      };
    }
    const parsed = CompleteSetupResult(body);
    if (parsed instanceof type.errors) {
      return {
        kind: "error",
        message: `Unexpected setup response shape: ${parsed.summary}`,
      };
    }
    if (parsed.kind === "unseeded") return { kind: "unseeded" };
    if (parsed.tenantSlug === undefined || parsed.workflows === undefined) {
      return {
        kind: "error",
        message:
          "Unexpected setup response: a finished workbench is missing its details.",
      };
    }
    return {
      kind: "seeded",
      ...(parsed.tenantId !== undefined ? { tenantId: parsed.tenantId } : {}),
      tenantSlug: parsed.tenantSlug,
      workflows: parsed.workflows,
    };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
