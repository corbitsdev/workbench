// Assembles the compact "here is everything you may reference" fact sheet
// that rides inside the planner prompt. Every source is host-injected —
// this package owns only the shape and assembly, never the listing logic.
// Memory folds into `listUsableToolPackages` as an ordinary tool package
// pin, but `memoryAvailable` is still surfaced as its own top-level fact
// so the planner prompt can state it plainly.

import type { CredentialBinding } from "@intx/types";
import { sanitizeInventoryText } from "./sanitize-inventory-text";

const MAX_DESCRIPTION_LENGTH = 200;

export type InventoryAgent = {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
};

export type InventoryToolPackage = {
  readonly name: string;
  readonly connectorId: string;
  /** The credential a definition pinning this tool package must be
   * granted; `null` when no per-tenant credential is needed. */
  readonly credentialBinding: CredentialBinding | null;
};

export type InventorySkill = {
  readonly name: string;
  readonly description?: string;
};

export type InventoryModel = {
  readonly canonicalName: string;
  readonly displayName?: string;
};

export type PlannerInventory = {
  readonly agents: readonly InventoryAgent[];
  readonly toolPackages: readonly InventoryToolPackage[];
  readonly skills: readonly InventorySkill[];
  readonly memoryAvailable: boolean;
  readonly models: readonly InventoryModel[];
};

export type InventorySources = {
  listConversationalAgents(tenantId: string): Promise<readonly InventoryAgent[]>;
  listUsableToolPackages(tenantId: string): Promise<readonly InventoryToolPackage[]>;
  listSkills(caller: { tenantId: string; principalId: string }): Promise<readonly InventorySkill[]>;
  /** A process-level fact, not a per-call lookup — memory is either
   * compiled into this deployment or it isn't. */
  readonly memoryAvailable: boolean;
  listModels(tenantId: string): Promise<readonly InventoryModel[]>;
};

/** Builds the inventory Myra is offered for one planning call. Kept compact
 * and JSON-serializable, since this rides inside an LLM prompt. */
export async function assembleInventory(
  sources: InventorySources,
  caller: { tenantId: string; principalId: string },
): Promise<PlannerInventory> {
  const [agents, toolPackages, skills, models] = await Promise.all([
    sources.listConversationalAgents(caller.tenantId),
    sources.listUsableToolPackages(caller.tenantId),
    sources.listSkills(caller),
    sources.listModels(caller.tenantId),
  ]);

  return {
    agents: agents.map((agent) =>
      agent.description !== undefined
        ? {
            ...agent,
            description: sanitizeInventoryText(agent.description, MAX_DESCRIPTION_LENGTH),
          }
        : agent,
    ),
    toolPackages,
    skills: skills.map((skill) =>
      skill.description !== undefined
        ? {
            ...skill,
            description: sanitizeInventoryText(skill.description, MAX_DESCRIPTION_LENGTH),
          }
        : skill,
    ),
    memoryAvailable: sources.memoryAvailable,
    models,
  };
}
