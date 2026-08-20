// An agent participant's definition, shaped as a long-lived `onTrigger`
// section keyed on the workbench it was invited into (CL-6329). One warm
// run per (agent, workbench); every message asking that agent for a turn
// is one occurrence of the section, and an occurrence runs the body as
// its own child run with its own run id and event log — which is what
// makes a reply traceable at all. The workbench host's own definition
// (`./workbench-workflow.ts`) stays a plain unbounded agent step: it
// holds a mailbox, it never takes turns.
//
// `onBodyFailure: "continue"` is the whole failure edge: a turn that
// ends `failed` records the failed occurrence and leaves the section
// subscribed, so one bad turn never kills the agent or the room. The
// dispatch seam turns that failure into a visible failed-turn message on
// the timeline rather than silence.
//
// Grounded in the CL-6323 spike (`cl-6323-spike-room-turn`), which
// proved this shape deploys through the existing single-step path.
import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, onTrigger, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

import { localPartOf } from "./agent-address";

/**
 * The section's step id. The runtime names an occurrence's child run
 * `<sectionId>__<eventIndex>` (see `runOnTrigger` in the workflow
 * runtime), so this constant plus the occurrence index is the whole
 * derivation of a turn's run id.
 */
export const AGENT_TURN_SECTION_ID = "turn";

/** The body step inside one occurrence — the agent that answers. */
export const AGENT_TURN_BODY_STEP_ID = "reply";

/**
 * The child run id occurrence `occurrence` runs under. Occurrences are
 * zero-based and sequential per section run, exactly as the runtime
 * assigns them.
 */
export function agentTurnChildRunId(occurrence: number): string {
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new Error(
      "agentTurnChildRunId requires a non-negative integer occurrence",
    );
  }
  return `${AGENT_TURN_SECTION_ID}__${String(occurrence)}`;
}

/** Workflow ids are identifiers, and addresses and workbench ids are not. */
function identifierPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}

/**
 * The section's workflow id — keyed on (agent, workbench), so the same
 * agent invited into two workbenches gets two independent warm runs and
 * neither one's turns can be mistaken for the other's.
 */
export function agentTurnWorkflowId(input: {
  readonly workbenchId: string;
  readonly agentAddress: string;
}): string {
  return `wf_agent_turn_${identifierPart(input.workbenchId)}_${identifierPart(
    localPartOf(input.agentAddress),
  )}`;
}

export interface AgentTurnWorkflowInput {
  readonly workbenchId: string;
  /** The agent's own mail address; every mail to it is one occurrence. */
  readonly agentAddress: string;
  readonly systemPrompt: string;
  /** Resolved catalog sources, in order; the deploy gate approves these. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-occurrence timeout, enforced on the body's one step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds an agent participant's section definition: one step, an
 * `onTrigger` section on the agent's own address, whose body is the
 * single agent step that answers one message.
 */
export function buildAgentTurnWorkflow(
  input: AgentTurnWorkflowInput,
): WorkflowDefinition {
  if (input.agentAddress === "") {
    throw new Error("buildAgentTurnWorkflow requires an agentAddress");
  }
  if (input.workbenchId === "") {
    throw new Error("buildAgentTurnWorkflow requires a workbenchId");
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildAgentTurnWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }

  const workflowId = agentTurnWorkflowId({
    workbenchId: input.workbenchId,
    agentAddress: input.agentAddress,
  });
  const body = defineWorkflow({
    id: `${workflowId}_body`,
    trigger: { type: "mail", to: input.agentAddress },
    steps: {
      [AGENT_TURN_BODY_STEP_ID]: step({
        agent: defineAgent({
          id: AGENT_TURN_BODY_STEP_ID,
          description: "Answers one workbench message",
          systemPrompt: input.systemPrompt,
          tools: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
        }),
        timeout: input.turnTimeoutMs,
      }),
    },
  });

  return defineWorkflow({
    id: workflowId,
    trigger: { type: "mail", to: input.agentAddress },
    steps: {
      [AGENT_TURN_SECTION_ID]: onTrigger({
        on: { type: "mail", to: input.agentAddress },
        body,
        onBodyFailure: "continue",
      }),
    },
  });
}
