import { type } from "arktype";
import { defineAgent } from "@intx/agent";
import { step } from "@intx/workflow";
import type { StepPrimitive, Selector, RetryPolicy } from "@intx/workflow";
import { canonicalizeStepToolName } from "./tool-names";
import { LLM_PROVIDER } from "./constants";
import { withCorbitsVocabulary } from "./corbits-vocabulary";

/**
 * Marker tags the sidecar's step invoker reads to dispatch a step as a
 * deterministic tool call instead of an inference turn.
 */
export const STEP_KIND_TAG = "workbench.stepKind";
export const STEP_TOOL_TAG = "workbench.tool";
export const DETERMINISTIC_TOOL_KIND = "deterministic-tool";

/**
 * Optional short, human-readable step title the catalog preview shows in place
 * of the humanized step-map key. Interchange primitives carry no title field,
 * so authors set this tag (via the `title` opt below) to name a step "Search
 * Hacker News" instead of "Web B". Read by `classifyWorkflowSteps`.
 */
export const STEP_TITLE_TAG = "workbench.title";

/**
 * Tag carrying the JSON-serialized `argMap` (a controlled producer/consumer
 * pair: `deterministicToolStep` writes it, the sidecar's
 * `runDeterministicToolStep` reads + re-validates it). Tags are
 * `Record<string,string>`, so the map is stringified.
 */
export const STEP_ARGMAP_TAG = "workbench.argMap";

/**
 * Marker the sidecar's `runDeterministicToolStep` reads to treat a thrown tool
 * error as non-fatal: instead of propagating the throw (which lands the step in
 * the `failed` phase and flips the whole run to `RunFailed`), the harness logs
 * the reason and returns a completed `isError` envelope. Used for best-effort
 * research sources where one dead source must not kill the run — the failure is
 * still surfaced (logged with the why, and recorded by the consumer as a skip).
 */
export const STEP_NONFATAL_TAG = "workbench.nonFatal";

/**
 * Per-tool-argument reshape spec. Maps a TOOL argument name to one of:
 * - `{ from: 'fieldName' }` — a top-level field on the evaluated step input.
 * - `{ literal: value }` — a JSON-serializable constant.
 * - `{ fromJson: 'envelopeField', field: 'name' }` — reads `envelopeField`
 *   off the input, JSON-parses it when it is a string (an already-object
 *   value is tolerated), then pulls top-level `field` from the parsed object.
 *   Use this when a deterministic step consumes another deterministic tool
 *   step's output: `stringTool` tools encode their result as
 *   `{ content: "<json>" }`, so the fields are only reachable after parsing.
 *
 * `optional` (on `from` and `fromJson`) treats an absent-or-empty value as
 * "this ARGUMENT may legitimately be missing" — the field is OMITTED from
 * the tool call arguments, and the tool still runs (and the step still
 * completes with real output). It never skips the whole step: an absent
 * optional argument that the tool schema itself requires still surfaces as a
 * tool-call failure, exactly as calling the tool by hand without that
 * argument would.
 *
 * `skipStepIfAbsent` (on `from` and `fromJson`) is the rarer case: an
 * absent-or-empty value means the deterministic tool call must not run AT
 * ALL for this step (e.g. a single-argument argMap whose sole field is the
 * tool's only required argument, so there is no sensible "omit and call
 * anyway"). Use this only when the step is genuinely conditional on the
 * field's presence, not as a synonym for `optional`.
 *
 * Must be JSON-serializable: the workflow definition is JSON-deployed, so no
 * functions.
 */
const ArgMapValue = type({
  from: "string",
  "optional?": "boolean",
  "skipStepIfAbsent?": "boolean",
})
  .or({ literal: "unknown" })
  .or({
    fromJson: "string",
    field: "string",
    "optional?": "boolean",
    "skipStepIfAbsent?": "boolean",
  });

// Compose a structured tool argument from the evaluated input without requiring
// a workflow-specific transform step. Template values use the same selectors as
// top-level arguments, while optional values are omitted from the object.
export const ArgMapSpec = ArgMapValue.or({
  object: { "[string]": ArgMapValue },
});
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
   * A `{ from }` spec may set `optional: true` to mean "this ARGUMENT may
   * legitimately be absent (or an empty string) on the evaluated input" —
   * e.g. an intake field that only exists for one run source. The sidecar's
   * `reshapeWithArgMap` OMITS an absent/empty optional field from the tool
   * call rather than the loud failure a non-optional `{ from }` still raises
   * for a missing field — the tool still runs and the step still completes
   * with real output. Use `skipStepIfAbsent: true` instead, on the rare field
   * whose absence means the whole tool call must not run (e.g. the sole field
   * of an argMap that is the tool's only required argument).
   */
  argMap?: ArgMap;
  /** Step ids this step depends on. */
  after?: readonly string[];
  /**
   * When true, a thrown tool error does not fail the step (and so cannot fail
   * the run): the sidecar logs the reason and returns a completed `isError`
   * envelope. For best-effort sources only — never for a step whose output the
   * run genuinely depends on.
   */
  nonFatal?: boolean;
  /**
   * Optional short human title shown in the catalog preview instead of the
   * humanized step id (e.g. "Search Hacker News" for a `hackernews` step).
   */
  title?: string;
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
  const canonicalTool = canonicalizeStepToolName(opts.id, opts.tool);
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
      ...(opts.nonFatal === true ? { [STEP_NONFATAL_TAG]: "true" } : {}),
      ...(opts.title !== undefined ? { [STEP_TITLE_TAG]: opts.title } : {}),
    },
  });
  return step({
    agent,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  });
}

export interface AgentStepOpts {
  /**
   * Unique step-agent id. Distinct per step, mirroring the existing
   * agents' id convention.
   */
  id: string;
  /** The agent's real system prompt — the single-turn reasoning instruction. */
  systemPrompt: string;
  /** Optional input selector resolved by the runtime and sent to the agent. */
  input?: Selector;
  /** Step ids this step depends on. */
  after?: readonly string[];
  /**
   * Optional per-step model preference. When set, the step's agent declares
   * this `(provider, model)` as its preferred inference source, so the deploy
   * orchestrator's `pickStepInferenceSource` pins that model for this step
   * instead of the deploy default. Absent, the step uses the deploy's default
   * model.
   */
  model?: string;
  /**
   * Optional inference-provider plugin for the declared `model` (e.g. `anthropic`,
   * `openai`, `google-genai`). Defaults to `LLM_PROVIDER` ("openai-compatible").
   * Ignored when `model` is absent.
   */
  provider?: string;
  /** Optional retry policy for transient failures, passed through to `step`. */
  retry?: RetryPolicy;
  /**
   * Optional per-step output-token ceiling. Carried on the step's preferred
   * inference source as `parameters.maxTokens`; the workflow deploy lifts it
   * onto the resolved `InferenceSource.defaults.maxTokens`. Only meaningful
   * alongside `model`.
   */
  maxTokens?: number;
  /**
   * Optional short human title shown in the catalog preview instead of the
   * humanized step id (e.g. "Draft the deck" for a `generate1` step).
   */
  title?: string;
}

/**
 * Declare a workflow step as a native reasoning-with-tools step: a plain
 * `step({ agent })` built from `defineAgent`. This is the "deployed" step
 * class every workflow step now runs as — the sidecar's default inference
 * invoker dispatches it directly, with no Workbench-specific dispatch tag
 * and no bespoke sidecar branch to interpret. The only tag it carries is the
 * cross-cutting `STEP_TITLE_TAG`, shared with every step class, which names
 * the step in the catalog/run-UI preview.
 */
export function agentStep(opts: AgentStepOpts): StepPrimitive {
  const agent = defineAgent({
    id: opts.id,
    description: `Reasoning step: ${opts.id}`,
    systemPrompt: withCorbitsVocabulary(opts.systemPrompt),
    tools: [],
    capabilities: [],
    inference:
      opts.model !== undefined
        ? {
            sources: [
              {
                provider: opts.provider ?? LLM_PROVIDER,
                model: opts.model,
                ...(opts.maxTokens !== undefined
                  ? { parameters: { maxTokens: opts.maxTokens } }
                  : {}),
              },
            ],
          }
        : { sources: [] },
    ...(opts.title !== undefined
      ? { tags: { [STEP_TITLE_TAG]: opts.title } }
      : {}),
  });
  return step({
    agent,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  });
}
