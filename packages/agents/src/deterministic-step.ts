import { type } from "arktype";
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

/**
 * Tag carrying the JSON-serialized `argMap` (a controlled producer/consumer
 * pair: `deterministicToolStep` writes it, the sidecar's
 * `runDeterministicToolStep` reads + re-validates it). Tags are
 * `Record<string,string>`, so the map is stringified.
 */
export const STEP_ARGMAP_TAG = "workbench.argMap";

/**
 * Per-tool-argument reshape spec. Maps a TOOL argument name to either a
 * top-level field on the evaluated step input (`{ from: 'fieldName' }`) or a
 * JSON-serializable constant (`{ literal: value }`). Must be
 * JSON-serializable: the workflow definition is JSON-deployed, so no
 * functions.
 */
export const ArgMapSpec = type({ from: "string" }).or({ literal: "unknown" });
export type ArgMapSpec = typeof ArgMapSpec.infer;

export const ArgMap = type({ "[string]": ArgMapSpec });
export type ArgMap = typeof ArgMap.infer;

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
  /**
   * Optional reshape from the evaluated step input to the tool's arguments.
   * Each key is a TOOL argument name; the value pulls a top-level field off
   * the evaluated input (`{ from }`) or supplies a constant (`{ literal }`).
   * When absent, the evaluated input is passed verbatim as the tool args.
   */
  argMap?: ArgMap;
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
      ...(opts.argMap !== undefined
        ? { [STEP_ARGMAP_TAG]: JSON.stringify(opts.argMap) }
        : {}),
    },
  });
  return step({
    agent,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  });
}
