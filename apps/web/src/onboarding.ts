// The browser side of the first-login hook: one call against the
// hub's native onboarding route, made once per session. A session with
// zero principals and no display name is reported as needs-onboarding so
// the UI can route into the naming wizard; only an explicit name creates
// the personal bench. Distinguishes real failures from "nothing to do",
// so a broken provisioning call never leaves the user silently benchless.

import { type } from "arktype";

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
  | { readonly kind: "existing-member" }
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
            ? `The hub answered ${response.status} while setting up your workbench.`
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
    if (parsed.kind === "existing-member") return { kind: "existing-member" };
    if (parsed.kind === "needs-onboarding") return { kind: "needs-onboarding" };
    if (
      parsed.tenantId === undefined ||
      parsed.tenantSlug === undefined ||
      parsed.seeded === undefined
    ) {
      return {
        kind: "error",
        message:
          "Unexpected provisioning response: a provisioned bench is missing its tenant details.",
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

export type CredentialProvider =
  | "anthropic"
  | "openai"
  | "google-genai"
  | "openrouter"
  | "opencode-zen"
  | "groq"
  | "deepseek"
  | "mistral";

export const CREDENTIAL_PROVIDERS: readonly {
  readonly id: CredentialProvider;
  readonly label: string;
  /** One honest line of what picking this provider gets you — shown next
   * to the key field once it's selected, never a marketing pitch. */
  readonly description: string;
  readonly keyConsoleUrl: string;
  readonly keyHint: string;
}[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude models, direct from Anthropic.",
    keyConsoleUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "GPT models, direct from OpenAI.",
    keyConsoleUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-",
  },
  {
    id: "google-genai",
    label: "Google",
    description: "Gemini models, direct from Google.",
    keyConsoleUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza",
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
];

const CredentialSeeded = type({
  kind: "'seeded'",
  tenantSlug: "string",
  workflows: "string[]",
});

export type CredentialOutcome =
  | {
      readonly kind: "seeded";
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
    ? `The hub answered ${status} while ${verb}.`
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
        "setting up your bench",
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
