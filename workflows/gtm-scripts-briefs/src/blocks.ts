import {
  humanizeStepId,
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type FormField,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";

export const INTAKE_SIGNAL = "intake";

export interface GtmScriptsBriefsBlockInput extends DockRunInput {
  stepOutputs: Record<string, unknown>;
}

const INTAKE_FIELDS: FormField[] = [
  {
    kind: "text",
    name: "topic",
    label: "Topic",
    placeholder: "e.g. Recent AI agent launches for revenue teams",
    required: true,
  },
  {
    kind: "number",
    name: "days",
    label: "Research window (days)",
    placeholder: "30",
    required: true,
    defaultValue: 30,
  },
  {
    kind: "text",
    name: "audience",
    label: "Audience (optional)",
    placeholder: "e.g. VP Sales at mid-market SaaS companies",
  },
  {
    kind: "textarea",
    name: "objective",
    label: "Objective (optional)",
    placeholder: "What should the artifact help the audience understand or do?",
  },
];

function intakeForm(signalName: string): UIBlock {
  return {
    kind: "form",
    prompt:
      "What current GTM story should we research and turn into a deliverable?",
    signalName,
    submitLabel: "Research and create deliverable",
    fields: INTAKE_FIELDS,
  };
}

export function buildGtmScriptsBriefsBlocks(
  input: GtmScriptsBriefsBlockInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    if (gate.signalName === INTAKE_SIGNAL) {
      blocks.push(intakeForm(gate.signalName));
    } else {
      blocks.push({
        kind: "link",
        url: `/workflows/${input.runId}`,
        title: "Continue on the run page",
        description:
          "This run needs input the dock cannot collect yet. Continue on the run page.",
      });
    }
  }

  if (input.phase === "failed" && input.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: input.errorMessage });
  }

  if (input.phase === "completed" && input.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: input.completedLink.url,
      title: input.completedLink.title,
      ...(input.completedLink.description !== undefined
        ? { description: input.completedLink.description }
        : {}),
    });
  }

  return blocks;
}
