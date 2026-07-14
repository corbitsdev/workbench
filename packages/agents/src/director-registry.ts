import { type } from "arktype";
import {
  createDirectorRegistry,
  defaultDirectorFactory,
  defineDirector,
  type DirectorRegistry,
} from "@intx/agent";
import {
  createPersonalAgentDirector,
  createTriageBudgetDirector,
  createBudgetDirector,
} from "@workbench/myra";
import { createGranolaDirector } from "./granola/director";
import { createFirecrawlDirector } from "./firecrawl/director";
import { dynamicToolsDirector } from "./dynamic-tools";

const SenderFilterConfig = type({ allowedSenders: "string[]" });

export const personalAgentDirector = defineDirector<
  typeof SenderFilterConfig.infer
>({
  id: "@workbench/agents/personal-agent",
  configSchema: SenderFilterConfig,
  factory: (config, _env, agent) =>
    createPersonalAgentDirector(
      agent.systemPrompt,
      [...agent.toolDefinitions],
      config.allowedSenders,
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
 * agent's own "Chief of Staff" prompt marker, which the triage prompt never
 * carries — so the harness never sets the dynamic-tools env for a triage
 * launch, and this factory always wraps the plain default director.
 */
export const triageBudgetDirector = defineDirector<typeof EmptyConfig.infer>({
  id: TRIAGE_BUDGET_DIRECTOR_ID,
  configSchema: EmptyConfig,
  factory: (_config, _env, agent) =>
    createTriageBudgetDirector(agent.systemPrompt, [...agent.toolDefinitions]),
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
  factory: (_config, _env, agent) =>
    createBudgetDirector(agent.systemPrompt, [...agent.toolDefinitions], {
      maxToolCalls: WORKFLOW_STEP_MAX_TOOL_CALLS,
      maxInputTokens: WORKFLOW_STEP_MAX_INPUT_TOKENS,
      maxOutputTokens: WORKFLOW_STEP_MAX_OUTPUT_TOKENS,
      maxInferenceTurns: WORKFLOW_STEP_MAX_INFERENCE_TURNS,
      stopMarker: WORKFLOW_STEP_BUDGET_STOP_MARKER,
    }),
});

/**
 * Registry of every director a Workbench bundle ships, with the
 * interchange default as the fallback. The workflow-deploy capability
 * walk resolves each step agent's `director` ref against this registry
 * to emit the `director:<id>` grant; the sidecar harness uses it so an
 * agent definition that pins a Workbench director resolves at launch.
 * Agents that omit `director` fall back to the interchange default.
 */
export function createWorkbenchDirectorRegistry(): DirectorRegistry {
  return createDirectorRegistry({
    factories: [
      defaultDirectorFactory,
      personalAgentDirector.factory,
      granolaDirector.factory,
      firecrawlDirector.factory,
      dynamicToolsDirector.factory,
      triageBudgetDirector.factory,
      workflowStepBudgetDirector.factory,
    ],
    defaultId: defaultDirectorFactory.id,
  });
}
