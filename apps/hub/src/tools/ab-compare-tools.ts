import {
  AB_PRESET_COMPOSE_DEFINITION,
  AB_PRESET_QUORUM_DEFINITION,
  createAbCompareTools,
} from "@workbench/tools-ab-compare";
import type { ContextToolEntry } from "../lib/tool-registry";

function toolByName(name: string) {
  return () => {
    const tool = createAbCompareTools().find((t) => t.definition.name === name);
    if (tool === undefined)
      throw new Error(`ab-compare tool not found: ${name}`);
    return [tool];
  };
}

export const AB_COMPARE_HUB_TOOLS: Record<string, ContextToolEntry> = {
  ab_preset_quorum: {
    sideEffect: "read",
    definition: AB_PRESET_QUORUM_DEFINITION,
    createTools: toolByName("ab_preset_quorum"),
  },
  ab_preset_compose: {
    sideEffect: "read",
    definition: AB_PRESET_COMPOSE_DEFINITION,
    createTools: toolByName("ab_preset_compose"),
  },
};
