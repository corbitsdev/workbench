// Assembles the compact "here is everything you may reference" fact
// sheet that rides inside the planner prompt. Every source is
// host-injected (mirrors `@corbits/tasks`' `TaskLauncherDeps.isTaskableDefinition`
// seam): this package owns the shape and the assembly, never the
// listing logic itself — a tenant's usable agents, tool packages,
// skills, and models are each already owned by another package
// (`@corbits/tasks`' definition list, `@workbench/connections`'
// registry ∩ credentials, `@corbits/skills`' registry, the tenant
// model catalog route), so task-planner only defines the seam those
// listers plug into.
//
// Memory folds into `listUsableToolPackages` rather than getting its
// own lister: memory is consumed by an agent as a tool package pin
// (the memory tool package), exactly like any connector-backed tool
// package, so a host's implementation only includes that entry when
// `memoryAvailable` is true and nothing else in this module needs to
// know how memory is wired. `memoryAvailable` is still surfaced as
// its own top-level fact so the planner prompt can reason about it
// directly ("memory is available" is a fact worth stating plainly,
// not left for the model to infer from a tool package name).

export type InventoryAgent = {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
};

export type InventoryToolPackage = {
  readonly name: string;
  readonly connectorId: string;
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
  listConversationalAgents(
    tenantId: string,
  ): Promise<readonly InventoryAgent[]>;
  listUsableToolPackages(
    tenantId: string,
  ): Promise<readonly InventoryToolPackage[]>;
  listSkills(caller: {
    tenantId: string;
    principalId: string;
  }): Promise<readonly InventorySkill[]>;
  /** A process-level fact (`mountMemory() !== undefined` at hub boot),
   * not a per-call async lookup — memory is either compiled into this
   * process's deployment or it isn't, for the process's whole
   * lifetime. */
  readonly memoryAvailable: boolean;
  listModels(tenantId: string): Promise<readonly InventoryModel[]>;
};

/** Builds the inventory Myra is offered for one planning call. Kept
 * compact and JSON-serializable — this rides inside an LLM prompt, so
 * no redundant or verbose fields belong here beyond what
 * `validateTaskSpecAgainstInventory` needs to check references
 * against and what the prompt needs to describe each option. */
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
    agents,
    toolPackages,
    skills,
    memoryAvailable: sources.memoryAvailable,
    models,
  };
}
