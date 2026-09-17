// Resolves the stock deploy body the needs-list converge driver
// (needs-converge.ts) needs to bring Myra up on a tenant: the tenant's
// own resolved `assistant` workflow asset, read from its catalog
// (inherited included) rather than invented client-side. Browser-safe —
// stock `/api/tenants/:id/assets` reads only, never `@corbits/seeding`
// or any other server-only package.

export const MYRA_DEFINITION_REF_ID = "assistant";

type WorkflowAsset = { readonly id: string; readonly name: string };

/**
 * Finds the tenant's resolved `assistant` workflow asset and returns the
 * stock `POST .../workflows/deployments` body for it. `undefined` when
 * the tenant's catalog carries no such asset yet — nothing this client
 * can deploy against; the caller (needs-converge) then refuses the op
 * rather than guessing a body. The `needs-converge.ts` `resolveAgentDeploy`
 * shape — accepts and ignores `tenantSlug`/`definitionRefId`, since this
 * resolver only ever supplies the one Myra deploy.
 */
export async function resolveMyraDeployBody(op: {
  readonly tenantId: string;
}): Promise<unknown | undefined> {
  const { tenantId } = op;
  const response = await fetch(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=workflow&inherited=true`,
  );
  if (!response.ok) return undefined;
  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) return undefined;
  const asset = body.find(
    (row): row is WorkflowAsset =>
      typeof row === "object" &&
      row !== null &&
      "id" in row &&
      "name" in row &&
      typeof (row as WorkflowAsset).id === "string" &&
      (row as WorkflowAsset).name === MYRA_DEFINITION_REF_ID,
  );
  if (asset === undefined) return undefined;
  return { definitionAssetId: asset.id, confirmDeployments: false };
}
