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

export type MyraDeployOutcome =
  | { readonly kind: "deployed" }
  | { readonly kind: "already-running" }
  | { readonly kind: "pending"; readonly reason: string };

type DeploymentRow = {
  readonly definitionAssetId: string;
  readonly status: string;
};

function isDeploymentRow(row: unknown): row is DeploymentRow {
  return (
    typeof row === "object" &&
    row !== null &&
    "definitionAssetId" in row &&
    typeof (row as DeploymentRow).definitionAssetId === "string" &&
    "status" in row &&
    typeof (row as DeploymentRow).status === "string"
  );
}

/** A deployment that will never become live — replacing it is the only way
 * Myra gets up. Anything else on the asset (deployed, deploying, queued)
 * counts as running and is left alone. */
function isTerminalDeploymentStatus(status: string): boolean {
  return status === "released" || status === "failed";
}

/**
 * Brings Myra up on an already-seeded tenant over stock routes: resolve
 * the `assistant` asset from the tenant's own catalog, skip the post when
 * a live deployment of it already exists, replace it when only a terminal
 * (released/failed) one does. A catalog with no `assistant` asset yet is
 * an expected pending — the credential seed hasn't landed — never an
 * error and never a blind deploy. A deployments list that cannot be read
 * throws: posting without knowing what is live would duplicate runners.
 */
export async function ensureMyraDeployed(
  tenantId: string,
): Promise<MyraDeployOutcome> {
  const encoded = encodeURIComponent(tenantId);
  const deploy = await resolveMyraDeployBody({ tenantId });
  if (deploy === undefined) {
    return {
      kind: "pending",
      reason: "the tenant catalog has no assistant asset yet",
    };
  }
  if (
    typeof deploy !== "object" ||
    deploy === null ||
    !("definitionAssetId" in deploy) ||
    typeof (deploy as { definitionAssetId: unknown }).definitionAssetId !==
      "string"
  ) {
    throw new Error("myra: the resolved body has no workflow id");
  }
  const definitionAssetId = (deploy as { definitionAssetId: string })
    .definitionAssetId;
  const listed = await fetch(`/api/tenants/${encoded}/workflows/deployments`);
  if (!listed.ok) {
    throw new Error(`myra: listing workflows failed: HTTP ${listed.status}`);
  }
  const existing: unknown = await listed.json().catch(() => null);
  if (!Array.isArray(existing)) {
    throw new Error("myra: the workflows answer was not a list");
  }
  const live = existing
    .filter(isDeploymentRow)
    .some(
      (row) =>
        row.definitionAssetId === definitionAssetId &&
        !isTerminalDeploymentStatus(row.status),
    );
  if (live) return { kind: "already-running" };
  const posted = await fetch(`/api/tenants/${encoded}/workflows/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deploy),
  });
  if (!posted.ok) {
    throw new Error(
      `myra: starting the assistant failed: HTTP ${posted.status}`,
    );
  }
  return { kind: "deployed" };
}

type MembershipRow = {
  readonly tenantId: string;
  readonly tenantSlug: string;
};

function isMembershipRow(row: unknown): row is MembershipRow {
  return (
    typeof row === "object" &&
    row !== null &&
    "tenantId" in row &&
    typeof (row as MembershipRow).tenantId === "string" &&
    "tenantSlug" in row &&
    typeof (row as MembershipRow).tenantSlug === "string"
  );
}

/**
 * Finds the tenant id for a manifest slug by walking the account's own
 * cursor-paged membership — the older `/complete` answers carry no tenant
 * id, only the slug. `null` when the account holds no such membership.
 */
export async function resolveTenantIdForSlug(
  tenantSlug: string,
): Promise<string | null> {
  let cursor: string | null = null;
  for (;;) {
    const response = await fetch(
      cursor === null
        ? "/api/me/principals"
        : `/api/me/principals?cursor=${encodeURIComponent(cursor)}`,
    );
    if (!response.ok) {
      throw new Error(
        `myra: listing memberships failed: HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body !== "object" ||
      body === null ||
      !("data" in body) ||
      !Array.isArray((body as { data: unknown }).data)
    ) {
      throw new Error("myra: the memberships answer was not a page");
    }
    const page = body as {
      readonly data: unknown[];
      readonly nextCursor?: unknown;
    };
    for (const row of page.data) {
      if (isMembershipRow(row) && row.tenantSlug === tenantSlug) {
        return row.tenantId;
      }
    }
    const next = typeof page.nextCursor === "string" ? page.nextCursor : null;
    if (next === null) return null;
    cursor = next;
  }
}

/**
 * The post-credential trigger: once the credential step has seeded the
 * catalog, the client itself retries the deploy that genesis had to leave
 * pending. Prefers the outcome's own tenant id; an older answer without
 * one resolves it from the slug. An unresolvable slug is pending, not a
 * crash — the tenant genuinely is not there yet.
 */
export async function driveMyraDeployAfterCredential(input: {
  readonly tenantId?: string | undefined;
  readonly tenantSlug: string;
}): Promise<MyraDeployOutcome> {
  const tenantId =
    input.tenantId ?? (await resolveTenantIdForSlug(input.tenantSlug));
  if (tenantId === null) {
    return {
      kind: "pending",
      reason: `no membership on tenant slug ${input.tenantSlug}`,
    };
  }
  return ensureMyraDeployed(tenantId);
}
