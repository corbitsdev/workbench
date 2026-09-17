// The convergence driver: diff the client's needs-list against a stock
// Interchange hub, then execute the minimal stock-API sequence that makes
// the hub match. Reads use the native tenants/principals routes only
// (`GET /api/me/principals`, `GET /api/tenants/:id`,
// `GET /api/tenants/:id/principals`); writes are stock hub routes only
// (`POST /api/tenants`, `POST /api/tenants/:id/members/invite`,
// `POST /api/tenants/:id/workflows/deployments`). No workbench,
// onboarding, or chat routes — the driver stays portable to nearly any
// hub by default. All hub access goes through the StockHub port so tests
// (and previews) run against doubles, never a live hub.

import { type } from "arktype";

import type { NeedsList } from "./needs-list";

export type HubTenant = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
};

export type HubPrincipal = {
  id: string;
  tenantId: string;
  kind: string;
  refId: string;
  email?: string;
  status: string;
  roles: string[];
};

export type MyMembership = {
  principalId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  kind: string;
  status: string;
  roles: { id: string; name: string }[];
};

export type HubSnapshot = {
  myPrincipals: MyMembership[];
  tenantsById: Record<string, HubTenant>;
  principalsByTenant: Record<string, HubPrincipal[]>;
};

export type ConvergeOp =
  | {
      kind: "create-tenant";
      slug: string;
      name: string;
      parentSlug: string | null;
    }
  | { kind: "invite-member"; tenantSlug: string; email: string }
  | { kind: "deploy-agent"; tenantSlug: string; definitionRefId: string };

export type StockHub = {
  listMyPrincipals(): Promise<MyMembership[]>;
  getTenant(id: string): Promise<HubTenant | null>;
  listPrincipals(tenantId: string): Promise<HubPrincipal[]>;
  createTenant(input: {
    name: string;
    slug: string;
    parentId?: string;
  }): Promise<HubTenant>;
  inviteMember(tenantId: string, input: { email: string }): Promise<void>;
  deployAgent(
    tenantId: string,
    input: { definitionRefId: string; deploy?: unknown },
  ): Promise<void>;
};

/**
 * Reads the hub state the diff needs, fanning out over the native
 * tenants/principals routes: my memberships first, then each visible
 * tenant plus its principals.
 */
export async function readHubSnapshot(
  hub: StockHub,
  _manifest: NeedsList,
): Promise<HubSnapshot> {
  const myPrincipals = await hub.listMyPrincipals();
  const tenantIds = [...new Set(myPrincipals.map((row) => row.tenantId))];
  const tenantsById: Record<string, HubTenant> = {};
  const principalsByTenant: Record<string, HubPrincipal[]> = {};
  for (const tenantId of tenantIds) {
    const [tenant, principals] = await Promise.all([
      hub.getTenant(tenantId),
      hub.listPrincipals(tenantId),
    ]);
    if (tenant !== null) tenantsById[tenant.id] = tenant;
    principalsByTenant[tenantId] = principals;
  }
  return { myPrincipals, tenantsById, principalsByTenant };
}

function tenantIdForSlug(snapshot: HubSnapshot, slug: string): string | null {
  for (const tenant of Object.values(snapshot.tenantsById)) {
    if (tenant.slug === slug) return tenant.id;
  }
  return null;
}

function activePrincipal(
  principals: HubPrincipal[] | undefined,
  match: (principal: HubPrincipal) => boolean,
): HubPrincipal | null {
  const found = (principals ?? []).find(
    (principal) => principal.status === "active" && match(principal),
  );
  return found ?? null;
}

/**
 * Diffs desired (manifest) against observed (snapshot) and returns the
 * minimal op sequence, ordered so parents exist before children: the
 * primary tenant, the Myra agent at top level, then each workbench with
 * its members and shares. Pure — no hub calls.
 */
export function diffNeedsList(
  manifest: NeedsList,
  snapshot: HubSnapshot,
): ConvergeOp[] {
  const ops: ConvergeOp[] = [];
  const primaryId = tenantIdForSlug(snapshot, manifest.primaryTenant.slug);

  if (primaryId === null) {
    ops.push({
      kind: "create-tenant",
      slug: manifest.primaryTenant.slug,
      name: manifest.primaryTenant.name,
      parentSlug: null,
    });
  }
  const primaryPrincipals =
    primaryId === null ? [] : snapshot.principalsByTenant[primaryId];

  const myraRunning =
    activePrincipal(
      primaryPrincipals,
      (principal) =>
        principal.kind === "workflow" &&
        principal.refId === manifest.myra.definitionRefId,
    ) !== null;
  if (!myraRunning) {
    ops.push({
      kind: "deploy-agent",
      tenantSlug: manifest.primaryTenant.slug,
      definitionRefId: manifest.myra.definitionRefId,
    });
  }

  for (const workbench of manifest.workbenches) {
    const workbenchId =
      primaryId === null
        ? null
        : (Object.values(snapshot.tenantsById).find(
            (tenant) =>
              tenant.slug === workbench.slug && tenant.parentId === primaryId,
          )?.id ??
          manifest.createdWorkbenchTenantIds
            .map((id) => snapshot.tenantsById[id])
            .find((tenant) => tenant?.slug === workbench.slug)?.id ??
          null);
    if (workbenchId === null) {
      ops.push({
        kind: "create-tenant",
        slug: workbench.slug,
        name: workbench.name,
        parentSlug: manifest.primaryTenant.slug,
      });
    }
    const observed =
      workbenchId === null ? [] : snapshot.principalsByTenant[workbenchId];
    for (const member of workbench.members) {
      const present =
        activePrincipal(
          observed,
          (principal) =>
            principal.kind === "user" && principal.refId === member.refId,
        ) !== null;
      if (!present && member.email !== undefined) {
        ops.push({
          kind: "invite-member",
          tenantSlug: workbench.slug,
          email: member.email,
        });
      }
    }
    const sharesByWorkbench = manifest.shares.filter(
      (share) => share.workbenchSlug === workbench.slug,
    );
    for (const share of sharesByWorkbench) {
      const present =
        activePrincipal(
          observed,
          (principal) =>
            principal.kind === "user" &&
            principal.email?.toLowerCase() === share.email.toLowerCase(),
        ) !== null;
      if (!present) {
        ops.push({
          kind: "invite-member",
          tenantSlug: workbench.slug,
          email: share.email,
        });
      }
    }
  }
  return ops;
}

export type ConvergeReport = {
  ops: ConvergeOp[];
  applied: ConvergeOp[];
};

export type ConvergeOptions = {
  /**
   * Resolves the stock deploy body (asset source, entry, offerings) for
   * the Myra definition ref. The driver cannot invent hub-specific
   * deploy values from a bare refId, so the app layer supplies them;
   * without a resolver the fetch hub refuses the op rather than posting
   * a guessed body. `tenantId` is included (alongside `tenantSlug`)
   * because resolving a real deploy body means reading the tenant's own
   * catalog, which only exists once the tenant does — synchronous or
   * async, either is accepted.
   */
  resolveAgentDeploy?: (op: {
    tenantId: string;
    tenantSlug: string;
    definitionRefId: string;
  }) => unknown | Promise<unknown>;
};

/**
 * Converges the hub toward the manifest: read (unless a snapshot is
 * supplied), diff, then execute each op against stock APIs in order. A
 * supplied snapshot skips the reads entirely — the caller already looked.
 */
export async function convergeNeedsList(
  manifest: NeedsList,
  hub: StockHub,
  snapshot?: HubSnapshot,
  options?: ConvergeOptions,
): Promise<ConvergeReport> {
  const observed = snapshot ?? (await readHubSnapshot(hub, manifest));
  const ops = diffNeedsList(manifest, observed);
  const tenantIds = new Map<string, string>(
    Object.values(observed.tenantsById).map((tenant): [string, string] => [
      tenant.slug,
      tenant.id,
    ]),
  );
  const applied: ConvergeOp[] = [];
  for (const op of ops) {
    if (op.kind === "create-tenant") {
      const parentId =
        op.parentSlug === null
          ? undefined
          : tenantIds.get(op.parentSlug) !== undefined
            ? { parentId: tenantIds.get(op.parentSlug) as string }
            : {};
      const created = await hub.createTenant({
        name: op.name,
        slug: op.slug,
        ...parentId,
      });
      tenantIds.set(op.slug, created.id);
      applied.push(op);
      continue;
    }
    const tenantId = tenantIds.get(op.tenantSlug);
    if (tenantId === undefined) continue;
    if (op.kind === "invite-member") {
      await hub.inviteMember(tenantId, { email: op.email });
      applied.push(op);
      continue;
    }
    await hub.deployAgent(tenantId, {
      definitionRefId: op.definitionRefId,
      deploy: await options?.resolveAgentDeploy?.({
        tenantId,
        tenantSlug: op.tenantSlug,
        definitionRefId: op.definitionRefId,
      }),
    });
    applied.push(op);
  }
  return { ops, applied };
}

const TenantShape = type({
  id: "string",
  name: "string",
  slug: "string",
  "parentId?": "string | null",
});

const MembershipShape = type({
  principalId: "string",
  tenantId: "string",
  tenantName: "string",
  tenantSlug: "string",
  kind: "string",
  status: "string",
  roles: type({ id: "string", name: "string" }).array(),
});

const TenantPrincipalShape = type({
  id: "string",
  tenantId: "string",
  kind: "string",
  refId: "string",
  "email?": "string",
  status: "string",
  roles: "string[]",
});

const MembershipPageShape = type({
  data: MembershipShape.array(),
  nextCursor: "string | null",
});

const TenantPrincipalPageShape = type({
  data: TenantPrincipalShape.array(),
  nextCursor: "string | null",
});

async function readJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`stock hub ${what} failed: HTTP ${response.status}`);
  }
  return (await response.json()) as unknown;
}

function tenantOf(value: unknown, what: string): HubTenant {
  const parsed = TenantShape(value);
  if (parsed instanceof type.errors) {
    throw new Error(`stock hub ${what} shape changed: ${parsed.summary}`);
  }
  return {
    id: parsed.id,
    name: parsed.name,
    slug: parsed.slug,
    parentId: parsed.parentId ?? null,
  };
}

/**
 * Builds the StockHub port on fetch over stock hub routes only. The
 * optional fetch defaults to global fetch; pass a double in tests. The
 * deploy op posts the caller-resolved stock body — without
 * resolveAgentDeploy it throws rather than guessing hub-specific deploy
 * values.
 */
export function createFetchStockHub(
  fetchImpl: typeof fetch = fetch,
  options?: ConvergeOptions,
): StockHub {
  return {
    async listMyPrincipals() {
      const body = await readJson(
        await fetchImpl("/api/me/principals"),
        "listMyPrincipals",
      );
      const parsed = MembershipPageShape(body);
      if (parsed instanceof type.errors) {
        throw new Error(
          `stock hub principals shape changed: ${parsed.summary}`,
        );
      }
      return parsed.data.map((row) => ({
        principalId: row.principalId,
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        tenantSlug: row.tenantSlug,
        kind: row.kind,
        status: row.status,
        roles: row.roles.map((role) => ({ id: role.id, name: role.name })),
      }));
    },
    async getTenant(id) {
      const response = await fetchImpl(
        `/api/tenants/${encodeURIComponent(id)}`,
      );
      if (response.status === 404) return null;
      return tenantOf(await readJson(response, "getTenant"), "getTenant");
    },
    async listPrincipals(tenantId) {
      const body = await readJson(
        await fetchImpl(
          `/api/tenants/${encodeURIComponent(tenantId)}/principals?limit=100`,
        ),
        "listPrincipals",
      );
      const parsed = TenantPrincipalPageShape(body);
      if (parsed instanceof type.errors) {
        throw new Error(
          `stock hub tenant principals shape changed: ${parsed.summary}`,
        );
      }
      return parsed.data.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        kind: row.kind,
        refId: row.refId,
        ...(row.email === undefined ? {} : { email: row.email }),
        status: row.status,
        roles: [...row.roles],
      }));
    },
    async createTenant(input) {
      const body = await readJson(
        await fetchImpl("/api/tenants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            slug: input.slug,
            ...(input.parentId === undefined
              ? {}
              : { parentId: input.parentId }),
          }),
        }),
        "createTenant",
      );
      return tenantOf(body, "createTenant");
    },
    async inviteMember(tenantId, input) {
      await readJson(
        await fetchImpl(
          `/api/tenants/${encodeURIComponent(tenantId)}/members/invite`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: input.email }),
          },
        ),
        "inviteMember",
      );
    },
    async deployAgent(tenantId, input) {
      const deploy =
        input.deploy ??
        (await options?.resolveAgentDeploy?.({
          tenantId,
          tenantSlug: tenantId,
          definitionRefId: input.definitionRefId,
        }));
      if (deploy === undefined) {
        throw new Error(
          `stock hub deployAgent needs a caller-resolved deploy body for definition ${input.definitionRefId}`,
        );
      }
      await readJson(
        await fetchImpl(
          `/api/tenants/${encodeURIComponent(tenantId)}/workflows/deployments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(deploy),
          },
        ),
        "deployAgent",
      );
    },
  };
}
