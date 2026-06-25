import {
  type WorkflowStep,
  type WorkflowStepName,
} from "./workflow-step-types";

const STEP_ORDER: WorkflowStepName[] = [
  "intake",
  "analyze",
  "generate",
  "approve",
];

export function buildSteps(
  currentStep: WorkflowStepName,
  labels: Record<WorkflowStepName, string>,
  isDone?: boolean,
): WorkflowStep[] {
  const currentIndex = STEP_ORDER.indexOf(currentStep);

  return STEP_ORDER.map((name, index) => {
    let status: WorkflowStep["status"];
    if (isDone || index < currentIndex) {
      status = "completed";
    } else if (index === currentIndex) {
      status = "current";
    } else {
      status = "pending";
    }

    return {
      number: index + 1,
      label: labels[name] ?? name,
      status,
    };
  });
}
