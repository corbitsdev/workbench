import { type } from "arktype";
import { defineAgent } from "@intx/agent";
import { step } from "@intx/workflow";
import type { StepPrimitive, Selector, RetryPolicy } from "@intx/workflow";
import { canonicalizeToolNames } from "./tool-names";
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
 * Marker the sidecar's step invoker reads to dispatch a step as an
 * in-process single-turn inference (CL-2251) instead of a full deployed
 * session. An inline-inference step is a pure reasoning turn: it carries a
 * real systemPrompt but no tools/capabilities, so the supervisor needs no
 * per-step agent-state repo, DB rows, or grants file, and the hub skips
 * `launchSession` for it. The sidecar runs it with a bare `createAgent`
 * against the step's pinned `InferenceSource` and a deny-all `authorize`.
 */
export const INLINE_INFERENCE_KIND = "inline-inference";

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
 * The retry policy's `maxAttempts`, stringified, set when an inline step declares
 * both `retry` and `nonFatal`. The engine's `RetryPolicy` re-invokes the step on
 * a throw, but a `nonFatal` runner that returns an `isError` output on the first
 * failure never throws — so retry would never fire. The runner reads this tag
 * plus `AuthorizeContext.attempt` to degrade to the non-fatal skip only on the
 * LAST attempt, throwing (and letting the engine retry) on earlier ones.
 */
export const STEP_INLINE_RETRY_MAX_TAG = "workbench.inlineRetryMaxAttempts";

/**
 * Per-tool-argument reshape spec. Maps a TOOL argument name to either a
 * top-level field on the evaluated step input (`{ from: 'fieldName' }`) or a
 * JSON-serializable constant (`{ literal: value }`). Must be
 * JSON-serializable: the workflow definition is JSON-deployed, so no
 * functions.
 */
export const ArgMapSpec = type({
  from: "string",
  "optional?": "boolean",
}).or({ literal: "unknown" });
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
   * A `{ from }` spec may set `optional: true` to mean "this field may
   * legitimately be absent (or an empty string) on the evaluated input" —
   * e.g. an intake field that only exists for one run source. The sidecar's
   * `reshapeWithArgMap` treats an absent/empty OPTIONAL field as a skip
   * (no tool call, no throw) rather than the loud failure a non-optional
   * `{ from }` still raises for a missing field.
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

export interface InlineInferenceStepOpts {
  /**
   * Unique step-agent id. Distinct per step, mirroring the existing
   * agents' id convention. Inline steps persist no per-step rows, but the
   * id still names the step's placeholder agent in the deployed definition.
   */
  id: string;
  /** The agent's real system prompt — the single-turn reasoning instruction. */
  systemPrompt: string;
  /** Optional input selector resolved by the runtime and sent to the agent. */
  input?: Selector;
  /** Step ids this step depends on. */
  after?: readonly string[];
  /**
   * Optional per-step model preference. When set, the step's placeholder agent
   * declares this `(LLM_PROVIDER, model)` as its preferred inference source, so
   * the deploy orchestrator's `pickStepInferenceSource` pins that model for this
   * step instead of the deploy default — provided the workflow deploy resolved
   * the model into `config.sources` (see `resolveWorkflowDeploySource`). Absent,
   * the step uses the deploy's default model. Use to route a heavier synthesis
   * step (e.g. `LLM_WRITER_MODEL`) while the rest stay on `LLM_DEFAULT_MODEL`.
   */
  model?: string;
  /**
   * Optional inference-provider plugin for the declared `model` (e.g. `anthropic`,
   * `openai`, `google-genai`). Defaults to `LLM_PROVIDER` ("openai-compatible").
   * The declared `(provider, model)` is what the deploy's source resolution pins,
   * so a step can run on a native-provider model (Opus via `anthropic`) rather
   * than only the openai-compatible gateway. Ignored when `model` is absent.
   */
  provider?: string;
  /**
   * When true, a failure of this step degrades to a recorded skip (via
   * `STEP_NONFATAL_TAG`) instead of failing the whole run — the same contract
   * `deterministicToolStep({ nonFatal })` provides. Used by the A/B preset
   * workflows so one dead variant does not kill the comparison; a downstream
   * quorum step decides whether enough variants succeeded.
   */
  nonFatal?: boolean;
  /**
   * Optional retry policy for transient failures, passed through to the
   * underlying `step`. Auto-retries the same pinned source (no cross-provider
   * failover — that is not wired in the workflow path).
   */
  retry?: RetryPolicy;
  /**
   * Optional per-step output-token ceiling. Carried on the step's preferred
   * inference source as `parameters.maxTokens`; the workflow deploy lifts it
   * onto the resolved `InferenceSource.defaults.maxTokens` so the step's model
   * turn runs with this ceiling instead of the source's small/unset default —
   * the cause of clean `finish_reason:"length"` truncation on long writers.
   * Only meaningful alongside `model`: with no `model` the step declares no
   * preferred source, so there is nothing to carry the ceiling and it is ignored.
   */
  maxTokens?: number;
  /**
   * Optional short human title shown in the catalog preview instead of the
   * humanized step id (e.g. "Draft the deck" for a `generate1` step).
   */
  title?: string;
}

/**
 * Declare a workflow step as an inline single-turn inference (CL-2251): a
 * pure reasoning turn the sidecar runs in-process with a bare `createAgent`,
 * WITHOUT a deployed per-step session. The placeholder agent keeps a real
 * systemPrompt (this is genuine reasoning) but declares no tools/capabilities
 * and no inference source in the definition — the source is pinned at deploy
 * time and resolved by the sidecar from its per-step `STEP_INFERENCE_SOURCES`
 * table, exactly as a deployed step would. The marker tag tells the hub to
 * skip the per-step agent/instance/grants writers and no-op `launchSession`
 * for this step, and tells the sidecar's step invoker to dispatch it through
 * the bare-inference branch instead of building a tool-capable harness.
 *
 * Only valid for no-tool reasoning steps. A step that invokes a tool must use
 * a deployed `step({ agent })` (tool-capable harness) or `deterministicToolStep`.
 */
export function inlineInferenceStep(
  opts: InlineInferenceStepOpts,
): StepPrimitive {
  const agent = defineAgent({
    id: opts.id,
    description: `Inline single-turn inference: ${opts.id}`,
    systemPrompt: withCorbitsVocabulary(opts.systemPrompt),
    tools: [],
    capabilities: [],
    // A declared preferred source makes the capability walk emit the
    // `inference.source:<provider>:<model>` grant and the orchestrator's
    // pickStepInferenceSource pin that model for the step; with none declared the
    // step falls back to the deploy defaultSource. The sidecar still resolves the
    // concrete pinned source from STEP_INFERENCE_SOURCES at runtime either way.
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
    tags: {
      [STEP_KIND_TAG]: INLINE_INFERENCE_KIND,
      ...(opts.nonFatal === true ? { [STEP_NONFATAL_TAG]: "true" } : {}),
      ...(opts.retry !== undefined
        ? { [STEP_INLINE_RETRY_MAX_TAG]: String(opts.retry.maxAttempts) }
        : {}),
      ...(opts.title !== undefined ? { [STEP_TITLE_TAG]: opts.title } : {}),
    },
  });
  return step({
    agent,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  });
}
