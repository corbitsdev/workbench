import type { WorkflowDefinition } from "@intx/workflow";
import {
  STEP_KIND_TAG,
  STEP_TITLE_TAG,
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
} from "./deterministic-step";

export type FlowStepClass = "auto" | "agent" | "human";

export interface ClassifiedFlowStep {
  id: string;
  title: string;
  kind: FlowStepClass;
}

type Primitive = WorkflowDefinition["steps"][string];

function humanize(raw: string): string {
  const spaced = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced === "") return raw;
  return spaced
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// A `step` primitive is deterministic or reasoning purely by its authoring tag:
// deterministicToolStep writes "deterministic-tool", inlineInferenceStep writes
// "inline-inference", and a plain tool-capable reasoning step carries no tag.
function classifyStepByTag(
  tags: Record<string, string> | undefined,
): FlowStepClass {
  if (tags?.[STEP_KIND_TAG] === DETERMINISTIC_TOOL_KIND) return "auto";
  if (tags?.[STEP_KIND_TAG] === INLINE_INFERENCE_KIND) return "agent";
  return "agent";
}

function classifyPrimitive(primitive: Primitive): FlowStepClass {
  switch (primitive.kind) {
    case "awaitSignal":
    case "escalation":
      return "human";
    case "gate":
    case "sleep":
      return "auto";
    case "childWorkflow":
      return "agent";
    case "map":
      return classifyStepByTag(primitive.step.agent.tags);
    case "step":
      return classifyStepByTag(primitive.agent.tags);
    default:
      return "auto";
  }
}

// The step/map primitive whose agent carries the authoring tags.
function agentTagsOf(primitive: Primitive): Record<string, string> | undefined {
  if (primitive.kind === "step") return primitive.agent.tags;
  if (primitive.kind === "map") return primitive.step.agent.tags;
  return undefined;
}

// Title precedence: an authored `workbench.title` tag, then an awaitSignal's
// signal name, then the humanized step-map key as a last resort.
function titleForPrimitive(id: string, primitive: Primitive): string {
  const authored = agentTagsOf(primitive)?.[STEP_TITLE_TAG];
  if (authored !== undefined && authored.trim() !== "") return authored;
  if (primitive.kind === "awaitSignal" && primitive.name.trim() !== "") {
    return humanize(primitive.name);
  }
  return humanize(id);
}

// Projects a deployed workflow definition into the ordered, classified steps the
// catalog preview renders. Follows `stepOrder` so the flow reads in author order;
// each step is typed auto / agent / human from its primitive and authoring tag.
export function classifyWorkflowSteps(
  definition: WorkflowDefinition,
): ClassifiedFlowStep[] {
  const steps: ClassifiedFlowStep[] = [];
  for (const id of definition.stepOrder) {
    const primitive = definition.steps[id];
    if (primitive === undefined) continue;
    steps.push({
      id,
      title: titleForPrimitive(id, primitive),
      kind: classifyPrimitive(primitive),
    });
  }
  return steps;
}

export function countHumanGates(steps: readonly ClassifiedFlowStep[]): number {
  return steps.filter((s) => s.kind === "human").length;
}
