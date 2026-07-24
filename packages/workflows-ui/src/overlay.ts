import type {
  DisplayFlow,
  DisplayOverlay,
  DisplayStepCharacter,
  OverlaidDisplayFlow,
  OverlaidDisplayStep,
} from "./types";

/**
 * Aggregation priority when a curated group clusters several runtime steps
 * with different characters — the strongest signal wins so a renderer never
 * under-represents a group (e.g. a group with a human `await` step reads as
 * `await` even if its other steps are `deterministic`). Mirrors the intent of
 * `aggregateKind` in `@workbench/agents`'s `flow-classify.ts`, extended from
 * three buckets to this module's eight.
 */
const CHARACTER_PRIORITY: readonly DisplayStepCharacter[] = [
  "await",
  "gate",
  "child",
  "action",
  "reasoning",
  "sleep",
  "deterministic",
  "other",
];

function aggregateCharacter(
  characters: readonly DisplayStepCharacter[],
): DisplayStepCharacter {
  for (const candidate of CHARACTER_PRIORITY) {
    if (characters.includes(candidate)) return candidate;
  }
  return "other";
}

/**
 * Curates a derived `DisplayFlow` into the author's declared groups. This is
 * the runtime backstop for the compile-time-typo goal: a generic, typed
 * authoring API over a live definition (checking a group's step ids against
 * the definition at the type level) is a later layer; here, every overlay
 * group's `steps` is validated against the flow's actual step ids and an
 * unknown id throws immediately rather than silently producing an empty or
 * partial group.
 */
export function applyDisplayOverlay(
  flow: DisplayFlow,
  overlay: DisplayOverlay,
): OverlaidDisplayFlow {
  const byId = new Map(flow.steps.map((step) => [step.stepId, step]));
  const groups: OverlaidDisplayStep[] = overlay.groups.map((group) => {
    const characters: DisplayStepCharacter[] = [];
    for (const stepId of group.steps) {
      const step = byId.get(stepId);
      if (step === undefined) {
        throw new Error(
          `display overlay group ${JSON.stringify(group.key)} references unknown step ${JSON.stringify(stepId)}`,
        );
      }
      characters.push(step.character);
    }
    return {
      key: group.key,
      label: group.label,
      character: aggregateCharacter(characters),
      stepIds: group.steps,
      ...(group.activityLabel !== undefined
        ? { activityLabel: group.activityLabel }
        : {}),
    };
  });
  return { groups };
}
