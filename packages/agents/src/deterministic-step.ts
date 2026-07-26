import { defineAgent } from "@intx/agent";
import { step } from "@intx/workflow";
import type { StepPrimitive, Selector, RetryPolicy } from "@intx/workflow";
import { LLM_PROVIDER } from "./constants";
import { withCorbitsVocabulary } from "./corbits-vocabulary";

/**
 * Optional short, human-readable step title the catalog preview shows in place
 * of the humanized step-map key. Interchange primitives carry no title field,
 * so authors set this tag (via the `title` opt below) to name a step "Search
 * Hacker News" instead of "Web B". Read by `classifyWorkflowSteps`.
 */
export const STEP_TITLE_TAG = "workbench.title";

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
