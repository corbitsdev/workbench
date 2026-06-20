import { defineAgent } from "@intx/agent";
import { step } from "@intx/workflow";
import type { StepPrimitive, Selector } from "@intx/workflow";
import { canonicalizeToolNames } from "./tool-names";

/**
 * Marker tags the sidecar's step invoker reads to dispatch a step as a
 * deterministic tool call instead of an inference turn.
 */
export const STEP_KIND_TAG = "workbench.stepKind";
export const STEP_TOOL_TAG = "workbench.tool";
export const DETERMINISTIC_TOOL_KIND = "deterministic-tool";

export interface DeterministicToolStepOpts {
  /**
   * Unique step-agent id. Must be distinct per step — the persisted step
   * agent rows + grants are keyed by this id (mirror the existing agents'
   * id'ing convention).
   */
  id: string;
  /** Tool to invoke. Canonicalized to the runtime (prefixed) name. */
  tool: string;
  /** Optional input selector resolved by the runtime and passed as the tool args. */
  input?: Selector;
  /** Step ids this step depends on. */
  after?: readonly string[];
}

/**
 * Declare a workflow step as a deterministic tool call: a tool/API invocation
 * the substrate runs WITHOUT the reactor or any inference. The placeholder
 * agent carries no inference source (the reactor never runs) but keeps the
 * tool in `capabilities` so CL-2199's grants.json + tool-manifest pin and
 * materialize it. The sidecar's step invoker detects the marker tags and
 * dispatches the tool directly against the step's loaded runner.
 */
export function deterministicToolStep(
  opts: DeterministicToolStepOpts,
): StepPrimitive {
  const [canonicalTool] = canonicalizeToolNames([opts.tool]);
  if (canonicalTool === undefined) {
    throw new Error(
      `deterministicToolStep: tool name "${opts.tool}" canonicalized to nothing`,
    );
  }
  const agent = defineAgent({
    id: opts.id,
    description: `Deterministic tool call: ${canonicalTool}`,
    systemPrompt: "",
    tools: [],
    capabilities: [canonicalTool],
    inference: { sources: [] },
    tags: {
      [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND,
      [STEP_TOOL_TAG]: canonicalTool,
    },
  });
  return step({
    agent,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  });
}
