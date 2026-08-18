// Workbench director: DefaultDirector plus an empty-turn retry.
//
// `@intx/inference`'s DefaultDirector checkpoints and waits when
// inference.done has no text and no tool calls. The human then sits in a
// silent wait. This director retries infer once; a second empty turn
// replies with a short honest message instead of waiting.
//
// tool.done is unchanged: DefaultDirector already re-infers once the
// outstanding batch is complete, including when the result is an error.
// We compose that path rather than reimplement it.
//
// Registered as the sidecar step-env default via
// `createWorkbenchDirectorRegistry` (see `./step-env`). Id is
// `@workbench/sidecar/workbench`; `@intx/agent/default` stays resolvable
// for definitions that name it explicitly.

import { type } from "arktype";

import {
  createDirectorRegistry,
  defaultDirectorFactory,
  defineDirector,
  type DirectorRegistry,
} from "@intx/agent";
import {
  createDefaultDirector,
  type DefaultDirectorPolicy,
} from "@intx/inference";
import {
  formatSafetyRatingText,
  type AssistantTurn,
  type ReactorAction,
  type ReactorCapabilities,
  type ReactorDirector,
  type ReactorInboundEvent,
  type ReactorState,
  type ToolCall,
  type ToolDefinition,
} from "@intx/types/runtime";

export const WORKBENCH_DIRECTOR_ID = "@workbench/sidecar/workbench";
export const EMPTY_TURN_REPLY = "I got an empty model turn";

function extractToolCalls(turn: AssistantTurn): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of turn.content) {
    if (block.type === "tool_call") {
      calls.push({
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      });
    }
  }
  return calls;
}

function extractTextContent(turn: AssistantTurn): string {
  const parts: string[] = [];
  for (const block of turn.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "refusal") {
      parts.push(block.reason);
    } else if (block.type === "safety_rating") {
      parts.push(formatSafetyRatingText(block));
    }
  }
  return parts.join("\n").trim();
}

function actionsIncludeWait(actions: ReactorAction | ReactorAction[]): boolean {
  const list = Array.isArray(actions) ? actions : [actions];
  return list.some((action) => action.type === "wait");
}

export class WorkbenchDirector implements ReactorDirector {
  private readonly inner: ReactorDirector;
  private readonly systemPrompt: string;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly conversational: boolean;
  private emptyTurnRetried = false;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[] = [],
    policy: DefaultDirectorPolicy = {},
  ) {
    this.inner = createDefaultDirector(systemPrompt, toolDefinitions, policy);
    this.systemPrompt = systemPrompt;
    this.toolDefinitions = toolDefinitions;
    this.conversational = policy.mode !== "reactive";
  }

  async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (event.type === "message.received") {
      this.emptyTurnRetried = false;
    }

    const actions = await this.inner.decide(event, state, capabilities);

    if (event.type !== "inference.done") {
      return actions;
    }

    if (
      !this.isEmptyConversationalTurn(event.turn) ||
      !actionsIncludeWait(actions)
    ) {
      this.emptyTurnRetried = false;
      return actions;
    }

    if (!this.emptyTurnRetried) {
      this.emptyTurnRetried = true;
      return [
        capabilities.checkpoint("empty-turn-retry"),
        capabilities.infer({
          systemPrompt: this.systemPrompt,
          tools: this.toolDefinitions,
        }),
      ];
    }

    this.emptyTurnRetried = false;
    return [
      capabilities.checkpoint("empty-turn-reply"),
      capabilities.reply(EMPTY_TURN_REPLY),
    ];
  }

  private isEmptyConversationalTurn(turn: AssistantTurn): boolean {
    if (!this.conversational) {
      return false;
    }
    return (
      extractToolCalls(turn).length === 0 &&
      extractTextContent(turn).length === 0
    );
  }
}

export function createWorkbenchDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[] = [],
  policy: DefaultDirectorPolicy = {},
): ReactorDirector {
  return new WorkbenchDirector(systemPrompt, toolDefinitions, policy);
}

const WorkbenchDirectorConfigSchema = type({
  "mode?": '"conversational" | "reactive"',
});

export type WorkbenchDirectorConfig = {
  mode?: "conversational" | "reactive";
};

const defined = defineDirector<WorkbenchDirectorConfig>({
  id: WORKBENCH_DIRECTOR_ID,
  configSchema: WorkbenchDirectorConfigSchema,
  factory: (config, _env, agent) => {
    const policy: DefaultDirectorPolicy = {};
    if (config.mode !== undefined) {
      policy.mode = config.mode;
    }
    return createWorkbenchDirector(
      agent.systemPrompt,
      [...agent.toolDefinitions],
      policy,
    );
  },
});

export const workbenchDirectorFactory = defined.factory;
export const buildWorkbenchDirectorRef = defined.build;

/**
 * Sidecar step-env director registry: workbench is the default so
 * unspecified AgentDefinitions get empty-turn retry. The built-in
 * `@intx/agent/default` stays resolvable for definitions that name it.
 */
export function createWorkbenchDirectorRegistry(): DirectorRegistry {
  return createDirectorRegistry({
    factories: [workbenchDirectorFactory, defaultDirectorFactory],
    defaultId: workbenchDirectorFactory.id,
  });
}
