// The deferred-tools director: the stock default director with a per-turn
// tool list.
//
// The model is sent its visible tools plus `tool_search`; a deferred tool
// joins that list only once a `tool_search` call in this context has
// matched it. The stock director is wrapped rather than reimplemented —
// every decision stays upstream's, and the only interception is the
// `infer` capability, whose tool list this swaps. Grants are untouched:
// the authz extension checks calls against the agent's full definitions.

import { defineDirector } from "@intx/agent";
import type { DirectorAgentContext } from "@intx/agent";
import { createDefaultDirector } from "@intx/inference";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolDefinition,
} from "@intx/types/runtime";
import { type } from "arktype";

import { publishDeferredCatalog } from "./catalog";
import { searchDefinitions, selectByPatterns } from "./match";
import { TOOL_SEARCH_DEFINITION, TOOL_SEARCH_NAME } from "./tool-search";

/** Glob-ish name patterns: what the model always sees, and what it has to
 * search for. A tool in neither list stays visible, so a missing pattern
 * never silently hides a tool. */
export interface DeferredDirectorConfig {
  readonly visible: readonly string[];
  readonly deferred: readonly string[];
}

const DeferredDirectorConfigSchema = type({
  visible: "string[]",
  deferred: "string[]",
});

/** Splits the agent's tools by the config's patterns and tracks which
 * deferred ones the model has searched up. Exported for tests. */
export class DeferredToolSelection {
  private readonly deferred: readonly ToolDefinition[];
  private readonly always: readonly ToolDefinition[];
  private readonly surfaced = new Set<string>();

  constructor(definitions: readonly ToolDefinition[], config: DeferredDirectorConfig) {
    const deferred = selectByPatterns(definitions, config.deferred);
    const deferredNames = new Set(deferred.map((definition) => definition.name));
    this.deferred = deferred;
    this.always = [
      ...definitions.filter(
        (definition) => !deferredNames.has(definition.name) && definition.name !== TOOL_SEARCH_NAME,
      ),
      TOOL_SEARCH_DEFINITION,
    ];
  }

  /** The deferred definitions held back from the model's first turn. */
  deferredDefinitions(): readonly ToolDefinition[] {
    return this.deferred;
  }

  /** A `tool_search` query surfaces exactly what it answered with. */
  surface(query: string): void {
    for (const definition of searchDefinitions(this.deferred, query)) {
      this.surfaced.add(definition.name);
    }
  }

  /** What the next inference call is sent. */
  tools(): ToolDefinition[] {
    return [
      ...this.always,
      ...this.deferred.filter((definition) => this.surfaced.has(definition.name)),
    ];
  }
}

function surfaceFromEvent(event: ReactorInboundEvent, selection: DeferredToolSelection): void {
  if (event.type !== "inference.done") return;
  for (const block of event.turn.content) {
    if (block.type !== "tool_call" || block.name !== TOOL_SEARCH_NAME) continue;
    const query = block.arguments["query"];
    selection.surface(typeof query === "string" ? query : "");
  }
}

class DeferredDirector implements ReactorDirector {
  private readonly inner: ReactorDirector;
  private readonly selection: DeferredToolSelection;

  constructor(agent: DirectorAgentContext, config: DeferredDirectorConfig) {
    this.selection = new DeferredToolSelection(agent.toolDefinitions, config);
    publishDeferredCatalog(this.selection.deferredDefinitions());
    this.inner = createDefaultDirector(agent.systemPrompt, [...agent.toolDefinitions]);
  }

  async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    surfaceFromEvent(event, this.selection);
    const tools = this.selection.tools();
    const narrowed: ReactorCapabilities = {
      ...capabilities,
      infer: (options) => capabilities.infer({ ...options, tools }),
    };
    return this.inner.decide(event, state, narrowed);
  }
}

const defined = defineDirector<DeferredDirectorConfig>({
  id: "@corbits/deferred-tools/director",
  configSchema: DeferredDirectorConfigSchema,
  factory: (config, _env, agent) => new DeferredDirector(agent, config),
});

export const deferredDirector = defined.factory;
export const buildDeferredDirectorRef = defined.build;
