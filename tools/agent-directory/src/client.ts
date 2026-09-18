// Every call here is a stock `@intx/hub-api` route reached with a
// workflow-run bearer, mirroring `tools/access`'s and
// `tools/workflow-authoring`'s clients: no workbench-specific mount. An
// agent is a `workflow`-kind asset named `agent-<slug>-source` (the same
// convention `apps/web/src/agent-deploy.ts` uses for the hand-authored
// create-agent panel), pushed and deployed the same way that panel does,
// so a specialist Myra creates and one created from the web look
// identical to every other reader.
import { type } from "arktype";

import { pushSourceTree } from "./git-push";
import { isValidSlug, slugify } from "./slug";

export interface AgentDirectoryToolClientConfig {
  /** The hub's plain HTTP origin. */
  readonly hubAgentDirectoryUrl: string;
  /** The run's own tenant — the `:tenantId` segment of every stock route. */
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Override for tests; defaults to the real git-over-HTTP push. Real
   * git plumbing has no meaningful unit-testable surface of its own
   * (see `./git-push.ts`), so tests substitute a stub here instead of
   * standing up a git-receive-pack server. */
  readonly pushSourceTreeImpl?: typeof pushSourceTree;
}

export interface ListedAgentDefinition {
  readonly id: string;
  readonly name: string;
  /** The agent's live mail address — pass this to {@link messageAgent}. */
  readonly address: string;
}

export interface CreateAgentDefinitionRequest {
  readonly name: string;
  readonly systemPrompt: string;
  /** A canonical model name from the tenant's own catalog. Falls back to
   * the catalog's default (with {@link CreatedAgentDefinition.modelNote}
   * set) when it names nothing in the catalog. */
  readonly model?: string;
}

export interface CreatedAgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly deploymentId: string;
  /** Set when `model` was requested but the tenant's catalog didn't offer
   * it, so the default was used instead of baking in a name that can
   * never resolve. `null` when no substitution was needed. */
  readonly modelNote: string | null;
}

export interface MessageAgentRequest {
  readonly address: string;
  readonly message: string;
}

export interface MessageAgentResult {
  readonly messageId: string;
}

/** Thrown when creating or deploying the agent's source is refused for a
 * reason the caller should relay honestly (a bad name, no connected model
 * provider) rather than a bare transport/HTTP failure. */
export class CreateAgentDefinitionError extends Error {}

function authHeaders(config: AgentDirectoryToolClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

function tenantBase(config: AgentDirectoryToolClientConfig): string {
  return `${config.hubAgentDirectoryUrl}/api/tenants/${encodeURIComponent(config.tenantId)}`;
}

/** Pulls `error.userMessage` out of the canonical hub envelope
 * (`{error: {code, userMessage, refId}}`), if `body` matches that shape. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object" || !("userMessage" in error)) {
    return undefined;
  }
  const userMessage = (error as { userMessage: unknown }).userMessage;
  return typeof userMessage === "string" ? userMessage : undefined;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

function parseOrThrow<T>(
  schema: (value: unknown) => T | type.errors,
  body: unknown,
  operation: string,
): T {
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new Error(`${operation} response did not match the expected shape: ${parsed.summary}`);
  }
  return parsed;
}

const AGENT_SOURCE_ASSET_NAME = /^agent-(.+)-source$/;

/** Every created agent's source asset name — the one naming convention
 * this pipeline owns, mirroring `apps/web/src/agent-deploy.ts`'s
 * `agentDeploySourceAssetName`. */
function agentDeploySourceAssetName(slug: string): string {
  return `agent-${slug}-source`;
}

const WORKFLOW_SOURCE_ENTRY = "./workflow.js";

/** The source tree a serialized, function-free definition renders into —
 * mirrors `@corbits/workflows`' `renderWorkflowSourceTree`, duplicated
 * here rather than pulling that package's server-only dependency graph
 * (`@intx/hub-api`, `drizzle-orm`, `hono`) into this trim tool bundle. */
function renderWorkflowSourceTree(args: {
  readonly packageName: string;
  readonly workflowJson: string;
}): Readonly<Record<string, string>> {
  return {
    "package.json": `${JSON.stringify(
      {
        name: args.packageName,
        version: "0.0.0",
        private: true,
        type: "module",
        interchange: { workflow: WORKFLOW_SOURCE_ENTRY },
      },
      null,
      2,
    )}\n`,
    "workflow.js": `export default ${args.workflowJson};\n`,
    "definition.json": `${args.workflowJson}\n`,
  };
}

const AssetListEntry = type({
  id: "string",
  name: "string",
  "displayName?": "string | null",
});

const TenantDomainResponse = type({ domain: "string" });
const AssetCreatedResponse = type({ id: "string" });
const GitTokenMintResponse = type({ id: "string", secret: "string" });
const DeployResponse = type({ id: "string", definitionAssetId: "string", status: "string" });
const SendAcceptedResponse = type({ messageId: "string" });

const DiscoveredModels = type({
  canonicalName: "string",
  offerings: type({ offeringId: "string", priority: "number", plugin: "string" }).array(),
}).array();

const PUSH_TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const AGENT_TURN_TIMEOUT_MS = 2 * 60 * 1000;

/** Every taskable agent already deployed in this tenant, resolved to its
 * source asset id and live mail address (`<slug>@<tenant domain>`). */
export async function listAgentDefinitions(
  config: AgentDirectoryToolClientConfig,
): Promise<readonly ListedAgentDefinition[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const [assetsResponse, tenantResponse] = await Promise.all([
    doFetch(`${tenantBase(config)}/assets?kind=workflow&inherited=false`, {
      headers: authHeaders(config),
    }),
    doFetch(tenantBase(config), { headers: authHeaders(config) }),
  ]);
  if (!assetsResponse.ok) {
    throw new Error(
      `Listing agents failed: ${await readErrorMessage(assetsResponse, `${assetsResponse.status} ${assetsResponse.statusText}`)}`,
    );
  }
  if (!tenantResponse.ok) {
    throw new Error(
      `Resolving this workbench's domain failed: ${await readErrorMessage(tenantResponse, `${tenantResponse.status} ${tenantResponse.statusText}`)}`,
    );
  }
  const assets = parseOrThrow(
    AssetListEntry.array(),
    await assetsResponse.json(),
    "Listing agents",
  );
  const tenant = parseOrThrow(
    TenantDomainResponse,
    await tenantResponse.json(),
    "Resolving this workbench's domain",
  );
  const definitions: ListedAgentDefinition[] = [];
  for (const asset of assets) {
    const match = AGENT_SOURCE_ASSET_NAME.exec(asset.name);
    if (match === null) continue;
    const slug = match[1];
    definitions.push({
      id: asset.id,
      name: asset.displayName ?? asset.name,
      address: `${slug}@${tenant.domain}`,
    });
  }
  return definitions;
}

/** Create-or-find this agent's source asset by name, mirroring
 * `apps/web/src/agent-deploy.ts`'s `ensureAgentSourceAsset`. */
async function ensureAgentSourceAsset(
  config: AgentDirectoryToolClientConfig,
  assetName: string,
  displayName: string,
): Promise<string> {
  const doFetch = config.fetchImpl ?? fetch;
  const created = await doFetch(`${tenantBase(config)}/assets`, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({ kind: "workflow", name: assetName, displayName }),
  });
  if (created.status === 201) {
    return parseOrThrow(AssetCreatedResponse, await created.json(), "Preparing this agent's source")
      .id;
  }
  if (created.status !== 409) {
    throw new CreateAgentDefinitionError(
      `preparing this agent's source failed: ${await readErrorMessage(created, `${created.status} ${created.statusText}`)}`,
    );
  }
  const listed = await doFetch(`${tenantBase(config)}/assets?kind=workflow&inherited=false`, {
    headers: authHeaders(config),
  });
  if (!listed.ok) {
    throw new CreateAgentDefinitionError(
      `checking this workbench's agents failed: ${await readErrorMessage(listed, `${listed.status} ${listed.statusText}`)}`,
    );
  }
  const assets = parseOrThrow(
    AssetListEntry.array(),
    await listed.json(),
    "Checking this workbench's agents",
  );
  const existing = assets.find((asset) => asset.name === assetName);
  if (existing === undefined) {
    throw new CreateAgentDefinitionError(
      "this agent's source reported a name conflict but is not listed on this workbench",
    );
  }
  return existing.id;
}

/** Mints a short-lived push token and pushes `tree` to the asset's
 * `main`, always revoking the token afterward. */
async function withPushToken<T>(
  config: AgentDirectoryToolClientConfig,
  assetId: string,
  push: (token: string) => Promise<T>,
): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const tokensPath = `${tenantBase(config)}/git-tokens`;
  const minted = await doFetch(tokensPath, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({
      name: `agent-deploy-${crypto.randomUUID()}`,
      resource: `asset:${assetId}`,
      refPattern: "refs/heads/main",
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + PUSH_TOKEN_LIFETIME_MS).toISOString(),
    }),
  });
  if (!minted.ok) {
    throw new CreateAgentDefinitionError(
      `minting a push token failed: ${await readErrorMessage(minted, `${minted.status} ${minted.statusText}`)}`,
    );
  }
  const token = parseOrThrow(GitTokenMintResponse, await minted.json(), "Minting a push token");
  try {
    return await push(token.secret);
  } finally {
    await doFetch(`${tokensPath}/${encodeURIComponent(token.id)}`, {
      method: "DELETE",
      headers: authHeaders(config),
    });
  }
}

/** The exact single-step, mail-triggered, unbounded-turn agent shape
 * `apps/web/src/agent-deploy.ts`'s `buildAgentDefinitionJson` produces. */
function buildAgentDefinitionJson(args: {
  readonly slug: string;
  readonly systemPrompt: string;
  readonly triggerAddress: string;
  readonly declaredSources: readonly { readonly provider: string; readonly model: string }[];
}): unknown {
  const stepId = "run";
  return {
    id: args.slug,
    triggers: [{ type: "mail", to: args.triggerAddress }],
    steps: {
      [stepId]: {
        kind: "step",
        id: stepId,
        agent: {
          id: stepId,
          description: `The "${args.slug}" agent`,
          systemPrompt: args.systemPrompt,
          toolFactories: [],
          capabilities: [],
          inference: { sources: args.declaredSources.map((source) => ({ ...source })) },
          toolPackagePins: [],
        },
        drainBehavior: "wait",
        timeout: AGENT_TURN_TIMEOUT_MS,
        triggers: "unbounded",
        input: { from: "trigger.payload" },
      },
    },
    stepOrder: [stepId],
  };
}

/**
 * Creates a brand-new specialist agent: ensures its source asset, renders
 * and pushes its definition, resolves the tenant's own catalog offerings,
 * and deploys through the stock `POST /workflows/deployments` — the same
 * pipeline `apps/web/src/agent-deploy.ts` runs for the hand-authored
 * create-agent panel, reached here with a workflow-run bearer instead of
 * a browser session. Fails closed when no provider is connected: there is
 * no offering to deploy against.
 */
export async function createAgentDefinition(
  config: AgentDirectoryToolClientConfig,
  input: CreateAgentDefinitionRequest,
): Promise<CreatedAgentDefinition> {
  const name = input.name.trim();
  if (name === "") throw new CreateAgentDefinitionError("an agent needs a name");
  const systemPrompt = input.systemPrompt.trim();
  if (systemPrompt === "") throw new CreateAgentDefinitionError("an agent needs a system prompt");
  const slug = slugify(name);
  if (!isValidSlug(slug)) {
    throw new CreateAgentDefinitionError("this name doesn't produce a usable agent address");
  }

  const doFetch = config.fetchImpl ?? fetch;
  const assetName = agentDeploySourceAssetName(slug);
  const packageName = `@workbench-agent/${slug}`;

  const tenantResponse = await doFetch(tenantBase(config), { headers: authHeaders(config) });
  if (!tenantResponse.ok) {
    throw new CreateAgentDefinitionError(
      `resolving this workbench's domain failed: ${await readErrorMessage(tenantResponse, `${tenantResponse.status} ${tenantResponse.statusText}`)}`,
    );
  }
  const tenant = parseOrThrow(
    TenantDomainResponse,
    await tenantResponse.json(),
    "Resolving this workbench's domain",
  );

  const modelsResponse = await doFetch(`${tenantBase(config)}/models`, {
    headers: authHeaders(config),
  });
  if (!modelsResponse.ok) {
    throw new CreateAgentDefinitionError(
      `reading this workbench's inference catalog failed: ${await readErrorMessage(modelsResponse, `${modelsResponse.status} ${modelsResponse.statusText}`)}`,
    );
  }
  const models = parseOrThrow(
    DiscoveredModels,
    await modelsResponse.json(),
    "Reading this workbench's inference catalog",
  );
  const flattened = models
    .flatMap((model) =>
      model.offerings.map((offering) => ({ ...offering, model: model.canonicalName })),
    )
    .sort((a, b) => a.priority - b.priority || a.offeringId.localeCompare(b.offeringId));
  const seen = new Set<string>();
  const declaredSources = flattened
    .filter((offering) => {
      if (seen.has(offering.offeringId)) return false;
      seen.add(offering.offeringId);
      return true;
    })
    .map((offering) => ({ provider: offering.plugin, model: offering.model }));
  const sourceOfferingIds = declaredSources.length > 0 ? [...seen] : [];
  const defaultSourceOfferingId = sourceOfferingIds[0];
  if (defaultSourceOfferingId === undefined) {
    throw new CreateAgentDefinitionError(
      "connect a model provider in Settings before creating an agent",
    );
  }

  let modelNote: string | null = null;
  let orderedDeclaredSources = declaredSources;
  if (input.model !== undefined) {
    const requestedIndex = orderedDeclaredSources.findIndex(
      (source) => source.model === input.model,
    );
    if (requestedIndex === -1) {
      modelNote = `Requested model "${input.model}" is not in this workbench's catalog; used the workspace default "${orderedDeclaredSources[0]?.model ?? "none"}" instead.`;
    } else if (requestedIndex > 0) {
      const [requested] = orderedDeclaredSources.splice(requestedIndex, 1);
      if (requested !== undefined) orderedDeclaredSources = [requested, ...orderedDeclaredSources];
    }
  }

  const assetId = await ensureAgentSourceAsset(config, assetName, name);
  const triggerAddress = `${slug}@${tenant.domain}`;
  const workflowJson = buildAgentDefinitionJson({
    slug,
    systemPrompt,
    triggerAddress,
    declaredSources: orderedDeclaredSources,
  });
  const tree = renderWorkflowSourceTree({
    packageName,
    workflowJson: JSON.stringify(workflowJson),
  });
  const doPush = config.pushSourceTreeImpl ?? pushSourceTree;
  const commitSha = await withPushToken(config, assetId, (token) =>
    doPush({
      url: `${tenantBase(config)}/assets/workflow/${assetName}.git`,
      token,
      tree,
      message: `Publish ${assetName}'s definition`,
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
    }),
  );

  const deployed = await doFetch(`${tenantBase(config)}/workflows/deployments`, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({
      source: { kind: "asset", assetId, package: { format: "source", commitSha } },
      entry: "./workflow.js",
      sourceOfferingIds,
      defaultSourceOfferingId,
    }),
  });
  if (!deployed.ok) {
    throw new CreateAgentDefinitionError(
      `deploying this agent failed: ${await readErrorMessage(deployed, `${deployed.status} ${deployed.statusText}`)}`,
    );
  }
  const deployment = parseOrThrow(DeployResponse, await deployed.json(), "Deploying this agent");

  return {
    id: assetId,
    name,
    address: triggerAddress,
    deploymentId: deployment.id,
    modelNote,
  };
}

/** Sends a mail-shaped message to an agent's live address through the
 * stock mailbox, the same send this run's own mailbox uses for a reply. */
export async function messageAgent(
  config: AgentDirectoryToolClientConfig,
  input: MessageAgentRequest,
): Promise<MessageAgentResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(`${tenantBase(config)}/mailbox/me/inbox/send`, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({
      to: [input.address],
      subject: input.message.slice(0, 60),
      body: input.message,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Messaging the agent failed: ${await readErrorMessage(response, `${response.status} ${response.statusText}`)}`,
    );
  }
  const parsed = parseOrThrow(SendAcceptedResponse, await response.json(), "Messaging the agent");
  return { messageId: parsed.messageId };
}
