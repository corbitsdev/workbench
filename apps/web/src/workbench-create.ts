// Creating a workbench is creating a child tenant and deploying an agent
// into it: the stock member invite only takes a real user's email, and a
// child tenant's deploy route rejects the parent's inherited asset, so an
// agent joins a room by being deployed there — with the child's own
// resolved offering, which does inherit.

import { isMyraAgent, listRoomParticipants, sendToRoom } from "@/chat/threads-api";
import { agentSlugFromSourceAssetName, deployAgentSource } from "./agent-deploy";
import { readAgentSource } from "./agent-source-read";
import { deployMyraSource } from "./myra-deploy";
import { createFetchStockHub } from "./needs-converge";
import { resolveExistingOffering } from "./onboarding/provider-connect-step";

export class WorkbenchCreateError extends Error {
  constructor(
    message: string,
    readonly stage: "create" | "deploy" | "opening-message",
    /** Set once the room tenant exists, so a later-stage failure can
     * still land the person in the room it created. */
    readonly tenantId?: string,
  ) {
    super(message);
    this.name = "WorkbenchCreateError";
  }
}

/** Slugs are tenant-unique and immutable, so a name alone cannot mint one:
 * the timestamp suffix is what keeps two rooms of the same name apart. */
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
  /** Existing bench agents to re-deploy into the room alongside Myra:
   * their source asset id, name, and asset name (for reading it back). */
  readonly pickedAgents?: readonly {
    readonly id: string;
    readonly name: string;
    readonly assetName: string;
  }[];
};

/** Returns the new room's tenant id — its deep link is `/w/<id>`. */
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

    // Each picked bench agent joins the room the same way Myra does: its
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
      const participants = await listRoomParticipants(tenantId);
      const agents = participants.filter((participant) => participant.kind === "agent");
      // A deployment's run address exists only once the deploy settles; a
      // room whose agent has not surfaced yet keeps the opening message
      // for the person to send from the room itself.
      if (agents.length > 0) {
        await sendToRoom({ roomTenantId: tenantId, participants, content: input.openingMessage });
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
 * redeploys one room agent through the same path `createWorkbench` used,
 * re-running it against the tenant its asset already lives in. */
export async function redeployRoomAgent(
  roomTenantId: string,
  agent: { readonly id: string; readonly name: string; readonly assetName: string },
): Promise<void> {
  if (isMyraAgent(agent)) {
    const hub = createFetchStockHub();
    const [tenant, offering] = await Promise.all([
      hub.getTenant(roomTenantId),
      resolveExistingOffering(roomTenantId),
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
      tenantId: roomTenantId,
      tenantDomain: tenant.domain,
      sourceOfferingIds: offering.sourceOfferingIds,
      defaultSourceOfferingId: offering.defaultSourceOfferingId,
      declaredSources: offering.declaredSources,
    });
    await hub.deployWorkflow(roomTenantId, deployInput);
    return;
  }
  const slug = agentSlugFromSourceAssetName(agent.assetName);
  if (slug === null) {
    throw new WorkbenchCreateError(
      `${agent.assetName} isn't a recognized agent source asset`,
      "deploy",
    );
  }
  const source = await readAgentSource(roomTenantId, agent.id, agent.assetName);
  await deployAgentSource({
    tenantId: roomTenantId,
    input: { name: agent.name, systemPrompt: source.systemPrompt, slug },
  });
}
