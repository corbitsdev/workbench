// The browser side of the first-login hook: one call against the
// hub's native onboarding route, made once per session. A session with
// zero principals anywhere gets a personal bench provisioned server-side
// (see @workbench/onboarding); this just learns whether that happened
// so the interface can route into the onboarding placeholder — and
// distinguishes a real failure from "nothing to do", so a broken
// provisioning call never leaves the user silently benchless.

import { type } from "arktype";

const ProvisionResult = type({
  kind: "'existing-member' | 'provisioned'",
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
  | {
      readonly kind: "provisioned";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly seeded: boolean;
      readonly seedSkipReason?: string;
    }
  | { readonly kind: "error"; readonly message: string };

export async function triggerFirstLoginProvisioning(): Promise<ProvisionOutcome> {
  try {
    const response = await fetch("/api/onboarding/provision", {
      method: "POST",
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

/**
 * Hands a user's own Anthropic key to the hub, which proves it with a
 * real call before doing anything else with it, then seeds the
 * caller's personal bench and confirms every default routine answers.
 * A rejected key is reported by name (`"rejected"`) rather than folded
 * into the same `"error"` bucket a broken hub call gets — the retry
 * story is different for each.
 */
export async function submitCredential(
  apiKey: string,
): Promise<CredentialOutcome> {
  try {
    const response = await fetch("/api/onboarding/credential", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = ErrorEnvelope(body);
      const message =
        envelope instanceof type.errors
          ? `The hub answered ${response.status} while checking your key.`
          : envelope.error.message;
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
