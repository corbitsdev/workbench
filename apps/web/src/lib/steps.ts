export type StepName = 'intake' | 'analyze' | 'generate' | 'improve' | 'export';

export interface Step {
  number: number;
  label: string;
  status: 'completed' | 'current' | 'pending';
}

const STEP_ORDER: StepName[] = ['intake', 'analyze', 'generate', 'improve', 'export'];

export function buildSteps(
  currentStep: StepName,
  labels: Record<StepName, string>,
  isDone?: boolean
): Step[] {
  const currentIndex = STEP_ORDER.indexOf(currentStep);

  return STEP_ORDER.map((name, index) => {
    let status: Step['status'];
    if (isDone || index < currentIndex) {
      status = 'completed';
    } else if (index === currentIndex) {
      status = 'current';
    } else {
      status = 'pending';
    }

    return {
      number: index + 1,
      label: labels[name] ?? name,
      status,
    };
  });
}
