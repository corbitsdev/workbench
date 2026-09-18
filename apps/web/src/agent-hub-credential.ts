// How a deployed agent gets to call this hub back: the workbench mints an
// agent token for the definition and stores it as a tenant-owned credential
// pinned to the hub's own origin. The definition itself binds that credential
// to the artifact tools and requires its use on the deployer's authority, so
// nothing here touches grants. The agent never holds the secret: the sidecar
// shapes a mediated fetch from it and hands the tools only that.
import { agentHubCredentialName, HUB_PROVIDER_NAME } from "@corbits/myra/workflow-ids";
import { type } from "arktype";

/** `@corbits/credential-header`'s raw-`authorization` preset sends the
 * secret verbatim, so the stored secret is the whole header value. */
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
 * rotates rather than accumulates. Returns the credential id the definition's
 * use requirement names.
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
