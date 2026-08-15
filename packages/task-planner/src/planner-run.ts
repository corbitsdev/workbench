// The fail-closed core of Myra auto-dispatch: resolve Myra's own
// definition for the tenant, assemble the inventory she's allowed to
// reference, ask her to turn an outcome into a `TaskSpec`, and never
// trust that reply beyond what `parseTaskSpec` and
// `validateTaskSpecAgainstInventory` (`./task-spec.ts`) can prove about
// it. Every failure mode — Myra unresolvable, the run timing out or
// failing, an unparseable reply, an out-of-inventory reference —
// propagates as its own honest, specific error; nothing here falls
// back to a default agent or partially trusts a plan.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import { WORKFLOW_CATALOG } from "@corbits/workflow-catalog";

import {
  assembleInventory,
  type InventorySources,
  type PlannerInventory,
} from "./inventory";
import {
  parseTaskSpec,
  validateTaskSpecAgainstInventory,
  type TaskSpec,
} from "./task-spec";
import type { OneShotReply } from "./one-shot-reply";

const DEFAULT_PLANNER_TIMEOUT_MS = 60_000;

/** Myra's asset name in the seeded workflow catalog — the same lookup
 * `apps/web/src/myra-channel.ts` does client-side, mirrored here for
 * the hub side where no such "resolve Myra's definitionId for this
 * tenant" function existed yet. */
const MYRA_ASSET_NAME = WORKFLOW_CATALOG.find(
  (entry) => entry.displayName === "Myra",
)?.assetName;

export class PlannerMyraUnavailableError extends Error {
  constructor(tenantId: string, reason: string) {
    super(`Myra isn't available for tenant "${tenantId}": ${reason}`);
    this.name = "PlannerMyraUnavailableError";
  }
}

export type PlannerRunDeps = {
  readonly db: DB["db"];
  /** `runOneShotFoldedPrompt` in production — the one boundary these
   * tests stub, never live inference. */
  readonly runner: {
    run(input: {
      readonly tenantId: string;
      readonly principalId: string;
      readonly definitionId: string;
      readonly prompt: string;
      readonly timeoutMs: number;
    }): Promise<OneShotReply>;
  };
  readonly inventorySources: InventorySources;
  readonly resolveMyraDefinitionId: (tenantId: string) => Promise<string>;
  readonly timeoutMs?: number;
};

export type PlannerRunResult = {
  readonly spec: TaskSpec;
  readonly plannerRunId: string;
  readonly inventory: PlannerInventory;
};

/**
 * Queries `workflowDefinition` by `name === "assistant"` (Myra's seeded
 * asset name) and `tenantId`, mirroring `@corbits/tasks`'
 * `launcher.ts`'s own `db.query.workflowDefinition.findFirst` lookup —
 * same idea, keyed on `name` instead of `id`, since there is no
 * "current tenant's Myra" foreign key anywhere else to join through.
 */
export async function resolveMyraDefinitionIdFromDb(
  db: DB["db"],
  tenantId: string,
): Promise<string> {
  if (MYRA_ASSET_NAME === undefined) {
    throw new PlannerMyraUnavailableError(
      tenantId,
      'the workflow catalog has no entry displayed as "Myra"',
    );
  }
  const row = await db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.name, MYRA_ASSET_NAME),
      eq(workflowDefinition.tenantId, tenantId),
    ),
  });
  if (row === undefined || row.status !== "deployed" || row.assetId === null) {
    throw new PlannerMyraUnavailableError(
      tenantId,
      "no deployed Myra definition was found",
    );
  }
  return row.id;
}

function buildPlannerPrompt(
  outcome: string,
  inventory: PlannerInventory,
): string {
  return [
    "A person typed the following outcome for you to turn into a task plan:",
    "",
    JSON.stringify(outcome),
    "",
    "Here is everything you may reference, as JSON:",
    JSON.stringify(inventory),
    "",
    "Reply with ONLY a JSON object — no prose, no markdown fences — shaped",
    "exactly like one of these two forms:",
    '  {"use": "<agent id from inventory.agents>", "refinedOutcome": "<a clear restatement of the outcome for that agent>"}',
    '  {"create": {"name": "<a short name>", "systemPrompt": "<the new agent\'s system prompt>", "toolPackagePins": ["<tool package names from inventory.toolPackages, or []>"], "skills": ["<skill names from inventory.skills, or []>"], "modelPreference": "<optional, a canonical model name from inventory.models>"}, "refinedOutcome": "<a clear restatement of the outcome for the new agent>"}',
    "",
    "Every agent id, tool package name, skill name, and model name you use",
    "MUST come from the inventory above, verbatim. Never invent one.",
  ].join("\n");
}

export async function runPlanner(
  deps: PlannerRunDeps,
  input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly outcome: string;
  },
): Promise<PlannerRunResult> {
  const definitionId = await deps.resolveMyraDefinitionId(input.tenantId);

  const inventory = await assembleInventory(deps.inventorySources, {
    tenantId: input.tenantId,
    principalId: input.principalId,
  });

  const prompt = buildPlannerPrompt(input.outcome, inventory);

  const reply = await deps.runner.run({
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId,
    prompt,
    timeoutMs: deps.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS,
  });

  const spec = parseTaskSpec(reply.content);
  validateTaskSpecAgainstInventory(spec, inventory);

  return { spec, plannerRunId: reply.runId, inventory };
}
