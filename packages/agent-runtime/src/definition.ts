// Builds the workflow definition a workbench agent run executes, from
// the run's deploy-time config alone.
//
// Two shapes, selected by `config.mode`, never by a branch in the deploy
// API: the deploy front takes one parameter set and the shape is purely
// whatever this module evaluates to.
//
// `step` is the folded conversational run — one unbounded agent step
// servicing every inbound mail as another turn. Its `triggers:
// "unbounded"` budget is the whole reason this is authored rather than
// wrapped: the platform's default budget of 1 makes a run go silent
// after its first reply.
//
// `section` is the per-turn shape (CL-6329) — an `onTrigger` section
// whose body is one agent step, so every message becomes an occurrence
// with its own child run id and event log.
//
// [Intx gap] CL-6329's `onBodyFailure: "continue"` policy — the failure
// edge that keeps a section subscribed after a failed turn — does not
// exist at the vendored pin `4ed8baf4`: `OnTriggerOpts` carries no such
// field and the inert projector's onTrigger whitelist
// (`vendor/intx/workflow/src/live-inert-projector.ts`) has no slot for
// it. Section mode is therefore authored without it here rather than
// with a workbench-local reimplementation of the primitive. When
// upstream lands the field, it is authored HERE — the projection drops
// it, so it survives only because the run child re-evaluates this
// module from the closure, and nothing may ever treat the projection as
// the executable definition.
import { buildSingleStepAgentDefinition } from "@intx/workflow-deploy";
import { defineWorkflow, onTrigger, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

import type { AgentRuntimeConfig } from "./config";

/** The step id of the folded conversational run's one step. */
export const AGENT_RUNTIME_STEP_ID = "default";

/** The section's step id in `section` mode. */
export const AGENT_RUNTIME_SECTION_ID = "turn";

/** The body step inside one section occurrence — the agent that answers. */
export const AGENT_RUNTIME_TURN_STEP_ID = "reply";

/**
 * The child run id occurrence `occurrence` runs under. The runtime names
 * an occurrence `<sectionId>__<eventIndex>` (see `onTriggerBodyRef` in
 * `@intx/workflow`), so the section id plus a zero-based occurrence
 * index is the whole derivation.
 */
export function agentRuntimeTurnRunId(occurrence: number): string {
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new Error(
      "agentRuntimeTurnRunId requires a non-negative integer occurrence",
    );
  }
  return `${AGENT_RUNTIME_SECTION_ID}__${String(occurrence)}`;
}

function buildTurnAgent(config: AgentRuntimeConfig, id: string) {
  return buildSingleStepAgentDefinition({
    id,
    systemPrompt: config.systemPrompt,
    inferencePreferences: config.inferencePreferences,
    toolFactories: [],
    toolPackagePins: config.toolPackagePins,
  });
}

function buildFoldedStepWorkflow(
  config: AgentRuntimeConfig,
  literalInput: unknown,
  hasLiteralInput: boolean,
): WorkflowDefinition {
  const steps = {
    [AGENT_RUNTIME_STEP_ID]: step({
      agent: buildTurnAgent(config, config.agentId),
      triggers: "unbounded" as const,
      ...(hasLiteralInput ? { input: { literal: literalInput } } : {}),
    }),
  };
  return config.credentialBindings.length > 0
    ? defineWorkflow({
        id: config.workflowId,
        trigger: { type: "mail", to: config.triggerAddress },
        credentialBindings: config.credentialBindings,
        steps,
      })
    : defineWorkflow({
        id: config.workflowId,
        trigger: { type: "mail", to: config.triggerAddress },
        steps,
      });
}

function buildSectionWorkflow(
  config: AgentRuntimeConfig,
  turnTimeoutMs: number,
): WorkflowDefinition {
  const body = defineWorkflow({
    id: `${config.workflowId}_body`,
    trigger: { type: "mail", to: config.triggerAddress },
    steps: {
      [AGENT_RUNTIME_TURN_STEP_ID]: step({
        agent: buildTurnAgent(config, AGENT_RUNTIME_TURN_STEP_ID),
        timeout: turnTimeoutMs,
      }),
    },
  });
  const steps = {
    [AGENT_RUNTIME_SECTION_ID]: onTrigger({
      on: { type: "mail" as const, to: config.triggerAddress },
      body,
    }),
  };
  return config.credentialBindings.length > 0
    ? defineWorkflow({
        id: config.workflowId,
        trigger: { type: "mail", to: config.triggerAddress },
        credentialBindings: config.credentialBindings,
        steps,
      })
    : defineWorkflow({
        id: config.workflowId,
        trigger: { type: "mail", to: config.triggerAddress },
        steps,
      });
}

/**
 * Build the run's definition from its deploy-time config. The config's
 * `mode` selects the shape; every other field is the same per-run data
 * either shape needs.
 */
export function buildAgentRuntimeWorkflow(
  config: AgentRuntimeConfig,
): WorkflowDefinition {
  if (config.mode.kind === "section") {
    return buildSectionWorkflow(config, config.mode.turnTimeoutMs);
  }
  return buildFoldedStepWorkflow(
    config,
    config.mode.literalInput,
    "literalInput" in config.mode,
  );
}
