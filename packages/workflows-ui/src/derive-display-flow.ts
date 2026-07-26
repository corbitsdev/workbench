import { type } from "arktype";
import { STEP_TITLE_TAG } from "@workbench/agents";
import { humanize } from "@workbench/agents";

// The retired `deterministic-tool` authoring kind's tag + value.
// `deterministicToolStep` and its `STEP_KIND_TAG`/`DETERMINISTIC_TOOL_KIND`
// exports are deleted from `@workbench/agents` — every tool/API call now
// folds into a native `action` (its own distinct "action" character below) —
// but a historical run's committed workflow.json from before the retirement
// can still carry this tag, and this preview must keep reading it correctly.
// Kept as literals, not an import, so they survive the authoring surface's
// deletion.
const LEGACY_STEP_KIND_TAG = "workbench.stepKind";
const LEGACY_DETERMINISTIC_TOOL_KIND = "deterministic-tool";
import {
  PersistedPrimitiveSchema,
  PersistedWorkflowDefFileSchema,
  type DisplayFlow,
  type DisplayFlowStep,
  type DisplayStepCharacter,
  type PersistedPrimitive,
  type PersistedWorkflowDefFile,
} from "./types";

/**
 * This module overlaps `classifyWorkflowSteps` in
 * `@workbench/agents`'s `flow-classify.ts`, which projects a *hydrated*
 * `WorkflowDefinition` (produced by `defineWorkflow`, agent objects intact)
 * into a coarse auto/agent/human classification for the run stepper.
 * `deriveDisplayFlow` instead reads the *persisted JSON* shape
 * (`apps/hub/generated/workflow-defs/*.json`) before any runtime hydration,
 * and derives a finer per-primitive-kind `DisplayStepCharacter` for a future
 * curation/preview surface. Candidates to unify later:
 *     from one place.
 *   - `DisplayFlowStep`/`DisplayOverlayGroup` here structurally match
 *     `DisplayFlowStep` in `flow-classify.ts` and `DisplayStep` in
 *     `@workbench/ui`'s `workflow-run-state.tsx` (`stepIds`/`key`/`label`/
 *     `activityLabel`) — the overlay group shape should become the single
 *     canonical `DISPLAY_STEPS` type all three modules consume.
 *   - `classifyStepByTag` there and `characterOf` here both branch on the
 *     legacy `workbench.stepKind` === `deterministic-tool` tag; this module's
 *     version just distinguishes more primitive kinds than "auto".
 */
function characterOf(primitive: PersistedPrimitive): DisplayStepCharacter {
  switch (primitive.kind) {
    case "step": {
      const tags = primitive.agent?.tags;
      return tags?.[LEGACY_STEP_KIND_TAG] === LEGACY_DETERMINISTIC_TOOL_KIND
        ? "deterministic"
        : "reasoning";
    }
    case "map": {
      const tags = primitive.step?.agent?.tags;
      return tags?.[LEGACY_STEP_KIND_TAG] === LEGACY_DETERMINISTIC_TOOL_KIND
        ? "deterministic"
        : "reasoning";
    }
    case "gate":
      return "gate";
    case "awaitSignal":
    case "escalation":
      return "await";
    case "sleep":
      return "sleep";
    case "childWorkflow":
      return "child";
    case "action":
      return "action";
    default:
      return "other";
  }
}

function titleTagOf(primitive: PersistedPrimitive): string | undefined {
  if (primitive.kind === "step") return primitive.agent?.tags?.[STEP_TITLE_TAG];
  if (primitive.kind === "map") {
    return primitive.step?.agent?.tags?.[STEP_TITLE_TAG];
  }
  return undefined;
}

function labelOf(stepId: string, primitive: PersistedPrimitive): string {
  const authored = titleTagOf(primitive);
  if (authored !== undefined && authored.trim() !== "") return authored;
  return humanize(stepId);
}

/**
 * Projects a persisted workflow-def JSON file (as read from
 * `apps/hub/generated/workflow-defs/*.json`) into one display step per
 * runtime step, ordered by `stepOrder`. Throws if the input does not
 * structurally match a persisted workflow-def file — see
 * `PersistedWorkflowDefFileSchema`.
 */
export function deriveDisplayFlow(definition: unknown): DisplayFlow {
  const parsed = PersistedWorkflowDefFileSchema(definition);
  if (parsed instanceof type.errors) {
    throw new Error(`not a persisted workflow definition: ${parsed.summary}`);
  }
  return deriveFromParsed(parsed);
}

function parsePrimitive(stepId: string, raw: unknown): PersistedPrimitive {
  const parsed = PersistedPrimitiveSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `step ${stepId} is not a valid primitive: ${parsed.summary}`,
    );
  }
  return parsed;
}

function deriveFromParsed(parsed: PersistedWorkflowDefFile): DisplayFlow {
  const { stepOrder, steps } = parsed.definition;
  const displaySteps: DisplayFlowStep[] = [];
  for (const stepId of stepOrder) {
    const raw = steps[stepId];
    if (raw === undefined) continue;
    const primitive = parsePrimitive(stepId, raw);
    displaySteps.push({
      stepId,
      label: labelOf(stepId, primitive),
      character: characterOf(primitive),
      after: primitive.after ?? [],
    });
  }
  return { steps: displaySteps };
}
