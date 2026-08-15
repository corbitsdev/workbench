// The "Recurring task" workflow: a catalog placeholder, not a real
// agent turn. It exists so a task's prompt+agent has an AUTOMATABLE
// workflow definition id the Routines picker can offer and schedule —
// task-launchable definitions are conversational (excluded from the
// automatable filter by construction, see
// `apps/hub/src/index.ts`'s `isConversationalAgentDefinition`), so
// there is no other honest way for "Make this a routine" (an Inbox
// action on a completed task result) to hand the create dialog a
// definitionId that actually resolves in that picker's list.
//
// Its own step below is never actually invoked in normal operation:
// `apps/hub/src/routine-launcher.ts` recognizes this workflow's asset
// name (`RECURRING_TASK_ASSET_NAME`, `@corbits/workflow-catalog`) the
// moment a routine on it fires, and dispatches straight through
// `@corbits/tasks`' `launchTask` with the routine's stored `agent`/
// `prompt` trigger-field input instead of launching this definition's
// folded run — the exact same launch path `POST /tasks` uses, so the
// result reaches the creator's Inbox exactly like a manual task. The
// step still has to be a real, deployable definition (a valid system
// prompt, at least one step) to pass asset materialization and the
// generic "is this routine's definition deployed" checks every routine
// gets before it fires — it is simply dead code in the fire path that
// matters.
import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export const RECURRING_TASK_WORKFLOW_ID = "wf_recurring_task";
export const RECURRING_TASK_STEP_ID = "recurring-task";

export const RECURRING_TASK_SYSTEM_PROMPT =
  "You are never invoked directly — a routine on this definition is " +
  "always intercepted before it reaches you and dispatched as a task " +
  "instead. If you are ever run, reply that this path is not supported " +
  "and take no other action.";

export interface RecurringTaskWorkflowInput {
  /** The deployment's mail address; unused in practice (see module
   * doc) but still required by the mail-trigger contract every other
   * definition in this repo commits to. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the recurring-task placeholder definition. Exactly one step,
 * matching the shape every other definition in this repo commits to.
 */
export function buildRecurringTaskWorkflow(
  input: RecurringTaskWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildRecurringTaskWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildRecurringTaskWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: RECURRING_TASK_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [RECURRING_TASK_STEP_ID]: step({
        agent: defineAgent({
          id: RECURRING_TASK_STEP_ID,
          description:
            "Placeholder step for the recurring-task catalog entry — " +
            "never actually reached; see this package's module doc.",
          systemPrompt: RECURRING_TASK_SYSTEM_PROMPT,
          tools: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
        }),
        timeout: input.turnTimeoutMs,
      }),
    },
  });
}

/**
 * Serializes a definition to the JSON a workflow asset carries. The
 * definition must survive the asset round-trip byte-faithfully, so
 * anything JSON would silently drop or mangle — functions, undefined,
 * symbols, bigints, non-finite numbers, class instances — is a loud
 * error naming the offending path instead of a corrupted asset.
 */
export function serializeRecurringTaskWorkflow(
  definition: WorkflowDefinition,
): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

function assertJsonPortable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is a non-finite number; JSON drops it`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(
        `${path} is a ${typeof value}, which does not survive JSON ` +
          "serialization",
      );
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path} is a non-plain object; JSON would flatten it lossily`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}
