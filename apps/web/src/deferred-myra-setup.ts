// Finishes the setup a skipped provider step left undone, once a model
// exists: the same publish-and-install the onboarding page runs.

import { reportError } from "@corbits/error-sink";

import { runPortableClientBootstrap } from "./client-bootstrap";
import { deployMyraSource } from "./myra-deploy";
import { createFetchStockHub, findOwnedTenants } from "./needs-converge";
import { resolveExistingOffering } from "./onboarding/provider-connect-step";
import { isProviderSkipped, setProviderSkipped } from "./provider-skip";
import type { SessionUser } from "./session";

let inFlight: Promise<boolean> | null = null;

/** True once Myra is deployed and the skip flag is cleared; false while
 * there is nothing to do yet (no skip, or no model connected). */
export function finishDeferredMyraSetup(user: SessionUser): Promise<boolean> {
  if (!isProviderSkipped(user.id)) return Promise.resolve(false);
  inFlight ??= run(user).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(user: SessionUser): Promise<boolean> {
  try {
    const owned = await findOwnedTenants(createFetchStockHub());
    const primary = owned.find((tenant) => tenant.parentId === null);
    if (primary === undefined) return false;
    const offering = await resolveExistingOffering(primary.id);
    if (offering === null) return false;
    const myraDeploy = await deployMyraSource({
      tenantId: primary.id,
      tenantDomain: primary.domain,
      sourceOfferingIds: offering.sourceOfferingIds,
      defaultSourceOfferingId: offering.defaultSourceOfferingId,
      declaredSources: offering.declaredSources,
    });
    const result = await runPortableClientBootstrap(user, { myraDeploy });
    if (result.kind !== "ready") return false;
    setProviderSkipped(user.id, false);
    return true;
  } catch (cause) {
    reportError(cause, { operation: "deferred_myra_setup" });
    return false;
  }
}
