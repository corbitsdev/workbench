// The browser side of the first-login hook: one call against the
// hub's native onboarding route, made once per session. A session with
// zero principals anywhere gets a personal org provisioned server-side
// (see @workbench/onboarding); this just learns whether that happened
// so the interface can route into the onboarding placeholder — and
// distinguishes a real failure from "nothing to do", so a broken
// provisioning call never leaves the user silently orgless.

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
          "Unexpected provisioning response: a provisioned org is missing its tenant details.",
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
