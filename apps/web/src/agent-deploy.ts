// Deploys a hand-authored agent the same way Myra deploys herself
// (`myra-deploy.ts`): a `workflow`-kind asset holding a rendered source
// tree, pushed over the stock git smart-HTTP route, then deployed through
// the stock `POST /workflows/deployments`. Generalized over {name,
// displayName, systemPrompt} so the create-agent panel can deploy any
// agent through the one path the platform actually backs.
import { renderWorkflowSourceTree } from "@corbits/workflows/client";
import { type } from "arktype";
import { WorkflowDeploymentResponse } from "@intx/types";

import { resolveExistingOffering } from "./onboarding/provider-connect-step";
import { isValidSlug, slugify } from "@/lib/slug";

export class AgentDeployError extends Error {}

const AssetCreatedShape = type({ id: "string" });
const AssetListShape = type({ id: "string", name: "string" }).array();
const GitTokenMintShape = type({ id: "string", secret: "string" });
const TenantDomainShape = type({ domain: "string" });

const PUSH_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

/** The `workflow`-kind asset a given agent's source pushes into, derived
 * from its name — idempotent create-or-find, mirroring `ensureMyraSourceAsset`
 * but keyed on a caller-supplied name rather than Myra's fixed one. */
export async function ensureAgentSourceAsset(
  tenantId: string,
  assetName: string,
  displayName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const created = await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "workflow", name: assetName, displayName }),
  });
  if (created.status === 201) {
    const parsed = AssetCreatedShape(await created.json());
    if (parsed instanceof type.errors) {
      throw new AgentDeployError(
        `this agent's source came back an unexpected shape: ${parsed.summary}`,
      );
    }
    return parsed.id;
  }
  if (created.status !== 409) {
    throw new AgentDeployError(
      `preparing this agent's source failed: ${await readErrorBody(created)}`,
    );
  }
  const listed = await fetchImpl(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=workflow&inherited=false`,
  );
  if (!listed.ok) {
    throw new AgentDeployError(
      `checking this workbench's agents failed: ${await readErrorBody(listed)}`,
    );
  }
  const parsed = AssetListShape(await listed.json());
  if (parsed instanceof type.errors) {
    throw new AgentDeployError(
      `this workbench's agent list came back an unexpected shape: ${parsed.summary}`,
    );
  }
  const existing = parsed.find((asset) => asset.name === assetName);
  if (existing === undefined) {
    throw new AgentDeployError(
      "this agent's source reported a name conflict but is not listed on this workbench",
    );
  }
  return existing.id;
}

/** The exact `WorkflowDefinition` JSON for a single-step, mail-triggered,
 * unbounded-turn agent — the same shape `buildMyraDefinitionJson` produces,
 * generalized over the caller's own name and system prompt. */
export function buildAgentDefinitionJson(args: {
  slug: string;
  systemPrompt: string;
  triggerAddress: string;
  declaredSources: readonly { readonly provider: string; readonly model: string }[];
  schedule?: string;
}): unknown {
  const stepId = "run";
  return {
    id: args.slug,
    triggers: [
      { type: "mail", to: args.triggerAddress },
      ...(args.schedule !== undefined ? [{ type: "schedule", cron: args.schedule }] : []),
    ],
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
        // No `timeout`: it stays armed across an approval park, so any
        // finite value aborts a run waiting on a person to answer an
        // ask-gated tool call (see agents/myra/src/index.ts).
        triggers: "unbounded",
        input: { from: "trigger.payload" },
      },
    },
    stepOrder: [stepId],
  };
}

async function withPushToken<T>(
  tenantId: string,
  assetId: string,
  fetchImpl: typeof fetch,
  push: (token: string) => Promise<T>,
): Promise<T> {
  const tokensPath = `/api/tenants/${encodeURIComponent(tenantId)}/git-tokens`;
  const minted = await fetchImpl(tokensPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `agent-deploy-${crypto.randomUUID()}`,
      resource: `asset:${assetId}`,
      refPattern: "refs/heads/main",
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + PUSH_TOKEN_LIFETIME_MS).toISOString(),
    }),
  });
  if (!minted.ok) {
    throw new AgentDeployError(`minting a push token failed: ${await readErrorBody(minted)}`);
  }
  const token = GitTokenMintShape(await minted.json());
  if (token instanceof type.errors) {
    throw new AgentDeployError(`the push token came back an unexpected shape: ${token.summary}`);
  }
  try {
    return await push(token.secret);
  } finally {
    await fetchImpl(`${tokensPath}/${encodeURIComponent(token.id)}`, { method: "DELETE" });
  }
}

/** Renders this agent's built definition as a source tree and pushes it to
 * its asset's `main`. Returns the commit sha the deploy pins to. */
export async function pushAgentSource(
  tenantId: string,
  assetId: string,
  assetName: string,
  packageName: string,
  workflowJson: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const tree = renderWorkflowSourceTree({
    packageName,
    workflowJson: JSON.stringify(workflowJson),
  });
  const url = new URL(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets/workflow/${assetName}.git`,
    globalThis.location.origin,
  ).toString();
  const { pushSourceTree } = await import("./git-push");
  return withPushToken(tenantId, assetId, fetchImpl, (token) =>
    pushSourceTree({ url, token, tree, message: `Publish ${assetName}'s definition` }),
  );
}

/** Every created agent's source asset name, `agent-<slug>-source` — the one
 * naming convention this pipeline owns, so callers can recognize a created
 * agent's asset without a lookup. */
export function agentDeploySourceAssetName(slug: string): string {
  return `agent-${slug}-source`;
}

const AGENT_DEPLOY_SOURCE_ASSET_NAME = /^agent-(.+)-source$/;

/** True for any asset this deploy pipeline named — used to keep created
 * agents (and Myra, checked separately by callers) out of surfaces that
 * list real workflows, since both are `workflow`-kind assets. */
export function isAgentDeploySourceAssetName(name: string): boolean {
  return AGENT_DEPLOY_SOURCE_ASSET_NAME.test(name);
}

/** The inverse of `agentDeploySourceAssetName`: recovers the slug this
 * pipeline deployed an asset under, so a caller re-deploying an existing
 * agent can reuse its slug instead of re-deriving one from its display
 * name. Null when the name isn't this pipeline's `agent-<slug>-source`
 * shape. */
export function agentSlugFromSourceAssetName(assetName: string): string | null {
  const match = AGENT_DEPLOY_SOURCE_ASSET_NAME.exec(assetName);
  return match?.[1] ?? null;
}

export type NewAgentInput = {
  readonly name: string;
  readonly systemPrompt: string;
  readonly schedule?: string;
  /** The agent's address slug, when a caller already knows it (e.g.
   * redeploying or re-joining an existing agent) — used verbatim instead
   * of being re-derived from `name`, so the asset name stays stable. */
  readonly slug?: string;
};

export type DeployedAgent = typeof WorkflowDeploymentResponse.infer;

/**
 * Deploys a hand-authored agent: ensures its source asset, pushes its
 * rendered definition, resolves the tenant's existing inference offering
 * (the same one Myra's own deploy resolves through), and deploys through
 * the stock `POST /workflows/deployments`. Fails closed when no provider is
 * connected yet — there is no offering to deploy against.
 */
export async function deployAgentSource(
  args: { readonly tenantId: string; readonly input: NewAgentInput },
  fetchImpl: typeof fetch = fetch,
): Promise<DeployedAgent> {
  const name = args.input.name.trim();
  if (name === "") throw new AgentDeployError("an agent needs a name");
  const systemPrompt = args.input.systemPrompt.trim();
  if (systemPrompt === "") throw new AgentDeployError("an agent needs a system prompt");

  const slug = args.input.slug ?? slugify(name);
  if (!isValidSlug(slug)) {
    throw new AgentDeployError("this name doesn't produce a usable agent address");
  }
  const assetName = agentDeploySourceAssetName(slug);
  const packageName = `@workbench-agent/${slug}`;

  const tenantResponse = await fetchImpl(`/api/tenants/${encodeURIComponent(args.tenantId)}`);
  if (!tenantResponse.ok) {
    throw new AgentDeployError(
      `resolving this workbench's domain failed: ${await readErrorBody(tenantResponse)}`,
    );
  }
  const tenant = TenantDomainShape(await tenantResponse.json());
  if (tenant instanceof type.errors) {
    throw new AgentDeployError(`this workbench came back an unexpected shape: ${tenant.summary}`);
  }

  const offering = await resolveExistingOffering(args.tenantId);
  if (offering === null) {
    throw new AgentDeployError("connect a model provider in Settings before deploying an agent");
  }

  const assetId = await ensureAgentSourceAsset(args.tenantId, assetName, name, fetchImpl);
  const workflowJson = buildAgentDefinitionJson({
    slug,
    systemPrompt,
    triggerAddress: `${slug}@${tenant.domain}`,
    declaredSources: offering.declaredSources,
    ...(args.input.schedule !== undefined ? { schedule: args.input.schedule } : {}),
  });
  const commitSha = await pushAgentSource(
    args.tenantId,
    assetId,
    assetName,
    packageName,
    workflowJson,
    fetchImpl,
  );

  const deployed = await fetchImpl(
    `/api/tenants/${encodeURIComponent(args.tenantId)}/workflows/deployments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: { kind: "asset", assetId, package: { format: "source", commitSha } },
        entry: "./workflow.js",
        sourceOfferingIds: offering.sourceOfferingIds,
        defaultSourceOfferingId: offering.defaultSourceOfferingId,
      }),
    },
  );
  if (!deployed.ok) {
    throw new AgentDeployError(`deploying this agent failed: ${await readErrorBody(deployed)}`);
  }
  const parsed = WorkflowDeploymentResponse(await deployed.json());
  if (parsed instanceof type.errors) {
    throw new AgentDeployError(`this deployment came back an unexpected shape: ${parsed.summary}`);
  }
  return parsed;
}
