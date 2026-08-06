// The browser side of the first-login hook: one call against the
// hub's native onboarding route, made once per session. A session with
// zero principals anywhere gets a personal org provisioned server-side
// (see @workbench/onboarding); this just learns whether that happened
// so the interface can route into the onboarding placeholder.

import { type } from "arktype";

const ProvisionResult = type({
  kind: "'existing-member' | 'provisioned'",
  "tenantId?": "string",
  "tenantSlug?": "string",
  "seeded?": "boolean",
  "seedSkipReason?": "string",
});

export type ProvisionResult = typeof ProvisionResult.infer;

export async function triggerFirstLoginProvisioning(): Promise<ProvisionResult | null> {
  try {
    const response = await fetch("/api/onboarding/provision", {
      method: "POST",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const parsed = ProvisionResult(body);
    return parsed instanceof type.errors ? null : parsed;
  } catch {
    return null;
  }
}
