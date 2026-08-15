// Myra-backed `RoutineDraftingPort` (CL-5917): turns a free-text
// description into a machine-checked routine draft via one one-shot
// Myra call, mirroring `@corbits/task-planner`'s `TaskSpec` pattern —
// inventory assembly, a strict reply schema, and fail-closed
// validation against the inventory that was actually offered. Every
// failure mode — Myra unresolvable, the run timing out or failing, an
// unparseable reply, an out-of-inventory reference — propagates as
// its own honest, specific error; nothing here fabricates a draft or
// falls back to an empty proposal.
import { type } from "arktype";

import type { OneShotReply } from "@corbits/folded-runs";
import {
  validateTriggerFieldsInput,
  type WorkflowTriggerField,
} from "@corbits/workflow-catalog";

import { DraftedStepSchema, type RoutineDraftingPort } from "./drafts";
import { RoutineScheduleTrigger } from "./trigger";

const DEFAULT_DRAFTING_TIMEOUT_MS = 60_000;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_REPLY_EXCERPT = 400;

// --- inventory ---

export type RoutineDraftInventoryWorkflow = {
  readonly definitionId: string;
  readonly assetName: string;
  readonly displayName: string;
  readonly deliveryMode: "channel" | "inbox";
  readonly triggerFields: readonly WorkflowTriggerField[];
  readonly description?: string;
};

export type RoutineDraftInventoryAgent = {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
};

export type RoutineDraftInventory = {
  readonly workflows: readonly RoutineDraftInventoryWorkflow[];
  readonly agents: readonly RoutineDraftInventoryAgent[];
};

/**
 * Host-injected listers, mirroring `@corbits/task-planner`'s own
 * `InventorySources` seam: this package owns the inventory's shape and
 * assembly, never the listing logic — a tenant's automatable catalog
 * workflows and taskable agents are each already owned elsewhere
 * (`apps/hub`'s `workflowDefinition` queries).
 */
export type RoutineDraftInventorySources = {
  listAutomatableWorkflows(
    tenantId: string,
  ): Promise<readonly RoutineDraftInventoryWorkflow[]>;
  listTaskableAgents(
    tenantId: string,
  ): Promise<readonly RoutineDraftInventoryAgent[]>;
};

/**
 * Mirrors `@corbits/task-planner`'s own `sanitize-inventory-text.ts`
 * exactly (not imported from there — that helper is not part of
 * task-planner's public barrel, and this package has no other reason
 * to depend on task-planner). Same defense-in-depth: strip
 * newlines/control characters and truncate, so a free-text description
 * can't pad the prompt with an oversized block of imperative text.
 */
function sanitizeInventoryText(raw: string, maxLen: number): string {
  const singleLine = raw
    .replace(/[\r\n\t\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > maxLen ? singleLine.slice(0, maxLen) : singleLine;
}

/** Builds the inventory Myra is offered for one drafting call. Kept
 * compact and JSON-serializable — this rides inside an LLM prompt. */
export async function assembleRoutineDraftInventory(
  sources: RoutineDraftInventorySources,
  tenantId: string,
): Promise<RoutineDraftInventory> {
  const [workflows, agents] = await Promise.all([
    sources.listAutomatableWorkflows(tenantId),
    sources.listTaskableAgents(tenantId),
  ]);

  return {
    workflows: workflows.map((workflow) => ({
      ...workflow,
      ...(workflow.description !== undefined
        ? {
            description: sanitizeInventoryText(
              workflow.description,
              MAX_DESCRIPTION_LENGTH,
            ),
          }
        : {}),
    })),
    agents: agents.map((agent) => ({
      ...agent,
      ...(agent.description !== undefined
        ? {
            description: sanitizeInventoryText(
              agent.description,
              MAX_DESCRIPTION_LENGTH,
            ),
          }
        : {}),
    })),
  };
}

// --- reply contract ---

/**
 * Myra's reply shape: proposed steps, an optional suggested name, an
 * optional catalog workflow pick, a cadence decision (a schedule
 * preset or `null` for a manual, run-now-only routine — required,
 * never omitted, so a draft always states its scheduling intent
 * explicitly), and trigger-field values for the picked workflow when
 * it declares any. Reuses `DraftedStepSchema` (`./drafts.ts`) and
 * `RoutineScheduleTrigger` (`./trigger.ts`) verbatim — the same
 * schedule-only shapes the rest of the drafting pipeline validates
 * against, never a parallel definition. Deliberately
 * `RoutineScheduleTrigger`, not the full `RoutineTrigger` union: a
 * webhook binding names a real `@corbits/webhook-triggers` row this
 * package never offered Myra, so the schema itself makes that reply
 * shape unparseable rather than relying on inventory validation to
 * catch it after the fact.
 */
export const RoutineDraftReply = type({
  steps: DraftedStepSchema.array().atLeastLength(1),
  "name?": "string > 0",
  "definitionId?": "string > 0",
  cadence: RoutineScheduleTrigger,
  "triggerInput?": "Record<string, string>",
});
export type RoutineDraftReply = typeof RoutineDraftReply.infer;

function excerpt(raw: string): string {
  return raw.length > MAX_REPLY_EXCERPT
    ? `${raw.slice(0, MAX_REPLY_EXCERPT)}…`
    : raw;
}

export class RoutineDraftReplyUnparseableError extends Error {
  constructor(reason: string, raw: string) {
    super(
      `Myra's reply couldn't be read as a routine draft: ${reason} ` +
        `(reply excerpt: ${excerpt(raw)})`,
    );
    this.name = "RoutineDraftReplyUnparseableError";
  }
}

export class RoutineDraftReferenceOutOfInventoryError extends Error {
  constructor(field: string, reference: string) {
    super(
      `Myra's draft named "${reference}" for "${field}", which was never ` +
        "offered in the inventory",
    );
    this.name = "RoutineDraftReferenceOutOfInventoryError";
  }
}

export class MyraRoutineDraftingUnavailableError extends Error {
  constructor(tenantId: string, reason: string) {
    super(`Myra isn't available for tenant "${tenantId}": ${reason}`);
    this.name = "MyraRoutineDraftingUnavailableError";
  }
}

/** Parses `raw` as a `RoutineDraftReply`, throwing
 * `RoutineDraftReplyUnparseableError` on malformed JSON or a shape
 * that doesn't match — including an invalid cadence (bad cron, an
 * impossible schedule, a bad timezone), since `cadence` embeds the
 * same strict `RoutineTrigger` union create/update request bodies are
 * validated against. Never partially trusts a near-miss. */
export function parseRoutineDraftReply(raw: string): RoutineDraftReply {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RoutineDraftReplyUnparseableError("not valid JSON", raw);
  }
  const parsed = RoutineDraftReply(json);
  if (parsed instanceof type.errors) {
    throw new RoutineDraftReplyUnparseableError(parsed.summary, raw);
  }
  return parsed;
}

/**
 * Asserts every reference a validated-shape `RoutineDraftReply` makes
 * actually appears in `inventory` — the inventory that was actually
 * offered to Myra. Throws `RoutineDraftReferenceOutOfInventoryError` on
 * the first violation found: an out-of-catalog `definitionId`, trigger
 * input that doesn't satisfy the picked workflow's own declared
 * `triggerFields` contract (shape, then — for an `"agent"`-kind field —
 * that the value is an agent id actually offered), or trigger input
 * given with no workflow picked to validate it against. No return
 * value — a pure assertion, exactly like
 * `validateTaskSpecAgainstInventory`.
 */
export function validateRoutineDraftReplyAgainstInventory(
  reply: RoutineDraftReply,
  inventory: RoutineDraftInventory,
): void {
  let workflow: RoutineDraftInventoryWorkflow | undefined;
  if (reply.definitionId !== undefined) {
    workflow = inventory.workflows.find(
      (entry) => entry.definitionId === reply.definitionId,
    );
    if (workflow === undefined) {
      throw new RoutineDraftReferenceOutOfInventoryError(
        "definitionId",
        reply.definitionId,
      );
    }
  }

  if (reply.triggerInput === undefined) return;

  if (workflow === undefined) {
    throw new RoutineDraftReferenceOutOfInventoryError(
      "triggerInput",
      "no definitionId was picked to validate trigger input against",
    );
  }

  const shapeResult = validateTriggerFieldsInput(
    workflow.triggerFields,
    reply.triggerInput,
  );
  if (!shapeResult.ok) {
    throw new RoutineDraftReferenceOutOfInventoryError(
      "triggerInput",
      shapeResult.message,
    );
  }

  const agentIds = new Set(inventory.agents.map((agent) => agent.id));
  for (const field of workflow.triggerFields) {
    if (field.kind !== "agent") continue;
    const value = reply.triggerInput[field.key];
    if (typeof value !== "string" || value === "") continue;
    if (!agentIds.has(value)) {
      throw new RoutineDraftReferenceOutOfInventoryError(
        `triggerInput.${field.key}`,
        value,
      );
    }
  }
}

// --- port ---

export type RoutineDraftingRunnerDeps = {
  /** `resolveMyraDefinitionIdFromDb` (`@corbits/task-planner`) in
   * production — a host-supplied function so this package never
   * depends on task-planner for a type it can express itself. */
  readonly resolveMyraDefinitionId: (tenantId: string) => Promise<string>;
  /** `runOneShotFoldedPrompt` in production — the one boundary tests
   * stub, never live inference. */
  readonly runner: {
    run(input: {
      readonly tenantId: string;
      readonly principalId: string;
      readonly definitionId: string;
      readonly prompt: string;
      readonly timeoutMs: number;
    }): Promise<OneShotReply>;
  };
  readonly inventorySources: RoutineDraftInventorySources;
  readonly timeoutMs?: number;
};

function buildRoutineDraftPrompt(
  description: string,
  inventory: RoutineDraftInventory,
): string {
  return [
    "A person typed the following description for you to turn into a",
    "routine — a scheduled or on-demand automation — for their review",
    "before anything is created:",
    "",
    JSON.stringify(description),
    "",
    "Here is everything you may reference, as JSON:",
    JSON.stringify(inventory),
    "",
    "Reply with ONLY a JSON object — no prose, no markdown fences — shaped",
    "exactly like this:",
    '  {"steps": [{"title": "<a short step title>", "detail": "<optional detail>"}, ...], "name": "<optional short routine name>", "definitionId": "<optional workflow id from inventory.workflows, verbatim>", "cadence": <a cadence object below, or null>, "triggerInput": {"<field key>": "<value>", ...}}',
    "",
    "cadence is REQUIRED — null for a manual, run-now-only routine, or",
    "exactly one of:",
    '  {"kind": "interval", "unit": "minutes" | "hours", "every": <positive integer>}',
    '  {"kind": "daily", "hour": <0-23>, "minute": <0-59>}',
    '  {"kind": "weekly", "dayOfWeek": <0-6, 0=Sunday>, "hour": <0-23>, "minute": <0-59>}',
    '  {"kind": "cron", "expression": "<5-field cron expression>"}',
    "",
    "Only include triggerInput when you picked a definitionId whose",
    "inventory entry declares triggerFields — its keys and values must",
    'match that entry\'s triggerFields exactly: a "text"-kind field takes',
    'any non-empty string; an "agent"-kind field\'s value MUST be an',
    "agent id from inventory.agents, verbatim.",
    "",
    "Every definitionId and every agent id you use MUST come from the",
    "inventory above, verbatim. Never invent one — if nothing in the",
    "inventory fits the description, omit definitionId and triggerInput",
    "entirely rather than guessing.",
  ].join("\n");
}

/**
 * Builds a `RoutineDraftingPort` backed by one one-shot Myra call:
 * resolve Myra's definition for the tenant, assemble the inventory she
 * may reference, ask her to turn the description into a
 * `RoutineDraftReply`, and never trust that reply beyond what
 * `parseRoutineDraftReply` and `validateRoutineDraftReplyAgainstInventory`
 * can prove about it.
 */
export function createMyraRoutineDrafting(
  deps: RoutineDraftingRunnerDeps,
): RoutineDraftingPort {
  return {
    async propose({ tenantId, principalId, prompt }) {
      let definitionId: string;
      try {
        definitionId = await deps.resolveMyraDefinitionId(tenantId);
      } catch (err) {
        throw new MyraRoutineDraftingUnavailableError(
          tenantId,
          err instanceof Error ? err.message : String(err),
        );
      }

      const inventory = await assembleRoutineDraftInventory(
        deps.inventorySources,
        tenantId,
      );

      const draftPrompt = buildRoutineDraftPrompt(prompt, inventory);

      const reply = await deps.runner.run({
        tenantId,
        principalId,
        definitionId,
        prompt: draftPrompt,
        timeoutMs: deps.timeoutMs ?? DEFAULT_DRAFTING_TIMEOUT_MS,
      });

      const parsed = parseRoutineDraftReply(reply.content);
      validateRoutineDraftReplyAgainstInventory(parsed, inventory);

      return {
        steps: parsed.steps,
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        trigger: parsed.cadence,
        ...(parsed.definitionId !== undefined
          ? { definitionId: parsed.definitionId }
          : {}),
        ...(parsed.triggerInput !== undefined
          ? { autonomy: { triggerInput: parsed.triggerInput } }
          : {}),
      };
    },
  };
}
