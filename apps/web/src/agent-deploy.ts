// Deploys a hand-authored agent the same way the default worker deploys
// (`worker-deploy.ts`), generalized over {name, displayName, systemPrompt}.
import { installPackage } from "./install-package";
import { type } from "arktype";
import { reportError } from "@corbits/error-sink";

import type { ToolEffect } from "@corbits/worker/definition-json";
import type { McpServerDeployment } from "@corbits/worker/workflow-ids";

import { ensureAgentHubCredential } from "./agent-hub-credential";
import { personMailAddress } from "./mail-address";
import { listMcpServers, resolveWorkspaceTenantId, toMcpServerDeployment } from "./mcp-servers";
import type { McpServer } from "./mcp-servers";
import { renderWorkerSourceTree } from "./worker-deploy";
import { resolveExistingOffering } from "./onboarding/provider-connect-step";
import { isValidSlug, slugify } from "@/lib/slug";

export type { ToolEffect };

export class AgentDeployError extends Error {}

const TenantDomainShape = type({ domain: "string" });
// Same shape `session.ts`'s `fetchSession` parses; a person's refId is
// their better-auth user id, exactly what `threads-api.ts` builds a
// principal's mailbox address from.
const SessionUserShape = type({ user: { id: "string" } });

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

/** Every created agent's source asset name, `agent-<slug>-source` — the one
 * naming convention this pipeline owns, so callers can recognize a created
 * agent's asset without a lookup. */
export function agentDeploySourceAssetName(slug: string): string {
  return `agent-${slug}-source`;
}

const AGENT_DEPLOY_SOURCE_ASSET_NAME = /^agent-(.+)-source$/;

/** True for any asset this deploy pipeline named — used to keep created
 * agents (and Worker, checked separately by callers) out of surfaces that
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
  /** Workspace-catalog server handles to bind, as chosen in the New Agent
   * dialog (or on Worker's create-agent card). Each becomes a definition
   * binding plus a use requirement, the same as Worker's Exa. */
  readonly mcpHandles?: readonly string[];
  /** A five-field cron expression: on success, a `@corbits/cron` schedule
   * row is created targeting this agent's definition, so the ticker mails
   * its live run on that cadence. */
  readonly schedule?: string;
  /** Tool permissions to re-declare on a redeploy, as creator-sourced grant
   * requirements. */
  readonly toolEffects?: readonly ToolEffect[];
};

/** Maps requested workspace-catalog handles to deployments. Fails closed on
 * an unknown handle: silently dropping one would deploy an agent that
 * cannot reach the server the person checked. */
export function resolveMcpServerDeployments(
  catalog: readonly McpServer[],
  handles: readonly string[],
): readonly McpServerDeployment[] {
  return handles.map((handle) => {
    const server = catalog.find((candidate) => candidate.handle === handle);
    if (server === undefined) {
      throw new AgentDeployError(`the ${handle} server is not in this workspace's catalog`);
    }
    return toMcpServerDeployment(server);
  });
}

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
  return parsed instanceof type.errors
    ? undefined
    : personMailAddress(parsed.user.id, tenantDomain);
}

/** Creates a `@corbits/cron` schedule row targeting a deployed agent by its
 * definition name — the only way an agent fires on a cadence, since
 * Interchange's `schedule` trigger is reserved but unimplemented. The
 * ticker resolves that name to the live run at fire time, so the schedule
 * survives a redeploy. */
async function scheduleAgentRun(
  tenantId: string,
  expression: string,
  definitionName: string,
  tenantDomain: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const deployerAddress = await resolveDeployerAddress(tenantDomain, fetchImpl);
  const created = await fetchImpl(cronPath(tenantId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expression,
      definitionName,
      subject: "Scheduled run",
      body: buildScheduledRunBody(deployerAddress),
    }),
  });
  if (!created.ok) {
    throw new AgentDeployError(`scheduling this agent failed: ${await readErrorBody(created)}`);
  }
}

export type DeployedAgent = Awaited<ReturnType<typeof installPackage>>;

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

  // The chosen handles bind workspace-catalog servers by ancestor walk, the
  // same as Worker's Exa; an empty choice deploys a server-less agent.
  const requestedHandles = args.input.mcpHandles ?? [];
  const mcpServers =
    requestedHandles.length === 0
      ? []
      : resolveMcpServerDeployments(
          await listMcpServers(await resolveWorkspaceTenantId(args.tenantId, fetchImpl), fetchImpl),
          requestedHandles,
        );
  // Grant configuration only, not a routable address: the hub mints the
  // agent's real address (its run address) at deploy time.
  const triggerAddress = `${slug}@${tenant.domain}`;
  const parsed = await installPackage({
    fetch: fetchImpl,
    origin: globalThis.location.origin,
    tenantId: args.tenantId,
    assetName,
    displayName: name,
    // Minted once the asset exists: the definition binds this credential by
    // name and requires its use by id, so it must precede the source.
    files: async (assetId) =>
      renderWorkerSourceTree(
        packageName,
        {
          workflowId: slug,
          systemPrompt,
          triggerAddress,
          inferencePreferences: offering.declaredSources,
          hubCredentialId: await ensureAgentHubCredential(
            { tenantId: args.tenantId, definitionId: slug, assetId },
            fetchImpl,
          ),
          mcpServers,
        },
        args.input.toolEffects ?? [],
      ),
    entry: "./workflow.js",
    sourceOfferingIds: offering.sourceOfferingIds,
    defaultSourceOfferingId: offering.defaultSourceOfferingId,
  });
  if (args.input.schedule !== undefined) {
    await scheduleAgentRun(args.tenantId, args.input.schedule, assetName, tenant.domain, fetchImpl);
  }
  return parsed;
}
