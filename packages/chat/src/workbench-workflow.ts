// The workbench host workflow: the folded, single-agent definition whose
// long-lived interactive run IS a workbench. It launches credential-free
// exactly like `workflows/echo`'s definition (see the empirical spike
// this rework is grounded in), and holds the workbench's shared mailbox
// as the anchor every participant's mail lands in. It performs no
// relaying of its own: `routes.ts` sends the caller's message to the
// anchor for the record, then fans mentioned participants their own
// copies directly through the platform port. No `onTrigger`/`action`
// relay DAG lives here anymore.
//
// This package is installable data. It imports only published
// platform packages, and nothing imports it statically: a host
// publishes the serialized definition as a workflow asset and deploys
// it through the platform's deploy machinery; the execution host
// materializes it at runtime from the deploy alone.
//
// Modeled directly on `workflows/echo`'s `buildEchoWorkflow`/
// `serializeEchoWorkflow` split: a single mail-triggered agent step,
// the shape a folded interactive instance launch requires.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export const WORKBENCH_HOST_WORKFLOW_ID = "wf_workbench_host";
export const WORKBENCH_HOST_STEP_ID = "host";

export const WORKBENCH_HOST_SYSTEM_PROMPT =
  "You are a workbench anchor. You exist only to hold this workbench's " +
  "shared mailbox and conversation record on behalf of its " +
  "participants. Never reply, comment, summarize, or take any action " +
  "on anything sent to you.";

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific workbench instance's inbox — a
 * workbench is an interactive instance launch of this definition — so a
 * definition built here is per-workbench by construction.
 */
export interface WorkbenchHostWorkflowInput {
  /** The workbench's mail address; every mail to it is a run occurrence. */
  readonly triggerAddress: string;
  /**
   * Provider/model preferences, in order. The anchor never actually
   * performs inference (its system prompt forbids replying), so this
   * may be omitted; when present it is resolved the same way `echo`'s
   * is, at deploy time.
   */
  readonly inferencePreferences?: readonly InferencePreference[];
  /** Per-occurrence timeout in milliseconds, enforced on the host step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the workbench host definition. Exactly one step, mirroring
 * `buildEchoWorkflow`: the single-step shape is what makes a folded
 * instance launch conversational (the execution host keeps one warm
 * agent with durable memory across runs), which is what lets the
 * anchor's run stay the workbench's one long-lived timeline.
 */
export function buildWorkbenchHostWorkflow(
  input: WorkbenchHostWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildWorkbenchHostWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildWorkbenchHostWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: WORKBENCH_HOST_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [WORKBENCH_HOST_STEP_ID]: step({
        agent: defineAgent({
          id: WORKBENCH_HOST_STEP_ID,
          description: "Holds a workbench's shared mailbox as its anchor run",
          systemPrompt: WORKBENCH_HOST_SYSTEM_PROMPT,
          tools: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences ?? [] },
        }),
        timeout: input.turnTimeoutMs,
        triggers: "unbounded",
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
 *
 * `assertJsonPortable` is deliberately re-implemented here rather than
 * imported: `workflows/echo`'s copy is module-private, and this
 * package must not reach into another package's internals to get it.
 */
export function serializeWorkbenchHostWorkflow(
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
