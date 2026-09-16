import { type } from "arktype";

import type {
  ChildTenantStore,
  NeedsList,
  WorkflowDeployInput,
} from "./needs-list";

export type HubTenant = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
};

export type HubRole = { id: string; name: string };

export type HubPrincipal = {
  id: string;
  tenantId: string;
  kind: string;
  refId: string;
  displayName: string;
  email?: string;
  status: string;
  roles: HubRole[];
};

export type MyMembership = {
  principalId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  kind: string;
  status: string;
  roles: HubRole[];
};

export type StockHub = {
  listMyPrincipals(): Promise<MyMembership[]>;
  getTenant(id: string): Promise<HubTenant | null>;
  listPrincipals(tenantId: string): Promise<HubPrincipal[]>;
  createTenant(input: {
    name: string;
    slug: string;
    parentId: string;
  }): Promise<HubTenant>;
  inviteMember(tenantId: string, input: { email: string }): Promise<void>;
  deployWorkflow(tenantId: string, input: WorkflowDeployInput): Promise<void>;
};

export type HubSnapshot = {
  primaryTenant: HubTenant;
  primaryPrincipals: HubPrincipal[];
  childTenants: HubTenant[];
  childPrincipals: Record<string, HubPrincipal[]>;
};

export type DesiredDirectMessage = {
  kind: "chat";
  localId: string;
  name: string;
  workflowRefId: string;
};

export type StockHubCapability =
  | "primary-tenant-bootstrap"
  | "deploy-workflow-inputs"
  | "project-workflow-principal"
  | "principal-roles";

export class StockHubCapabilityError extends Error {
  readonly code = "stock-capability-missing" as const;

  constructor(
    readonly capability: StockHubCapability,
    message: string,
  ) {
    super(message);
    this.name = "StockHubCapabilityError";
  }
}

export class StockHubRequestError extends Error {
  readonly code = "stock-hub-request-failed" as const;

  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "StockHubRequestError";
  }
}

export async function readHubSnapshot(hub: StockHub): Promise<HubSnapshot> {
  const memberships = await hub.listMyPrincipals();
  const activeOwned = memberships.filter(
    (membership) =>
      membership.kind === "user" &&
      membership.status === "active" &&
      membership.roles.some((role) => role.name === "owner"),
  );
  const tenants = (
    await Promise.all(
      activeOwned.map((membership) => hub.getTenant(membership.tenantId)),
    )
  ).filter((tenant): tenant is HubTenant => tenant !== null);
  const primaryCandidates = tenants.filter(
    (tenant) => tenant.parentId === null,
  );
  const [primaryTenant] = primaryCandidates;
  if (primaryCandidates.length !== 1 || primaryTenant === undefined) {
    throw new StockHubCapabilityError(
      "primary-tenant-bootstrap",
      `Sign-in must leave exactly one owned top-level home; found ${primaryCandidates.length}.`,
    );
  }
  const childTenants = tenants.filter(
    (tenant) => tenant.parentId === primaryTenant.id,
  );
  const [primaryPrincipals, childRows] = await Promise.all([
    hub.listPrincipals(primaryTenant.id),
    Promise.all(
      childTenants.map(
        async (tenant) =>
          [tenant.id, await hub.listPrincipals(tenant.id)] as const,
      ),
    ),
  ]);
  return {
    primaryTenant,
    primaryPrincipals,
    childTenants,
    childPrincipals: Object.fromEntries(childRows),
  };
}

export function deriveDesiredDirectMessages(
  snapshot: HubSnapshot,
): DesiredDirectMessage[] {
  const byRefId = new Map<string, DesiredDirectMessage>();
  for (const principal of snapshot.primaryPrincipals) {
    if (principal.kind !== "workflow" || principal.status !== "active")
      continue;
    if (byRefId.has(principal.refId)) continue;
    byRefId.set(principal.refId, {
      kind: "chat",
      localId: `dm:${principal.refId}`,
      name: principal.displayName,
      workflowRefId: principal.refId,
    });
  }
  return [...byRefId.values()];
}

function hasMyra(manifest: NeedsList, snapshot: HubSnapshot): boolean {
  const expected = manifest.myra.definitionRefId.toLowerCase();
  return snapshot.primaryPrincipals.some(
    (principal) =>
      principal.kind === "workflow" &&
      principal.status === "active" &&
      (principal.refId === manifest.myra.definitionRefId ||
        principal.displayName.toLowerCase() === expected ||
        principal.displayName.toLowerCase() === "myra"),
  );
}

function directMessageExists(
  desired: DesiredDirectMessage,
  snapshot: HubSnapshot,
  store: ChildTenantStore,
): boolean {
  const record = store
    .load()
    .find(
      (candidate) =>
        candidate.localId === desired.localId && candidate.kind === "chat",
    );
  if (record === undefined) return false;
  const tenant = snapshot.childTenants.find(
    (candidate) => candidate.id === record.tenantId,
  );
  if (tenant === undefined || tenant.parentId !== snapshot.primaryTenant.id) {
    return false;
  }
  return (snapshot.childPrincipals[tenant.id] ?? []).some(
    (principal) =>
      principal.kind === "workflow" &&
      principal.status === "active" &&
      principal.refId === desired.workflowRefId,
  );
}

export type ConvergeReport = {
  primaryTenantId: string;
  createdTenantIds: string[];
  directMessages: DesiredDirectMessage[];
};

export async function convergeNeedsList(
  manifest: NeedsList,
  hub: StockHub,
  store: ChildTenantStore,
  suppliedSnapshot?: HubSnapshot,
): Promise<ConvergeReport> {
  const snapshot = suppliedSnapshot ?? (await readHubSnapshot(hub));
  const directMessages = deriveDesiredDirectMessages(snapshot);

  if (!hasMyra(manifest, snapshot) && manifest.myra.deploy === undefined) {
    throw new StockHubCapabilityError(
      "deploy-workflow-inputs",
      "Myra is absent and the client was not supplied the exact stock workflow source and offering ids.",
    );
  }

  const missingDirectMessage = directMessages.find(
    (desired) => !directMessageExists(desired, snapshot, store),
  );
  if (missingDirectMessage !== undefined) {
    throw new StockHubCapabilityError(
      "project-workflow-principal",
      `Stock Interchange cannot carry workflow ${missingDirectMessage.workflowRefId} into a child room by refId; no DM was created.`,
    );
  }

  for (const workbench of manifest.workbenches) {
    for (const principal of workbench.principals) {
      if (principal.kind === "workflow") {
        throw new StockHubCapabilityError(
          "project-workflow-principal",
          `Stock Interchange cannot carry workflow ${principal.refId} into a child room by refId.`,
        );
      }
      if (principal.roles.some((role) => role !== "member")) {
        throw new StockHubCapabilityError(
          "principal-roles",
          "The stock member invite route cannot assign the requested child-room roles.",
        );
      }
      if (principal.email === undefined) {
        throw new StockHubCapabilityError(
          "project-workflow-principal",
          `The stock member invite route cannot project user ${principal.refId} without an email address.`,
        );
      }
    }
  }

  if (!hasMyra(manifest, snapshot) && manifest.myra.deploy !== undefined) {
    await hub.deployWorkflow(snapshot.primaryTenant.id, manifest.myra.deploy);
  }

  const createdTenantIds: string[] = [];
  for (const workbench of manifest.workbenches) {
    const existingRecord = store
      .load()
      .find((record) => record.localId === workbench.localId);
    const existing = snapshot.childTenants.find(
      (tenant) => tenant.id === existingRecord?.tenantId,
    );
    if (existing !== undefined) continue;
    const created = await hub.createTenant({
      name: workbench.name,
      slug: workbench.slug,
      parentId: snapshot.primaryTenant.id,
    });
    store.record({
      localId: workbench.localId,
      tenantId: created.id,
      kind: "workbench",
    });
    createdTenantIds.push(created.id);
    for (const principal of workbench.principals) {
      if (principal.email !== undefined) {
        await hub.inviteMember(created.id, { email: principal.email });
      }
    }
  }

  return {
    primaryTenantId: snapshot.primaryTenant.id,
    createdTenantIds,
    directMessages,
  };
}

const TenantShape = type({
  id: "string",
  name: "string",
  slug: "string",
  "parentId?": "string | null",
});
const RoleShape = type({ id: "string", name: "string" });
const MembershipPageShape = type({
  data: type({
    principalId: "string",
    tenantId: "string",
    tenantName: "string",
    tenantSlug: "string",
    kind: "string",
    status: "string",
    roles: RoleShape.array(),
  }).array(),
  nextCursor: "string | null",
});
const PrincipalPageShape = type({
  data: type({
    id: "string",
    tenantId: "string",
    kind: "string",
    refId: "string",
    displayName: "string",
    "email?": "string",
    status: "string",
    roles: RoleShape.array(),
  }).array(),
  nextCursor: "string | null",
});

async function readJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok) {
    throw new StockHubRequestError(
      operation,
      response.status,
      `Stock request ${operation} failed with HTTP ${response.status}.`,
    );
  }
  return (await response.json()) as unknown;
}

function parseBoundary<T>(
  validator: (value: unknown) => T | type.errors,
  value: unknown,
  operation: string,
): T {
  const parsed = validator(value);
  if (parsed instanceof type.errors) {
    throw new StockHubRequestError(
      operation,
      undefined,
      `Stock request ${operation} returned an unexpected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Follows every page of a `{ data, nextCursor }` stock listing — the hub
 * caps pages at its own limit, so reading only the first page would
 * silently mistarget accounts past ~100 principals or memberships. */
async function fetchAllPages<T>(
  fetchImpl: typeof fetch,
  basePath: string,
  operation: string,
  parsePage: (body: unknown) => { data: T[]; nextCursor: string | null },
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const path =
      cursor === null
        ? `${basePath}?limit=100`
        : `${basePath}?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const page = parsePage(await readJson(await fetchImpl(path), operation));
    rows.push(...page.data);
    if (page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
}

export function createFetchStockHub(fetchImpl: typeof fetch = fetch): StockHub {
  return {
    async listMyPrincipals() {
      return fetchAllPages(
        fetchImpl,
        "/api/me/principals",
        "listMyPrincipals",
        (body) => parseBoundary(MembershipPageShape, body, "listMyPrincipals"),
      );
    },
    async getTenant(id) {
      const response = await fetchImpl(
        `/api/tenants/${encodeURIComponent(id)}`,
      );
      if (response.status === 404) return null;
      const parsed = parseBoundary(
        TenantShape,
        await readJson(response, "getTenant"),
        "getTenant",
      );
      return { ...parsed, parentId: parsed.parentId ?? null };
    },
    async listPrincipals(tenantId) {
      return fetchAllPages(
        fetchImpl,
        `/api/tenants/${encodeURIComponent(tenantId)}/principals`,
        "listPrincipals",
        (body) => parseBoundary(PrincipalPageShape, body, "listPrincipals"),
      );
    },
    async createTenant(input) {
      const body = await readJson(
        await fetchImpl("/api/tenants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
        "createTenant",
      );
      const parsed = parseBoundary(TenantShape, body, "createTenant");
      return { ...parsed, parentId: parsed.parentId ?? null };
    },
    async inviteMember(tenantId, input) {
      await readJson(
        await fetchImpl(
          `/api/tenants/${encodeURIComponent(tenantId)}/members/invite`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
        "inviteMember",
      );
    },
    async deployWorkflow(tenantId, input) {
      await readJson(
        await fetchImpl(
          `/api/tenants/${encodeURIComponent(tenantId)}/workflows/deployments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
        "deployWorkflow",
      );
    },
  };
}
