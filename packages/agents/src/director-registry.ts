import { type } from "arktype";
import {
  createDirectorRegistry,
  defaultDirectorFactory,
  defineDirector,
  type AnnotatedDirectorFactory,
  type DirectorAgentContext,
  type DirectorFactory,
  type DirectorRegistry,
} from "@intx/agent";
import {
  createPersonalAgentDirector,
  createTriageBudgetDirector,
  createInvokeBudgetDirector,
  createBudgetDirector,
  readInferenceParamsForDirector,
  wrapDirectorWithInferenceParams,
} from "@workbench/myra";
import { createGranolaDirector } from "./granola/director";
import { createFirecrawlDirector } from "./firecrawl/director";
import { dynamicToolsDirector } from "./dynamic-tools";
import { wrapDirectorWithCompaction } from "./compaction-director";
import { SUMMARIZE_COMPACTOR_NAME } from "./summarize-compactor";

/**
 * Whether the deployer wired the summarize compactor onto `env.compactors`
 * for this agent, as recorded at construction on `agent.compactorNames`
 * (the registry's own record of what got registered). Warm single-step
 * agents pick it up via the sidecar `buildEnv` path (CL-3806); multi-step
 * workflow steps register it the same way when sources are available.
 * `withCompaction` uses this to skip the wrap rather than fail construction
 * when the env never registered a compactor.
 */
function hasSummarizeCompactor(agent: DirectorAgentContext): boolean {
  return agent.compactorNames.includes(SUMMARIZE_COMPACTOR_NAME);
}

/**
 * Wraps a director factory so its produced director carries the
 * 80%-of-context-window compaction trigger, applied uniformly
 * across every director the registry resolves — default, personal-agent,
 * granola, firecrawl, dynamic-tools, and the three budget directors. The
 * wrap only activates when `hasSummarizeCompactor` confirms the agent's
 * env actually registered the compactor; agents that never register one
 * get the plain, unwrapped director back.
 *
 * Latch telemetry (CL-3806) is available via `CompactionDirectorOptions.onEvent`
 * — under a sustained over-threshold breach the latch alternates fire /
 * grace-skip. Unit tests assert on that stream; the sidecar logs cheap-model
 * fallback at wire time without changing the self-healing policy.
 */
function withCompaction<Config>(
  factory: AnnotatedDirectorFactory<Config>,
): AnnotatedDirectorFactory<Config> {
  const wrapped: DirectorFactory<Config> = (config, env, agent) => {
    const director = factory(config, env, agent);
    return hasSummarizeCompactor(agent)
      ? wrapDirectorWithCompaction(director)
      : director;
  };
  return Object.assign(wrapped, {
    id: factory.id,
    requires: factory.requires,
    configSchema: factory.configSchema,
  });
}

const SenderFilterConfig = type({ allowedSenders: "string[]" });

export const personalAgentDirector = defineDirector<
  typeof SenderFilterConfig.infer
>({
  id: "@workbench/agents/personal-agent",
  configSchema: SenderFilterConfig,
  factory: (config, env, agent) =>
    wrapDirectorWithInferenceParams(
      createPersonalAgentDirector(
        agent.systemPrompt,
        [...agent.toolDefinitions],
        config.allowedSenders,
      ),
      readInferenceParamsForDirector(env, agent.systemPrompt),
    ),
});

export const granolaDirector = defineDirector<typeof SenderFilterConfig.infer>({
  id: "@workbench/agents/granola",
  configSchema: SenderFilterConfig,
  factory: (config, _env, agent) =>
    createGranolaDirector(
      agent.systemPrompt,
      [...agent.toolDefinitions],
      config.allowedSenders,
    ),
});

const EmptyConfig = type({});

export const firecrawlDirector = defineDirector<typeof EmptyConfig.infer>({
  id: "@workbench/agents/firecrawl",
  configSchema: EmptyConfig,
  factory: (_config, _env, agent) =>
    createFirecrawlDirector(agent.systemPrompt, [...agent.toolDefinitions]),
});

export const TRIAGE_BUDGET_DIRECTOR_ID = "@workbench/agents/triage-budget";

/**
 * Director for the ephemeral mailbox-triage Myra (CL-3384): construction-time
 * tool-call, token, and inference-turn budget caps composed on top of the
 * interchange default director. Triage's persona lists `search_tools`/
 * `load_tools` in `MAILBOX_PERSONA_TOOLS`, but that alone does not opt a
 * triage session into dynamic tool exposure: `resolveDynamicToolConfig`
 * (`./dynamic-tools/index.ts`) only returns a config for the personal
 * agent's control-plane identity marker (`<!-- workbench:personal-agent -->`,
 * CL-3194), which the triage prompt never carries — so the harness never sets
 * the dynamic-tools env for a triage launch, and this factory always wraps the
 * plain default director.
 */
export const triageBudgetDirector = defineDirector<typeof EmptyConfig.infer>({
  id: TRIAGE_BUDGET_DIRECTOR_ID,
  configSchema: EmptyConfig,
  factory: (_config, env, agent) =>
    wrapDirectorWithInferenceParams(
      createTriageBudgetDirector(agent.systemPrompt, [
        ...agent.toolDefinitions,
      ]),
      readInferenceParamsForDirector(env, agent.systemPrompt),
    ),
});

export const INVOKE_BUDGET_DIRECTOR_ID = "@workbench/agents/invoke-budget";

/**
 * Director for a subagent instance launched via `invoke_agent` (CL-3683):
 * the same construction-time budget-cap wrapper as triage, so unattended
 * delegated work is bounded by construction rather than by trusting the
 * model to stop. Selected sidecar-side from the invoke session-prompt
 * marker (`isInvokeSessionPrompt`), the same mechanism `triageBudgetDirector`
 * uses.
 */
export const invokeBudgetDirector = defineDirector<typeof EmptyConfig.infer>({
  id: INVOKE_BUDGET_DIRECTOR_ID,
  configSchema: EmptyConfig,
  factory: (_config, env, agent) =>
    wrapDirectorWithInferenceParams(
      createInvokeBudgetDirector(agent.systemPrompt, [
        ...agent.toolDefinitions,
      ]),
      readInferenceParamsForDirector(env, agent.systemPrompt),
    ),
});

export const WORKFLOW_STEP_BUDGET_DIRECTOR_ID =
  "@workbench/agents/workflow-step-budget";

/**
 * Hard cap on tool calls in one unattended workflow step turn (CL-3384 gap
 * 2). Steps legitimately do more read-heavy grounding than a triage session
 * (e.g. a 12-read-tool CRM analyze step), so this preset's ceiling sits
 * above the triage preset's.
 */
export const WORKFLOW_STEP_MAX_TOOL_CALLS = 50;
export const WORKFLOW_STEP_MAX_INPUT_TOKENS = 1_000_000;
export const WORKFLOW_STEP_MAX_OUTPUT_TOKENS = 1_000_000;
export const WORKFLOW_STEP_MAX_INFERENCE_TURNS = 60;

export const WORKFLOW_STEP_BUDGET_STOP_MARKER =
  "Note: this workflow step stopped at its safety budget (tool calls, tokens, or inference turns) before finishing normally. A human should review this run.";

/**
 * Director for unattended, tool-capable workflow reasoning steps (CL-3384
 * gap 2): the same construction-time budget-cap wrapper as triage, sized for
 * a step's heavier grounding workload. A deployed step turns between HITL
 * gates with nobody watching a turn in progress, exactly like triage — so it
 * needs the same provider-independent bound. `apps/sidecar`'s
 * `createStepAgentFactory` pins every step agent to this director id.
 */
export const workflowStepBudgetDirector = defineDirector<
  typeof EmptyConfig.infer
>({
  id: WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
  configSchema: EmptyConfig,
  factory: (_config, env, agent) =>
    wrapDirectorWithInferenceParams(
      createBudgetDirector(agent.systemPrompt, [...agent.toolDefinitions], {
        maxToolCalls: WORKFLOW_STEP_MAX_TOOL_CALLS,
        maxInputTokens: WORKFLOW_STEP_MAX_INPUT_TOKENS,
        maxOutputTokens: WORKFLOW_STEP_MAX_OUTPUT_TOKENS,
        maxInferenceTurns: WORKFLOW_STEP_MAX_INFERENCE_TURNS,
        stopMarker: WORKFLOW_STEP_BUDGET_STOP_MARKER,
      }),
      readInferenceParamsForDirector(env, agent.systemPrompt),
    ),
});

/**
 * Registry of every director a Workbench bundle ships, with the
 * interchange default as the fallback. Every factory — default,
 * personal-agent, granola, firecrawl, dynamic-tools, and the three budget
 * directors — is wrapped uniformly with `withCompaction` so the
 * 80%-of-context-window compaction trigger applies across the
 * board; it activates only when the agent's env actually registered the
 * summarize compactor (`hasSummarizeCompactor`), so directors resolved for
 * agents that never register one (workflow steps) fall through unwrapped
 * instead of failing construction. The workflow-deploy capability walk
 * resolves each step agent's `director` ref against this registry to emit
 * the `director:<id>` grant; the sidecar harness uses it so an agent
 * definition that pins a Workbench director resolves at launch. Agents
 * that omit `director` fall back to the interchange default, still
 * registered under its own id (`@intx/agent/default`).
 */
export function createWorkbenchDirectorRegistry(): DirectorRegistry {
  return createDirectorRegistry({
    factories: [
      withCompaction(defaultDirectorFactory),
      withCompaction(personalAgentDirector.factory),
      withCompaction(granolaDirector.factory),
      withCompaction(firecrawlDirector.factory),
      withCompaction(dynamicToolsDirector.factory),
      withCompaction(triageBudgetDirector.factory),
      withCompaction(invokeBudgetDirector.factory),
      withCompaction(workflowStepBudgetDirector.factory),
    ],
    defaultId: defaultDirectorFactory.id,
  });
}
