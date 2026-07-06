import { createDefaultDirector } from "@intx/inference";
import {
  catalogManagedNames,
  type DynamicToolsEnv,
} from "@workbench/tools-catalog";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
  ToolDefinition,
} from "@intx/types/runtime";

/**
 * Director for agents that opt into dynamic tool exposure. It delegates every
 * decision to the default director but rewrites each `infer` call so the model
 * is advertised only `base ∪ catalog-tools ∪ exposed`, where `base` is every
 * resolved tool that is NOT catalog-managed. Catalog-managed tools (the
 * long-tail packages) start hidden and become advertised — sticky for the
 * session — once `load_tools` adds them to the shared exposure set.
 *
 * Only advertisement changes: the underlying runner still holds and dispatches
 * every loaded tool by name, so a tool the model was pointed at by
 * `load_tools` is callable on the very next turn (the tool.done re-infer keeps
 * the same turn going with the new schema in view).
 */
export function createDynamicToolsDirector(
  systemPrompt: string,
  toolDefinitions: readonly ToolDefinition[],
  dynamic: DynamicToolsEnv,
): ReactorDirector {
  const base = createDefaultDirector(systemPrompt, [...toolDefinitions]);
  const managed = catalogManagedNames(dynamic.catalog);

  function advertised(): ToolDefinition[] {
    return toolDefinitions.filter(
      (def) => !managed.has(def.name) || dynamic.exposure.exposed.has(def.name),
    );
  }

  return {
    async decide(
      event: ReactorInboundEvent,
      state: ReactorState,
      capabilities: ReactorCapabilities,
    ): Promise<ReactorAction | ReactorAction[]> {
      const wrapped: ReactorCapabilities = {
        ...capabilities,
        infer: (options) =>
          capabilities.infer({ ...options, tools: advertised() }),
      };
      return base.decide(event, state, wrapped);
    },
  };
}
