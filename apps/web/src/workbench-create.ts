// An agent joins a workbench by being deployed into the child tenant
// itself — its deploy route rejects the parent's inherited asset.

import { isMyraAgent, listWorkbenchParticipants, sendToWorkbench } from "@/chat/threads-api";
import { agentSlugFromSourceAssetName, deployAgentSource } from "./agent-deploy";
import { readAgentSource } from "./agent-source-read";
import { authorizeMyraHubCredential, deployMyraSource } from "./myra-deploy";
import { createFetchStockHub } from "./needs-converge";
import { resolveExistingOffering } from "./onboarding/provider-connect-step";

export class WorkbenchCreateError extends Error {
  constructor(
    message: string,
    readonly stage: "create" | "deploy" | "opening-message",
    /** Set once the workbench tenant exists, so a later-stage failure can
     * still land the person in the workbench it created. */
    readonly tenantId?: string,
  ) {
    super(message);
    this.name = "WorkbenchCreateError";
  }
}

/** Slugs are tenant-unique and immutable, so a name alone cannot mint one:
 * the timestamp suffix is what keeps two workbenches of the same name apart. */
function workbenchSlug(name: string): string {
  const base = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${base === "" ? "workbench" : base}-${Date.now().toString(36)}`;
}

function failure(
  cause: unknown,
  stage: WorkbenchCreateError["stage"],
  tenantId?: string,
): WorkbenchCreateError {
  return new WorkbenchCreateError(
    cause instanceof Error ? cause.message : String(cause),
    stage,
    tenantId,
  );
}

export type CreateWorkbenchInput = {
  readonly benchTenantId: string;
  readonly name: string;
  readonly openingMessage?: string;
  /** Existing bench agents to re-deploy into the workbench alongside Myra:
   * their source asset id, name, and asset name (for reading it back). */
  readonly pickedAgents?: readonly {
    readonly id: string;
    readonly name: string;
    readonly assetName: string;
  }[];
};

/** Returns the new workbench's tenant id — its deep link is `/w/<id>`. */
export async function createWorkbench(input: CreateWorkbenchInput): Promise<string> {
  const hub = createFetchStockHub();

  let tenantId: string;
  let domain: string;
  try {
    const created = await hub.createTenant({
      name: input.name,
      slug: workbenchSlug(input.name),
      parentId: input.benchTenantId,
    });
    tenantId = created.id;
    domain = created.domain;
  } catch (cause) {
    throw failure(cause, "create");
  }

  try {
    const offering = await resolveExistingOffering(tenantId);
    if (offering === null) {
      throw new Error("Connect a model provider in Settings before starting a workbench.");
    }
    const deployInput = await deployMyraSource({
      tenantId,
      tenantDomain: domain,
      sourceOfferingIds: offering.sourceOfferingIds,
      defaultSourceOfferingId: offering.defaultSourceOfferingId,
      declaredSources: offering.declaredSources,
    });
    await hub.deployWorkflow(tenantId, deployInput);
    await authorizeMyraHubCredential({ tenantId });

    // Each picked bench agent joins the workbench the same way Myra does: its
    // source is read back out of the bench and re-pushed into the child,
    // since a child's deploy rejects the parent's inherited asset outright.
    for (const picked of input.pickedAgents ?? []) {
      const slug = agentSlugFromSourceAssetName(picked.assetName);
      if (slug === null) {
        throw new Error(`${picked.assetName} isn't a recognized agent source asset`);
      }
      const source = await readAgentSource(input.benchTenantId, picked.id, picked.assetName);
      await deployAgentSource({
        tenantId,
        input: { name: picked.name, systemPrompt: source.systemPrompt, slug },
      });
    }
  } catch (cause) {
    throw failure(cause, "deploy", tenantId);
  }

  if (input.openingMessage !== undefined && input.openingMessage !== "") {
    try {
      const participants = await listWorkbenchParticipants(tenantId, domain);
      const agents = participants.filter((participant) => participant.kind === "agent");
      // A deployment's run address exists only once the deploy settles; a
      // workbench whose agent has not surfaced yet keeps the opening message
      // for the person to send from the workbench itself.
      if (agents.length > 0) {
        await sendToWorkbench({
          workbenchTenantId: tenantId,
          participants,
          content: input.openingMessage,
        });
      }
    } catch (cause) {
      throw failure(cause, "opening-message", tenantId);
    }
  }

  return tenantId;
}

const GENERIC_RESTART_FAILURE = "Couldn't restart this agent. Try again.";

/** Allow-lists what is safe to show verbatim: only the authored stage
 * copy, never a raw request path or schema summary. */
export function describeRestartFailure(cause: unknown): string {
  if (!(cause instanceof WorkbenchCreateError)) return GENERIC_RESTART_FAILURE;
  return cause.stage === "deploy"
    ? "This agent couldn't be deployed. Try again."
    : GENERIC_RESTART_FAILURE;
}

/** A hub restart releases every process-provisioned deployment; this
 * redeploys one workbench agent through the same path `createWorkbench` used,
 * re-running it against the tenant its asset already lives in. */
export async function redeployWorkbenchAgent(
  workbenchTenantId: string,
  agent: { readonly id: string; readonly name: string; readonly assetName: string },
): Promise<void> {
  if (isMyraAgent(agent)) {
    const hub = createFetchStockHub();
    const [tenant, offering] = await Promise.all([
      hub.getTenant(workbenchTenantId),
      resolveExistingOffering(workbenchTenantId),
    ]);
    if (tenant === null) {
      throw new WorkbenchCreateError("this workbench no longer exists", "deploy");
    }
    if (offering === null) {
      throw new WorkbenchCreateError(
        "Connect a model provider in Settings before restarting Myra.",
        "deploy",
      );
    }
    const deployInput = await deployMyraSource({
      tenantId: workbenchTenantId,
      tenantDomain: tenant.domain,
      sourceOfferingIds: offering.sourceOfferingIds,
      defaultSourceOfferingId: offering.defaultSourceOfferingId,
      declaredSources: offering.declaredSources,
    });
    await hub.deployWorkflow(workbenchTenantId, deployInput);
    await authorizeMyraHubCredential({ tenantId: workbenchTenantId });
    return;
  }
  const slug = agentSlugFromSourceAssetName(agent.assetName);
  if (slug === null) {
    throw new WorkbenchCreateError(
      `${agent.assetName} isn't a recognized agent source asset`,
      "deploy",
    );
  }
  const source = await readAgentSource(workbenchTenantId, agent.id, agent.assetName);
  await deployAgentSource({
    tenantId: workbenchTenantId,
    input: { name: agent.name, systemPrompt: source.systemPrompt, slug },
  });
}
