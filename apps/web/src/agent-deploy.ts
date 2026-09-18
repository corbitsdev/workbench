// Deploys a hand-authored agent the same way Myra deploys herself
// (`myra-deploy.ts`), generalized over {name, displayName, systemPrompt}.
import { renderBundledWorkflowSourceTree } from "@corbits/workflows/client";
import { type } from "arktype";
import { WorkflowDeploymentResponse } from "@intx/types";
import { reportError } from "@corbits/error-sink";

import { resolveExistingOffering } from "./onboarding/provider-connect-step";
import { isValidSlug, slugify } from "@/lib/slug";

export class AgentDeployError extends Error {}

const AssetCreatedShape = type({ id: "string" });
const AssetListShape = type({ id: "string", name: "string" }).array();
const GitTokenMintShape = type({ id: "string", secret: "string" });
const TenantDomainShape = type({ domain: "string" });
// Same shape `session.ts`'s `fetchSession` parses; a person's refId is
// their better-auth user id, exactly what `threads-api.ts` builds a
// principal's mailbox address from.
const SessionUserShape = type({ user: { id: "string" } });

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
}): unknown {
  const stepId = "run";
  return {
    id: args.slug,
    // `to` only feeds the deploy-time mail.address/mail.send grants; it is
    // not how mail reaches this agent — that happens at its run address.
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

// The bundle's `buildMyraWorkflow` is generic over which agent it builds.
// Returns the commit sha the deploy pins to.
export async function pushAgentSource(
  tenantId: string,
  assetId: string,
  assetName: string,
  packageName: string,
  args: {
    readonly slug: string;
    readonly systemPrompt: string;
    readonly triggerAddress: string;
    readonly declaredSources: readonly { readonly provider: string; readonly model: string }[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { MYRA_BUNDLE_BUILD_EXPORT, MYRA_WORKFLOW_BUNDLE } = await import("@corbits/myra/bundle");
  const tree = renderBundledWorkflowSourceTree({
    packageName,
    bundle: MYRA_WORKFLOW_BUNDLE,
    buildExport: MYRA_BUNDLE_BUILD_EXPORT,
    buildInput: {
      workflowId: args.slug,
      triggerAddress: args.triggerAddress,
      inferencePreferences: args.declaredSources.map((source) => ({ ...source })),
      systemPrompt: args.systemPrompt,
    },
    workflowJson: JSON.stringify(
      buildAgentDefinitionJson({
        slug: args.slug,
        systemPrompt: args.systemPrompt,
        triggerAddress: args.triggerAddress,
        declaredSources: args.declaredSources,
      }),
    ),
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

/** Lets a caller re-deploying an existing agent reuse its slug instead of
 * re-deriving one from its display name. */
export function agentSlugFromSourceAssetName(assetName: string): string | null {
  const match = AGENT_DEPLOY_SOURCE_ASSET_NAME.exec(assetName);
  return match?.[1] ?? null;
}

export type NewAgentInput = {
  readonly name: string;
  readonly systemPrompt: string;
  /** The agent's address slug, when a caller already knows it (e.g.
   * redeploying or re-joining an existing agent) — used verbatim instead
   * of being re-derived from `name`, so the asset name stays stable. */
  readonly slug?: string;
  /** A five-field cron expression: on success, a `@corbits/cron` schedule
   * row is created addressed at this deploy's run, so the ticker mails it
   * on that cadence. */
  readonly schedule?: string;
};

function cronPath(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/cron`;
}

/** The scheduled-run mail body: names the person to report to (when known)
 * so the agent's reply has somewhere routable to go, since the cron
 * sender itself has no mailbox. */
export function buildScheduledRunBody(deployerAddress?: string): string {
  const task = "Do the work your definition describes.";
  if (deployerAddress === undefined) {
    return `This is your scheduled run. ${task} Reply with the result.`;
  }
  return `This is your scheduled run. ${task} Mail the result to ${deployerAddress} (pass it as a single-item \`to\` list) with a short, descriptive subject.`;
}

// Best-effort: a failed or signed-out session probe just means the
// scheduled run's body falls back to naming nobody, never a failed deploy.
async function resolveDeployerAddress(
  tenantDomain: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchImpl("/api/auth/get-session", {
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    reportError(cause, { operation: "agent_deploy_resolve_deployer_address" });
    return undefined;
  }
  if (!response.ok) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    reportError(cause, { operation: "agent_deploy_resolve_deployer_address" });
    return undefined;
  }
  const parsed = SessionUserShape(body);
  return parsed instanceof type.errors ? undefined : `${parsed.user.id}@${tenantDomain}`;
}

/** Creates a `@corbits/cron` schedule row addressed at a deployed agent's
 * run — the only way an agent fires on a cadence, since Interchange's
 * `schedule` trigger is reserved but unimplemented. */
async function scheduleAgentRun(
  tenantId: string,
  expression: string,
  runAddress: string,
  tenantDomain: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const deployerAddress = await resolveDeployerAddress(tenantDomain, fetchImpl);
  const created = await fetchImpl(cronPath(tenantId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expression,
      toAddress: runAddress,
      subject: "Scheduled run",
      body: buildScheduledRunBody(deployerAddress),
    }),
  });
  if (!created.ok) {
    throw new AgentDeployError(`scheduling this agent failed: ${await readErrorBody(created)}`);
  }
}

export type DeployedAgent = typeof WorkflowDeploymentResponse.infer;

// Fails closed when no provider is connected yet — there is no offering
// to deploy against.
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
  // Grant configuration only, not a routable address: the hub mints the
  // agent's real address (its run address) at deploy time.
  const triggerAddress = `${slug}@${tenant.domain}`;
  const commitSha = await pushAgentSource(
    args.tenantId,
    assetId,
    assetName,
    packageName,
    { slug, systemPrompt, triggerAddress, declaredSources: offering.declaredSources },
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
  if (args.input.schedule !== undefined) {
    await scheduleAgentRun(
      args.tenantId,
      args.input.schedule,
      // The deployment id is the top-level run id (already `run_…`), and
      // the run address is that id at the tenant domain.
      `${parsed.id}@${tenant.domain}`,
      tenant.domain,
      fetchImpl,
    );
  }
  return parsed;
}
