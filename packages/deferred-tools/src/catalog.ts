// The one place the director and the `tool_search` tool meet.
//
// Only the director is handed the agent's full tool definitions, and the
// tool bundle is evaluated from a different module instance than the
// director (the deploy pushes `workflow.js` and `directors.js` as separate
// closures), so a module-level variable would give each half its own copy.
// A registered symbol on `globalThis` is the narrowest channel that
// crosses that boundary inside one run child.

import type { ToolDefinition } from "@intx/types/runtime";

const CELL = Symbol.for("@corbits/deferred-tools.catalog");

type Cell = { definitions: readonly ToolDefinition[] };

function cell(): Cell {
  const host = globalThis as typeof globalThis & { [CELL]?: Cell };
  const existing = host[CELL];
  if (existing !== undefined) return existing;
  const fresh: Cell = { definitions: [] };
  host[CELL] = fresh;
  return fresh;
}

/** The director publishes the deferred definitions it is holding back. */
export function publishDeferredCatalog(definitions: readonly ToolDefinition[]): void {
  cell().definitions = definitions;
}

/** What `tool_search` searches. Empty until a deferred director has run. */
export function readDeferredCatalog(): readonly ToolDefinition[] {
  return cell().definitions;
}
