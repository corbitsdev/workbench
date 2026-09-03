// The heartbeat workflow: the smallest possible true consumer of the
// native workflow contract, meant to run on a tight, continuous
// schedule so that the platform's scheduling and mail-trigger paths
// stay exercised in the background. It is a single-step, mail-triggered
// definition whose agent replies with a fixed, zero-content
// acknowledgement — the definition carries no per-run computation at
// all, so the run's own recorded lifecycle (its trigger time and
// completion) is the "timestamp result" this workflow exists to
// produce, not anything the agent says.
//
// Zero inference cost: the DSL has no agent-free step primitive that
// runs on the deployed host today (the `action` primitive exists in
// `@intx/workflow`, but no shipped host wires an `invokeAction`
// callback to resolve it — see VENDORED.md-adjacent research notes in
// this package's README). A deployer therefore pins this definition's
// `inferencePreferences` to the hub's `noop-inference` endpoint (see
// `packages/chat/src/noop-inference.ts` and
// `packages/seeding/src/seed.ts`'s `NOOP_MODEL_SOURCE`): the turn
// completes instantly against a constant, never reaching a real model
// provider, so running this workflow every few seconds costs nothing.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export const HEARTBEAT_WORKFLOW_ID = "wf_heartbeat";
export const HEARTBEAT_STEP_ID = "heartbeat";

export const HEARTBEAT_SYSTEM_PROMPT =
  "You are a heartbeat check. You exist only to let a run complete; " +
  "never draft a reply of your own.";

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox, so a definition
 * built here is per-deployment by construction.
 */
export interface HeartbeatWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the heartbeat definition. Exactly one step, matching the
 * shape every other definition in this repo commits to; a second step
 * would give a heartbeat run more to fail on for no benefit.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a
 * run forever. Tools are never inlined on the definition: they arrive
 * as packages on the deploy, keeping the definition pure data.
 */
export function buildHeartbeatWorkflow(
  input: HeartbeatWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildHeartbeatWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildHeartbeatWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: HEARTBEAT_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      heartbeat: step({
        agent: defineAgent({
          id: HEARTBEAT_STEP_ID,
          description:
            "Completes immediately on every trigger, proving the " +
            "scheduling and mail-trigger paths are alive",
          systemPrompt: HEARTBEAT_SYSTEM_PROMPT,
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
export function serializeHeartbeatWorkflow(
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
