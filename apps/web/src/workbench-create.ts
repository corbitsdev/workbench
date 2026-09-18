// Creating a workbench is creating a child tenant and deploying an agent
// into it: the stock member invite only takes a real user's email, and a
// child tenant's deploy route rejects the parent's inherited asset, so an
// agent joins a room by being deployed there — with the child's own
// resolved offering, which does inherit.

import { listRoomParticipants, sendToRoom } from "@/chat/threads-api";
import { deployMyraSource } from "./myra-deploy";
import { createFetchStockHub } from "./needs-converge";
import { resolveExistingOffering } from "./onboarding/provider-connect-step";
import { publishToolPackageRegistry } from "./tools/registry-publish";

export class WorkbenchCreateError extends Error {
  constructor(
    message: string,
    readonly stage: "create" | "deploy" | "opening-message",
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

function failure(cause: unknown, stage: WorkbenchCreateError["stage"]): WorkbenchCreateError {
  return new WorkbenchCreateError(cause instanceof Error ? cause.message : String(cause), stage);
}

export type CreateWorkbenchInput = {
  readonly benchTenantId: string;
  readonly name: string;
  readonly openingMessage?: string;
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
    // Myra's tool pins resolve from the room's own registry, so the
    // packages have to be there before her definition deploys.
    await publishToolPackageRegistry(tenantId);
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
  } catch (cause) {
    throw failure(cause, "deploy");
  }

  if (input.openingMessage !== undefined && input.openingMessage !== "") {
    try {
      const participants = await listRoomParticipants(tenantId);
      const agents = participants.filter((participant) => participant.kind === "agent");
      // A deployment's run address exists only once the deploy settles; a
      // room whose agent has not surfaced yet keeps the opening message
      // for the person to send from the room itself.
      if (agents.length > 0) {
        await sendToRoom({ roomTenantId: tenantId, agents, content: input.openingMessage });
      }
    } catch (cause) {
      throw failure(cause, "opening-message");
    }
  }

  return tenantId;
}
