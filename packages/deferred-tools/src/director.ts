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
import { getLogger } from "@intx/log";
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
import { searchDefinitions, selectByPatterns, toolNamespace } from "./match";
import { TOOL_SEARCH_DEFINITION, TOOL_SEARCH_NAME } from "./tool-search";

/** Glob-ish name patterns: what the model always sees, and what it has to
 * search for. A tool in neither list stays visible, so a missing pattern
 * never silently hides a tool. */
export interface DeferredDirectorConfig {
  readonly visible: readonly string[];
  readonly deferred: readonly string[];
}

const logger = getLogger(["corbits", "deferred-tools"]);

const DeferredDirectorConfigSchema = type({
  visible: "string[]",
  deferred: "string[]",
});

/** Splits the agent's tools by the config's patterns and tracks which
 * deferred ones the model has searched up. Exported for tests.
 *
 * Surfacing is append-only and ordered by when a tool was surfaced, never by
 * the catalogue's order: the tools block a turn sends is then a prefix of
 * every later one, so a provider's prompt cache keeps hitting. Nothing is
 * ever dropped or reordered within a context. */
export class DeferredToolSelection {
  private readonly deferred: readonly ToolDefinition[];
  private readonly always: readonly ToolDefinition[];
  /** Insertion-ordered, which is the wire order of the surfaced block. */
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

  /** A `tool_search` query surfaces whole namespaces, not single tools: one
   * `memory_*` hit brings every `memory_*` tool along, so a server costs one
   * cache miss rather than one per tool. */
  surface(query: string): void {
    const namespaces = new Set(
      searchDefinitions(this.deferred, query).map((definition) => toolNamespace(definition.name)),
    );
    for (const definition of this.deferred) {
      if (namespaces.has(toolNamespace(definition.name))) {
        this.surfaced.add(definition.name);
      }
    }
  }

  /** What the next inference call is sent: the fixed block, then the surfaced
   * tools in the order they were surfaced. */
  tools(): ToolDefinition[] {
    const byName = new Map(this.deferred.map((definition) => [definition.name, definition]));
    const surfaced: ToolDefinition[] = [];
    for (const name of this.surfaced) {
      const definition = byName.get(name);
      if (definition !== undefined) surfaced.push(definition);
    }
    return [...this.always, ...surfaced];
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
    // The only place the per-turn tool list is observable; a deferral bug is
    // otherwise invisible until the model misbehaves.
    logger.debug`deferred tools on ${event.type}: ${tools.map((tool) => tool.name).join(", ")}`;
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
