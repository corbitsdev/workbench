import type { WorkflowDefinition } from "@intx/workflow";
import {
  STEP_KIND_TAG,
  STEP_TITLE_TAG,
  DETERMINISTIC_TOOL_KIND,
} from "./deterministic-step";

export type FlowStepClass = "auto" | "agent" | "human";

export interface ClassifiedFlowStep {
  id: string;
  title: string;
  kind: FlowStepClass;
  // The runtime step ids this entry represents, in run order. A single-step
  // entry (the per-stepOrder fallback) carries its own id; a declared
  // DISPLAY_STEPS group carries every runtime id it clusters. The client's run
  // pane keys off THIS, never `id` alone — `id` is the group's synthetic key
  // (e.g. "gather"), not a runtime step id, so it never matches a RunState
  // step directly for a grouped flow (CL-4285 follow-up).
  stepIds: string[];
}

// A workflow author's declaration of one user-facing step in the display flow:
// a label plus the runtime step ids it clusters. This is the serializable,
// browser-safe subset the catalog classifier needs — it is structurally
// satisfied by `DisplayStep` from `@workbench/ui` (which adds a UI-only
// `activityLabel`), so a workflow's `DISPLAY_STEPS` export can be passed here
// directly without importing the UI package into this server-safe module.
export interface DisplayFlowStep {
  key: string;
  label: string;
  stepIds: readonly string[];
}

type Primitive = WorkflowDefinition["steps"][string];

export function humanize(raw: string): string {
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
// deterministicToolStep writes "deterministic-tool"; every reasoning step
// (agentStep's native `step({ agent })`) carries no deterministic tag and
// classifies as "agent" by default. A historical run's definition may still
// carry the retired `inline-inference` tag value on disk; that also has no
// deterministic tag, so it classifies as "agent" here too.
function classifyStepByTag(
  tags: Record<string, string> | undefined,
): FlowStepClass {
  if (tags?.[STEP_KIND_TAG] === DETERMINISTIC_TOOL_KIND) return "auto";
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

// The strongest classification wins when a display group clusters several
// runtime steps: a group containing a human gate reads as human, one with a
// reasoning step reads as agent, otherwise auto.
function aggregateKind(kinds: readonly FlowStepClass[]): FlowStepClass {
  if (kinds.includes("human")) return "human";
  if (kinds.includes("agent")) return "agent";
  return "auto";
}

// Projects the workflow onto the author's declared display flow: one classified
// entry per display group, titled by the declared label, in declared order. The
// group's kind aggregates its runtime steps so the preview colours the grouped
// node the same way the flow actually behaves.
function projectDisplayFlow(
  definition: WorkflowDefinition,
  displayFlow: readonly DisplayFlowStep[],
): ClassifiedFlowStep[] {
  return displayFlow.map((group) => {
    const kinds: FlowStepClass[] = [];
    for (const stepId of group.stepIds) {
      const primitive = definition.steps[stepId];
      if (primitive !== undefined) kinds.push(classifyPrimitive(primitive));
    }
    return {
      id: group.key,
      title: group.label,
      kind: aggregateKind(kinds),
      stepIds: [...group.stepIds],
    };
  });
}

// Projects a deployed workflow definition into the ordered, classified steps the
// catalog preview renders. When the author declares a `displayFlow`, the preview
// is grouped and labelled by that single declaration — the same one the client
// run stepper consumes — so the two surfaces stay in sync. Otherwise it falls
// back to one entry per runtime step in `stepOrder`, each typed auto / agent /
// human from its primitive and authoring tag.
export function classifyWorkflowSteps(
  definition: WorkflowDefinition,
  displayFlow?: readonly DisplayFlowStep[],
): ClassifiedFlowStep[] {
  if (displayFlow !== undefined && displayFlow.length > 0) {
    return projectDisplayFlow(definition, displayFlow);
  }
  const steps: ClassifiedFlowStep[] = [];
  for (const id of definition.stepOrder) {
    const primitive = definition.steps[id];
    if (primitive === undefined) continue;
    steps.push({
      id,
      title: titleForPrimitive(id, primitive),
      kind: classifyPrimitive(primitive),
      stepIds: [id],
    });
  }
  return steps;
}

export function countHumanGates(steps: readonly ClassifiedFlowStep[]): number {
  return steps.filter((s) => s.kind === "human").length;
}
