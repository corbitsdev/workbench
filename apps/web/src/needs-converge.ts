// Convergence for the portable client manifest: stock writes only, after
// gap checks. Group workbench creation sequence per workbench: stock
// `POST /api/tenants { parentId }` → send the primary-thread first message
// (the workbench's chat, only when the caller supplied its exact content)
// → fork sub-threads as needed via `forkSubThread`. DMs are never created
// here — they derive from participant-filtered threads over stock mail
// snapshots the caller supplies, via `deriveDmThreads` in threads.ts.
//
// Creation idempotency rides native Message-IDs the hub stamps and returns:
// the primary thread id is recorded on the child-tenant row and fork links
// in the thread store, beside created ids — never a custom key. Reads stay
// stock routes (mailbox list); writes stay stock routes (tenant create,
// member invite, workflow deploy, run-mail send). Per-agent mailbox search
// and full thread reads stay typed upstream gaps until the hub exposes
// stock routes for them.

import { type } from "arktype";

import { MYRA_SOURCE_CONFIG } from "./myra-source";
import {
  childTenantStore,
  threadLinkStore,
  type ChildTenantStore,
  type NeedsList,
  type StringStorage,
  type WorkflowDeployInput,
} from "./needs-list";
import {
  buildForkReference,
  deriveDmThreads,
  deriveThreads,
  type DmThread,
  type Thread,
  type ThreadMessage,
} from "./threads";

export type HubTenant = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  domain: string;
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

/** One stock `conversation.message` row: the native Message-ID plus the
 * threading headers thread derivation reads (In-Reply-To, References,
 * List-ID) and the To/Cc membership set. */
export type MailMessage = ThreadMessage & {
  runId?: string;
};

export type SendRunMailInput = {
  tenantId: string;
  runId?: string;
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  body: string;
  /** Native fork ancestry for a sub-thread first message. */
  headers?: {
    inReplyTo?: string;
    references?: readonly string[];
  };
};

export type StockHub = {
  listMyPrincipals(): Promise<MyMembership[]>;
  getTenant(id: string): Promise<HubTenant | null>;
  listPrincipals(tenantId: string): Promise<HubPrincipal[]>;
  /** Omitting `parentId` mints a top-level tenant with the caller as its
   * owner — the stock route the first-signup installer step uses to
   * create the primary tenant; a workbench child tenant always supplies
   * it. */
  createTenant(input: { name: string; slug: string; parentId?: string }): Promise<HubTenant>;
  /**
   * Invites by email and assigns `role` (a system role name, e.g.
   * "member") in the same op — the stock invite route's `roleId` is the
   * only way an invited principal gets any grant at all; without it the
   * principal lands with zero roles and every subsequent read 403s
   * (/ fix).
   */
  inviteMember(tenantId: string, input: { email: string; role: string }): Promise<void>;
  deployWorkflow(tenantId: string, input: WorkflowDeployInput): Promise<void>;
  /** Whether a live (non-released, non-failed) deployment is anchored to
   * the tenant's `workflow` asset of that name. Stock mints a deployment's
   * principal only at its first run, so this is the deploy-time truth. */
  hasWorkflowDeployment(tenantId: string, assetName: string): Promise<boolean>;
  sendRunMail(input: SendRunMailInput): Promise<{ messageId: string }>;
  listRunMail(input: { tenantId: string }): Promise<MailMessage[]>;
  /** Stock per-agent mailbox search: participant-filtered thread derivation
   * reads through this once the hub exposes a stock route for it. */
  searchAgentMailbox(input: { address: string }): Promise<MailMessage[]>;
  /** Stock full thread read: sub-thread fork context reads through this
   * once the hub exposes a stock route for it. */
  readMailThread(input: { messageId: string }): Promise<MailMessage[]>;
};

export type HubSnapshot = {
  primaryTenant: HubTenant;
  myraDeployed: boolean;
  primaryPrincipals: HubPrincipal[];
  childTenants: HubTenant[];
  childPrincipals: Record<string, HubPrincipal[]>;
};

export type PrimaryThread = {
  tenantId: string;
  rootMessageId: string;
  subThreads: Thread[];
};

export type StockHubCapability =
  | "primary-tenant-bootstrap"
  | "deploy-workflow-inputs"
  | "project-workflow-principal"
  | "principal-roles"
  | "agent-mailbox-reads"
  | "thread-fork-context";

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

/** Every tenant the signed-in user owns (active `owner` role), regardless
 * of whether it is a top-level home or a workbench child — the shared
 * read behind both the primary-tenant gap check and the first-signup
 * installer's "does a primary tenant already exist" probe. */
export async function findOwnedTenants(hub: StockHub): Promise<HubTenant[]> {
  const memberships = await hub.listMyPrincipals();
  const activeOwned = memberships.filter(
    (membership) =>
      membership.kind === "user" &&
      membership.status === "active" &&
      membership.roles.some((role) => role.name === "owner"),
  );
  return (
    await Promise.all(activeOwned.map((membership) => hub.getTenant(membership.tenantId)))
  ).filter((tenant): tenant is HubTenant => tenant !== null);
}

export async function readHubSnapshot(hub: StockHub): Promise<HubSnapshot> {
  const tenants = await findOwnedTenants(hub);
  const primaryCandidates = tenants.filter((tenant) => tenant.parentId === null);
  const [primaryTenant] = primaryCandidates;
  if (primaryCandidates.length !== 1 || primaryTenant === undefined) {
    throw new StockHubCapabilityError(
      "primary-tenant-bootstrap",
      `Sign-in must leave exactly one owned top-level home; found ${primaryCandidates.length}.`,
    );
  }
  const childTenants = tenants.filter((tenant) => tenant.parentId === primaryTenant.id);
  const [primaryPrincipals, childRows, myraDeployed] = await Promise.all([
    hub.listPrincipals(primaryTenant.id),
    Promise.all(
      childTenants.map(async (tenant) => [tenant.id, await hub.listPrincipals(tenant.id)] as const),
    ),
    hub.hasWorkflowDeployment(primaryTenant.id, MYRA_SOURCE_CONFIG.assetName),
  ]);
  return {
    primaryTenant,
    myraDeployed,
    primaryPrincipals,
    childTenants,
    childPrincipals: Object.fromEntries(childRows),
  };
}

function hasMyra(_manifest: NeedsList, snapshot: HubSnapshot): boolean {
  return snapshot.myraDeployed;
}

export type ConvergeReport = {
  primaryTenantId: string;
  createdTenantIds: string[];
  /** DMs derived from participant-filtered threads — never tenants. */
  directMessages: DmThread[];
  primaryThreads: PrimaryThread[];
};

/** Ensures the group workbench child tenant exists (stock `POST
 * /api/tenants { parentId }` when the stored id no longer resolves) and
 * invites its email members. Returns the converged tenant id, whether it
 * was just created, and its stored record. */
async function convergeWorkbenchTenant(
  hub: StockHub,
  store: ChildTenantStore,
  snapshot: HubSnapshot,
  workbench: NeedsList["workbenches"][number],
): Promise<{ tenantId: string; created: boolean }> {
  const stored = store.load().find((row) => row.localId === workbench.localId);
  const existing = snapshot.childTenants.find((tenant) => tenant.id === stored?.tenantId);
  if (existing !== undefined && stored !== undefined) {
    return { tenantId: existing.id, created: false };
  }
  const created = await hub.createTenant({
    name: workbench.name,
    slug: workbench.slug,
    parentId: snapshot.primaryTenant.id,
  });
  store.record({
    ...(stored ?? {}),
    localId: workbench.localId,
    tenantId: created.id,
    kind: "workbench",
  });
  for (const principal of workbench.principals) {
    if (principal.email !== undefined) {
      await hub.inviteMember(created.id, {
        email: principal.email,
        role: principal.roles[0] ?? "member",
      });
    }
  }
  return { tenantId: created.id, created: true };
}

/** Sends the workbench's primary-thread first message — the workbench's
 * chat — exactly when the caller supplied its content and no native
 * Message-ID is recorded yet. A recorded id means the send already
 * happened: never resend, never mint a custom key. */
async function convergePrimaryThread(
  hub: StockHub,
  store: ChildTenantStore,
  workbench: NeedsList["workbenches"][number],
  tenantId: string,
): Promise<void> {
  const stored = store.load().find((row) => row.localId === workbench.localId);
  if (stored?.primaryThreadMessageId !== undefined) return;
  if (workbench.initialMessage === undefined) return;
  const sent = await hub.sendRunMail({
    tenantId,
    runId: workbench.initialMessage.runId,
    to: workbench.principals.flatMap((principal) =>
      principal.email === undefined ? [] : [principal.email],
    ),
    subject: workbench.name,
    body: workbench.initialMessage.content,
  });
  store.record({
    ...(stored ?? {}),
    localId: workbench.localId,
    tenantId,
    kind: "workbench",
    primaryThreadMessageId: sent.messageId,
  });
}

export async function convergeNeedsList(
  manifest: NeedsList,
  hub: StockHub,
  store: ChildTenantStore,
  suppliedSnapshot?: HubSnapshot,
  directMail: readonly ThreadMessage[] = [],
): Promise<ConvergeReport> {
  const snapshot = suppliedSnapshot ?? (await readHubSnapshot(hub));

  // Gap checks first: nothing is written until every need is satisfiable.
  if (!hasMyra(manifest, snapshot) && manifest.myra.deploy === undefined) {
    throw new StockHubCapabilityError(
      "deploy-workflow-inputs",
      "Myra is absent and the client was not supplied the exact stock workflow source and offering ids.",
    );
  }

  for (const workbench of manifest.workbenches) {
    for (const principal of workbench.principals) {
      if (principal.kind === "workflow") {
        throw new StockHubCapabilityError(
          "project-workflow-principal",
          `Stock Interchange cannot carry workflow ${principal.refId} into a child workbench by refId.`,
        );
      }
      if (principal.roles.some((role) => role !== "member")) {
        throw new StockHubCapabilityError(
          "principal-roles",
          "The stock member invite route cannot assign the requested child-workbench roles.",
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

  // Writes after gap checks, in needs-list order: child tenant, then its
  // primary-thread first message.
  const createdTenantIds: string[] = [];
  for (const workbench of manifest.workbenches) {
    const converged = await convergeWorkbenchTenant(hub, store, snapshot, workbench);
    if (converged.created) createdTenantIds.push(converged.tenantId);
    await convergePrimaryThread(hub, store, workbench, converged.tenantId);
  }

  // Reads stay stock routes: split each workbench mailbox into its primary
  // thread (first conversation.message sent in the child tenant, or the
  // recorded primary id) plus forked sub-threads.
  const primaryThreads: PrimaryThread[] = [];
  for (const workbench of manifest.workbenches) {
    const stored = store.load().find((row) => row.localId === workbench.localId);
    if (stored === undefined) continue;
    const mail = await hub.listRunMail({ tenantId: stored.tenantId });
    const grouped = deriveThreads(mail);
    // Ordering assumption: the stock mailbox list returns rows oldest-first,
    // so mail[0] is the primary-thread first message. The recorded
    // primaryThreadMessageId (written at send time) is authoritative and this
    // fallback only covers mail sent before the id was recorded; if the hub
    // ever returns newest-first or unordered rows, the root mistargets and
    // the real sub-threads misclassify — until the hub documents ordering,
    // prefer the recorded id.
    const rootMessageId = stored.primaryThreadMessageId ?? mail[0]?.messageId;
    if (rootMessageId === undefined) continue;
    primaryThreads.push({
      tenantId: stored.tenantId,
      rootMessageId,
      subThreads: grouped.filter((thread) => thread.rootMessageId !== rootMessageId),
    });
  }

  return {
    primaryTenantId: snapshot.primaryTenant.id,
    createdTenantIds,
    directMessages: deriveDmThreads(directMail, [manifest.account.email]),
    primaryThreads,
  };
}

export type ForkSubThreadParent = {
  workbenchLocalId: string;
  tenantId: string;
  messageId: string;
  references?: readonly string[];
};

export type ForkSubThreadInput = {
  to: readonly string[];
  subject: string;
  body: string;
};

/** Forks a sub-thread off a primary-thread message: the fork ancestry
 * (parent as In-Reply-To closing the References chain) rides the sent
 * first message natively, and the linkage is recorded in the client-held
 * thread store beside created ids. A fork already recorded for the same
 * parent + subject + recipients + body returns its native Message-ID
 * instead of resending; any of those differing (including an edited body)
 * sends anew. Rows recorded before recipients/body were stored match on
 * parent + subject only, preserving their exactly-once replay. */
export async function forkSubThread(
  storage: StringStorage,
  hub: StockHub,
  hubScope: string,
  accountId: string,
  parent: ForkSubThreadParent,
  input: ForkSubThreadInput,
): Promise<string> {
  const links = threadLinkStore(storage, hubScope, accountId);
  const replay = links
    .load()
    .find(
      (link) =>
        link.workbenchLocalId === parent.workbenchLocalId &&
        link.inReplyTo === parent.messageId &&
        link.subject === input.subject &&
        (link.to === undefined ||
          (link.to.length === input.to.length &&
            link.to.every((address, index) => address === input.to[index]))) &&
        (link.body === undefined || link.body === input.body),
    );
  if (replay !== undefined) return replay.messageId;
  const fork = buildForkReference(parent);
  const sent = await hub.sendRunMail({
    tenantId: parent.tenantId,
    to: input.to,
    subject: input.subject,
    body: input.body,
    headers: { inReplyTo: fork.inReplyTo, references: fork.references },
  });
  links.record({
    workbenchLocalId: parent.workbenchLocalId,
    messageId: sent.messageId,
    inReplyTo: fork.inReplyTo,
    references: [...fork.references],
    subject: input.subject,
    to: [...input.to],
    body: input.body,
  });
  return sent.messageId;
}

const TenantShape = type({
  id: "string",
  name: "string",
  slug: "string",
  domain: "string",
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
const MailRowShape = type({
  messageId: "string",
  from: "string",
  to: type("string").array(),
  "cc?": type("string").array(),
  "subject?": "string",
  "listId?": "string",
  "inReplyTo?": "string",
  "references?": type("string").array(),
  "runId?": "string",
});
const MailPageShape = type({
  data: MailRowShape.array(),
  nextCursor: "string | null",
});
const SentMailShape = type({ messageId: "string" });
const RolePageShape = type({
  data: type({ id: "string", name: "string" }).array(),
  nextCursor: "string | null",
});

/**
 * Resolves a system role name (e.g. "member") to its per-tenant role id
 * over the stock roles route. A tenant's system roles are seeded by
 * `createTenant` itself, so this never needs to page past the first
 * roles listing in practice — the route is still cursor-shaped, so this
 * follows it rather than assuming a single page.
 */
async function resolveRoleId(
  fetchImpl: typeof fetch,
  tenantId: string,
  roleName: string,
): Promise<string> {
  const roles = await fetchAllPages(
    fetchImpl,
    `/api/tenants/${encodeURIComponent(tenantId)}/roles`,
    "listRoles",
    (body) => parseBoundary(RolePageShape, body, "listRoles"),
  );
  const found = roles.find((role) => role.name === roleName);
  if (found === undefined) {
    throw new StockHubRequestError(
      "listRoles",
      undefined,
      `Stock roles for workbench ${tenantId} carry no role named "${roleName}".`,
    );
  }
  return found.id;
}

const HubErrorEnvelope = type({
  error: { code: "string", "message?": "string", "userMessage?": "string" },
});

const WorkflowAssetListShape = type({ id: "string", name: "string" }).array();
const DeploymentListShape = type({
  definitionAssetId: "string",
  status: "string",
}).array();
const TERMINAL_DEPLOYMENT_STATUSES = new Set(["released", "failed", "destroy_failed"]);

async function readJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    const envelope = HubErrorEnvelope(await response.json().catch(() => undefined));
    const reason =
      envelope instanceof type.errors
        ? ""
        : ` ${envelope.error.code}: ${envelope.error.userMessage ?? envelope.error.message ?? ""}`;
    throw new StockHubRequestError(
      operation,
      response.status,
      `Stock request ${operation} failed with HTTP ${response.status}.${reason}`,
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

/** Builds the StockHub port over stock routes only: tenant bootstrap,
 * member invite, workflow deploy, and run-mail send/list under the tenant
 * mailbox surface. Per-agent mailbox search and full thread reads stay
 * typed upstream gaps until the hub exposes stock routes for them. */
export function createFetchStockHub(fetchImpl: typeof fetch = fetch): StockHub {
  return {
    async listMyPrincipals() {
      return fetchAllPages(fetchImpl, "/api/me/principals", "listMyPrincipals", (body) =>
        parseBoundary(MembershipPageShape, body, "listMyPrincipals"),
      );
    },
    async getTenant(id) {
      const response = await fetchImpl(`/api/tenants/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      const parsed = parseBoundary(TenantShape, await readJson(response, "getTenant"), "getTenant");
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
      const roleId = await resolveRoleId(fetchImpl, tenantId, input.role);
      await readJson(
        await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/members/invite`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: input.email, roleId }),
        }),
        "inviteMember",
      );
    },
    async deployWorkflow(tenantId, input) {
      await readJson(
        await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/workflows/deployments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
        "deployWorkflow",
      );
    },
    async hasWorkflowDeployment(tenantId, assetName) {
      const assets = parseBoundary(
        WorkflowAssetListShape,
        await readJson(
          await fetchImpl(
            `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=workflow&inherited=false`,
          ),
          "listWorkflowAssets",
        ),
        "listWorkflowAssets",
      );
      const asset = assets.find((row) => row.name === assetName);
      if (asset === undefined) return false;
      const deployments = parseBoundary(
        DeploymentListShape,
        await readJson(
          await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/workflows/deployments`),
          "listDeployments",
        ),
        "listDeployments",
      );
      return deployments.some(
        (deployment) =>
          deployment.definitionAssetId === asset.id &&
          !TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status),
      );
    },
    async sendRunMail(input) {
      const { tenantId, ...message } = input;
      const body = await readJson(
        await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/mailbox/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        }),
        "sendRunMail",
      );
      return parseBoundary(SentMailShape, body, "sendRunMail");
    },
    async listRunMail(input) {
      return fetchAllPages(
        fetchImpl,
        `/api/tenants/${encodeURIComponent(input.tenantId)}/mailbox/messages`,
        "listRunMail",
        (body) => parseBoundary(MailPageShape, body, "listRunMail"),
      );
    },
    async searchAgentMailbox(input) {
      throw new StockHubCapabilityError(
        "agent-mailbox-reads",
        `Stock Interchange exposes no per-agent mailbox search route for ${input.address}; no DM was derived.`,
      );
    },
    async readMailThread(input) {
      throw new StockHubCapabilityError(
        "thread-fork-context",
        `Stock Interchange exposes no full thread route for ${input.messageId}; no fork context was read.`,
      );
    },
  };
}

export { childTenantStore };
export type { ChildTenantStore };
