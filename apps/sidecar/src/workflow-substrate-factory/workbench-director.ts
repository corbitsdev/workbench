// Workbench director: DefaultDirector plus an empty-turn retry and a
// context-budget gate.
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
// Context budget (`contextBudget`, optional -- absent means unbudgeted,
// today's pre-CL-6204 behavior): checks the turn history against the
// model's real context window (`resolveContextBudgetChars` /
// `resolveHardContextLimitChars` in `./context-budget`, sized from
// `InferenceSource.quirks` and the advertised catalog window).
//
//   - Over the hard limit (no headroom left at all): this is Ollama's
//     silent-truncation case made honest -- reply with the same
//     "exceeded the model's context limit" message hosted providers
//     produce via `inference.error`'s `context_overflow` category
//     (`@intx/inference`'s `default-director.js`), instead of sending a
//     request that would truncate server-side with no error. Compact
//     cannot help here, so `CONTEXT_OVERFLOW_MESSAGE` is the only reply.
//   - Over the (headroomed) budget but under the hard limit, on a
//     non-final `tool.done` in a multi-call batch (DefaultDirector
//     returns `[]` for every `tool.done` before the batch's last): fire
//     `caps.compact` instead of the no-op. The batch's remaining
//     `tool.done` events are already enqueued (`@intx/inference`'s
//     `reactor.js` `executeTools` enqueues every result from one
//     `Promise.all` before the reactor dequeues any of them) and will
//     still drive the eventual re-infer. Do not compact as the sole
//     terminal action on `message.received`: the reactor forbids
//     compact+infer in one cycle and does not re-enter the director
//     after compact, so compact-only would leave the inbound message
//     unanswered. Over-budget inbound still infers; compaction waits
//     for that next safe point.
//   - Otherwise: let the inner decision through unchanged. Compaction is
//     deferred to the next safe point rather than forced here.
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

import { estimateTurnsChars } from "./compactors";

export const WORKBENCH_DIRECTOR_ID = "@workbench/sidecar/workbench";
export const EMPTY_TURN_REPLY = "I got an empty model turn";
export const CONTEXT_OVERFLOW_MESSAGE =
  "This agent could not complete your request because the conversation exceeded the model's context limit";

export type ContextBudgetOptions = {
  /** Headroomed char budget past which a safe compaction point fires. */
  budgetChars: number;
  /** Raw char limit past which sending would overflow the model's window. */
  hardLimitChars: number;
  /** Name the compactor is registered under in `env.compactors`. */
  compactorName: string;
};

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
  private readonly contextBudget: ContextBudgetOptions | undefined;
  private emptyTurnRetried = false;

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[] = [],
    policy: DefaultDirectorPolicy = {},
    contextBudget?: ContextBudgetOptions,
  ) {
    this.inner = createDefaultDirector(systemPrompt, toolDefinitions, policy);
    this.systemPrompt = systemPrompt;
    this.toolDefinitions = toolDefinitions;
    this.conversational = policy.mode !== "reactive";
    this.contextBudget = contextBudget;
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

    const budgeted = this.applyContextBudget(
      event,
      state,
      capabilities,
      actions,
    );
    if (budgeted !== undefined) {
      return budgeted;
    }

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

  /**
   * Returns a replacement action set when the context budget overrides
   * the inner director's decision, `undefined` to let it through
   * unchanged. See this file's header comment for the two cases this
   * covers (honest overflow, safe-point compaction) and why every other
   * case passes through untouched.
   */
  private applyContextBudget(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
    actions: ReactorAction | ReactorAction[],
  ): ReactorAction[] | undefined {
    if (this.contextBudget === undefined) {
      return undefined;
    }
    const list = Array.isArray(actions) ? actions : [actions];
    const chars = estimateTurnsChars(state.turns);

    if (chars > this.contextBudget.hardLimitChars) {
      if (
        list.some((action) => action.type === "infer") ||
        event.type === "message.received"
      ) {
        return [
          capabilities.checkpoint("context-overflow"),
          capabilities.reply(CONTEXT_OVERFLOW_MESSAGE),
        ];
      }
    }

    if (list.some((action) => action.type === "infer")) {
      return undefined;
    }

    if (
      event.type === "tool.done" &&
      list.length === 0 &&
      chars > this.contextBudget.budgetChars
    ) {
      return [
        capabilities.checkpoint("context-budget-compact"),
        capabilities.compact(
          this.contextBudget.compactorName,
          "context-budget",
        ),
      ];
    }

    return undefined;
  }
}

export function createWorkbenchDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[] = [],
  policy: DefaultDirectorPolicy = {},
  contextBudget?: ContextBudgetOptions,
): ReactorDirector {
  return new WorkbenchDirector(
    systemPrompt,
    toolDefinitions,
    policy,
    contextBudget,
  );
}

const WorkbenchDirectorConfigSchema = type({
  "mode?": '"conversational" | "reactive"',
});

export type WorkbenchDirectorConfig = {
  mode?: "conversational" | "reactive";
};

function buildWorkbenchFactory(
  contextBudget: ContextBudgetOptions | undefined,
) {
  return defineDirector<WorkbenchDirectorConfig>({
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
        contextBudget,
      );
    },
  }).factory;
}

/**
 * Sidecar step-env director registry: workbench is the default so
 * unspecified AgentDefinitions get empty-turn retry. The built-in
 * `@intx/agent/default` stays resolvable for definitions that name it.
 *
 * `contextBudget`, when supplied, bakes a per-step context-window budget
 * (sized from the step's active `InferenceSource`, which varies per
 * step/model) into the workbench factory this registry resolves --
 * `createSidecarStepBuildEnv` builds a fresh registry per step build
 * rather than reusing one shared instance so each step's budget matches
 * its own model. See `WorkbenchDirector`'s header comment for what the
 * budget gates.
 */
export function createWorkbenchDirectorRegistry(
  contextBudget?: ContextBudgetOptions,
): DirectorRegistry {
  const workbenchFactory = buildWorkbenchFactory(contextBudget);
  return createDirectorRegistry({
    factories: [workbenchFactory, defaultDirectorFactory],
    defaultId: workbenchFactory.id,
  });
}
