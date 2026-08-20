// The spike room definition (CL-6323 Phase 0): one living workflow run
// per room whose single step is an `onTrigger` section. Every message
// mailed to the room address is one occurrence, and each occurrence runs
// the section body as its own child run with its own run id and its own
// event log — the "turn = child run" half of the spike.
//
// Contrast the production chat host (`workbench-workflow.ts`), whose one
// step is a plain unbounded agent step: there, every turn shares the
// host run's identity, so a reply has no run id to carry.

import { defineAgent } from "@intx/agent";
import type { InferencePreference } from "@intx/agent";
import { defineWorkflow, onTrigger, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

/** The section's step id; a turn's child run id is `<id>__<n>`. */
export const SPIKE_ROOM_SECTION_ID = "turn";

export type SpikeRoomWorkflowInput = {
  readonly roomRunId: string;
  readonly triggerAddress: string;
  readonly systemPrompt: string;
  /** Resolved catalog sources, in order; the deploy gate approves these. */
  readonly inferencePreferences: readonly InferencePreference[];
  readonly turnTimeoutMs: number;
};

/** The child run id an occurrence at `eventIndex` runs under. */
export function spikeTurnChildRunId(eventIndex: number): string {
  return `${SPIKE_ROOM_SECTION_ID}__${String(eventIndex)}`;
}

export function buildSpikeRoomWorkflow(
  input: SpikeRoomWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error("buildSpikeRoomWorkflow requires a triggerAddress");
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildSpikeRoomWorkflow requires a positive integer turnTimeoutMs",
    );
  }
  const bodyStepId = "reply";
  const body = defineWorkflow({
    id: `wf_spike_room_turn_${input.roomRunId}`,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [bodyStepId]: step({
        agent: defineAgent({
          id: bodyStepId,
          description: "Answers one room message",
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
    id: `wf_spike_room_${input.roomRunId}`,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [SPIKE_ROOM_SECTION_ID]: onTrigger({
        on: { type: "mail", to: input.triggerAddress },
        body,
      }),
    },
  });
}
