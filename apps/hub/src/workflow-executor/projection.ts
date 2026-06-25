import type { WorkflowDefinition } from "@intx/workflow";
import type { Selector } from "@intx/workflow";
import {
  DETERMINISTIC_TOOL_KIND,
  STEP_ARGMAP_TAG,
  STEP_KIND_TAG,
  STEP_TOOL_TAG,
  type ArgMap,
} from "@workbench/agents";

// A thin, executor-facing projection of the deployed `@intx/workflow`
// definition. The thin executor never runs the interchange runtime — it walks
// `order` and dispatches on `kind`. Each projected step erases the runtime-only
// machinery (drain behavior, retry/timeout reactors) and keeps only what the
// hub-side executor needs: how to produce the step's input (selector) and how
// to run it.
export type ProjectedStep =
  | {
      kind: "tool";
      id: string;
      tool: string;
      input?: Selector;
      argMap?: ArgMap;
      after: readonly string[];
    }
  | {
      kind: "reasoning";
      id: string;
      systemPrompt: string;
      source: { provider: string; model: string };
      credentialName?: string;
      input?: Selector;
      after: readonly string[];
    }
  | {
      kind: "gate";
      id: string;
      signalName: string;
      after: readonly string[];
    }
  | {
      kind: "map";
      id: string;
      over: Selector;
      child: ProjectedStep & { kind: "tool" | "reasoning" };
      after: readonly string[];
    };

export interface ProjectedWorkflow {
  id: string;
  order: readonly string[];
  steps: Record<string, ProjectedStep>;
}

function tagOf(
  tags: Record<string, string> | undefined,
  key: string,
): string | undefined {
  return tags?.[key];
}

function parseArgMap(raw: string | undefined): ArgMap | undefined {
  if (raw === undefined) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("workflow projection: argMap tag is not an object");
  }
  return parsed as ArgMap;
}

// Project a single `kind: 'step'` primitive into either a deterministic tool
// step or a reasoning step, keyed off the `STEP_KIND_TAG` the workbench
// `deterministicToolStep` stamps. A reasoning step is a plain `step({agent})`
// with no such tag.
function projectStepPrimitive(
  id: string,
  // The interchange StepPrimitive carries `agent` with `systemPrompt`,
  // `inference.sources`, and `tags`. The deploy path serializes it to JSON, so
  // at read-back it is a plain object — typed `unknown` and narrowed here.
  primitive: { agent?: unknown; input?: Selector; after?: readonly string[] },
): ProjectedStep & { kind: "tool" | "reasoning" } {
  const agent = primitive.agent;
  if (typeof agent !== "object" || agent === null) {
    throw new Error(`workflow projection: step "${id}" has no agent`);
  }
  const a = agent as {
    systemPrompt?: string;
    tags?: Record<string, string>;
    inference?: { sources?: { provider?: string; model?: string }[] };
  };
  const after = primitive.after ?? [];

  if (tagOf(a.tags, STEP_KIND_TAG) === DETERMINISTIC_TOOL_KIND) {
    const tool = tagOf(a.tags, STEP_TOOL_TAG);
    if (tool === undefined) {
      throw new Error(
        `workflow projection: deterministic step "${id}" has no tool tag`,
      );
    }
    return {
      kind: "tool",
      id,
      tool,
      ...(primitive.input !== undefined ? { input: primitive.input } : {}),
      ...((): { argMap?: ArgMap } => {
        const argMap = parseArgMap(tagOf(a.tags, STEP_ARGMAP_TAG));
        return argMap !== undefined ? { argMap } : {};
      })(),
      after,
    };
  }

  const source = a.inference?.sources?.[0];
  if (!source?.provider || !source.model) {
    throw new Error(
      `workflow projection: reasoning step "${id}" has no inference source`,
    );
  }
  return {
    kind: "reasoning",
    id,
    systemPrompt: a.systemPrompt ?? "",
    source: { provider: source.provider, model: source.model },
    ...((): { credentialName?: string } => {
      const credentialName = tagOf(a.tags, "credentialName");
      return credentialName !== undefined ? { credentialName } : {};
    })(),
    ...(primitive.input !== undefined ? { input: primitive.input } : {}),
    after,
  };
}

export function projectWorkflow(
  definition: WorkflowDefinition,
): ProjectedWorkflow {
  const steps: Record<string, ProjectedStep> = {};
  for (const id of definition.stepOrder) {
    const primitive = definition.steps[id] as
      | {
          kind: string;
          agent?: unknown;
          input?: Selector;
          over?: Selector;
          step?: { agent?: unknown; input?: Selector };
          name?: string;
          after?: readonly string[];
        }
      | undefined;
    if (!primitive) {
      throw new Error(
        `workflow projection: step "${id}" missing from definition`,
      );
    }
    const after = primitive.after ?? [];

    if (primitive.kind === "step") {
      steps[id] = projectStepPrimitive(id, primitive);
      continue;
    }
    if (primitive.kind === "awaitSignal") {
      if (!primitive.name) {
        throw new Error(
          `workflow projection: awaitSignal step "${id}" has no signal name`,
        );
      }
      steps[id] = { kind: "gate", id, signalName: primitive.name, after };
      continue;
    }
    if (primitive.kind === "map") {
      if (!primitive.over || !primitive.step) {
        throw new Error(
          `workflow projection: map step "${id}" missing over/step`,
        );
      }
      const child = projectStepPrimitive(`${id}.child`, primitive.step);
      steps[id] = { kind: "map", id, over: primitive.over, child, after };
      continue;
    }
    throw new Error(
      `workflow projection: unsupported step kind "${primitive.kind}" for step "${id}"`,
    );
  }
  return { id: definition.id, order: definition.stepOrder, steps };
}
