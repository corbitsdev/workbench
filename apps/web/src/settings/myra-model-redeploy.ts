// A credential edit that changes "the model" swaps in a new offering
// (`mintOfferingForModel`) while the old one stays alive — a deployed
// Myra run pins `sourceOfferingIds` in its stock launch spec and the
// allocation service re-resolves by those exact ids, so the old offering
// can only be retired once a redeploy has moved Myra onto the new one.
// This is the same stock deploy path the client runs at onboarding
// (`myra-deploy.ts`'s `deployMyraSource`, `POST /workflows/deployments`),
// just re-run here with one offering id swapped for another.

import { type } from "arktype";

import { deployMyraSource } from "@/myra-deploy";
import { resolveExistingOffering, type DeclaredSource } from "@/onboarding/provider-connect-step";
import type { ModelProviderPlugin } from "@intx/types";

export class MyraRedeployError extends Error {}

const TenantDomainShape = type({ domain: "string" });

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

async function resolveTenantDomain(tenantId: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}`);
  if (!response.ok) {
    throw new MyraRedeployError(
      `resolving this workbench's domain failed: ${await readErrorBody(response)}`,
    );
  }
  const parsed = TenantDomainShape(await response.json());
  if (parsed instanceof type.errors) {
    throw new MyraRedeployError(`this workbench came back an unexpected shape: ${parsed.summary}`);
  }
  return parsed.domain;
}

export type RedeployForModelChangeInput = {
  readonly tenantId: string;
  readonly oldOfferingId: string;
  readonly newOfferingId: string;
  readonly provider: ModelProviderPlugin;
  readonly newCanonicalName: string;
};

type ExistingOffering = Awaited<ReturnType<typeof resolveExistingOffering>>;

/** The pure swap at this module's center: everything Myra already
 * declares, with exactly the old offering id (and its declared source)
 * replaced by the new one, order and every other source untouched. `null`
 * when the old offering id isn't declared at all — nothing pins it, so
 * there is nothing to swap. */
export function swapDeclaredOffering(
  before: NonNullable<ExistingOffering>,
  oldOfferingId: string,
  newOfferingId: string,
  provider: ModelProviderPlugin,
  newCanonicalName: string,
): {
  sourceOfferingIds: readonly string[];
  defaultSourceOfferingId: string;
  declaredSources: readonly DeclaredSource[];
} | null {
  const index = before.sourceOfferingIds.indexOf(oldOfferingId);
  if (index === -1) return null;
  return {
    sourceOfferingIds: before.sourceOfferingIds.map((id) =>
      id === oldOfferingId ? newOfferingId : id,
    ),
    defaultSourceOfferingId:
      before.defaultSourceOfferingId === oldOfferingId
        ? newOfferingId
        : before.defaultSourceOfferingId,
    declaredSources: before.declaredSources.map((source, position) =>
      position === index ? { provider, model: newCanonicalName } : source,
    ),
  };
}

/**
 * Redeploys Myra so her declared sources point at `newOfferingId` instead
 * of `oldOfferingId`, everything else in the fallback chain unchanged.
 * Returns `false` (does nothing) when Myra isn't declaring the old
 * offering at all — nothing pins it, so the caller can retire it directly
 * — and throws, changing nothing about which offering is declared, if the
 * redeploy itself fails; the caller must leave both offerings in that case.
 */
export async function redeployMyraForModelChange(
  input: RedeployForModelChangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const before = await resolveExistingOffering(input.tenantId, fetchImpl);
  if (before === null) return false;
  const swapped = swapDeclaredOffering(
    before,
    input.oldOfferingId,
    input.newOfferingId,
    input.provider,
    input.newCanonicalName,
  );
  if (swapped === null) return false;

  const tenantDomain = await resolveTenantDomain(input.tenantId, fetchImpl);
  const deploy = await deployMyraSource(
    { tenantId: input.tenantId, tenantDomain, ...swapped },
    fetchImpl,
  );
  const deployed = await fetchImpl(
    `/api/tenants/${encodeURIComponent(input.tenantId)}/workflows/deployments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deploy),
    },
  );
  if (!deployed.ok) {
    throw new MyraRedeployError(
      `redeploying Myra onto the new model failed: ${await readErrorBody(deployed)}`,
    );
  }
  return true;
}
