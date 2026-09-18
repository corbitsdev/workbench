// How a deployed agent gets to call this hub back: the workbench mints an
// agent token for the definition, stores it as a tenant-owned credential
// pinned to the hub's own origin, and the definition names it through a
// credential binding. The agent never holds the secret — the sidecar shapes
// a mediated fetch from it and hands the tools only that.
import { type } from "arktype";

/** The tool package the binding authorizes, and the consumer identity the
 * credential-use grant is conditioned on. */
export const ARTIFACT_TOOLS_PACKAGE = "@corbits/artifacts/sidecar-bundle";

/** The handle `@corbits/artifacts`' sidecar bundle resolves. */
export const HUB_CREDENTIAL_HANDLE = "hub";

/** One provider row per workbench, standing for the hub itself. Its plugin
 * is `@corbits/credential-header`'s raw-`authorization` preset, which sends
 * the secret verbatim — so the stored secret is the whole header value. */
export const HUB_PROVIDER_NAME = "workbench-hub";
export const HUB_PROVIDER_PLUGIN = "http-raw-authorization";

export class AgentHubCredentialError extends Error {}

const ProviderShape = type({ id: "string", name: "string" });
const ProvidersPage = type({ data: ProviderShape.array() });
const CredentialShape = type({
  id: "string",
  name: "string",
  "metadata?": "Record<string, unknown> | null",
});
const CredentialsPage = type({ data: CredentialShape.array() });
const MintedTokenShape = type({ token: { id: "string", token: "string" } });
const PrincipalShape = type({ id: "string", refId: "string" });
const DeploymentShape = type({
  id: "string",
  definitionAssetId: "string",
  status: "string",
});
const DeploymentsPage = type({ data: DeploymentShape.array() });
const PrincipalsPage = type({
  data: PrincipalShape.array(),
  nextCursor: "string | null",
});

function tenantPath(tenantId: string, suffix: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}${suffix}`;
}

async function readJson<T>(
  response: Response,
  shape: (value: unknown) => T | type.errors,
  what: string,
): Promise<T> {
  const parsed = shape(await response.json());
  if (parsed instanceof type.errors) {
    throw new AgentHubCredentialError(`${what} came back an unexpected shape: ${parsed.summary}`);
  }
  return parsed;
}

/** The credential name a given agent's hub token is stored under. It is also
 * the binding's `name` tiebreaker, so both derive it here. */
export function agentHubCredentialName(definitionId: string): string {
  return `${definitionId}-hub`;
}

/** The `credentialBindings` entry a definition carries so the deploy resolves
 * this credential into the artifact tools' `hub` handle. */
export function artifactToolsCredentialBinding(definitionId: string): {
  readonly package: string;
  readonly handle: string;
  readonly provider: string;
  readonly name: string;
  readonly locator: "tenant";
} {
  return {
    package: ARTIFACT_TOOLS_PACKAGE,
    handle: HUB_CREDENTIAL_HANDLE,
    provider: HUB_PROVIDER_NAME,
    name: agentHubCredentialName(definitionId),
    locator: "tenant",
  };
}

/** The stored hub credential for an agent, without rotating it. */
export async function resolveAgentHubCredentialId(
  args: { readonly tenantId: string; readonly definitionId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const listed = await fetchImpl(tenantPath(args.tenantId, "/credentials"));
  if (!listed.ok) {
    throw new AgentHubCredentialError("listing this workbench's credentials failed");
  }
  const page = await readJson(listed, CredentialsPage, "this workbench's credentials");
  const name = agentHubCredentialName(args.definitionId);
  return page.data.find((row) => row.name === name)?.id ?? null;
}

async function ensureHubProvider(tenantId: string, fetchImpl: typeof fetch): Promise<string> {
  const listed = await fetchImpl(tenantPath(tenantId, "/providers"));
  if (!listed.ok) {
    throw new AgentHubCredentialError("listing this workbench's providers failed");
  }
  const page = await readJson(listed, ProvidersPage, "this workbench's providers");
  const existing = page.data.find((provider) => provider.name === HUB_PROVIDER_NAME);
  if (existing !== undefined) return existing.id;

  const created = await fetchImpl(tenantPath(tenantId, "/providers"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: HUB_PROVIDER_NAME,
      plugin: HUB_PROVIDER_PLUGIN,
      // A tool credential must resolve to an origin-pinned handle, so the
      // provider names the hub the browser is already talking to.
      apiBaseUrl: globalThis.location.origin,
    }),
  });
  if (!created.ok) {
    throw new AgentHubCredentialError("preparing this workbench's hub provider failed");
  }
  return (await readJson(created, ProviderShape, "this workbench's hub provider")).id;
}

/**
 * Mints a fresh agent token for `definitionId` and stores it as the tenant's
 * hub credential for that agent, replacing any prior one so a redeploy
 * rotates rather than accumulates. Returns the credential id the use-grant is
 * written against.
 */
export async function ensureAgentHubCredential(
  args: {
    readonly tenantId: string;
    readonly definitionId: string;
    /** The agent's `workflow` source asset. It is what the token is scoped
     * to, because it is the tenant-owned thing that already exists when the
     * token is minted — the deploy has not run yet. */
    readonly assetId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { tenantId, definitionId, assetId } = args;
  const providerId = await ensureHubProvider(tenantId, fetchImpl);
  const credentialName = agentHubCredentialName(definitionId);

  const listed = await fetchImpl(tenantPath(tenantId, "/credentials"));
  if (!listed.ok) {
    throw new AgentHubCredentialError("listing this workbench's credentials failed");
  }
  const page = await readJson(listed, CredentialsPage, "this workbench's credentials");
  for (const credential of page.data.filter((row) => row.name === credentialName)) {
    // Revoke the bearer before dropping the row that recorded it: deleting
    // only the credential would leave the old token valid forever.
    const priorTokenId = credential.metadata?.["agentTokenId"];
    if (typeof priorTokenId === "string" && priorTokenId !== "") {
      const revoked = await fetchImpl(
        tenantPath(tenantId, `/agent-tokens/${encodeURIComponent(priorTokenId)}`),
        { method: "DELETE" },
      );
      // 404 means it was revoked already; anything else left a live bearer.
      if (!revoked.ok && revoked.status !== 404) {
        throw new AgentHubCredentialError("revoking this agent's previous hub token failed");
      }
    }
    const dropped = await fetchImpl(
      tenantPath(tenantId, `/credentials/${encodeURIComponent(credential.id)}`),
      { method: "DELETE" },
    );
    if (!dropped.ok) {
      throw new AgentHubCredentialError("replacing this agent's hub credential failed");
    }
  }

  const minted = await fetchImpl(tenantPath(tenantId, "/agent-tokens"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definitionId: assetId, name: credentialName }),
  });
  if (!minted.ok) {
    throw new AgentHubCredentialError("minting this agent's hub token failed");
  }
  const { token } = await readJson(minted, MintedTokenShape, "this agent's hub token");

  const stored = await fetchImpl(tenantPath(tenantId, "/credentials"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId,
      name: credentialName,
      type: "api_key",
      // The raw-authorization provider sends the secret verbatim, so the
      // secret is the finished header value, not the bare token.
      secret: `Bearer ${token.token}`,
      // The token id, so the next deploy revokes this bearer instead of
      // orphaning it.
      metadata: { agentTokenId: token.id },
    }),
  });
  if (!stored.ok) {
    throw new AgentHubCredentialError("storing this agent's hub token failed");
  }
  return (await readJson(stored, CredentialShape, "this agent's hub credential")).id;
}

/** The stock principals route filters by kind and status only, so the run's
 * principal is found by walking the pages rather than by a server-side
 * refId filter. */
async function findWorkflowPrincipalId(
  tenantId: string,
  refId: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ kind: "workflow", limit: "100" });
    if (cursor !== null) query.set("cursor", cursor);
    const listed = await fetchImpl(tenantPath(tenantId, `/principals?${query.toString()}`));
    if (!listed.ok) {
      throw new AgentHubCredentialError("listing this workbench's agents failed");
    }
    const page: typeof PrincipalsPage.infer = await readJson(
      listed,
      PrincipalsPage,
      "this workbench's agents",
    );
    const match = page.data.find((row) => row.refId === refId);
    if (match !== undefined) return match.id;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return null;
}

/**
 * Authorizes the deployed run to use its hub credential, scoped to the
 * artifact tool package. The deploy request creates the run's principal, so
 * by the time its 201 is in hand the principal exists; an absent one means
 * the deploy did not land what it claimed and the caller hears about it.
 */
export async function grantArtifactToolsCredentialUse(
  args: {
    readonly tenantId: string;
    readonly deploymentId: string;
    readonly credentialId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const principalId = await findWorkflowPrincipalId(args.tenantId, args.deploymentId, fetchImpl);
  if (principalId === null) {
    throw new AgentHubCredentialError(
      "this agent has no principal to authorize, so its artifact tools would not work",
    );
  }
  const created = await fetchImpl(tenantPath(args.tenantId, "/grants"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      principalId,
      resource: `credential:${args.credentialId}`,
      action: "use",
      effect: "allow",
      origin: "creator",
      conditions: { tool: `tool:${ARTIFACT_TOOLS_PACKAGE}` },
    }),
  });
  if (!created.ok) {
    throw new AgentHubCredentialError("authorizing this agent's hub credential failed");
  }
}

const TERMINAL_DEPLOYMENT_STATUSES = new Set(["failed", "released", "destroy_failed"]);

/** The live deployment anchored to a workflow asset, for a caller that
 * deployed through a pipeline which does not hand back the deployment. */
export async function resolveLiveDeploymentId(
  args: { readonly tenantId: string; readonly assetId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const listed = await fetchImpl(tenantPath(args.tenantId, "/workflows/deployments"));
  if (!listed.ok) {
    throw new AgentHubCredentialError("listing this workbench's deployments failed");
  }
  const page = await readJson(listed, DeploymentsPage, "this workbench's deployments");
  const live = page.data.find(
    (deployment) =>
      deployment.definitionAssetId === args.assetId &&
      !TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status),
  );
  return live?.id ?? null;
}
